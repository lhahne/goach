import { createRemoteJWKSet, jwtVerify } from "jose";
import { OAUTH_SCOPES, type Env } from "./config.js";

/** A function that validates a Cloudflare Access JWT and returns the email claim. */
export type AccessVerifier = (token: string) => Promise<string>;

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function defaultVerifier(env: Env): AccessVerifier {
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  const certsUrl = `${issuer}/cdn-cgi/access/certs`;
  let jwks = jwksCache.get(certsUrl);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(certsUrl));
    jwksCache.set(certsUrl, jwks);
  }
  return async (token) => {
    const { payload } = await jwtVerify(token, jwks!, {
      issuer,
      audience: env.ACCESS_AUD,
    });
    const email = payload.email;
    if (typeof email !== "string" || email.length === 0) {
      throw new Error("Access token has no email claim");
    }
    return email;
  };
}

/**
 * Resolve the authenticated identity for an /authorize request.
 *
 * - In dev/test, `DEV_ACCESS_EMAIL` short-circuits verification (must never be
 *   set in production).
 * - In production, the Cloudflare Access JWT in the `Cf-Access-Jwt-Assertion`
 *   header is verified against the team's JWKS and the application AUD.
 *
 * Returns the email, or null if there is no valid identity.
 */
export async function getAccessIdentity(
  request: Request,
  env: Env,
  verify?: AccessVerifier,
): Promise<string | null> {
  if (env.DEV_ACCESS_EMAIL) return env.DEV_ACCESS_EMAIL;
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return null;
  const verifier = verify ?? defaultVerifier(env);
  try {
    return await verifier(token);
  } catch {
    return null;
  }
}

function isOwner(email: string | null, env: Env): boolean {
  return (
    email !== null && email.toLowerCase() === env.OWNER_EMAIL.toLowerCase()
  );
}

/**
 * Handle GET /authorize: confirm the Cloudflare Access identity is the owner,
 * then auto-approve the OAuth grant (single user ⇒ no consent screen).
 */
export async function handleAuthorize(
  request: Request,
  env: Env,
  verify?: AccessVerifier,
): Promise<Response> {
  const email = await getAccessIdentity(request, env, verify);
  if (!isOwner(email, env)) {
    return new Response("Forbidden: this server is restricted to its owner.", {
      status: 403,
    });
  }

  const authReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);

  // Only ever grant scopes this server supports. If the client requested
  // scopes, grant the intersection; reject if none are allowed. With no
  // requested scopes, grant the full supported set.
  const supported = new Set<string>(OAUTH_SCOPES);
  let scope: string[];
  if (authReq.scope.length > 0) {
    scope = authReq.scope.filter((s) => supported.has(s));
    if (scope.length === 0) {
      return new Response("invalid_scope: no supported scopes requested.", {
        status: 400,
      });
    }
  } else {
    scope = [...OAUTH_SCOPES];
  }

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: authReq,
    userId: email!,
    scope,
    metadata: { via: "cloudflare-access" },
    props: { email: email! },
  });
  return Response.redirect(redirectTo, 302);
}
