import { createWorkersAI } from "workers-ai-provider";
import { callable, routeAgentRequest, type Schedule } from "agents";
import { getSchedulePrompt } from "agents/schedule";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText
} from "ai";
import { buildCoachTools } from "./tools";
import { inlineDataUrls } from "./utils";
import { AccessAuthError, readAccessConfig, verifyAccessJwt } from "./auth";

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
        ...mcpTools,
        ...buildCoachTools({
          schedule: (when, description) =>
            this.schedule(when, "executeTask", description, {
              idempotent: true
            }),
          getSchedules: () => this.getSchedules(),
          cancelSchedule: (id) => this.cancelSchedule(id)
        })
      },
      stopWhen: stepCountIs(5),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }

  async executeTask(description: string, _task: Schedule<string>) {
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
    // Cloudflare Access gate. When ACCESS_TEAM_DOMAIN + ACCESS_AUD are
    // set, every request must carry a valid Access JWT (Access injects
    // it into the Cf-Access-Jwt-Assertion header, also accept the
    // CF_Authorization cookie). When unset, validation is skipped so
    // local `npm run dev` works without an Access app configured.
    const access = readAccessConfig(env);
    if (access) {
      try {
        await verifyAccessJwt(request, access);
      } catch (err) {
        if (err instanceof AccessAuthError) {
          return new Response("Unauthorized", { status: 401 });
        }
        throw err;
      }
    }
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
