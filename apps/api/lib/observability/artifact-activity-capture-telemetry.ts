import {
  type ArtifactFieldEditField,
  ArtifactFieldEditOutcome,
} from "@repo/api/src/types/artifact-field-edit-receipt";
import type { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { captureArtifactFieldEditAnalytics } from "../artifact-field-edit-analytics";
import {
  EmissionRollupCause,
  FixedWindowEmissionThrottle,
} from "./fixed-window-emission-throttle";

/**
 * The queryable event a failed activity receipt is reported on.
 *
 * A stable snake_case name, not prose: the Datadog monitor is still pending in
 * ISS-10185 and is expected to key on this literal. Until then the event can be
 * queried but does not page. Exported so tests that pin the emission cannot
 * drift from production sites.
 */
export const ARTIFACT_ACTIVITY_CAPTURE_FAILED_EVENT =
  "artifact_activity_capture_failed";

/**
 * Which capture path failed its receipt. A closed, code-owned set — never
 * caller-supplied — so it is safe as a Datadog grouping label, and each member
 * is a different operator reading: a single edit could not record one row, a
 * creation could not record the artifact's opening entry, a batch could not
 * roll back multiple receipt rows. Each one refused its mutation (ISS-10993).
 */
export const ArtifactActivityCaptureStage = {
  /** One artifact's field diff, via `recordActivityEvent`. */
  SingleUpdate: "single_update",
  /**
   * A new artifact's opening `creation` entry (#7225 review, codex). Shares
   * `recordChanges` with the update path, so before this member existed a failed
   * creation receipt was reported as `single_update` and an operator grouping
   * by this label classified it as an edit failure. The two are different
   * readings: an edit loses one row in a feed that still has history, a
   * creation refuses the artifact whose feed would otherwise start there.
   */
  Creation: "creation",
  /** A batch status update, via the batched `recordActivityEvents`. */
  BatchStatus: "batch_status",
  /** A batch priority update, via the batched `recordActivityEvents`. */
  BatchPriority: "batch_priority",
  /** A batch project move (ISS-9158), via the batched `recordActivityEvents`. */
  BatchProject: "batch_project",
  /** A bulk tag application (ISS-9465), via the batched `recordActivityEvents`. */
  BatchTag: "batch_tag",
  /**
   * A bulk session OWNER assignment (ISS-9465). Its project sibling reports
   * `batch_project`, because it records through the same capture function every
   * other project move uses.
   */
  BatchAssign: "batch_assign",
} as const;
export type ArtifactActivityCaptureStage =
  (typeof ArtifactActivityCaptureStage)[keyof typeof ArtifactActivityCaptureStage];

export type ArtifactActivityCaptureFailure = {
  stage: ArtifactActivityCaptureStage;
  organizationId: string;
  /** Authenticated actor for user-authored rollback analytics. */
  userId?: string;
  /** The single artifact whose receipt failed, when the stage names one. */
  artifactId?: string;
  /** How many receipt rows the enclosing mutation rolled back. */
  rolledBackReceiptCount?: number;
  /** Bounded field taxonomy; never a caller-provided field name. */
  field?: ArtifactFieldEditField;
  /** Bounded fields when one grouped write carried multiple field receipts. */
  fields?: readonly ArtifactFieldEditField[];
  /** Validated or route-authoritative provenance, when available. */
  surface?: ArtifactStatusEditSurface;
  /** Used only to classify rollback lineage; never emitted as a raw id. */
  commitGroupId?: string;
  /** Used only to classify rollback lineage; never emitted as a raw id. */
  undoOfCommitGroupId?: string;
  /** The underlying error. Parsed, never a raw throwable. */
  error: unknown;
};

/** The throttle's key parts, kept so an eviction flush can name what it drops. */
type CaptureFailureKeyParts = {
  organizationId: string;
  stage: ArtifactActivityCaptureStage;
  field?: ArtifactFieldEditField;
  fields?: readonly ArtifactFieldEditField[];
  surface?: ArtifactStatusEditSurface;
};

/** Composite-key delimiter. Stage values are fixed snake_case tokens, so `|` cannot collide. */
const KEY_DELIMITER = "|";

/**
 * Emit a suppressed count as ONE aggregate, so a throttled burst still reaches
 * the monitor as volume rather than being discarded. Carries no `artifactId` or
 * `error`: the rollup spans occurrences that named different artifacts and may
 * have failed for different reasons, and picking one of them to stand for all
 * of them would be a confident wrong answer.
 */
function emitCaptureFailureRollup(
  parts: CaptureFailureKeyParts,
  suppressedCount: number,
  cause: EmissionRollupCause
): void {
  try {
    log.error(ARTIFACT_ACTIVITY_CAPTURE_FAILED_EVENT, {
      stage: parts.stage,
      organizationId: parts.organizationId,
      occurrences: suppressedCount,
      result: ArtifactFieldEditOutcome.RolledBack,
      rollupCause: cause,
      ...(parts.field === undefined ? {} : { field: parts.field }),
      ...(parts.fields === undefined ? {} : { fields: parts.fields }),
      ...(parts.surface === undefined ? {} : { surface: parts.surface }),
    });
  } catch {
    // Reporting is best-effort; see `reportArtifactActivityCaptureFailure`.
  }
}

/**
 * Process-local per-`(organizationId, stage, field, surface)` bound on this emission. Ephemeral
 * per serverless instance by design — each instance dedups independently, so a
 * fleet still reports the incident while no single hot instance can be replayed
 * into an unbounded emit stream.
 */
const captureFailureThrottle =
  new FixedWindowEmissionThrottle<CaptureFailureKeyParts>({
    onFlush: emitCaptureFailureRollup,
  });

/**
 * Emit for an activity receipt that was not persisted.
 *
 * Never throws. A failure to report the rollback must not replace the capture
 * error the caller is already propagating.
 *
 * Bounded per `(organizationId, stage, field, surface)` per window — see the module docstring
 * for why a write path needs that bound and what the suppressed rollup
 * preserves.
 */
export function reportArtifactActivityCaptureFailure(
  failure: ArtifactActivityCaptureFailure
): void {
  try {
    reportCaptureFailureLog(failure);
  } catch {
    // Reporting is best-effort; the user's write is the thing that matters.
  }
  try {
    emitRolledBackAnalytics(failure);
  } catch {
    // Analytics is independent of the monitored rollback sink.
  }
}

function reportCaptureFailureLog(
  failure: ArtifactActivityCaptureFailure
): void {
  const parts: CaptureFailureKeyParts = {
    organizationId: failure.organizationId,
    stage: failure.stage,
    ...(failure.field === undefined ? {} : { field: failure.field }),
    ...(failure.fields === undefined ? {} : { fields: failure.fields }),
    ...(failure.surface === undefined ? {} : { surface: failure.surface }),
  };
  const fieldKey = failure.field ?? failure.fields?.join(",") ?? "unknown";
  const surfaceKey = failure.surface ?? "unknown";
  const decision = captureFailureThrottle.record(
    [failure.organizationId, failure.stage, fieldKey, surfaceKey].join(
      KEY_DELIMITER
    ),
    parts,
    Date.now()
  );

  if (decision.flushedSuppressedCount > 0) {
    emitCaptureFailureRollup(
      parts,
      decision.flushedSuppressedCount,
      EmissionRollupCause.Window
    );
  }
  if (!decision.emit) {
    return;
  }
  log.error(ARTIFACT_ACTIVITY_CAPTURE_FAILED_EVENT, {
    stage: failure.stage,
    organizationId: failure.organizationId,
    ...(failure.artifactId === undefined
      ? {}
      : { artifactId: failure.artifactId }),
    ...(failure.rolledBackReceiptCount === undefined
      ? {}
      : {
          count: failure.rolledBackReceiptCount,
          rolledBackReceiptCount: failure.rolledBackReceiptCount,
        }),
    ...(failure.field === undefined ? {} : { field: failure.field }),
    ...(failure.fields === undefined ? {} : { fields: failure.fields }),
    ...(failure.surface === undefined ? {} : { surface: failure.surface }),
    result: ArtifactFieldEditOutcome.RolledBack,
    error: parseError(failure.error),
    occurrences: 1,
  });
}

function emitRolledBackAnalytics(
  failure: ArtifactActivityCaptureFailure
): void {
  const fields = failure.field
    ? [failure.field]
    : [...new Set(failure.fields ?? [])];
  const artifactCount = failure.artifactId ? 1 : failure.rolledBackReceiptCount;
  for (const field of fields) {
    captureArtifactFieldEditAnalytics({
      organizationId: failure.organizationId,
      ...(failure.userId === undefined ? {} : { userId: failure.userId }),
      field,
      result: ArtifactFieldEditOutcome.RolledBack,
      ...(artifactCount === undefined ? {} : { artifactCount }),
      ...(failure.surface === undefined ? {} : { surface: failure.surface }),
      ...(failure.commitGroupId === undefined
        ? {}
        : { commitGroupId: failure.commitGroupId }),
      ...(failure.undoOfCommitGroupId === undefined
        ? {}
        : { undoOfCommitGroupId: failure.undoOfCommitGroupId }),
    });
  }
}

/**
 * Drop the throttle's state WITHOUT flushing pending suppressed counts.
 *
 * TEST ISOLATION ONLY. The throttle is a module-level latch: without this, one
 * suite's failure case primes a key and the next case's emission is suppressed,
 * so the second test passes or fails on file order. Production must never call
 * it — discarding a pending count is losing occurrences.
 */
export function clearArtifactActivityCaptureFailureThrottle(): void {
  captureFailureThrottle.clear();
}
