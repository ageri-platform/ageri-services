import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Production was built as d1/schema.sql first and migrations/ afterwards, so the test
// database is built the same way round. D1's exec() is fussy about multi-statement
// strings, hence the split; anything that is only a comment is dropped by requiring the
// fragment to begin with a statement keyword.
const statements = (env.TEST_BASE_SCHEMA as string)
  .split(";")
  .map((s) => s.trim())
  .filter((s) => /^\s*(?:--[^\n]*\n\s*)*(CREATE|INSERT|ALTER)/i.test(s));

await env.DB.batch(statements.map((s) => env.DB.prepare(s)));
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
