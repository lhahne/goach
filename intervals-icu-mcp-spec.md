# Intervals.icu Personal MCP Server

**Single-user bridge between Claude / Grok and the Intervals.icu API**
**Platform:** Cloudflare Workers (TypeScript)
**Version:** 0.2
**Date:** June 2026

---

## 1. Overview

This is a lightweight, personal **Model Context Protocol (MCP) server** that lets your chatbots (Claude, Grok, Cursor, and other MCP clients) directly read from and write to your Intervals.icu account using natural language or tool calling.

Instead of manually copying data or writing brittle prompts, the LLM can ask things like:

- "What's my CTL/ATL/TSB trend this month?"
- "Show me my best 5-minute power efforts in the last 8 weeks"
- "Update my weight to 91.5 kg today and resting HR to 48"
- "List my rides from the last 30 days with average power > 200W"
- "Create a 90-minute endurance workout for next Tuesday"

The server runs on **Cloudflare Workers** (edge, cheap, fast cold starts, native MCP support via the Streamable HTTP transport).

---

## 2. Goals

- Give Claude and Grok (and other MCP-compatible clients) high-quality, typed access to your Intervals.icu data.
- Keep everything **single-user and dead simple** to operate and maintain.
- Deploy and update with a single `wrangler deploy`.
- Excellent tool descriptions so the LLM uses tools correctly and efficiently.
- Read-heavy with a few safe write operations (wellness updates, planned workouts).
- Leverage the official Intervals.icu OpenAPI spec for accurate schemas and descriptions.
- **Keep tool responses small and context-friendly** — never dump raw streams or full curves into the model.

---

## 3. Non-Goals (MVP)

- No multi-user or team support
- No complex OAuth flows (a static bearer token or Cloudflare Access is sufficient)
- Not every single Intervals.icu endpoint (focus on the 8–10 highest-value tools first)
- No heavy frontend (optional minimal status page is acceptable)

---

## 4. Recommended Architecture

**Core pattern:** Remote MCP server on Cloudflare Workers exposing the **Streamable HTTP** transport at `/mcp`.

### Decision: stateless handler, not a Durable Object (resolves Open Question #1)

Cloudflare offers two paths:

| Approach | Mechanism | Needs Durable Objects? | Best for |
|---|---|---|---|
| **Stateless** `createMcpHandler()` | Plain Worker fetch handler | No | Simple, request/response tools with no cross-call session state |
| **Stateful** `McpAgent` | Durable Object per session | Yes (Workers **Paid** plan) | Tools that must remember context within a session, MCP elicitation, etc. |

For a **single-user, read-heavy** server where every tool is a clean request → Intervals.icu → response, **start with the stateless `createMcpHandler()`**. It avoids the Durable Objects requirement (and therefore the Workers Paid plan), is simpler to reason about, and is trivially testable. Move to `McpAgent` only if you later need MCP **elicitation** (interactive confirmation prompts) or per-session caching.

### Components

- **Hono** for the HTTP layer (auth middleware, health check, MCP route)
- **`@modelcontextprotocol/sdk`** (`McpServer`) for tool registration
- Cloudflare's MCP adapter (`createMcpHandler` for stateless; `agents`/`McpAgent` if you opt into stateful)
- Small, typed **Intervals.icu client** (wrapper around `fetch` + Zod schemas, with retry + rate-limit handling)
- **Worker secrets only** for the MVP (no KV needed — see §5)

**Why MCP?**
It is the established 2025–2026 standard. Claude Desktop/claude.ai, Cursor, Windsurf, Goose, and many other agents support it natively. Add the server once and it works across many tools.

**Alternative considered:** A plain Hono app exposing an OpenAI-compatible `/v1/chat/completions` endpoint with Intervals tools. MCP is cleaner and more future-proof.

---

## 5. Authentication (Simple Personal Flow)

Two lightweight layers.

### 1. Worker protection (MCP endpoint)

- Use a strong random `MCP_AUTH_TOKEN` (generate once) and check it in Hono middleware as `Authorization: Bearer <token>`.
- **Client caveat:** a static bearer token is **not** accepted by every MCP client. claude.ai / Claude Desktop "custom connectors" expect an OAuth flow for remote servers; clients that allow arbitrary headers (or the `mcp-remote` bridge) can pass the static token directly. Pick one of:
  - **Cloudflare Access (Zero Trust)** in front of the Worker, gated to your email — gives you SSO with no token to manage, and works well with `mcp-remote`. **Recommended.**
  - Static bearer token for clients that support custom headers, plus `mcp-remote` for those that don't.
  - Full OAuth via Cloudflare's `workers-oauth-provider` only if a client requires it.

