# Intervals.icu Personal MCP Server

**Single-user bridge between Claude / Grok and the Intervals.icu API**
**Platform:** Cloudflare Workers (TypeScript)
**Version:** 0.3
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

- No multi-user or team support (OAuth is single-user — backed by Cloudflare Access with a single-email policy; not a full IdP)
- No custom identity provider — reuse Cloudflare's `workers-oauth-provider` rather than building OAuth from scratch
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
- **`@cloudflare/workers-oauth-provider`** wrapping the MCP handler so Claude's required OAuth 2.1 flow is satisfied (see §5)
- **Secrets** for the Intervals.icu key + **one KV namespace** as the OAuth token/client store

**Why MCP?**
It is the established 2025–2026 standard. Claude Desktop/claude.ai, Cursor, Windsurf, Goose, and many other agents support it natively. Add the server once and it works across many tools.

**Alternative considered:** A plain Hono app exposing an OpenAI-compatible `/v1/chat/completions` endpoint with Intervals tools. MCP is cleaner and more future-proof.

---

## 5. Authentication

Two distinct layers: how **Claude (and other MCP clients) authenticate to the Worker**, and how the **Worker authenticates to Intervals.icu**.

### 5.1 Client → Worker: OAuth 2.1 (required for Claude)

**Claude's hosted clients — claude.ai (web) and Claude Desktop "custom connectors" — do not accept a static bearer token. They require an OAuth 2.1 authorization-code flow.** To "ensure auth works at Claude", the Worker must implement OAuth, not a shared secret. Concretely, Claude expects:

- **OAuth 2.1 + PKCE** with the `S256` challenge method, exact redirect-URI matching, no implicit grant.
- **Protected Resource Metadata (PRM)** at `/.well-known/oauth-protected-resource`, and **Authorization Server Metadata** at `/.well-known/oauth-authorization-server`, so Claude can discover the endpoints.
- A `401` on unauthenticated MCP requests carrying a `WWW-Authenticate` header that points at the PRM document.
- **Client registration:** support **Dynamic Client Registration (DCR)** (Claude registers itself automatically). Claude's callback is `https://claude.ai/api/mcp/auth_callback` and its client name is `Claude`. (Client ID Metadata Documents / Anthropic-held credentials are alternatives, but DCR is the simplest to support.)
- **Token expiry + refresh** (issue short-lived access tokens + refresh tokens).

**Implementation: use Cloudflare's `@cloudflare/workers-oauth-provider`.** It implements the OAuth 2.1 server, DCR, PKCE, PRM/AS metadata discovery, and token issuance/refresh for you, and wraps the MCP handler so only authenticated requests reach your tools. The library is the authorization **server**; you only supply the login/consent step.

**Decided: Cloudflare Access (Zero Trust) is the upstream login.** Flow:

