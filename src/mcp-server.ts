import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { IntervalsClient } from "./lib/intervals-client.js";
import { allTools, type ToolDef } from "./tools/index.js";

const SERVER_INFO = {
  name: "intervals-icu-mcp",
  version: "0.3.0",
} as const;

function jsonResult(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function errorResult(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
  };
}

function registerTool(server: McpServer, client: IntervalsClient, tool: ToolDef): void {
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    },
    async (args: Record<string, unknown>): Promise<CallToolResult> => {
      try {
        const result = await tool.handler(client, args ?? {});
        return jsonResult(result);
      } catch (err) {
        // Tool failures are returned as MCP error content, never thrown.
        return errorResult(err);
      }
    },
  );
}

/**
 * Build an McpServer with every MVP tool registered against the given
 * Intervals.icu client. Used by both the Worker and the in-process tests.
 */
export function createMcpServer(client: IntervalsClient): McpServer {
  const server = new McpServer(SERVER_INFO, {
    capabilities: { tools: {} },
  });
  for (const tool of allTools) registerTool(server, client, tool);
  return server;
}
