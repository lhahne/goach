import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Connection, ConnectionContext, Schedule } from "agents";
import type { ChatAgent } from "../../src/server";

// Smoke tests: verify the worker boots in workerd, the bundled module graph
// loads (no Workers-incompatible imports), the default fetch handler returns
// 404 for unknown paths, and the ChatAgent Durable Object can be constructed
// without throwing in onStart.
describe("worker fetch handler", () => {
  it("returns 404 for an unknown path", async () => {
    const res = await SELF.fetch("https://goach.test/does-not-exist");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not found");
  });
});

describe("ChatAgent durable object", () => {
  it("boots without throwing", async () => {
    const id = env.ChatAgent.idFromName("smoke-test");
    const stub = env.ChatAgent.get(id);
    await runInDurableObject<ChatAgent, void>(stub, async (agent, state) => {
      expect(agent).toBeDefined();
      expect(state.id.equals(id)).toBe(true);
    });
  });

  it("exposes addServer and removeServer as callable methods", async () => {
    const id = env.ChatAgent.idFromName("smoke-test-callable");
    const stub = env.ChatAgent.get(id);
    await runInDurableObject<ChatAgent, void>(stub, async (agent) => {
      // The methods exist on the instance — calling them for real would
      // require a live MCP server, which is out of scope for a smoke test.
      expect(typeof agent.addServer).toBe("function");
      expect(typeof agent.removeServer).toBe("function");
    });
  });
});

function fakeSchedule(id: string): Schedule<string> {
  return { id } as unknown as Schedule<string>;
}

function fakeConnection(sent: string[]): Connection {
  return {
    send(msg: string | ArrayBuffer | ArrayBufferView) {
      sent.push(
        typeof msg === "string" ? msg : new TextDecoder().decode(msg as ArrayBuffer)
      );
    }
  } as unknown as Connection;
}

const fakeCtx = {
  request: new Request("https://goach.test/agents/chat-agent/x")
} as ConnectionContext;

// super.onConnect sends initial agent-state frames; we only care about
// the scheduled-task frames our drain replays.
function scheduledTaskFrames(sent: string[]): Array<{ description: string }> {
  return sent
    .map((s) => {
      try {
        return JSON.parse(s) as { type?: string; description?: string };
      } catch {
        return null;
      }
    })
    .filter(
      (m): m is { type: string; description: string } =>
        m !== null && m.type === "scheduled-task"
    );
}

describe("durable scheduled-task notifications", () => {
  it("persists the payload when no clients are connected at fire time", async () => {
    const id = env.ChatAgent.idFromName("notif-persist");
    const stub = env.ChatAgent.get(id);
    await runInDurableObject<ChatAgent, void>(stub, async (agent) => {
      await agent.executeTask("drink water", fakeSchedule("task-1"));

      const rows = agent.sql<{ payload: string; created_at: number }>`
        SELECT payload, created_at FROM pending_notifications ORDER BY id ASC
      `;
      expect(rows).toHaveLength(1);
      const parsed = JSON.parse(rows[0].payload) as Record<string, unknown>;
      expect(parsed).toMatchObject({
        type: "scheduled-task",
        description: "drink water"
      });
      expect(typeof parsed.timestamp).toBe("string");
      expect(rows[0].created_at).toBeGreaterThan(0);
    });
  });

  it("does NOT persist when at least one client is already connected (no double-delivery on next reconnect)", async () => {
    const id = env.ChatAgent.idFromName("notif-no-double");
    const stub = env.ChatAgent.get(id);
    await runInDurableObject<ChatAgent, void>(stub, async (agent) => {
      // Pretend a client is connected. We override getConnections so the
      // live-client check sees one; broadcast() falls through to the real
      // WebSocket map (empty in tests) and silently no-ops.
      const fake = { send: () => {} } as unknown as Connection;
      const stubbed = agent as unknown as {
        getConnections: () => Iterable<Connection>;
      };
      const original = stubbed.getConnections.bind(agent);
      stubbed.getConnections = () => [fake];

      try {
        await agent.executeTask("delivered live", fakeSchedule("live-1"));
      } finally {
        stubbed.getConnections = original;
      }

      const rows = agent.sql<{ id: number }>`
        SELECT id FROM pending_notifications
      `;
      expect(rows).toHaveLength(0);
    });
  });

  it("drains the queue to the connecting client and deletes the rows", async () => {
    const id = env.ChatAgent.idFromName("notif-drain");
    const stub = env.ChatAgent.get(id);
    await runInDurableObject<ChatAgent, void>(stub, async (agent) => {
      await agent.executeTask("a", fakeSchedule("1"));
      await agent.executeTask("b", fakeSchedule("2"));

      const sent: string[] = [];
      await agent.onConnect(fakeConnection(sent), fakeCtx);

      const replayed = scheduledTaskFrames(sent);
      expect(replayed.map((f) => f.description)).toEqual(["a", "b"]);

      const remaining = agent.sql<{ id: number }>`
        SELECT id FROM pending_notifications
      `;
      expect(remaining).toHaveLength(0);
    });
  });

  it("replays nothing when the queue is empty", async () => {
    const id = env.ChatAgent.idFromName("notif-empty");
    const stub = env.ChatAgent.get(id);
    await runInDurableObject<ChatAgent, void>(stub, async (agent) => {
      const sent: string[] = [];
      await agent.onConnect(fakeConnection(sent), fakeCtx);
      expect(scheduledTaskFrames(sent)).toHaveLength(0);
    });
  });

  it("prunes notifications older than the 30-day TTL on connect", async () => {
    const id = env.ChatAgent.idFromName("notif-ttl");
    const stub = env.ChatAgent.get(id);
    await runInDurableObject<ChatAgent, void>(stub, async (agent) => {
      const ancient = Date.now() - 40 * 24 * 60 * 60 * 1000; // 40 days ago
      const fresh = Date.now() - 1000;
      agent.sql`
        INSERT INTO pending_notifications (payload, created_at)
        VALUES (${'{"type":"scheduled-task","description":"old"}'}, ${ancient})
      `;
      agent.sql`
        INSERT INTO pending_notifications (payload, created_at)
        VALUES (${'{"type":"scheduled-task","description":"new"}'}, ${fresh})
      `;

      const sent: string[] = [];
      await agent.onConnect(fakeConnection(sent), fakeCtx);

      const replayed = scheduledTaskFrames(sent);
      expect(replayed.map((f) => f.description)).toEqual(["new"]);
      const remaining = agent.sql<{ id: number }>`
        SELECT id FROM pending_notifications
      `;
      expect(remaining).toHaveLength(0);
    });
  });
});
