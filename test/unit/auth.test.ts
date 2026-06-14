import { describe, expect, it, vi } from "vitest";
import { getAccessIdentity, handleAuthorize } from "../../src/auth.js";
import { makeEnv } from "../helpers.js";

function authorizeRequest(): Request {
  const url =
    "https://mcp.example.com/authorize?response_type=code&client_id=c1" +
    "&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback" +
    "&state=xyz&code_challenge=abc&code_challenge_method=S256";
  return new Request(url, { headers: { "Cf-Access-Jwt-Assertion": "tok" } });
}

describe("getAccessIdentity", () => {
  it("short-circuits to DEV_ACCESS_EMAIL when set", async () => {
    const env = makeEnv({ DEV_ACCESS_EMAIL: "dev@example.com" });
    const email = await getAccessIdentity(new Request("https://x/authorize"), env);
    expect(email).toBe("dev@example.com");
  });

  it("returns null when the Access header is missing", async () => {
    const env = makeEnv();
    const email = await getAccessIdentity(new Request("https://x/authorize"), env);
    expect(email).toBeNull();
  });

  it("verifies the Access JWT via the injected verifier", async () => {
    const env = makeEnv();
    const verify = vi.fn(async () => "owner@example.com");
    const email = await getAccessIdentity(authorizeRequest(), env, verify);
    expect(email).toBe("owner@example.com");
    expect(verify).toHaveBeenCalledWith("tok");
  });

  it("returns null when verification throws", async () => {
    const env = makeEnv();
    const verify = vi.fn(async () => {
      throw new Error("bad signature");
    });
    expect(await getAccessIdentity(authorizeRequest(), env, verify)).toBeNull();
  });
});

describe("handleAuthorize", () => {
  it("rejects a non-owner identity with 403", async () => {
    const env = makeEnv();
    const verify = vi.fn(async () => "stranger@example.com");
    const res = await handleAuthorize(authorizeRequest(), env, verify);
    expect(res.status).toBe(403);
  });

  it("auto-approves the owner and redirects with the grant", async () => {
    const completeAuthorization = vi.fn(async () => ({
      redirectTo: "https://claude.ai/api/mcp/auth_callback?code=abc&state=xyz",
    }));
    const parseAuthRequest = vi.fn(async () => ({
      responseType: "code",
      clientId: "c1",
      redirectUri: "https://claude.ai/api/mcp/auth_callback",
      scope: [],
      state: "xyz",
    }));
    const env = makeEnv({
      OAUTH_PROVIDER: { parseAuthRequest, completeAuthorization } as never,
    });
    const verify = vi.fn(async () => "owner@example.com");
    const res = await handleAuthorize(authorizeRequest(), env, verify);

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("code=abc");
    expect(completeAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "owner@example.com",
        props: { email: "owner@example.com" },
        scope: ["intervals:read", "intervals:write"],
      }),
    );
  });
});
