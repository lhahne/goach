import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey
} from "jose";

export interface AccessConfig {
  /** e.g. "myteam.cloudflareaccess.com" */
  teamDomain: string;
  /** Application AUD tag from the Cloudflare Access dashboard. */
  aud: string;
  /** Test seam: override the JWKS resolver with a fixed key. */
  getKey?: JWTVerifyGetKey;
}

export interface AccessClaims extends JWTPayload {
  email?: string;
  identity_nonce?: string;
}

export class AccessAuthError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown
  ) {
    super(message);
  }
}

export class AccessConfigError extends Error {}

/**
 * Read Access config from the worker env.
 *
 * Three states:
 *  - both vars empty/unset → returns null (intentional "no auth", e.g.
 *    `npm run dev` with no Access app configured)
 *  - both vars set → returns the config; auth is enforced
 *  - exactly one var set → throws AccessConfigError so the worker fails
 *    closed instead of silently skipping auth (avoids the footgun of
 *    deploying with one secret missing and getting an unauthenticated
 *    public worker)
 */
export function readAccessConfig(env: {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
}): AccessConfig | null {
  const teamDomain = env.ACCESS_TEAM_DOMAIN?.trim() ?? "";
  const aud = env.ACCESS_AUD?.trim() ?? "";
  if (!teamDomain && !aud) return null;
  if (!teamDomain || !aud) {
    throw new AccessConfigError(
      "Cloudflare Access is partially configured: set both ACCESS_TEAM_DOMAIN and ACCESS_AUD, or unset both."
    );
  }
  return { teamDomain, aud };
}

const jwksCache = new Map<string, JWTVerifyGetKey>();

function defaultGetKey(teamDomain: string): JWTVerifyGetKey {
  let getKey = jwksCache.get(teamDomain);
  if (!getKey) {
    getKey = createRemoteJWKSet(
      new URL(`https://${teamDomain}/cdn-cgi/access/certs`)
    );
    jwksCache.set(teamDomain, getKey);
  }
  return getKey;
}

/**
 * Verify a Cloudflare Access JWT on the request.
 *
 * Access injects the JWT into the `Cf-Access-Jwt-Assertion` header at the
 * edge for every request that passes through it. We also accept the
 * `CF_Authorization` cookie as a fallback (browser navigations carry it
 * the same way Access does).
 *
 * Throws AccessAuthError on missing/invalid/expired tokens.
 */
export async function verifyAccessJwt(
  request: Request,
  config: AccessConfig
): Promise<AccessClaims> {
  const token = extractToken(request);
  if (!token) throw new AccessAuthError("Missing Cloudflare Access JWT");

  const getKey = config.getKey ?? defaultGetKey(config.teamDomain);
  try {
    const { payload } = await jwtVerify(token, getKey, {
      audience: config.aud,
      issuer: `https://${config.teamDomain}`
    });
    return payload as AccessClaims;
  } catch (err) {
    throw new AccessAuthError("Invalid Cloudflare Access JWT", err);
  }
}

function extractToken(request: Request): string | undefined {
  const header = request.headers.get("cf-access-jwt-assertion");
  if (header) return header;
  const cookie = request.headers.get("cookie");
  if (!cookie) return undefined;
  for (const part of cookie.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    if (name === "CF_Authorization") return part.slice(idx + 1).trim();
  }
  return undefined;
}
