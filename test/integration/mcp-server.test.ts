import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IntervalsClient } from "../../src/lib/intervals-client.js";
import { createMcpServer } from "../../src/mcp-server.js";

/** Build a client wired to a server backed by a programmable fetch. */
async function connect(fetchImpl: typeof fetch) {
  const intervals = new IntervalsClient({
    apiKey: "k",
    fetchImpl,
    sleep: async () => {},
  });
  const server = createMcpServer(intervals);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientT);
  return client;
}

const okJson = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });

describe("MCP server integration", () => {
  let fetchImpl: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchImpl = vi.fn(async () => okJson([]));
  });

  it("lists all tools with descriptions and annotations", async () => {
    const client = await connect(fetchImpl as unknown as typeof fetch);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("get_wellness");
    expect(names).toContain("update_wellness");
    expect(names.length).toBeGreaterThanOrEqual(9);

    const wellness = tools.find((t) => t.name === "get_wellness")!;
    expect(wellness.description).toBeTruthy();
    expect(wellness.annotations?.readOnlyHint).toBe(true);
  });

  it("calls a read tool and returns the Intervals.icu data as JSON text", async () => {
    fetchImpl.mockResolvedValueOnce(
      okJson([{ id: "2026-06-14", weight: 91.5, ctl: 70, atl: 65, form: 5 }]),
    );
    const client = await connect(fetchImpl as unknown as typeof fetch);
    const res = await client.callTool({
      name: "get_wellness",
      arguments: { oldest: "2026-06-01", newest: "2026-06-14" },
    });
    const text = (res.content as { type: string; text: string }[])[0].text;
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(text)[0]).toMatchObject({ weight: 91.5, ctl: 70 });
    // Compact JSON — no pretty-print indentation in tool output.
    expect(text).not.toContain("\n  ");
  });

  it("validates input and rejects a bad date", async () => {
    const client = await connect(fetchImpl as unknown as typeof fetch);
    const res = await client.callTool({
      name: "get_wellness",
      arguments: { oldest: "yesterday", newest: "2026-06-14" },
    });
    expect(res.isError).toBe(true);
    const text = (res.content as { type: string; text: string }[])[0].text;
    expect(text).toContain("validation");
  });

  it("returns an MCP error (isError) when Intervals.icu fails", async () => {
    fetchImpl.mockResolvedValue(new Response("nope", { status: 404 }));
    const client = await connect(fetchImpl as unknown as typeof fetch);
    const res = await client.callTool({
      name: "get_athlete",
      arguments: {},
    });
    expect(res.isError).toBe(true);
    const text = (res.content as { type: string; text: string }[])[0].text;
    expect(text).toContain("Error");
  });
});
