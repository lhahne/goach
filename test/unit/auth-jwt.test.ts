import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAccessIdentity } from "../../src/auth.js";
import { makeEnv } from "../helpers.js";

const AUD = "test-aud";
const KID = "test-key-1";

let privateKey: CryptoKey;
// Unique per test so the module-level JWKS cache never collides between cases.
let team: string;

async function makeToken(claims: {
  email?: string;
  audience?: string;
}): Promise<string> {
  return new SignJWT({ email: claims.email ?? "owner@example.com" })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuedAt()
    .setIssuer(`https://${team}`)
    .setAudience(claims.audience ?? AUD)
    .setExpirationTime("2h")
    .sign(privateKey);
}

describe("production Cloudflare Access JWT verification", () => {
  beforeEach(async () => {
    team = `${crypto.randomUUID()}.cloudflareaccess.com`;
    const { publicKey, privateKey: pk } = await generateKeyPair("RS256", {
      extractable: true,
    });
    privateKey = pk as CryptoKey;
    const jwk = await exportJWK(publicKey);
    jwk.kid = KID;
    jwk.alg = "RS256";
    jwk.use = "sig";

    // Serve the team's JWKS over the (stubbed) network.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("/cdn-cgi/access/certs")) {
          return Response.json({ keys: [jwk] });
        }
        throw new Error(`unexpected fetch: ${String(input)}`);
      }),
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  function request(token: string): Request {
    return new Request("https://mcp.example.com/authorize", {
      headers: { "Cf-Access-Jwt-Assertion": token },
    });
  }

  it("accepts a valid token and returns the email claim", async () => {
    const env = makeEnv({ ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: AUD });
    const token = await makeToken({ email: "owner@example.com" });
    expect(await getAccessIdentity(request(token), env)).toBe("owner@example.com");
  });

  it("rejects a token with the wrong audience", async () => {
    const env = makeEnv({ ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: AUD });
    const token = await makeToken({ audience: "some-other-app" });
    expect(await getAccessIdentity(request(token), env)).toBeNull();
  });
});