### 2. Intervals.icu

- Store **your** Intervals.icu API key as a Worker secret (`INTERVALS_API_KEY`). Generate it under **Settings → Developer Settings**.
- The Worker authenticates to Intervals.icu using **HTTP Basic Auth** with username `API_KEY` and password = your key:
  `Authorization: Basic base64("API_KEY:<your-key>")`.
- **Athlete ID:** use `0` in the path (e.g. `/api/v1/athlete/0/...`) — Intervals.icu auto-resolves `0` to the athlete that owns the API key. No need to store your real `iNNNNNN` id.

This setup requires only **2 secrets and one deploy** — no KV namespace for the MVP.

---

## 6. Core Tools (MVP Priority)

Prioritized for a serious 39–40 year old orienteering/fitness user.

Every tool must include:
- A high-quality `description` written for the LLM (what it does, when to use it, units, date format).
- A strict **Zod input schema** (dates as `YYYY-MM-DD`, sensible `limit` defaults).
- **MCP tool annotations** so clients can reason about safety: `readOnlyHint: true` for all reads; `destructiveHint`/`idempotentHint` set appropriately on writes (see §11).
- A **bounded, summarized output** — see the context-budget note below.

### High Priority (implement first)
- `get_wellness` — date range (`oldest` / `newest`); returns weight, resting HR, HRV, sleep, **plus CTL/ATL/form which Intervals.icu already stores per day**.
- `update_wellness` — weight, resting_hr, hrv, sleep, etc. (idempotent upsert by date).
- `list_activities` — filters: sport, oldest, newest, limit, has_power, etc. Returns a **compact summary row per activity**, not full detail.
- `get_activity` — full details + interval list. Streams are **opt-in and downsampled** (see below), not returned by default.
- `get_power_curves` / `get_pace_curves` / `get_hr_curves` — return a **selected set of durations** (e.g. 5s, 1m, 5m, 20m, 60m), not the full curve.
- `list_calendar_events` — `oldest` / `newest` (includes planned workouts).
- `get_athlete` — profile + current fitness metrics (CTL/ATL/form, FTP, zones).

### Medium Priority
- `list_workouts` / `get_workout` (Library)
- `create_workout` or `duplicate_workout`
- `create_event` / `plan_workout_to_calendar`
- `get_fitness_summary` — CTL, ATL, TSB/form, ramp rate. **Prefer reading the values Intervals.icu already returns** (in wellness/athlete data); only compute as a fallback.
- `search_activities` (text or structured filters)

### Later / Nice-to-have
- Upload activity (FIT/GPX)
- Gear management
- Routes & route similarity

### Context-budget note (important)

Activity **streams** (per-second power/HR/pace/GPS) and **full curves** can be tens of thousands of points and will blow the model's context window. For every potentially-large response:
- Default to **summaries**; require an explicit flag/duration list to return raw detail.
- **Downsample** streams (e.g. to N points or a fixed cadence) and let the caller pick which channels.
- **Paginate** activity lists with a `limit` (default ~30) and date window.

---

## 7. Tech Stack

- **Language**: TypeScript (strict mode)
- **Web framework**: Hono + `@modelcontextprotocol/sdk`, served via Cloudflare's stateless MCP handler (`McpAgent`/`agents` only if you opt into stateful)
- **Validation & schemas**: Zod (also used to generate clean tool schemas)
- **HTTP client**: native `fetch` with a typed wrapper (timeout, retry on 429/5xx with backoff, honoring `Retry-After`)
- **Config & storage**: `wrangler.toml` + secrets (KV/D1 deferred to Phase 2)
- **Observability**: Cloudflare Workers Logs / Logpush (+ optional Sentry)
- **Types**: derived from the Intervals.icu OpenAPI spec where practical

