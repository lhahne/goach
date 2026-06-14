import type { ZodRawShape } from "zod";
import type { IntervalsClient } from "../lib/intervals-client.js";

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/**
 * A single MCP tool: its schema + annotations + a pure handler that takes the
 * Intervals.icu client and validated input and returns a JSON-serialisable
 * result. The handler never formats MCP envelopes — mcp-server.ts does that.
 */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: ZodRawShape;
  annotations: ToolAnnotations;
  handler: (client: IntervalsClient, input: Record<string, unknown>) => Promise<unknown>;
}

export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  openWorldHint: true,
};
