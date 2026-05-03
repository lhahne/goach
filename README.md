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

1. Click **Add MCP server** in the header.
2. Give it a name (e.g. `habits`) and paste the public URL of your habit MCP
   server.
3. If the server uses OAuth, complete the popup. The agent stores the auth
   in its Durable Object so you only do this once.

Now ask things like:

- "How did I do this past week?"
- "What habits am I tracking?"
- "Mark today's egg breakfast as done — note: two scrambled."
- "Write a weekly review based on the last 7 days."

The agent will call `list_habits`, `list_days`, `get_day`, `upsert_check_in`,
etc. on your habit MCP and reason over the results.

## Deploy

```bash
npm run deploy
```

`wrangler deploy` publishes to `goach.<your-account>.workers.dev`. Open it,
add your habit MCP again (the deployed agent has its own Durable Object
state), and you're set.

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
