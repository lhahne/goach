import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index.js";
import type { Env } from "../../src/config.js";
import { makeCtx, makeEnv, pkce } from "../helpers.js";

const ORIGIN = "https://mcp.example.com";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

function call(path: string, env: Env, init?: RequestInit): Promise<Response> {
  return (worker as { fetch: (r: Request, e: Env, c: ExecutionContext) => Promise<Response> })
    .fetch(new Request(`${ORIGIN}${path}`, init), env, makeCtx());
}

async function rpc(
  env: Env,
  token: string,
  body: unknown,
): Promise<{ status: number; json: any }> {
  const res = await call("/mcp", env, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

describe("OAuth + MCP end-to-end (local)", () => {
  let env: Env;

  beforeEach(() => {
    env = makeEnv({ DEV_ACCESS_EMAIL: "owner@example.com" });
    // Mock Intervals.icu so tool calls never hit the network.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("intervals.icu")) {
          return new Response(JSON.stringify([{ id: "2026-06-14", weight: 91.5 }]), {
            headers: { "Content-Type": "application/json" },
          });
        }
        throw new Error(`unexpected fetch to ${url}`);
      }),
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it("serves authorization-server metadata", async () => {
    const res = await call("/.well-known/oauth-authorization-server", env);
    expect(res.status).toBe(200);
    const meta = (await res.json()) as any;
    expect(meta.token_endpoint).toContain("/token");
    expect(meta.registration_endpoint).toContain("/register");
  });

  it("rejects an unauthenticated MCP request with 401", async () => {
    const res = await call("/mcp", env, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBeTruthy();
  });

  it("completes the full OAuth flow and calls a tool", async () => {
    // 1. Dynamic client registration.
    const reg = await call("/register", env, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Claude",
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    });
    expect(reg.status).toBeLessThan(300);
    const { client_id } = (await reg.json()) as any;
    expect(client_id).toBeTruthy();

    // 2. Authorize (Cloudflare Access identity provided via DEV_ACCESS_EMAIL).
    const { verifier, challenge } = await pkce();
    const authUrl =
      `/authorize?response_type=code&client_id=${client_id}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT)}&state=xyz` +
      `&code_challenge=${challenge}&code_challenge_method=S256` +
      `&scope=${encodeURIComponent("intervals:read intervals:write")}`;
    const authRes = await call(authUrl, env);
    expect(authRes.status).toBe(302);
    const location = authRes.headers.get("Location")!;
    const code = new URL(location).searchParams.get("code")!;
    expect(code).toBeTruthy();

    // 3. Exchange the code for an access token (PKCE, public client).
    const tokenRes = await call("/token", env, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        client_id,
        code_verifier: verifier,
      }).toString(),
    });
    expect(tokenRes.status).toBe(200);
    const { access_token, refresh_token } = (await tokenRes.json()) as any;
    expect(access_token).toBeTruthy();
    expect(refresh_token).toBeTruthy();

    // 4. initialize over the protected, stateless MCP endpoint.
    const init = await rpc(env, access_token, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    });
    expect(init.status).toBe(200);
    expect(init.json.result.serverInfo.name).toBe("intervals-icu-mcp");

    // 5. tools/list.
    const list = await rpc(env, access_token, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    const toolNames = list.json.result.tools.map((t: { name: string }) => t.name);
    expect(toolNames).toContain("get_wellness");

    // 6. tools/call against the mocked Intervals.icu.
    const callRes = await rpc(env, access_token, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "get_wellness",
        arguments: { oldest: "2026-06-01", newest: "2026-06-14" },
      },
    });
    expect(callRes.json.result.isError).toBeFalsy();
    const payload = JSON.parse(callRes.json.result.content[0].text);
    expect(payload[0]).toMatchObject({ weight: 91.5 });
  });

  it("refuses a non-owner identity at /authorize", async () => {
    const env2 = makeEnv({ DEV_ACCESS_EMAIL: "stranger@example.com" });
    const res = await call(
      `/authorize?response_type=code&client_id=x&redirect_uri=${encodeURIComponent(REDIRECT)}&state=s`,
      env2,
    );
    expect(res.status).toBe(403);
  });
});
