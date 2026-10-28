import type { DevCronJob } from "@/lib/dev-cron-scheduler";
import { DEV_CRON_ENABLE_ENV_VAR } from "@/lib/dev-cron-scheduler";

/**
 * Shared fixtures for the ISS-8152 dev-cron suites.
 *
 * Extracted when `dev-cron-scheduler.test.ts` crossed the 1,000-line ceiling and
 * split into a plan suite and a runtime suite; both drive the same guard and the
 * same job shape, so the fixtures belong in one place rather than diverging.
 */

export const LOCAL_DATABASE_URL =
  "postgresql://postgres:postgres@localhost:5432/cl";

/** The one sanctioned opt-in value. */
export const OPTED_IN = "1";

/** What `randomBytes(32).toString("hex")` produces. */
export const MINTED_SECRET_PATTERN = /^[0-9a-f]{64}$/;

/**
 * A synthetic environment is passed to every call rather than mutating
 * `process.env`, because `apps/api/__tests__/setup.ts` loads `.env.local`
 * through dotenv — so a developer's real `DATABASE_URL` is present in this
 * process and would otherwise decide the outcome of the guard under test.
 */
export function env(
  overrides: Partial<NodeJS.ProcessEnv> = {}
): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "development",
    [DEV_CRON_ENABLE_ENV_VAR]: OPTED_IN,
    DATABASE_URL: LOCAL_DATABASE_URL,
    ...overrides,
  };
}

export const BOOT_JOB: DevCronJob = {
  path: "/cron/boot-job",
  intervalMs: 1000,
  cadenceLabel: "1s",
  productionCadenceLabel: "hourly",
  runAtBoot: true,
};

export const INTERVAL_JOB: DevCronJob = {
  path: "/cron/interval-job",
  intervalMs: 500,
  cadenceLabel: "500ms",
  productionCadenceLabel: "quarter-hourly",
  runAtBoot: false,
};

/**
 * A FRESH `Response` per call. Production consumes the body, so handing the same
 * instance to two ticks makes the second throw "Body is unusable" and silently
 * take the error path (#6048 review) — always call this inside a
 * `mockImplementation`, never once in a `mockResolvedValue`.
 */
export function okResponse(body = "OK: swept 1"): Response {
  return new Response(body, { status: 200 });
}
