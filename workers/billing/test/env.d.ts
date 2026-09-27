import type { Env as BillingEnv } from "../index";

declare global {
  namespace Cloudflare {
    interface Env extends BillingEnv {
      TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
      TEST_BASE_SCHEMA: string;
    }
  }
}

export {};
