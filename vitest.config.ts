import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import agents from "agents/vite";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/unit/**/*.test.ts"],
          environment: "node"
        }
      },
      {
        plugins: [
          // The agents SDK ships a vite plugin that transforms the
          // `@callable()` decorators used in src/server.ts. Without it
          // workerd's parser sees raw decorator syntax and fails.
          agents(),
          cloudflareTest({
            // Don't try to log into Cloudflare for `remote: true` bindings.
            // Tests run fully against Miniflare; the AI binding is mocked
            // out per-test if needed.
            remoteBindings: false,
            wrangler: { configPath: "./wrangler.jsonc" }
          })
        ],
        test: {
          name: "workers",
          include: ["test/workers/**/*.test.ts"]
        }
      }
    ],
    coverage: {
      provider: "v8",
      // Report on every source file, even if no test imported it.
      // Excludes:
      //  - app.tsx / client.tsx: React UI, not unit-tested in v1
      //  - server.ts: tested via the workers project (integration smoke);
      //    when running with --project unit it can't even be imported,
      //    which would otherwise look like 0% coverage.
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/client.tsx", "src/app.tsx", "src/server.ts"],
      reporter: ["text", "html"],
      reportsDirectory: "./coverage"
    }
  }
});
