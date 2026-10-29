import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACK_TIMEOUT_TICK_MS } from "@/lib/desktop-command-ack-timeout";
import { IDLE_DRAIN_TICK_MS } from "@/lib/desktop-command-idle-drain";

const API_VERCEL_CONFIG_PATH = join(process.cwd(), "vercel.json");
const DRAIN_CHECK_RUN_RETRIES_PATH = "/cron/drain-check-run-retries";
const DRAIN_BRANCH_MATERIALIZATION_RETRIES_PATH =
  "/cron/drain-branch-materialization-retries";
const REFRESH_BRANCH_ANALYTICS_ROLLUPS_PATH =
  "/cron/refresh-branch-analytics-rollups";
const RECONCILE_STALE_SESSIONS_PATH = "/cron/reconcile-stale-sessions";
const SESSION_INGESTION_HEALTH_PATH = "/cron/sample-session-ingestion-health";
const BOOTSTRAP_REPO_SYNC_STATES_PATH = "/cron/bootstrap-repo-sync-states";
const AUDIT_DATA_INVARIANTS_PATH = "/cron/audit-data-invariants";
const COMMAND_QUEUE_DEPTH_PATH = "/cron/sample-command-queue-depth";
const IDLE_COMMAND_DRAIN_PATH = "/cron/drain-idle-command-queues";
const UNACKED_COMMAND_SWEEP_PATH = "/cron/sweep-unacked-commands";
const ORPHANED_CHUNK_MARKER_SWEEP_PATH = "/cron/sweep-orphaned-chunk-markers";
const CLEANUP_PHANTOM_SESSIONS_PATH = "/cron/cleanup-phantom-sessions";
const SWEEP_DOC_SYNC_STATE_PATH = "/cron/sweep-doc-sync-state";
const CLEANUP_OBSERVATION_RECEIPTS_PATH =
  "/cron/cleanup-repository-default-observation-receipts";
const SWEEP_HOUR = 5;
/** Cron routes ISS-12435 deleted with Loops; written out as the oracle. */
const RETIRED_LOOP_CRON_PATHS = [
  "/cron/timeout-loops",
  "/cron/sample-heartbeat-lag",
  "/cron/drain-pr-materialization-retries",
  "/cron/cleanup-loop-state",
  "/cron/run-cloud-routines",
];
/** Cron routes ISS-12780 unscheduled; their routes stay for manual runs. */
const UNSCHEDULED_ISS_12780_CRON_PATHS = [
  "/cron/backfill-orphan-transcripts",
  "/cron/reconcile-attachment-rows",
];
/**
 * The two stepped minute shapes this manifest uses — `*\/5` and `2-59/5`.
 * Anything else in the minute field is a bare minute.
 */
const CRON_MINUTE_STEP_PATTERN = /^(?:\*|(\d+)-\d+)\/(\d+)$/;

/** Every minute of an hour the given cron minute-field fires on. */
function minutesFiredInHour(minuteField: string): number[] {
  const step = CRON_MINUTE_STEP_PATTERN.exec(minuteField);
  if (!step) {
    return [Number(minuteField)];
  }
  const start = step[1] === undefined ? 0 : Number(step[1]);
  const every = Number(step[2]);
  const minutes: number[] = [];
  for (let minute = start; minute < 60; minute += every) {
    minutes.push(minute);
  }
  return minutes;
}

