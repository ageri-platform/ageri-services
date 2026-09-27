import fs from "node:fs/promises";
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// The ledger moves money, so it is tested inside the Workers runtime against a real local
// D1 with the real migrations applied - not against a mock of D1. The whole point of
// entry_idem, the CHECK on kind and the partial UNIQUE index is that SQLite enforces them,
// and a fake would enforce whatever the fake believed.
export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  // THE BASE SCHEMA IS NOT IN migrations/. billing, billing_transactions, subkeys and
  // usage_log live in d1/schema.sql and were applied by hand; migrations/ starts at 0002.
  // So the test database has to be built the same way round as production - schema first,
  // then the migrations - or 0003's backfill selects from a `billing` table that is not
  // there, which is exactly how this suite failed the first time it ran.
  const base = await fs.readFile(
    path.join(import.meta.dirname, "..", "..", "d1", "schema.sql"), "utf8");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            BILLING_SERVER_SECRET: "test-server-secret",
            PADDLE_WEBHOOK_SECRET: "test-paddle",
            VIETQR_JWT_SECRET: "0123456789012345678901234567890123",
            TEST_MIGRATIONS: migrations,
            TEST_BASE_SCHEMA: base,
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/setup.ts"] },
  };
});
