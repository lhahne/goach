import { createWorkersAI } from "workers-ai-provider";
import {
  callable,
  routeAgentRequest,
  type AgentContext,
  type Connection,
  type ConnectionContext,
  type Schedule
} from "agents";
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
import {
  AccessAuthError,
  AccessConfigError,
  readAccessConfig,
  verifyAccessJwt
} from "./auth";

// 30 days. Pending notifications older than this are dropped on next
// connect — a user who's been silent for a month doesn't need a backlog.
const PENDING_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export class ChatAgent extends AIChatAgent<Env> {
  maxPersistedMessages = 100;

  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);

    // Durable queue for scheduled-task fires. Lets us replay notifications
    // to a client that was offline when the task fired. CREATE TABLE IF
    // NOT EXISTS means we can run this on every wake — idempotent — and
    // it guarantees the table is there before any onConnect / executeTask
    // call, regardless of whether onStart has fired yet.
    this.sql`
      CREATE TABLE IF NOT EXISTS pending_notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `;
  }

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

  async onConnect(connection: Connection, ctx: ConnectionContext) {
    await super.onConnect(connection, ctx);

    // Drop notifications older than the TTL — keeps the table from
    // growing if the user goes silent for months.
    this.sql`
      DELETE FROM pending_notifications
      WHERE created_at < ${Date.now() - PENDING_TTL_MS}
    `;

    // Replay pending notifications to the new connection only. We don't
    // use broadcast() here because live clients already saw the original
    // broadcast at fire time. Note: with multiple devices/tabs, only the
    // first one to reconnect gets the missed notifications — fine for a
    // personal coach, would need per-connection delivery tracking otherwise.
    const pending = this.sql<{ id: number; payload: string }>`
      SELECT id, payload FROM pending_notifications ORDER BY id ASC
    `;
    if (pending.length === 0) return;
    for (const row of pending) connection.send(row.payload);
    const lastId = pending[pending.length - 1].id;
    this.sql`DELETE FROM pending_notifications WHERE id <= ${lastId}`;
  }

  async executeTask(description: string, task: Schedule<string>) {
    // Don't log `description` — it's user-supplied and may include
    // health/personal data (e.g. "weigh in", "log medication time").
    console.log(`Executing scheduled task ${task.id}`);

    const payload = JSON.stringify({
      type: "scheduled-task",
      description,
      timestamp: new Date().toISOString()
    });

    // Persist before broadcasting so a thrown broadcast still leaves
    // the notification recoverable on next connect.
    this.sql`
      INSERT INTO pending_notifications (payload, created_at)
      VALUES (${payload}, ${Date.now()})
    `;

    // We use broadcast() instead of saveMessages() to avoid injecting
    // into chat history — the AI would see the notification as new
    // context and potentially loop.
    this.broadcast(payload);
  }
}

export default {
  async fetch(request: Request, env: Env) {
    // Cloudflare Access gate. When ACCESS_TEAM_DOMAIN + ACCESS_AUD are
    // both set, every request must carry a valid Access JWT (Access
    // injects it into the Cf-Access-Jwt-Assertion header, also accept
    // the CF_Authorization cookie). When both are unset, validation is
    // skipped so local `npm run dev` works without an Access app. When
    // exactly one is set, readAccessConfig throws so we fail closed
    // (503) instead of silently leaving the worker unauthenticated.
    let access: ReturnType<typeof readAccessConfig>;
    try {
      access = readAccessConfig(env);
    } catch (err) {
      if (err instanceof AccessConfigError) {
        console.error("Access misconfigured:", err.message);
        return new Response("Service Unavailable", { status: 503 });
      }
      throw err;
    }
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