describe("api vercel cron manifest", () => {
  it("schedules the idle command-queue drain, phase-offset from the sampler", () => {
    const config = JSON.parse(readFileSync(API_VERCEL_CONFIG_PATH, "utf8")) as {
      crons?: Array<{ path?: string; schedule?: string }>;
    };

    const drain = config.crons?.find(
      (candidate) => candidate.path === IDLE_COMMAND_DRAIN_PATH
    );
    const sampler = config.crons?.find(
      (candidate) => candidate.path === COMMAND_QUEUE_DEPTH_PATH
    );

    // ISS-8686, restated for the shape these two reads have now. The reason the
    // offset was load-bearing at landing — both sweeps aggregated the whole live
    // queued set before the LIMIT could pick a winner — stopped being true when
    // ISS-8674 (#6414) moved the fleet-wide depth onto the trigger-maintained
    // counter column, and ISS-8895 then pointed the drain at its own read. They
    // still share `compute_targets_queued_depth_idx`, and the drain's read walks
    // it with a presence filter that can carry it past `limit + 1` entries, so
    // sharing a tick still puts both passes on one index at once.
    expect(drain).toEqual({
      path: IDLE_COMMAND_DRAIN_PATH,
      schedule: "2-59/5 * * * *",
    });
    expect(drain?.schedule).not.toBe(sampler?.schedule);
  });

  it("drives the idle drain at the cadence its backoff ladder is written in", () => {
    const config = JSON.parse(readFileSync(API_VERCEL_CONFIG_PATH, "utf8")) as {
      crons?: Array<{ path?: string; schedule?: string }>;
    };

    const cron = config.crons?.find(
      (candidate) => candidate.path === IDLE_COMMAND_DRAIN_PATH
    );

    // The strides are expressed in TICKS, so a schedule that drifted from
    // IDLE_DRAIN_TICK_MS would silently change every interval in the ladder
    // while every comment kept claiming the old minutes.
    const everyNMinutes = Number(cron?.schedule?.split(" ")[0]?.split("/")[1]);
    expect(everyNMinutes * 60 * 1000).toBe(IDLE_DRAIN_TICK_MS);
  });

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

  it("schedules the Branch materialization retry drain route", () => {
    const config = JSON.parse(readFileSync(API_VERCEL_CONFIG_PATH, "utf8")) as {
      crons?: Array<{ path?: string; schedule?: string }>;
    };
    const cron = config.crons?.find(
      (candidate) =>
        candidate.path === DRAIN_BRANCH_MATERIALIZATION_RETRIES_PATH
    );

    expect(cron).toEqual({
      path: DRAIN_BRANCH_MATERIALIZATION_RETRIES_PATH,
      schedule: "*/5 * * * *",
    });
  });

  it("schedules the Branch analytics rollup refresh within the lag ceiling", () => {
    const config = JSON.parse(readFileSync(API_VERCEL_CONFIG_PATH, "utf8")) as {
      crons?: Array<{ path?: string; schedule?: string }>;
    };
    const cron = config.crons?.find(
      (candidate) => candidate.path === REFRESH_BRANCH_ANALYTICS_ROLLUPS_PATH
    );

    expect(cron).toEqual({
      path: REFRESH_BRANCH_ANALYTICS_ROLLUPS_PATH,
      schedule: "*/5 * * * *",
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
  it("schedules the orphaned chunk-marker sweep AFTER the phantom purge (ISS-8602)", () => {
    const config = JSON.parse(readFileSync(API_VERCEL_CONFIG_PATH, "utf8")) as {
      crons?: Array<{ path?: string; schedule?: string }>;
    };

    const sweep = config.crons?.find(
      (candidate) => candidate.path === ORPHANED_CHUNK_MARKER_SWEEP_PATH
    );
    const phantomPurge = config.crons?.find(
      (candidate) => candidate.path === CLEANUP_PHANTOM_SESSIONS_PATH
    );

    // Without this entry NOTHING clears an orphaned marker — the service and
    // route suites stay green while the sweep silently never runs, which is the
    // same permanence the sweep exists to end.
    expect(sweep).toEqual({
      path: ORPHANED_CHUNK_MARKER_SWEEP_PATH,
      schedule: "13 5 * * *",
    });
    // The ORDER is the difference between un-marking a row and deleting one.
    // `phantomSessionWhere` spares a row carrying a marker, so this sweep is
    // what makes a row phantom-eligible; running it BEFORE the purge would hand
    // every freed row to a delete minutes later, while a tail chunk may still be
    // in an outbox. Running after leaves a full day for one to re-stage the
    // marker. Compared as instants, not minutes — the two are in different hours.
    const instantOf = (schedule?: string) => {
      const [minute, hour] = (schedule ?? "").split(" ");
      return Number(hour) * 60 + Number(minute);
    };
    expect(instantOf(sweep?.schedule)).toBeGreaterThan(
      instantOf(phantomPurge?.schedule)
    );
  });

  it("keeps the chunk-marker sweep off the stale-session reaper's minute (ISS-8602, review: marisolashgrove)", () => {
    const config = JSON.parse(readFileSync(API_VERCEL_CONFIG_PATH, "utf8")) as {
      crons?: Array<{ path?: string; schedule?: string }>;
    };

    const sweep = config.crons?.find(
      (candidate) => candidate.path === ORPHANED_CHUNK_MARKER_SWEEP_PATH
    );
    const reaper = config.crons?.find(
      (candidate) => candidate.path === RECONCILE_STALE_SESSIONS_PATH
    );

    // These two are the only SCHEDULED holders of the per-session advisory-lock
    // pair, and they contend over the same rows: the reaper takes the blocking
    // `acquireSessionAdvisoryLocks` on sessions whose status is reapable and
    // whose `lastActivityAt` is past its cutoff, which is exactly the shape a
    // session with a 72h-abandoned chunk sequence sits in. The sweep's
    // `tryAcquireSessionAdvisoryLocks` does not wait, so every candidate the
    // reaper is holding comes back `Contended` — a run that clears nothing and
    // still reports success, which is the invisible failure.
    //
    // MINUTES, not instants: the reaper runs EVERY hour, so its hour field
    // constrains nothing and only the minutes can collide. Comparing instants
    // here would pass on `13 5` and `13 * * * *` alike.
    const minuteOf = (schedule?: string) => (schedule ?? "").split(" ")[0];
    expect(reaper?.schedule).toBe("17 * * * *");
    expect(minuteOf(sweep?.schedule)).not.toBe(minuteOf(reaper?.schedule));
  });

  it("puts the chunk-marker sweep on a minute of its hour nothing else fires on (ISS-8602, review: marisolashgrove)", () => {
    const config = JSON.parse(readFileSync(API_VERCEL_CONFIG_PATH, "utf8")) as {
      crons?: Array<{ path?: string; schedule?: string }>;
    };

    const sweep = config.crons?.find(
      (candidate) => candidate.path === ORPHANED_CHUNK_MARKER_SWEEP_PATH
    );
    const [sweepMinuteField, sweepHourField] = (sweep?.schedule ?? "").split(
      " "
    );
    expect(sweepHourField).toBe(String(SWEEP_HOUR));

    // This is what makes the minute a REASONED pick rather than a shuffle one
    // along. Moving off the reaper closes the hazard above; landing on a minute
    // some five-minute family already occupies would trade it for load
    // contention on the same instant. The suggestions raised in review show the
    // trap is real — `19 5` sits on `4-59/5 sweep-unacked-commands`, so this
    // fails on it.
    const coFiring = (config.crons ?? [])
      .filter(
        (candidate) => candidate.path !== ORPHANED_CHUNK_MARKER_SWEEP_PATH
      )
      .filter((candidate) => {
        const [minuteField, hourField] = (candidate.schedule ?? "").split(" ");
        if (hourField !== "*" && Number(hourField) !== SWEEP_HOUR) {
          return false;
        }
        return minutesFiredInHour(minuteField).includes(
          Number(sweepMinuteField)
        );
      })
      .map((candidate) => candidate.path);

    expect(coFiring).toEqual([]);
  });

  it("schedules the data invariant audit daily (ISS-4752)", () => {
    // The audit only exists if it is actually scheduled. Nothing else fails
    // when this entry is renamed or dropped — the route and service suites
    // stay green while the audit silently stops running, which is the same
    // silence the audit was built to end.
    const config = JSON.parse(readFileSync(API_VERCEL_CONFIG_PATH, "utf8")) as {
      crons?: Array<{ path?: string; schedule?: string }>;
    };

    const cron = config.crons?.find(
      (candidate) => candidate.path === AUDIT_DATA_INVARIANTS_PATH
    );

    expect(cron).toEqual({
      path: AUDIT_DATA_INVARIANTS_PATH,
      schedule: "23 3 * * *",
    });
  });

  it("schedules the unacked-command sweep at the cadence its band is one tick of (ISS-7223)", () => {
    const config = JSON.parse(readFileSync(API_VERCEL_CONFIG_PATH, "utf8")) as {
      crons?: Array<{ path?: string; schedule?: string }>;
    };

    const cron = config.crons?.find(
      (candidate) => candidate.path === UNACKED_COMMAND_SWEEP_PATH
    );

    // The sweep reads a HALF-OPEN age band exactly one tick wide so each
    // crossing is reported once. A schedule slower than the band silently skips
    // commands; a faster one double-counts them, turning a defect count into an
    // unbounded multiple of itself. Neither failure is visible in the sweep's
    // own suite, which never reads this file.
    const everyNMinutes = Number(cron?.schedule?.split(" ")[0]?.split("/")[1]);
    expect(everyNMinutes * 60 * 1000).toBe(ACK_TIMEOUT_TICK_MS);
  });

  it("phase-offsets the unacked-command sweep from the other queued-set passes", () => {
    const config = JSON.parse(readFileSync(API_VERCEL_CONFIG_PATH, "utf8")) as {
      crons?: Array<{ path?: string; schedule?: string }>;
    };

    const sweep = config.crons?.find(
      (candidate) => candidate.path === UNACKED_COMMAND_SWEEP_PATH
    );
    const drain = config.crons?.find(
      (candidate) => candidate.path === IDLE_COMMAND_DRAIN_PATH
    );
    const sampler = config.crons?.find(
      (candidate) => candidate.path === COMMAND_QUEUE_DEPTH_PATH
    );

    // All three read the live queued set. Sharing a tick would put every pass
    // on it at once, which is the cost the drain's own offset already exists to
    // avoid.
    expect(sweep).toEqual({
      path: UNACKED_COMMAND_SWEEP_PATH,
      schedule: "4-59/5 * * * *",
    });
    expect(sweep?.schedule).not.toBe(drain?.schedule);
    expect(sweep?.schedule).not.toBe(sampler?.schedule);
  });

  it("schedules the command queue-depth sampler every 5 minutes (ISS-8453)", () => {
    // This is the ONLY emitter of `queued_command_count` that does not sit
    // behind a live relay socket. Drop the entry and the route's own suite
    // stays green while the disconnected-target blind spot silently returns —
    // the blind spot that let a backlog climb for 100 minutes unobserved.
    const config = JSON.parse(readFileSync(API_VERCEL_CONFIG_PATH, "utf8")) as {
      crons?: Array<{ path?: string; schedule?: string }>;
    };

    const cron = config.crons?.find(
      (candidate) => candidate.path === COMMAND_QUEUE_DEPTH_PATH
    );

    expect(cron).toEqual({
      path: COMMAND_QUEUE_DEPTH_PATH,
      schedule: "*/5 * * * *",
    });
  });
  it("schedules the doc-sync stored-state sweep daily (PLN-2200 T-6.2)", () => {
    const config = JSON.parse(readFileSync(API_VERCEL_CONFIG_PATH, "utf8")) as {
      crons?: Array<{ path?: string; schedule?: string }>;
    };

    const cron = config.crons?.find(
      (candidate) => candidate.path === SWEEP_DOC_SYNC_STATE_PATH
    );

    expect(cron).toEqual({
      path: SWEEP_DOC_SYNC_STATE_PATH,
      schedule: "29 6 * * *",
    });
  });
  it("schedules the observation-receipt retention sweep daily, alone on its minute (ISS-12780)", () => {
    const config = JSON.parse(readFileSync(API_VERCEL_CONFIG_PATH, "utf8")) as {
      crons?: Array<{ path?: string; schedule?: string }>;
    };

    const cron = config.crons?.find(
      (candidate) => candidate.path === CLEANUP_OBSERVATION_RECEIPTS_PATH
    );
    expect(cron).toEqual({
      path: CLEANUP_OBSERVATION_RECEIPTS_PATH,
      schedule: "1 1 * * *",
    });

    const coFiring = (config.crons ?? [])
      .filter(
        (candidate) => candidate.path !== CLEANUP_OBSERVATION_RECEIPTS_PATH
      )
      .filter((candidate) => {
        const [minuteField, hourField] = (candidate.schedule ?? "").split(" ");
        return (
          (hourField === "*" || Number(hourField) === 1) &&
          minutesFiredInHour(minuteField).includes(1)
        );
      })
      .map((candidate) => candidate.path);
    expect(coFiring).toEqual([]);
  });
  it("schedules none of the retired Loop crons (ISS-12435)", () => {
    const config = JSON.parse(readFileSync(API_VERCEL_CONFIG_PATH, "utf8")) as {
      crons?: Array<{ path?: string; schedule?: string }>;
    };
    const scheduled = new Set(
      (config.crons ?? []).map((candidate) => candidate.path)
    );

    // Their routes are deleted, so a schedule left behind would call a 404
    // every tick.
    expect(
      RETIRED_LOOP_CRON_PATHS.filter((path) => scheduled.has(path))
    ).toEqual([]);
  });
  it("schedules neither cron ISS-12780 unscheduled", () => {
    const config = JSON.parse(readFileSync(API_VERCEL_CONFIG_PATH, "utf8")) as {
      crons?: Array<{ path?: string; schedule?: string }>;
    };
    const scheduled = new Set(
      (config.crons ?? []).map((candidate) => candidate.path)
    );

    expect(
      UNSCHEDULED_ISS_12780_CRON_PATHS.filter((path) => scheduled.has(path))
    ).toEqual([]);
  });
});
