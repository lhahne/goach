import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

/**
 * Worker bindings. Secrets and vars are configured via wrangler.toml / secrets.
 * See spec §5 "Secrets & bindings summary".
 */
export interface Env {
  // --- Intervals.icu ---
  /** Intervals.icu API key (Basic Auth password, username is the literal "API_KEY"). */
  INTERVALS_API_KEY: string;

  // --- Cloudflare Access (client login in front of /authorize) ---
  /** e.g. "yourteam.cloudflareaccess.com" */
  ACCESS_TEAM_DOMAIN: string;
  /** Access application AUD tag. */
  ACCESS_AUD: string;
  /** The single identity allowed to use this server. */
  OWNER_EMAIL: string;

  /** Dev/test ONLY: bypass Access JWT verification with a fixed identity. */
  DEV_ACCESS_EMAIL?: string;

  // --- OAuth provider storage + helpers ---
  OAUTH_KV: KVNamespace;
  /** Injected by @cloudflare/workers-oauth-provider into handler env. */
  OAUTH_PROVIDER: OAuthHelpers;
}

/** Props carried through the OAuth grant into the MCP API handler (ctx.props). */
export interface AuthProps {
  email: string;
}

/** Base URL for the Intervals.icu API. */
export const INTERVALS_BASE_URL = "https://intervals.icu";

/** Intervals.icu resolves athlete id 0 to the owner of the API key. */
export const SELF_ATHLETE_ID = "0";

export const OAUTH_SCOPES = ["intervals:read", "intervals:write"] as const;
