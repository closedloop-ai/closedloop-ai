/**
 * @file import-log-messages.ts
 * @description ISS-5101 (PRD-611): single source of truth for the log-message
 * family write-core.ts emits when an import (or one of its tolerated groups)
 * fails and the failure is swallowed at runtime. The shared test harness
 * (`apps/desktop/test/agent-db-test-utils.ts`) matches these lines to fail the
 * owning unit test by default — the detector for the swallowed-rollback class
 * the ISS-5100 FK teardown gate cannot see (a rolled-back group leaves the
 * store clean). The deliberate FEA-2027 unsafe-token skip line
 * ("sqlite import: skipping …") is an input-data condition, not a failure, and
 * is intentionally NOT part of this family.
 */

export const ImportFailureLogPrefix = {
  /** Outer backstop: the whole importSession call failed pre-transaction. */
  ImportSession: "sqlite importSession failed for",
  /** The gating session/main-agent FK-parent group failed; import aborted. */
  SessionMainAgent: "sqlite import session/main-agent failed for",
  /** The best-effort activity-metrics rollup failed (does not flip `incomplete`). */
  ActivityMetrics: "sqlite import activity_metrics (best-effort) failed for",
  /** The final revision seal did not commit; row left at the pending sentinel. */
  RevisionSeal: "sqlite import revision_seal did not complete",
} as const;

export type ImportFailureLogPrefix =
  (typeof ImportFailureLogPrefix)[keyof typeof ImportFailureLogPrefix];

/**
 * Tolerated per-group failure lines carry a dynamic group label
 * (`sqlite import <label> failed for <sessionId>: …`); every label is a single
 * space-free token (e.g. `events`, `token_usage`, `revision_seal`).
 */
const IMPORT_GROUP_FAILED_RE = /^sqlite import \S+ failed for /;

/** Failure-line prefix for a named tolerated import group (write-core's runGroup). */
export function importGroupFailedPrefix(label: string): string {
  return `sqlite import ${label} failed for`;
}

/** True when a log line reports a swallowed import(-group) failure. */
export function isImportFailureLogLine(line: string): boolean {
  return (
    Object.values(ImportFailureLogPrefix).some((prefix) =>
      line.startsWith(prefix)
    ) || IMPORT_GROUP_FAILED_RE.test(line)
  );
}
