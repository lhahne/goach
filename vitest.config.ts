import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// The whole suite runs locally in Node. We alias the `cloudflare:workers`
// runtime module to a small stub so the OAuth provider (the only dependency
// that imports it) can run under Node. Outbound HTTP is injected/mocked and
// KV is an in-memory fake, so no network or deployed Worker is ever needed.
export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(
        new URL("./test/stubs/cloudflare-workers.ts", import.meta.url),
      ),
      // Use jose's browser/workerd build (fetch-based JWKS) so tests exercise the
      // exact code path that runs on Cloudflare Workers, not the node:http one.
      jose: fileURLToPath(
        new URL("./node_modules/jose/dist/browser/index.js", import.meta.url),
      ),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Inline the OAuth provider so Vite transforms it and applies the
    // `cloudflare:workers` alias above (externalized deps bypass the resolver).
    server: {
      deps: { inline: ["@cloudflare/workers-oauth-provider"] },
    },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 85,
        statements: 90,
      },
    },
  },
});
