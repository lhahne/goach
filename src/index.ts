import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { handleAuthorize } from "./auth.js";
import { OAUTH_SCOPES, type Env } from "./config.js";
import { IntervalsClient } from "./lib/intervals-client.js";
import { createMcpServer } from "./mcp-server.js";

/**
 * API handler for the OAuth-protected /mcp route. Only reached after the OAuth
 * access token has been validated by the provider. Runs a stateless Streamable
 * HTTP MCP server (one server + transport per request).
 */
const mcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const client = new IntervalsClient({ apiKey: env.INTERVALS_API_KEY });
    const server = createMcpServer(client);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    ctx.waitUntil(server.close());
    return response;
  },
};

const STATUS_PAGE = `<!doctype html><html><head><meta charset="utf-8">
<title>Intervals.icu MCP</title></head><body style="font-family:system-ui;max-width:40rem;margin:3rem auto">
<h1>Intervals.icu MCP server</h1>
<p>This is a personal Model Context Protocol server. Add <code>/mcp</code> as a
custom connector in your MCP client; authentication is handled via OAuth behind
Cloudflare Access.</p></body></html>`;

// Default handler: everything that is not the OAuth-protected API or an OAuth
// endpoint owned by the provider (/token, /register, metadata).
const app = new Hono<{ Bindings: Env }>();
app.get("/health", (c) => c.json({ ok: true }));
app.get("/", (c) => c.html(STATUS_PAGE));
app.get("/authorize", (c) => handleAuthorize(c.req.raw, c.env));
app.all("*", (c) => c.text("Not found", 404));

const defaultHandler = { fetch: app.fetch };

// The provider's handler param types use an `unknown` env; our handlers are
// Env-typed. The runtime shape ({ fetch }) is exactly what it expects, so we
// cast through unknown.
type HandlerWithFetch = ExportedHandler & {
  fetch: NonNullable<ExportedHandler["fetch"]>;
};

export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: mcpApiHandler as unknown as HandlerWithFetch,
  defaultHandler: defaultHandler as unknown as ExportedHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: [...OAUTH_SCOPES],
});
