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
import { gateAccess } from "./auth";

// 30 days. Pending notifications older than this are pruned — a user
// who's been silent for a month doesn't need a backlog.
const PENDING_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Hard cap on how many pending notifications we'll hold for a single
// agent at once. Trims the oldest beyond this threshold so the table
// can't grow without bound while a cron reminder fires repeatedly with
// no client ever connecting.
const PENDING_MAX_ROWS = 100;

/**
 * Merge built-in coach tools with tools from connected MCP servers.
 *
 * MCP wins on collision: the user explicitly added that server, so a
 * tool they brought in should take precedence over a generically-named
 * built-in (otherwise "connect any MCP server" silently breaks for
 * servers that expose `getToday`, `scheduleTask`, etc.). Collisions are
 * logged so the operator notices the shadowing.
 */
function mergeTools<A extends object, B extends object>(
  builtins: A,
  mcp: B
): A & B {
  for (const name of Object.keys(mcp)) {
    if (name in builtins) {
      console.warn(
        `Tool name collision: connected MCP server's '${name}' shadows the built-in coach tool of the same name.`
      );
    }
  }
  return { ...builtins, ...mcp } as A & B;
}

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
dates and numbers. Use getToday, getCurrentWeek, and getRecentDays to anchor date
queries — never guess today's date. When writing data on the user's behalf
(set_day_*, upsert_check_in, create_habit, update_habit), confirm intent first.

Be direct, kind, and specific. Skip generic motivational filler.

The schedule prompt below uses the worker's UTC clock. For relative scheduling
("tomorrow at 8", "next Monday morning"), call getUserTimezone first, then
getToday, and translate the user's wall-clock time into an absolute ISO instant
before invoking scheduleTask. Without this step, reminders near a UTC day
boundary land on the wrong day.

${getSchedulePrompt({ date: new Date() })}

If the user asks to be reminded of something later, use the scheduleTask tool.`,
      // Prune old tool calls to save tokens on long conversations
      messages: pruneMessages({
        messages: inlineDataUrls(await convertToModelMessages(this.messages)),
        toolCalls: "before-last-2-messages"
      }),
      tools: mergeTools(
        buildCoachTools({
          schedule: (when, description) =>
            this.schedule(when, "executeTask", description, {
              idempotent: true
            }),
          getSchedules: () => this.getSchedules(),
          cancelSchedule: (id) => this.cancelSchedule(id)
        }),
        mcpTools
      ),
      // 10 not 5: a typical "review my week" turn chains
      // getUserTimezone → getCurrentWeek → list_days → list_habits →
      // (optional) write check-ins → final message. Five steps wasn't
      // enough headroom; ten lets the model finish without runaway loops.
      stopWhen: stepCountIs(10),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }

  /**
   * Bound the pending_notifications queue: drop entries older than the
   * TTL and trim the oldest beyond the row cap. Called from both insert
   * and replay paths so the queue stays bounded even if the user never
   * reconnects.
   */
  private prunePending(): void {
    this.sql`
      DELETE FROM pending_notifications
      WHERE created_at < ${Date.now() - PENDING_TTL_MS}
    `;
    this.sql`
      DELETE FROM pending_notifications
      WHERE id NOT IN (
        SELECT id FROM pending_notifications
        ORDER BY id DESC
        LIMIT ${PENDING_MAX_ROWS}
      )
    `;
  }

  async onConnect(connection: Connection, ctx: ConnectionContext) {
    await super.onConnect(connection, ctx);
    this.prunePending();

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

    // If at least one client is connected, broadcast live and skip the
    // queue — otherwise the row would still be there on next connect
    // and the user would see the same toast twice. If nobody's listening,
    // persist so onConnect replays it on reconnect.
    //
    // We use broadcast() instead of saveMessages() to avoid injecting
    // into chat history — the AI would see the notification as new
    // context and potentially loop.
    let hasLiveClient = false;
    for (const _conn of this.getConnections()) {
      hasLiveClient = true;
      break;
    }
    if (hasLiveClient) {
      this.broadcast(payload);
    } else {
      this.sql`
        INSERT INTO pending_notifications (payload, created_at)
        VALUES (${payload}, ${Date.now()})
      `;
      // Prune on every insert so the queue stays bounded even when the
      // user never reconnects (e.g. cron reminder firing every day for
      // months). Without this, the SQLite table can grow unboundedly.
      this.prunePending();
    }
  }
}

export default {
  async fetch(request: Request, env: Env) {
    // Cloudflare Access gate. See gateAccess() for full semantics. Both
    // env vars unset → auth disabled (local dev). Both set → JWT must
    // verify. Exactly one set → 503 (misconfig). JWT invalid → 401.
    // JWKS unreachable → 503.
    const blocked = await gateAccess(request, env);
    if (blocked) return blocked;
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
