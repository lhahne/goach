import type { Env } from "../src/config.js";

/** Minimal in-memory KVNamespace sufficient for @cloudflare/workers-oauth-provider. */
export class MemoryKV {
  private store = new Map<string, string>();

  async get(key: string, opts?: { type?: "json" | "text" }): Promise<unknown> {
    const raw = this.store.get(key);
    if (raw === undefined) return null;
    if (opts?.type === "json") return JSON.parse(raw);
    return raw;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(opts?: {
    prefix?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }> {
    const prefix = opts?.prefix ?? "";
    const keys = [...this.store.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((name) => ({ name }));
    return { keys, list_complete: true };
  }
}

export function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    INTERVALS_API_KEY: "test-key",
    ACCESS_TEAM_DOMAIN: "test.cloudflareaccess.com",
    ACCESS_AUD: "test-aud",
    OWNER_EMAIL: "owner@example.com",
    DEV_ACCESS_EMAIL: undefined,
    OAUTH_KV: new MemoryKV() as unknown as KVNamespace,
    OAUTH_PROVIDER: undefined as unknown as Env["OAUTH_PROVIDER"],
    ...overrides,
  };
}

/** A no-op ExecutionContext for invoking the Worker in tests. */
export function makeCtx(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
}

function base64url(bytes: ArrayBuffer): string {
  return Buffer.from(new Uint8Array(bytes))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Generate an RFC-7636 PKCE pair (S256). */
export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)).buffer);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return { verifier, challenge: base64url(digest) };
}
