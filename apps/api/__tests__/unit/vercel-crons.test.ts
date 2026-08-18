import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const API_VERCEL_CONFIG_PATH = join(process.cwd(), "vercel.json");
const DRAIN_CHECK_RUN_RETRIES_PATH = "/cron/drain-check-run-retries";
const RECONCILE_STALE_SESSIONS_PATH = "/cron/reconcile-stale-sessions";
const SESSION_INGESTION_HEALTH_PATH = "/cron/sample-session-ingestion-health";
const MERGE_QUEUE_STALL_PATH = "/cron/sample-merge-queue-stall";
const BOOTSTRAP_REPO_SYNC_STATES_PATH = "/cron/bootstrap-repo-sync-states";

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

  it("schedules the stale session reconciliation route hourly", () => {
    const config = JSON.parse(readFileSync(API_VERCEL_CONFIG_PATH, "utf8")) as {
      crons?: Array<{ path?: string; schedule?: string }>;
    };

    const cron = config.crons?.find(
      (candidate) => candidate.path === RECONCILE_STALE_SESSIONS_PATH
    );

    expect(cron).toEqual({
      path: RECONCILE_STALE_SESSIONS_PATH,
      schedule: "17 * * * *",
    });
  });

  it("schedules the session ingestion health sampler (ISS-4543)", () => {
    // The alerting lane only exists if the cron is actually scheduled — an
    // unregistered health check is the same silence ISS-4537 died of.
    const config = JSON.parse(readFileSync(API_VERCEL_CONFIG_PATH, "utf8")) as {
      crons?: Array<{ path?: string; schedule?: string }>;
    };

    const cron = config.crons?.find(
      (candidate) => candidate.path === SESSION_INGESTION_HEALTH_PATH
    );

    expect(cron).toEqual({
      path: SESSION_INGESTION_HEALTH_PATH,
      schedule: "*/15 * * * *",
    });
  });

  it("schedules the merge-queue stall sampler every 5 minutes (ISS-4450)", () => {
    // The cadence is load-bearing, not cosmetic. This poller exists because
    // GitHub Actions delivered its cron at a p50 of 50.5m, which pushed
    // detection past GitHub's own 120m merge-queue self-clear and made the
    // monitor retrospective. A 90m threshold only lands inside that deadline
    // because a tick arrives every 5 minutes — slow this schedule down and the
    // stall monitor silently reverts to paging after the queue already healed.
    const config = JSON.parse(readFileSync(API_VERCEL_CONFIG_PATH, "utf8")) as {
      crons?: Array<{ path?: string; schedule?: string }>;
    };

    const cron = config.crons?.find(
      (candidate) => candidate.path === MERGE_QUEUE_STALL_PATH
    );

    expect(cron).toEqual({
      path: MERGE_QUEUE_STALL_PATH,
      schedule: "*/5 * * * *",
    });
  });

  it("schedules the bootstrap-repo-sync-states route hourly at :37 (ISS-5091)", () => {
    const config = JSON.parse(readFileSync(API_VERCEL_CONFIG_PATH, "utf8")) as {
      crons?: Array<{ path?: string; schedule?: string }>;
    };

    const cron = config.crons?.find(
      (candidate) => candidate.path === BOOTSTRAP_REPO_SYNC_STATES_PATH
    );

    expect(cron).toEqual({
      path: BOOTSTRAP_REPO_SYNC_STATES_PATH,
      schedule: "37 * * * *",
    });
  });
});
