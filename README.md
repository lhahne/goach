# Intervals.icu Personal MCP Server

A single-user [Model Context Protocol](https://modelcontextprotocol.io) server that
gives Claude (and other MCP clients) typed access to your
[Intervals.icu](https://intervals.icu) training data. Runs on Cloudflare Workers.

Design and rationale: see [`intervals-icu-mcp-spec.md`](./intervals-icu-mcp-spec.md).

## What it does

Exposes high-value Intervals.icu data as MCP tools:

| Tool | Purpose |
|---|---|
| `get_athlete` | Profile, FTP, zones, current fitness |
| `get_wellness` / `update_wellness` | Daily wellness + CTL/ATL/form; idempotent upsert |
| `list_activities` / `get_activity` | Compact activity rows; full detail + downsampled streams |
| `get_power_curves` / `get_pace_curves` / `get_hr_curves` | Best-effort curves at selected durations |
| `list_calendar_events` | Planned workouts & calendar |

Large payloads (streams, curves, lists) are **summarized/downsampled** so they don't
overflow the model's context window.

## Auth

- **Client → Worker:** OAuth 2.1 (PKCE, DCR, token refresh) via
  [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider),
  with **Cloudflare Access** (single-email policy) as the upstream login. This is what
  claude.ai / Claude Desktop custom connectors require.
- **Worker → Intervals.icu:** HTTP Basic Auth (`API_KEY` / your key), athlete id `0`.

See spec §5 for the full flow and the Cloudflare Access dashboard setup.

## Develop

```bash
npm install
npm run typecheck      # tsc --noEmit
npm test               # full Vitest suite (unit + integration + OAuth e2e)
npm run test:coverage  # with coverage thresholds
npm run dev            # wrangler dev
```

The whole test suite runs locally in Node — no network, no deployed Worker. The real
OAuth provider and MCP SDK are exercised; outbound Intervals.icu calls are injected and
KV is an in-memory fake. See spec §12.

## Deploy

```bash
wrangler secret put INTERVALS_API_KEY
wrangler kv namespace create OAUTH_KV   # paste the id into wrangler.toml
# set ACCESS_TEAM_DOMAIN / ACCESS_AUD / OWNER_EMAIL in wrangler.toml
wrangler deploy
```

Then create a Cloudflare Access self-hosted app over `/authorize` (single-email policy)
and add `https://<your-worker>/mcp` as a custom connector in Claude. See spec §10.
