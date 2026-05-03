# goach

Your AI fitness and life coach. Built on the Cloudflare Agents SDK, deployed
to Cloudflare Workers, and integrated with your habit-tracking MCP server.

goach reads your recent days (weight, exercise, check-ins, journal comments),
spots patterns, suggests next steps, and can log entries on your behalf —
all through a chat UI.

## Stack

- **Cloudflare Agents SDK** (`agents`, `@cloudflare/ai-chat`) — stateful agent
  on a Durable Object with per-conversation SQLite.
- **Workers AI** — `@cf/moonshotai/kimi-k2.6` via `workers-ai-provider`. No
  API keys required.
- **Vercel AI SDK** (`ai`) — tool calling and streaming.
- **React + Vite + Tailwind** — chat UI from `cloudflare/agents-starter`.
- **MCP** — connect any number of remote MCP servers (Streamable HTTP, OAuth
  supported) from the UI.

## Develop

```bash
npm install
npm run dev
```

Open the URL printed by Vite. The first request spins up the agent's Durable
Object locally.

## Connect your habit MCP

1. Click **MCP** in the header to open the server panel.
2. Give the server a name (e.g. `habits`) and paste the public URL of your
   habit MCP server, then add it.
3. If the server uses OAuth, click **Auth** on its row to complete the
   popup. The agent stores the auth in its Durable Object so you only do
   this once.

Now ask things like:

- "How did I do this past week?"
- "What habits am I tracking?"
- "Mark today's egg breakfast as done — note: two scrambled."
- "Write a weekly review based on the last 7 days."

The agent will call `list_habits`, `list_days`, `get_day`, `upsert_check_in`,
etc. on your habit MCP and reason over the results.

## Test

```bash
npm test                # full suite (unit + workers)
npm run test:unit       # node-only unit tests for src/utils.ts and src/tools.ts
npm run test:workers    # workerd integration smoke test (Durable Object boots, fetch routes)
npm run test:coverage   # v8 coverage report for the unit project
npm run test:watch      # vitest in watch mode
```

The unit project covers pure logic (date helpers, tool execute functions) in
node. The workers project boots the worker in Miniflare via
`@cloudflare/vitest-pool-workers` and verifies the `ChatAgent` Durable
Object constructs cleanly and the fetch handler routes correctly. Coverage
on `src/utils.ts` and `src/tools.ts` is 100% lines / 100% functions; the
React UI and `src/server.ts` glue are covered by the workers smoke test
and by `vite build` rather than by unit tests.

## Deploy

```bash
npm run deploy
```

`wrangler deploy` publishes to `goach.<your-account>.workers.dev`. Open it,
add your habit MCP again (the deployed agent has its own Durable Object
state), and you're set.

## Reminders survive disconnects

When a `scheduleTask` fires, the agent persists the notification to its
Durable Object SQLite (`pending_notifications` table) **before** broadcasting
to live WebSocket clients. On reconnect, `onConnect` replays any pending
entries to the new connection and deletes them. So a reminder scheduled while
the user is offline will be delivered the next time they open the app.

A 30-day TTL prunes the queue on connect to keep it bounded. With multiple
devices/tabs, only the first one to reconnect after a fire sees the missed
notifications — adequate for a single-user coach.

## Auth (Cloudflare Access)

The deployed worker has no built-in user auth — anyone with the URL can
chat with your coach. Put **Cloudflare Access** in front of it:

1. **Dashboard:** Zero Trust → Access → Applications → Add an
   application → Self-hosted. Set the application domain to your
   worker hostname (`goach.<account>.workers.dev` or your custom
   domain). Add a policy (e.g. "Emails ending in `@yourdomain.com`").
   Copy the **Application Audience (AUD) Tag** from the application's
   overview page, and your team domain (e.g.
   `myteam.cloudflareaccess.com`).
2. **Worker config:** in `wrangler.jsonc`, set:
   ```jsonc
   "vars": {
     "ACCESS_TEAM_DOMAIN": "myteam.cloudflareaccess.com",
     "ACCESS_AUD": "<paste-the-aud-tag-here>"
   }
   ```
   Or set them as secrets so they're not in git:
   ```bash
   wrangler secret put ACCESS_TEAM_DOMAIN
   wrangler secret put ACCESS_AUD
   ```
3. **Redeploy:** `npm run deploy`.

The worker (`src/auth.ts`) verifies the `Cf-Access-Jwt-Assertion` header
on every request against your team's JWKS, and rejects requests without
a valid JWT with `401 Unauthorized`. When **both** vars are empty (the
default) validation is skipped — that's what makes `npm run dev` work
without an Access app configured. When **exactly one** var is set the
worker fails closed with `503 Service Unavailable` to avoid the footgun
of accidentally deploying with auth half-configured.

## How it works

`src/server.ts` defines `ChatAgent extends AIChatAgent`. On each user
message:

1. `this.mcp.getAITools()` collects every tool from connected MCP servers.
2. Those tools, plus a few built-ins (`getToday`, `getCurrentWeek`,
   `getUserTimezone`, `scheduleTask`/`getScheduledTasks`/`cancelScheduledTask`),
   are passed to `streamText` from the Vercel AI SDK.
3. Workers AI streams the response; tool calls are routed automatically.

`src/app.tsx` is the React chat UI: message thread, attachments, and a
panel to add/remove MCP servers via the agent's `@callable() addServer`
and `removeServer` methods.
