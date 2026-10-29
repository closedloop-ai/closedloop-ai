/**
 * @file collector-import-failure-log.ts
 * @description ISS-5262 — how the collector import lane reports a pass that did
 * not finish, extracted out of `collector-manager.ts` (which has no entry in the
 * `noExcessiveLinesPerFile` grandfather list, so the 1,000-line ceiling is
 * enforced on it) so the decision lives in a directly unit-testable sibling
 * instead of growing that file. The
 * agent-session sync lane's twin is `agent-session-sync-tick-failure-log.ts`.
 *
 * The distinction it owns: `collector claude import failed: db-host exited
 * (code: 0)` used to land immediately AFTER `shutdown sequence end: clean`,
 * which made the shutdown verdict a lie. The import did not fail — the user quit
 * while it was in flight.
 *
 * Why one helper rather than a branch at the call site: the abandonment is
 * narrated TWICE — once by the manager, and again by the ingest tracker as
 * `session backfill [<harness>] abandoned at N/M source file(s): <reason>`.
 * Deriving each independently is how the second line kept the raw
 * `db-host exited (code: 0)` after the first had been cleaned up (closedloop-ai-stage
 * review). Both strings come from here, off one classification, so they cannot
 * drift apart again.
 *
 * Nothing is swallowed. Import is idempotent (catchup cache + revision
 * constants), so an abandoned pass re-reads its sources when it next runs, and a
 * genuine failure keeps its `failed` wording and its message verbatim.
 *
 * ISS-5808 added the third thing this classification decides: whether the pass
 * is reported COMPLETE. See `passCompleted` — until then every unfinished pass
 * said "complete", so a backfill the db-host killed at 5/6 source files was
 * indistinguishable from a finished one and nothing re-drove it in that session.
 */
import { isRecoverableDbHostExitError } from "../../../shared/db-host-exit-error.js";
import {
  DB_HOST_SHUTDOWN_ABANDON_REASON,
  isDbHostShutdownError,
} from "../../../shared/db-host-shutdown-error.js";
import { errorMessage } from "../../diagnostics/component-sync-diagnostics.js";
import { HarnessImportOutcome } from "./watcher.js";

/**
 * Which pass ended — the wording the log line uses for it. The manager has two
 * catch sites (the historical/boot sweep and the live-watcher batch) that make
 * the identical shutdown-vs-failure call, so they share this helper rather than
 * each re-deriving it.
 */
export const CollectorImportScope = {
  Historical: "import",
  Live: "live import",
} as const;
export type CollectorImportScope =
  (typeof CollectorImportScope)[keyof typeof CollectorImportScope];

/** The two narrations of one unfinished import pass. */
export type CollectorImportFailureReport = {
  /** The manager's own line. */
  readonly line: string;
  /**
   * What `IngestProgressTracker.abandonPass` appends to its
   * `abandoned at N/M source file(s):` line. Never a raw db-host exit message.
   * (Only the historical pass tracks progress, so only it consumes this.)
   */
  readonly reason: string;
  /**
   * ISS-5808 — whether the manager reports this pass as
   * `HarnessImportOutcome.Completed` (ISS-6207 replaced the boolean this used to
   * name with the three-way outcome).
   *
   * Every unfinished pass used to report completion, and the watcher reads
   * exactly that outcome to decide whether to re-arm
   * `pendingHistoricalImport`. So a codex session backfill that
   * `abandoned at 5/6 source file(s)` when the db-host died was indistinguishable
   * from a finished pass to every downstream consumer, and nothing re-drove it
   * until the 60s catch-up poll or the next launch — precisely the "an abandoned
   * ingest must not read as success" rule.
   *
   * `false` for a db-host exit the supervisor has already armed a replacement
   * fork for: that is the one class where the pass genuinely did not finish AND
   * can finish now, so re-driving it against the replacement child recovers the
   * work in this session. Import is idempotent (catch-up cache + revision
   * constants), so a re-drive re-reads its sources rather than duplicating them.
   *
   * `true` everywhere else, unchanged — including a SHUTDOWN abandonment, where
   * re-arming would fight the teardown, and an unrecoverable exit, where there is
   * no host to re-drive against.
   */
  readonly passCompleted: boolean;
};

/**
 * Describe an import pass for `collectorKey` that ended in `error`.
 *
 * A db-host shutdown is an ABANDONMENT (the app is quitting); anything else is
 * a FAILURE and keeps its message. Unrecognized errors degrade to failure, so
 * this can only ever quieten a case it positively classified.
 */
export function describeCollectorImportFailure(
  collectorKey: string,
  error: unknown,
  scope: CollectorImportScope = CollectorImportScope.Historical
): CollectorImportFailureReport {
  if (isDbHostShutdownError(error)) {
    return {
      line: `collector ${collectorKey} ${scope} abandoned: ${DB_HOST_SHUTDOWN_ABANDON_REASON}`,
      reason: DB_HOST_SHUTDOWN_ABANDON_REASON,
      passCompleted: true,
    };
  }
  const reason = errorMessage(error);
  return {
    line: `collector ${collectorKey} ${scope} failed: ${reason}`,
    reason,
    passCompleted: !isRecoverableDbHostExitError(error),
  };
}

/**
 * ISS-6207 — the terminal outcome for a pass that ABANDONED, from its failure
 * classification plus whether the tracker still authorizes an in-session
 * re-drive. Lives beside `passCompleted` (the classification it reads) so the
 * three-way decision cannot drift from the two-way verdict that feeds it.
 *
 * A spent budget is `RetriesExhausted`, NOT `Completed`: it stops the immediate
 * retry lane without telling the boot-import lifecycle the work finished. The
 * pre-fix `passCompleted || !budgeted` collapsed those into one claim and let a
 * readiness state be reported over source files that were never imported.
 */
export function importOutcomeForAbandonedPass(
  report: CollectorImportFailureReport,
  redriveBudgeted: boolean
): HarnessImportOutcome {
  if (report.passCompleted) {
    return HarnessImportOutcome.Completed;
  }
  return redriveBudgeted
    ? HarnessImportOutcome.Incomplete
    : HarnessImportOutcome.RetriesExhausted;
}

/**
 * ISS-6207 (whitlockk, #5917) — does this abandoned pass end its harness's boot
 * import with work outstanding, so the lifecycle must not claim completion?
 *
 * A spent budget always does. So does ANY unfinished pass on the DEFERRED lane
 * (`viaWatcher: false` — the hooks/disabled mode `captureDeferredImport`
 * schedules), and that second arm is the one the outcome alone cannot express.
 * `Incomplete` means "still eligible for automatic re-drive", but the thing that
 * re-drives it is the watcher's own `drainImports` loop, which re-queues on
 * exactly that outcome. The deferred lane has no such loop: its single pass IS
 * that harness's whole boot import, and `captureDeferredImport` resolves on
 * finish rather than success, so the outcome reaches nobody. Left to the outcome
 * alone, a hooks-mode harness that abandoned its first pass with budget to spare
 * settled as COMPLETE over sources nothing would re-read this boot — this
 * ticket's own defect, surviving on the lane Claude takes whenever its hook
 * collection mode is active.
 */
export function abandonedPassEndsBootImport(
  outcome: HarnessImportOutcome,
  viaWatcher: boolean
): boolean {
  if (outcome === HarnessImportOutcome.Completed) {
    return false;
  }
  return outcome === HarnessImportOutcome.RetriesExhausted || !viaWatcher;
}
