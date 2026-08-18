/**
 * @file import-health-telemetry.ts
 * @description ISS-5103 (PRD-611 gap 5): desktop import-health counters. Wraps
 * the `Importer` handed to the collector manager to tally tolerated group
 * failures by label and sessions flagged `incomplete`, and samples the
 * DATA_REVISION_IMPORT_PENDING sentinel on a fixed tick. Each tick emits one
 * `import.group_failed` record per failed label plus an `import.health` pass
 * record carrying `sessions_incomplete` and `sessions_pending_revision`.
 *
 * Decorating the importer (rather than hooking `settlePass` inside the collector
 * manager) covers every import path — boot backfill, catch-up sweeps, and
 * live-watcher imports — including passes that exit early on a live-event yield,
 * with zero edits to the manager.
 *
 * TWO THINGS THIS DELIBERATELY DOES NOT DO, both because they would make the
 * numbers lie:
 *
 * 1. It does not drive the tick off observed results. `importSessionBounded`
 *    wraps this decorator, so a per-session timeout resolves a synthetic result
 *    ABOVE us and our `await` never returns — exactly the wedged-DB case these
 *    counters exist to catch. A fixed tick reports the stuck sentinel even when
 *    no import result is ever observed again.
 *
 * 2. It does not use `updated_at` to decide what is stuck. The revision-only
 *    heal path in write-core stamps the sentinel WITHOUT bumping `updated_at`
 *    (deliberately — it is the sync watermark), so "sentinel AND old
 *    updated_at" also matches a session being imported right now, which is the
 *    majority case during a DATA_REVISION backfill. Instead each tick snapshots
 *    the pending session ids and reports the INTERSECTION with the previous
 *    tick's snapshot: rows that were pending a full tick ago and still are.
 *    With a tick longer than the per-session import bound, a healthy in-flight
 *    import cannot appear in two consecutive snapshots.
 *
 * Everything here is best-effort per the desktop exporter-boundary rule: an
 * observation, sample, or emit failure is swallowed (optionally logged to the
 * main-process diagnostic sink) and never throws into the import pipeline.
 * Emission happens only when a signal is non-zero, so a healthy install ships no
 * records at all (the Datadog monitor is count-of-breaches shaped).
 */
import {
  ImportGroupLabel,
  ImportHealthEvent,
} from "@closedloop-ai/telemetry-contract/app";
import type {
  Importer,
  ImportResult,
} from "../dashboard/agent-dashboard-db-types.js";
import { WriteQueueCancelOutcome } from "../database/write-queue.js";
import type { DesktopImportHealthEventInput } from "./app-otel-runtime-import-health.js";
import { raceShutdownDeadline } from "./shutdown-deadline.js";

/**
 * Sampling period. Comfortably longer than the per-session import bound
 * (ISS-4410, ~2 min) so a session that is merely mid-import cannot survive two
 * consecutive snapshots and be miscounted as stuck.
 */
const IMPORT_HEALTH_TICK_MS = 5 * 60_000;

/**
 * Cap on the sentinel snapshot. A backlog past this is already far beyond any
 * alert threshold, so the exact number stops mattering — the cap keeps a
 * mid-backfill snapshot (where the whole corpus transits the sentinel) from
 * holding a large id array in the main process.
 */
const IMPORT_PENDING_SNAPSHOT_LIMIT = 1000;

const KNOWN_IMPORT_GROUP_LABELS: ReadonlySet<string> = new Set(
  Object.values(ImportGroupLabel)
);

export type ImportHealthTrackerOptions = {
  /** Best-effort emit into the app-OTel runtime (which swallows internally). */
  emitImportHealth: (input: DesktopImportHealthEventInput) => void;
  /**
   * Ids of sessions currently at the pending-revision sentinel, capped at
   * `limit` (see `listImportPendingSessionIds`).
   */
  listPendingRevisionSessionIds: (limit: number) => Promise<string[]>;
  /** Key-free diagnostic sink. */
  log?: (message: string) => void;
  /** Test override for the sampling cadence. */
  tickMs?: number;
};

