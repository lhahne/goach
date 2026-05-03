import { beforeAll, describe, expect, it } from "vitest";
import { exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import {
  AccessAuthError,
  readAccessConfig,
  verifyAccessJwt,
  type AccessConfig
} from "../../src/auth";

const TEAM_DOMAIN = "goach-test.cloudflareaccess.com";
const AUD = "test-aud-tag";
const ISSUER = `https://${TEAM_DOMAIN}`;

let privateKey: CryptoKey;
let getKey: JWTVerifyGetKey;

beforeAll(async () => {
  const kp = await generateKeyPair("RS256", { extractable: true });
  privateKey = kp.privateKey;
  // Materialize the public key as a JWK so we can hand it back as a
  // resolver — same shape Access's JWKS endpoint would return.
  const jwk = await exportJWK(kp.publicKey);
  jwk.alg = "RS256";
  jwk.kid = "test-key";
  getKey = async () => kp.publicKey;
  // touch jwk so the variable isn't dropped (keeps the JWK shape doc'd)
  expect(jwk.kty).toBe("RSA");
});

async function signToken(
  overrides: {
    aud?: string | string[];
    iss?: string;
    email?: string;
    expiresIn?: string;
    notBefore?: number;
  } = {}
): Promise<string> {
  return await new SignJWT({ email: overrides.email ?? "user@example.com" })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(overrides.iss ?? ISSUER)
    .setAudience(overrides.aud ?? AUD)
    .setIssuedAt()
    .setExpirationTime(overrides.expiresIn ?? "5m")
    .sign(privateKey);
}

const config = (): AccessConfig => ({ teamDomain: TEAM_DOMAIN, aud: AUD, getKey });

describe("readAccessConfig", () => {
  it("returns config when both vars are set", () => {
    expect(
      readAccessConfig({ ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUD: AUD })
    ).toEqual({ teamDomain: TEAM_DOMAIN, aud: AUD });
  });

  it("returns null when ACCESS_TEAM_DOMAIN is missing", () => {
    expect(readAccessConfig({ ACCESS_AUD: AUD })).toBeNull();
  });

  it("returns null when ACCESS_AUD is missing", () => {
    expect(readAccessConfig({ ACCESS_TEAM_DOMAIN: TEAM_DOMAIN })).toBeNull();
  });

  it("returns null when either var is empty/whitespace", () => {
    expect(
      readAccessConfig({ ACCESS_TEAM_DOMAIN: "  ", ACCESS_AUD: AUD })
    ).toBeNull();
    expect(
      readAccessConfig({ ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUD: "" })
    ).toBeNull();
  });

  it("trims whitespace around values", () => {
    expect(
      readAccessConfig({
        ACCESS_TEAM_DOMAIN: ` ${TEAM_DOMAIN} `,
        ACCESS_AUD: ` ${AUD} `
      })
    ).toEqual({ teamDomain: TEAM_DOMAIN, aud: AUD });
  });
});

describe("verifyAccessJwt: token extraction", () => {
  it("rejects requests with no JWT in header or cookie", async () => {
    const req = new Request("https://goach.test/");
    await expect(verifyAccessJwt(req, config())).rejects.toBeInstanceOf(
      AccessAuthError
    );
  });

  it("accepts the token from the Cf-Access-Jwt-Assertion header", async () => {
    const token = await signToken();
    const req = new Request("https://goach.test/", {
      headers: { "Cf-Access-Jwt-Assertion": token }
    });
    const claims = await verifyAccessJwt(req, config());
    expect(claims.email).toBe("user@example.com");
  });

  it("accepts the token from the CF_Authorization cookie", async () => {
    const token = await signToken();
    const req = new Request("https://goach.test/", {
      headers: { Cookie: `CF_Authorization=${token}; other=ignored` }
    });
    const claims = await verifyAccessJwt(req, config());
    expect(claims.email).toBe("user@example.com");
  });

  it("ignores other cookies when finding CF_Authorization", async () => {
    const token = await signToken();
    const req = new Request("https://goach.test/", {
      headers: {
        Cookie: `theme=light; CF_Authorization=${token}; session=abc`
      }
    });
    const claims = await verifyAccessJwt(req, config());
    expect(claims.email).toBe("user@example.com");
  });

  it("prefers the header over the cookie when both are present", async () => {
    const headerToken = await signToken({ email: "header@example.com" });
    const cookieToken = await signToken({ email: "cookie@example.com" });
    const req = new Request("https://goach.test/", {
      headers: {
        "Cf-Access-Jwt-Assertion": headerToken,
        Cookie: `CF_Authorization=${cookieToken}`
      }
    });
    const claims = await verifyAccessJwt(req, config());
    expect(claims.email).toBe("header@example.com");
  });

  it("returns nothing useful when cookie header has no = sign", async () => {
    const req = new Request("https://goach.test/", {
      headers: { Cookie: "malformed-cookie-no-equals" }
    });
    await expect(verifyAccessJwt(req, config())).rejects.toBeInstanceOf(
      AccessAuthError
    );
  });
});

describe("verifyAccessJwt: claim validation", () => {
  it("verifies a well-formed token and returns claims", async () => {
    const token = await signToken({ email: "alice@example.com" });
    const req = new Request("https://goach.test/", {
      headers: { "Cf-Access-Jwt-Assertion": token }
    });
    const claims = await verifyAccessJwt(req, config());
    expect(claims.email).toBe("alice@example.com");
    expect(claims.iss).toBe(ISSUER);
    expect(claims.aud).toBe(AUD);
    expect(typeof claims.exp).toBe("number");
  });

  it("rejects tokens with the wrong audience", async () => {
    const token = await signToken({ aud: "some-other-app" });
    const req = new Request("https://goach.test/", {
      headers: { "Cf-Access-Jwt-Assertion": token }
    });
    await expect(verifyAccessJwt(req, config())).rejects.toBeInstanceOf(
      AccessAuthError
    );
  });

  it("rejects tokens with the wrong issuer", async () => {
    const token = await signToken({ iss: "https://attacker.example.com" });
    const req = new Request("https://goach.test/", {
      headers: { "Cf-Access-Jwt-Assertion": token }
    });
    await expect(verifyAccessJwt(req, config())).rejects.toBeInstanceOf(
      AccessAuthError
    );
  });

  it("rejects expired tokens", async () => {
    const token = await new SignJWT({ email: "u@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(ISSUER)
      .setAudience(AUD)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(privateKey);
    const req = new Request("https://goach.test/", {
      headers: { "Cf-Access-Jwt-Assertion": token }
    });
    await expect(verifyAccessJwt(req, config())).rejects.toBeInstanceOf(
      AccessAuthError
    );
  });

  it("rejects garbage tokens", async () => {
    const req = new Request("https://goach.test/", {
      headers: { "Cf-Access-Jwt-Assertion": "not-a-jwt" }
    });
    await expect(verifyAccessJwt(req, config())).rejects.toBeInstanceOf(
      AccessAuthError
    );
  });
});
