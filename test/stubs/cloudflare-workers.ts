// Minimal stub for the `cloudflare:workers` runtime module so that
// @cloudflare/workers-oauth-provider can be imported and exercised in a plain
// Node/Vitest environment. The provider only uses WorkerEntrypoint as a base
// class for detecting handler shape; our handlers are plain object handlers, so
// a no-op class is sufficient. All other behaviour relies on Web Standard APIs
// (crypto.subtle, Request/Response, URL) which Node 18+ provides natively.
export class WorkerEntrypoint {
  ctx: unknown;
  env: unknown;
  constructor(ctx: unknown, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}