export type ImportHealthTracker = {
  /** Decorate an importer so every result feeds the tally. */
  wrapImporter(importer: Importer): Importer;
  /**
   * Run one sampling tick now: emit the accumulated tally and compare the
   * sentinel snapshot against the previous one. Used by tests and by the
   * shutdown path, which must drain the tally while the DB host and the OTel
   * relay are both still alive.
   */
  flushNow(): Promise<void>;
  /** Stop sampling and drop any untallied state. Idempotent. */
  dispose(): void;
};

export function createImportHealthTracker(
  options: ImportHealthTrackerOptions
): ImportHealthTracker {
  const tickMs = options.tickMs ?? IMPORT_HEALTH_TICK_MS;

  let disposed = false;
  let sessionsIncomplete = 0;
  const failedGroupCounts = new Map<ImportGroupLabel, number>();
  /** Sentinel ids seen at the previous tick; null until the first tick runs. */
  let previousPendingIds: ReadonlySet<string> | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;

  const logFailure = (what: string, error: unknown): void => {
    options.log?.(
      `import-health ${what} failed: ${error instanceof Error ? error.message : String(error)}`
    );
  };

  /**
   * Sample the sentinel and return how many ids survived a full tick. Returns 0
   * on the first tick (no prior snapshot means nothing can be proven stuck yet)
   * and re-snapshots for the next comparison.
   */
  const samplePendingSurvivors = async (): Promise<number> => {
    const current = new Set(
      await options.listPendingRevisionSessionIds(IMPORT_PENDING_SNAPSHOT_LIMIT)
    );
    const previous = previousPendingIds;
    previousPendingIds = current;
    if (previous === null) {
      return 0;
    }
    let survivors = 0;
    for (const id of current) {
      if (previous.has(id)) {
        survivors++;
      }
    }
    return survivors;
  };

  /** Never rejects: every failure path is caught and (optionally) logged. */
  const tick = async (): Promise<void> => {
    const incomplete = sessionsIncomplete;
    const groupCounts = [...failedGroupCounts.entries()];
    sessionsIncomplete = 0;
    failedGroupCounts.clear();
    try {
      for (const [groupLabel, count] of groupCounts) {
        options.emitImportHealth({
          kind: ImportHealthEvent.GroupFailed,
          groupLabel,
          count,
        });
      }
      const pending = await samplePendingSurvivors();
      if (incomplete > 0 || pending > 0) {
        options.emitImportHealth({
          kind: ImportHealthEvent.Pass,
          sessionsIncomplete: incomplete,
          sessionsPendingRevision: pending,
        });
      }
    } catch (error) {
      // Best-effort: a failed sentinel sample or a throwing emit seam must never
      // reach the import pipeline. Group records already emitted stand; the pass
      // record is skipped rather than shipped with a value we could not compute.
      logFailure("tick", error);
    }
  };

  const startTicking = (): void => {
    if (disposed || tickTimer) {
      return;
    }
    tickTimer = setInterval(() => {
      tick().catch((error: unknown) => logFailure("scheduled tick", error));
    }, tickMs);
    tickTimer.unref?.();
  };

  const observe = (result: ImportResult): void => {
    if (disposed) {
      // `importSessionBounded` abandons — never cancels — a timed-out import, so
      // its result can land long after teardown. Ignoring it here keeps a late
      // arrival from resurrecting the timer we just stopped.
      return;
    }
    if (result.incomplete) {
      sessionsIncomplete++;
    }
    for (const label of result.failedGroups ?? []) {
      // Cardinality cap: an out-of-set label (a write-core group added before
      // the contract learns it) degrades to the closed set's `unknown` bucket.
      const mapped = KNOWN_IMPORT_GROUP_LABELS.has(label)
        ? (label as ImportGroupLabel)
        : ImportGroupLabel.Unknown;
      failedGroupCounts.set(mapped, (failedGroupCounts.get(mapped) ?? 0) + 1);
    }
  };

  startTicking();

  return {
    wrapImporter(importer: Importer): Importer {
      // Forward EVERY argument, including `reason` (the diagnostic Error the
      // bounded-import timeout passes) — dropping it loses the eviction
      // diagnostic.
      //
      // Written out rather than `.bind(importer)`, which looks tidier and is a
      // trap here: in production this importer is the db-host ES Proxy, whose
      // `get` trap answers EVERY property path. `.bind` is not a real method on
      // it — reading it mints the op path `importer.cancelInFlightWrite.bind`,
      // and calling that fires an IPC invoke with the proxy itself as an
      // argument, which cannot be structured-cloned. That wedges the db-host
      // client and every later database read with it. Only `get`-then-`apply`
      // is safe on this object.
      const forwardCancel = importer.cancelInFlightWrite
        ? (sessionId: string, reason?: Error) =>
            importer.cancelInFlightWrite?.(sessionId, reason) ??
            WriteQueueCancelOutcome.None
        : undefined;
      return {
        importSession: async (session, harness) => {
          const result = await importer.importSession(session, harness);
          try {
            observe(result);
          } catch (error) {
            logFailure("observe", error);
          }
          return result;
        },
        ...(forwardCancel ? { cancelInFlightWrite: forwardCancel } : {}),
      };
    },
    flushNow(): Promise<void> {
      return tick();
    },
    dispose(): void {
      disposed = true;
      if (tickTimer) {
        clearInterval(tickTimer);
        tickTimer = null;
      }
      sessionsIncomplete = 0;
      failedGroupCounts.clear();
      previousPendingIds = null;
    },
  };
}

