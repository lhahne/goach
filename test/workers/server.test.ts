import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
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
