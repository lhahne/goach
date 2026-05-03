import { createWorkersAI } from "workers-ai-provider";
import { callable, routeAgentRequest, type Schedule } from "agents";
import { getSchedulePrompt, scheduleSchema } from "agents/schedule";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText,
  tool,
  type ModelMessage
} from "ai";
import { z } from "zod";

/**
 * The AI SDK's downloadAssets step runs `new URL(data)` on every file
 * part's string data. Data URIs parse as valid URLs, so it tries to
 * HTTP-fetch them and fails. Decode to Uint8Array so the SDK treats
 * them as inline data instead.
 */
function isoDateInTimezone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const lookup = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${lookup.year}-${lookup.month}-${lookup.day}`;
}

function inlineDataUrls(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((msg) => {
    if (msg.role !== "user" || typeof msg.content === "string") return msg;
    return {
      ...msg,
      content: msg.content.map((part) => {
        if (part.type !== "file" || typeof part.data !== "string") return part;
        const match = part.data.match(/^data:([^;]+);base64,(.+)$/);
        if (!match) return part;
        const bytes = Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0));
        return { ...part, data: bytes, mediaType: match[1] };
      })
    };
  });
}

export class ChatAgent extends AIChatAgent<Env> {
  maxPersistedMessages = 100;

  onStart() {
    // Configure OAuth popup behavior for MCP servers that require authentication
    this.mcp.configureOAuthCallback({
      customHandler: (result) => {
        if (result.authSuccess) {
          return new Response("<script>window.close();</script>", {
            headers: { "content-type": "text/html" },
            status: 200
          });
        }
        return new Response(
          `Authentication Failed: ${result.authError || "Unknown error"}`,
          { headers: { "content-type": "text/plain" }, status: 400 }
        );
      }
    });
  }

  @callable()
  async addServer(name: string, url: string) {
    return await this.addMcpServer(name, url);
  }

  @callable()
  async removeServer(serverId: string) {
    await this.removeMcpServer(serverId);
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const mcpTools = this.mcp.getAITools();
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: workersai("@cf/moonshotai/kimi-k2.6", {
        sessionAffinity: this.sessionAffinity
      }),
      system: `You are goach, a thoughtful fitness and life coach. You help the user:
- review recent days (weight trend, exercise, habit check-ins)
- spot patterns in habit completion and journal comments
- suggest concrete, specific next steps and weekly reviews
- log check-ins, comments, weights, and exercise on the user's behalf when asked

When the user has connected a habit MCP server, prefer reading their actual data
(list_habits, list_days, get_day, search_text) before giving advice. Cite specific
dates and numbers. Use getToday and getCurrentWeek to anchor date queries — never
guess today's date. When writing data on the user's behalf (set_day_*,
upsert_check_in, create_habit, update_habit), confirm intent first.

Be direct, kind, and specific. Skip generic motivational filler.

${getSchedulePrompt({ date: new Date() })}

If the user asks to be reminded of something later, use the scheduleTask tool.`,
      // Prune old tool calls to save tokens on long conversations
      messages: pruneMessages({
        messages: inlineDataUrls(await convertToModelMessages(this.messages)),
        toolCalls: "before-last-2-messages"
      }),
      tools: {
        // MCP tools from connected servers (e.g. the user's habit MCP)
        ...mcpTools,

        // Client-side tool: the browser fills in the user's IANA timezone.
        getUserTimezone: tool({
          description:
            "Get the user's IANA timezone from their browser. Call before getToday or getCurrentWeek if you don't already know it.",
          inputSchema: z.object({})
        }),

        getToday: tool({
          description:
            "Return today's date as an ISO string (YYYY-MM-DD) in the user's timezone. Use this before querying habit-MCP tools that take a `date` argument.",
          inputSchema: z.object({
            timezone: z
              .string()
              .describe("IANA timezone, e.g. 'Europe/Helsinki'")
          }),
          execute: async ({ timezone }) => {
            return { date: isoDateInTimezone(new Date(), timezone) };
          }
        }),

        getCurrentWeek: tool({
          description:
            "Return the from/to ISO dates for the current week (Mon–Sun) in the user's timezone. Use this before list_days when the user asks about 'this week' or 'the past week'.",
          inputSchema: z.object({
            timezone: z
              .string()
              .describe("IANA timezone, e.g. 'Europe/Helsinki'")
          }),
          execute: async ({ timezone }) => {
            const today = isoDateInTimezone(new Date(), timezone);
            const [y, m, d] = today.split("-").map(Number);
            const utc = new Date(Date.UTC(y, m - 1, d));
            const dayOfWeek = (utc.getUTCDay() + 6) % 7; // Mon=0, Sun=6
            const monday = new Date(utc);
            monday.setUTCDate(utc.getUTCDate() - dayOfWeek);
            const sunday = new Date(monday);
            sunday.setUTCDate(monday.getUTCDate() + 6);
            return {
              from: monday.toISOString().slice(0, 10),
              to: sunday.toISOString().slice(0, 10)
            };
          }
        }),

        scheduleTask: tool({
          description:
            "Schedule a task to be executed at a later time. Use this when the user asks to be reminded or wants something done later.",
          inputSchema: scheduleSchema,
          execute: async ({ when, description }) => {
            if (when.type === "no-schedule") {
              return "Not a valid schedule input";
            }
            const input =
              when.type === "scheduled"
                ? when.date
                : when.type === "delayed"
                  ? when.delayInSeconds
                  : when.type === "cron"
                    ? when.cron
                    : null;
            if (!input) return "Invalid schedule type";
            try {
              this.schedule(input, "executeTask", description, {
                idempotent: true
              });
              return `Task scheduled: "${description}" (${when.type}: ${input})`;
            } catch (error) {
              return `Error scheduling task: ${error}`;
            }
          }
        }),

        getScheduledTasks: tool({
          description: "List all tasks that have been scheduled",
          inputSchema: z.object({}),
          execute: async () => {
            const tasks = this.getSchedules();
            return tasks.length > 0 ? tasks : "No scheduled tasks found.";
          }
        }),

        cancelScheduledTask: tool({
          description: "Cancel a scheduled task by its ID",
          inputSchema: z.object({
            taskId: z.string().describe("The ID of the task to cancel")
          }),
          execute: async ({ taskId }) => {
            try {
              this.cancelSchedule(taskId);
              return `Task ${taskId} cancelled.`;
            } catch (error) {
              return `Error cancelling task: ${error}`;
            }
          }
        })
      },
      stopWhen: stepCountIs(5),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }

  async executeTask(description: string, _task: Schedule<string>) {
    // Do the actual work here (send email, call API, etc.)
    console.log(`Executing scheduled task: ${description}`);

    // Notify connected clients via a broadcast event.
    // We use broadcast() instead of saveMessages() to avoid injecting
    // into chat history — that would cause the AI to see the notification
    // as new context and potentially loop.
    this.broadcast(
      JSON.stringify({
        type: "scheduled-task",
        description,
        timestamp: new Date().toISOString()
      })
    );
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
