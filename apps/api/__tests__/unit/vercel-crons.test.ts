import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const API_VERCEL_CONFIG_PATH = join(process.cwd(), "vercel.json");
const DRAIN_CHECK_RUN_RETRIES_PATH = "/cron/drain-check-run-retries";

describe("api vercel cron manifest", () => {
  it("schedules the check_run retry drain route", () => {
    const config = JSON.parse(readFileSync(API_VERCEL_CONFIG_PATH, "utf8")) as {
      crons?: Array<{ path?: string; schedule?: string }>;
    };

    const cron = config.crons?.find(
      (candidate) => candidate.path === DRAIN_CHECK_RUN_RETRIES_PATH
    );

    expect(cron).toEqual({
      path: DRAIN_CHECK_RUN_RETRIES_PATH,
      schedule: "*/10 * * * *",
    });
  });
});