**Example key dependencies** (pin to versions that are mutually compatible at install time — verify the MCP SDK's required Zod major before choosing Zod 3 vs 4):
```json
{
  "@modelcontextprotocol/sdk": "^1.x",
  "agents": "^0.x",
  "hono": "^4.x",
  "zod": "^3.x"
}
```

---

## 8. Proposed Project Structure

```
intervals-icu-mcp/
├── src/
│   ├── index.ts                 # Entry point: Hono app + auth middleware + MCP handler
│   ├── mcp-server.ts            # Tool registration & descriptions
│   ├── tools/
│   │   ├── wellness.ts
│   │   ├── activities.ts
│   │   ├── curves.ts
│   │   ├── calendar.ts
│   │   └── workouts.ts
│   ├── lib/
│   │   ├── intervals-client.ts  # Typed Intervals.icu fetch wrapper (auth, retry, rate limit)
│   │   └── schemas.ts           # Zod schemas + LLM-friendly descriptions
│   └── config.ts
├── test/                        # Vitest unit tests (schemas, client, tool handlers)
├── wrangler.toml
├── package.json
└── README.md
```

---

## 9. Data Flow Example

1. You add the MCP server URL + auth (bearer token or Cloudflare Access) in Claude / Cursor.
2. LLM decides it needs data → calls a tool (e.g. `list_activities`).
3. Worker receives an MCP `tools/call` request over Streamable HTTP.
4. Hono middleware validates the bearer token (or Cloudflare Access has already gated the request).
5. Worker calls Intervals.icu using your stored API key (Basic Auth, athlete `0`).
6. Worker validates and **summarizes** the result, returns structured JSON to the LLM.
7. LLM reasons over the data and responds naturally to you.

---

## 10. Deployment

```bash
# Set secrets
wrangler secret put INTERVALS_API_KEY
wrangler secret put MCP_AUTH_TOKEN

# Deploy (no KV namespace needed for the MVP)
wrangler deploy
```

After deploy, add the URL (e.g. `https://intervals-mcp.yourname.workers.dev/mcp`) to your MCP client, with the bearer token or behind Cloudflare Access.

> If you later add KV (Phase 2 caching), the modern command is `wrangler kv namespace create INTERVALS_MCP` (note: the older `wrangler kv:namespace create` colon syntax is deprecated), then add the binding to `wrangler.toml`.

---

## 11. Security, Privacy & Safe Writes

- Your Intervals.icu data only leaves the Worker when you explicitly call a tool.
- Keep the Worker URL + token private, or protect with Cloudflare Access.
- **Safe writes:** MCP doesn't enforce confirmation itself — express intent through the protocol so clients can prompt:
  - Mark writes with annotations: `readOnlyHint: false`, `destructiveHint`, and `idempotentHint: true` for upserts like `update_wellness`.
  - For irreversible actions, prefer MCP **elicitation** to ask the user to confirm (requires the stateful `McpAgent` path).
  - Keep write tools narrow and idempotent (upsert wellness by date; create-or-update calendar events).
- No long-term storage of your training data in the Worker — only your API key lives in secrets.
- **Rate limits:** Intervals.icu can throttle; the client wrapper should back off on `429`, honor `Retry-After`, and cap retries.

---

## 12. Testing & Operability (new)

- **Unit tests (Vitest)** for Zod schemas, the Intervals.icu client (mock `fetch`), and each tool handler's summarization logic.
- **Local dev** with `wrangler dev`; smoke-test the MCP endpoint with the MCP Inspector.
- **Error handling:** tool failures should return MCP error content (`isError: true`) with a useful message, never an unhandled throw.
- **Logging:** log tool name + duration + status (never the API key or raw personal data).

---

## 13. Future Extensions (Phase 2+)

- **Code Mode** support (Cloudflare's pattern where the LLM writes TypeScript against a typed SDK instead of many small tools).
- Caching of expensive curve/interval/stream data in KV or D1.
- Simple web UI for reviewing recent tool calls / audit log.
- More advanced write tools (natural-language → structured workout creation).
- MCP **elicitation**-based confirmation for destructive writes (via `McpAgent`).
- Integration with additional personal data sources (Withings, Suunto/Garmin, etc.).

---

## Open Questions / Decisions

- ~~Full `McpAgent` + Agents SDK, or lighter stateless implementation?~~ **Decided:** start stateless (`createMcpHandler()`), upgrade to `McpAgent` only if elicitation/session state is needed (§4).
- ~~How many tools in v0.1?~~ **Decided:** the 7 High-Priority tools (§6); add Medium tier in v0.2.
- ~~KV-only vs D1 early?~~ **Decided:** secrets-only for MVP; defer both to Phase 2 caching (§5, §7).
- Should we auto-generate tool schemas from the Intervals.icu OpenAPI spec? **Recommended where it reduces drift**, but hand-write the LLM-facing `description` text either way.
- Which MCP clients must be supported on day one (determines bearer-token vs Cloudflare Access vs OAuth — §5)?

---

**Ready to build.**
This spec is designed to be directly actionable. Tell me which part to implement first and I'll generate the code.