1. Claude hits the OAuth `/authorize` endpoint (served by our `defaultHandler`).
2. That route sits behind a **Cloudflare Access self-hosted application**, gated by a policy that allows only your email. Access performs the human authentication (SSO / one-time PIN) and injects a signed identity (`Cf-Access-Jwt-Assertion` + `Cf-Access-Authenticated-User-Email`).
3. The Worker **verifies the Access JWT** (against `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, checking the `aud` of the Access app) and confirms the email equals the configured owner. Single user ⇒ **no consent screen needed**; it auto-approves and calls `OAUTH_PROVIDER.completeAuthorization(...)`.
4. `workers-oauth-provider` issues the code/token back to Claude.

So Access authenticates *you*; `workers-oauth-provider` gives *Claude* the OAuth 2.1 surface it requires. No passwords to manage.

Config needed (non-secret `vars` in `wrangler.toml`): `ACCESS_TEAM_DOMAIN` (e.g. `yourteam.cloudflareaccess.com`), `ACCESS_AUD` (the Access application AUD tag), `OWNER_EMAIL` (allowed identity). For **local dev/test** where Access isn't present, the Access-identity lookup is pluggable and reads `DEV_ACCESS_EMAIL` instead of verifying a JWT (never enabled in production).

Store OAuth state (issued tokens, registered clients) in a **KV namespace** — `workers-oauth-provider` uses it as its token/client store.

### 5.2 Other clients (Claude Code CLI, Cursor, scripts)

The same OAuth flow works for any spec-compliant client. For convenience, clients that support custom headers can **also** be allowed in via a static `MCP_AUTH_TOKEN` checked in middleware — notably **Claude Code CLI**:

```bash
claude mcp add --transport http intervals https://intervals-mcp.<you>.workers.dev/mcp \
  --header "Authorization: Bearer $MCP_AUTH_TOKEN"
```

Keep both paths only if you want the CLI shortcut; OAuth alone is sufficient and is the path Claude's connectors use.

### 5.3 Worker → Intervals.icu

- Store **your** Intervals.icu API key as a Worker secret (`INTERVALS_API_KEY`). Generate it under **Settings → Developer Settings**.
- The Worker authenticates to Intervals.icu using **HTTP Basic Auth** with username `API_KEY` and password = your key:
  `Authorization: Basic base64("API_KEY:<your-key>")`.
- **Athlete ID:** use `0` in the path (e.g. `/api/v1/athlete/0/...`) — Intervals.icu auto-resolves `0` to the athlete that owns the API key. No need to store your real `iNNNNNN` id.

### Secrets & bindings summary

| Name | Type | Purpose |
|---|---|---|
| `INTERVALS_API_KEY` | secret | Basic Auth to Intervals.icu |
| `OAUTH_KV` | KV namespace | `workers-oauth-provider` token/client store |
| `ACCESS_TEAM_DOMAIN` | var | Cloudflare Access team domain for JWT verification |
| `ACCESS_AUD` | var | Cloudflare Access application AUD tag |
| `OWNER_EMAIL` | var | the single allowed identity |
| `MCP_AUTH_TOKEN` | secret | optional static token for header-capable clients (e.g. Claude Code CLI) |
| `DEV_ACCESS_EMAIL` | var (dev/test only) | simulates the Access identity locally |

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
- **Auth**: `@cloudflare/workers-oauth-provider` (OAuth 2.1 server: DCR, PKCE, PRM/AS metadata, token refresh) — required for Claude connectors (§5)
- **Config & storage**: `wrangler.toml` + secrets + one KV namespace for OAuth state (D1 / caching KV deferred to Phase 2)
- **Observability**: Cloudflare Workers Logs / Logpush (+ optional Sentry)
- **Types**: derived from the Intervals.icu OpenAPI spec where practical

**Example key dependencies** (pin to versions that are mutually compatible at install time — verify the MCP SDK's required Zod major before choosing Zod 3 vs 4):
```json
{
  "@modelcontextprotocol/sdk": "^1.x",
  "@cloudflare/workers-oauth-provider": "^0.x",
  "agents": "^0.x",
  "hono": "^4.x",
  "zod": "^3.x"
}
```
Dev/test: `vitest`, `@cloudflare/vitest-pool-workers`, `msw` (or `undici` `MockAgent`), `wrangler`.

---

## 8. Proposed Project Structure

```
intervals-icu-mcp/
├── src/
│   ├── index.ts                 # Entry: workers-oauth-provider wrapping the Hono app + MCP handler
│   ├── auth.ts                  # /authorize handler: verify Cloudflare Access JWT, auto-approve owner
│   ├── mcp-server.ts            # Tool registration & descriptions
│   ├── tools/
│   │   ├── wellness.ts
│   │   ├── activities.ts
│   │   ├── curves.ts
│   │   ├── calendar.ts
│   │   └── workouts.ts
│   ├── lib/
│   │   ├── intervals-client.ts  # Typed Intervals.icu fetch wrapper (auth, retry, rate limit)
│   │   ├── summarize.ts         # Stream/curve downsampling + list truncation (context budget)
│   │   └── schemas.ts           # Zod schemas + LLM-friendly descriptions
│   └── config.ts
├── test/
│   ├── unit/                    # Layer 1: schemas, client, summarize, tool handlers, auth helpers
│   ├── integration/            # Layer 2: Worker in workerd — OAuth flow, auth enforcement, MCP protocol
│   ├── e2e/                     # Layer 3: real MCP Client → local Worker (full OAuth → tools/call)
│   └── fixtures/               # Intervals.icu responses derived from the OpenAPI spec
├── vitest.config.ts             # @cloudflare/vitest-pool-workers config
├── wrangler.toml
├── package.json
└── README.md
```

---

## 9. Data Flow Example

1. You add the MCP server URL in Claude → Claude discovers `/.well-known/oauth-protected-resource`, runs the OAuth 2.1 + PKCE flow (DCR + your Cloudflare Access / password login), and stores an access + refresh token.
2. LLM decides it needs data → calls a tool (e.g. `list_activities`) with the OAuth access token.
3. Worker receives an MCP `tools/call` request over Streamable HTTP.
4. `workers-oauth-provider` validates the access token (401 + `WWW-Authenticate` → PRM if missing/expired); the request reaches the tool handler.
5. Worker calls Intervals.icu using your stored API key (Basic Auth, athlete `0`).
6. Worker validates and **summarizes** the result, returns structured JSON to the LLM.
7. LLM reasons over the data and responds naturally to you.

---

## 10. Deployment

```bash
# Intervals.icu key
wrangler secret put INTERVALS_API_KEY

# OAuth state store (modern syntax — the old `kv:namespace` colon form is deprecated)
wrangler kv namespace create OAUTH_KV
# → copy the printed id into the OAUTH_KV binding in wrangler.toml

# Optional: static token for header-capable clients (e.g. Claude Code CLI)
wrangler secret put MCP_AUTH_TOKEN            # optional

# Set non-secret vars in wrangler.toml: ACCESS_TEAM_DOMAIN, ACCESS_AUD, OWNER_EMAIL
wrangler deploy
```

**Cloudflare Access setup (one time, in the Zero Trust dashboard):**
1. Create a **self-hosted Access application** covering the authorize route (e.g. `intervals-mcp.<you>.workers.dev/authorize`).
2. Add a policy: **Allow**, selector **Emails** = your email.
3. Copy the application **AUD** tag → set `ACCESS_AUD`; set `ACCESS_TEAM_DOMAIN` to `<you>.cloudflareaccess.com`.

After deploy, add the URL (e.g. `https://intervals-mcp.yourname.workers.dev/mcp`) as a **custom connector** in claude.ai / Claude Desktop; Claude runs the OAuth flow, Access prompts you to log in, and you're connected.

---

## 11. Security, Privacy & Safe Writes

- Your Intervals.icu data only leaves the Worker when you explicitly call a tool.
- Access to the MCP endpoint is gated by the OAuth 2.1 flow (§5); the upstream login (Cloudflare Access / single password) is what actually authenticates *you*. OAuth tokens are short-lived and refreshable, and live in KV — revoke by clearing the store.
- **Safe writes:** MCP doesn't enforce confirmation itself — express intent through the protocol so clients can prompt:
  - Mark writes with annotations: `readOnlyHint: false`, `destructiveHint`, and `idempotentHint: true` for upserts like `update_wellness`.
  - For irreversible actions, prefer MCP **elicitation** to ask the user to confirm (requires the stateful `McpAgent` path).
  - Keep write tools narrow and idempotent (upsert wellness by date; create-or-update calendar events).
- No long-term storage of your training data in the Worker — only your API key lives in secrets.
- **Rate limits:** Intervals.icu can throttle; the client wrapper should back off on `429`, honor `Retry-After`, and cap retries.

---

## 12. Testing Strategy (Testing Pyramid — 100% Local)

Extensive automated testing arranged as a pyramid: a broad base of fast unit tests, a smaller band of integration tests against the real Worker runtime, and a thin top of end-to-end contract tests driven by a real MCP client. **Every layer runs fully locally** — no calls to claude.ai, no calls to the real Intervals.icu API, no deployed Worker. All outbound HTTP to Intervals.icu is intercepted; the OAuth flow is exercised against the locally-running Worker.

### Tooling

- **Vitest** as the runner for all layers.
- **`@cloudflare/vitest-pool-workers`** runs tests **inside `workerd`** (the same runtime Cloudflare deploys), via Miniflare — so KV bindings, secrets, and the OAuth provider behave as in production, locally and offline.
- **MSW** (or `undici` `MockAgent`) intercepts the Worker's outbound `fetch` to `intervals.icu`. Responses are **fixtures derived from the Intervals.icu OpenAPI spec** so shapes stay realistic.
- **`@modelcontextprotocol/sdk` `Client`** drives the top of the pyramid over a real transport.
- Deterministic clock/`Date` and seeded fixtures; no network, no wall-clock flakiness.

### Layer 1 — Unit tests (the broad base, the majority of tests)

Pure functions, no Worker runtime, milliseconds each:

- **Schemas:** every Zod input/output schema — valid cases, boundary cases, and rejected bad input (e.g. malformed dates, negative limits, out-of-range power).
- **Intervals.icu client:** URL/auth construction (Basic Auth header, athlete `0` path), query-param building, and the **retry/backoff** logic — `429`/`5xx` retried, `Retry-After` honored, retries capped, `4xx` not retried — using a stubbed `fetch`.
- **Summarization / downsampling:** the context-budget logic (§6) — streams downsampled to the target point count, curves reduced to the selected duration set, activity lists truncated to `limit`. Assert output size bounds.
- **Tool handlers:** each handler with a **mocked client**, asserting it maps inputs → the right client call and shapes the summarized result. Include error mapping (client throw → MCP `isError` content).
- **Auth helpers:** token/PKCE/PRM helper logic and the optional static-token middleware check.

### Layer 2 — Integration tests (middle band, against the real runtime)

Run the assembled Worker in `workers-pool` (workerd + Miniflare), with Intervals.icu mocked via MSW and a **real KV** binding for OAuth state. Exercise the HTTP surface directly:

- **OAuth discovery & flow:** `GET /.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server` return correct metadata; **DCR** registers a client; the **authorization-code + PKCE (S256)** flow issues an access token; the **refresh** grant works; tokens persist in KV.
- **Auth enforcement:** an MCP request with no/expired/invalid token gets `401` with a `WWW-Authenticate` header pointing at the PRM doc; a valid token passes.
- **MCP protocol:** `initialize`, `tools/list` (all tools present with descriptions + annotations), and `tools/call` for representative read and write tools over the Streamable HTTP transport — asserting the outbound Intervals.icu request (method, path, Basic Auth, athlete `0`) and the summarized response.
- **Write safety:** `update_wellness` is idempotent (same date upserts), and tool annotations (`readOnlyHint`/`destructiveHint`/`idempotentHint`) are present.
- **Error propagation:** simulated Intervals.icu `429`/`500` surfaces as a clean MCP error, not a crash.

### Layer 3 — End-to-end contract tests (thin top)

A handful of tests that connect a **real MCP `Client`** (from `@modelcontextprotocol/sdk`) to the locally-running Worker and complete the full **OAuth handshake → `tools/list` → `tools/call`** journey, with Intervals.icu still mocked. This proves the server is genuinely usable by a spec-compliant client (the same contract Claude uses) without ever leaving the machine. Optionally scripted against `wrangler dev` for a manual smoke run, and the **MCP Inspector** is documented for ad-hoc local debugging.

### Coverage, CI & gates

- Coverage thresholds enforced (e.g. lines/branches ≥ 90% on `src/`), checked by Vitest.
- A single `npm test` runs all three layers locally and in CI; a `test:watch` script for development.
- **CI runs the identical local suite** (GitHub Actions: `npm ci && npm test`) — no secrets, no deploy, no external network required, so the pipeline is hermetic and reproducible.

### Operability (kept from before)

- **Error handling:** tool failures return MCP error content (`isError: true`) with a useful message, never an unhandled throw.
- **Logging:** log tool name + duration + status (never the API key, tokens, or raw personal data).
- **Local dev:** `wrangler dev` + MCP Inspector for manual exploration.

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
- ~~KV-only vs D1 early?~~ **Decided:** one KV namespace from the start (required as the OAuth token/client store, §5); D1 and any caching KV deferred to Phase 2.
- Should we auto-generate tool schemas from the Intervals.icu OpenAPI spec? **Recommended where it reduces drift**, but hand-write the LLM-facing `description` text either way.
- ~~Which auth for Claude?~~ **Decided:** OAuth 2.1 via `@cloudflare/workers-oauth-provider`, with **Cloudflare Access** as the upstream login (single-email policy; the `/authorize` route verifies the Access JWT). Static bearer token kept only as an optional convenience for header-capable clients like Claude Code CLI (§5).

---

**Ready to build.**
This spec is designed to be directly actionable. Tell me which part to implement first and I'll generate the code.