/** The slice of the agent database import-health tracking reads. */
export type ImportHealthDatabase = {
  importer: Importer;
  listImportPendingSessionIds: (limit: number) => Promise<string[]>;
};

export type InstallImportHealthTrackingOptions = {
  /**
   * Best-effort emit seam, wired to the desktop OTel runtime. Undefined in
   * contexts with no telemetry runtime, in which case tracking is not installed
   * at all — no tally, and no sentinel sampling.
   */
  emitImportHealth?: (input: DesktopImportHealthEventInput) => void;
  database: ImportHealthDatabase;
  log: (message: string) => void;
};

export type InstalledImportHealthTracking = {
  importer: Importer;
  /**
   * Drain the tally and stop sampling. Awaited on the shutdown path, which runs
   * while the DB host and the OTel relay are both still alive, so a failure
   * inside the last tick window still reaches the relay on a clean quit.
   */
  shutdown: () => Promise<void>;
};

/**
 * Wire import-health tracking for the agent-dashboard runtime: returns the
 * importer to hand the collector manager (decorated when a telemetry seam
 * exists, the database's own importer when it does not) plus the shutdown hook.
 */
export function installImportHealthTracking(
  options: InstallImportHealthTrackingOptions
): InstalledImportHealthTracking {
  const emitImportHealth = options.emitImportHealth;
  if (!emitImportHealth) {
    return {
      importer: options.database.importer,
      shutdown: () => Promise.resolve(),
    };
  }
  const tracker = createImportHealthTracker({
    emitImportHealth,
    listPendingRevisionSessionIds: (limit) =>
      options.database.listImportPendingSessionIds(limit),
    log: options.log,
  });
  return {
    importer: tracker.wrapImporter(options.database.importer),
    shutdown: async () => {
      // BOUNDED, always. The final tick does a db-host read while the db host is
      // being torn down around us, and an unbounded await here would hang
      // process exit — the ISS-4585 failure mode (`desktop-dev` force-killed
      // with SIGKILL 137) that `raceShutdownDeadline` exists to prevent. A
      // dropped last tick is an acceptable loss; a quit that never finishes is
      // not. `dispose()` still runs either way, so the interval is always
      // cleared.
      await raceShutdownDeadline(tracker.flushNow());
      tracker.dispose();
    },
  };
}
