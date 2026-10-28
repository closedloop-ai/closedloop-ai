import type { AuditAction } from "@repo/api/src/types/audit";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import {
  EmissionRollupCause,
  FixedWindowEmissionThrottle,
} from "./fixed-window-emission-throttle";

/**
 * The monitored event a lost audit enqueue is reported on.
 *
 * A stable snake_case name, not prose: the Datadog monitor keys on this
 * literal, so it must not be reworded casually. Exported so the tests that pin
 * the emission cannot drift from the production sites.
 */
export const AUDIT_OUTBOX_ENQUEUE_FAILED_EVENT = "audit_outbox_enqueue_failed";

export type AuditOutboxEnqueueFailure = {
  organizationId: string;
  /** The audit action that was owed. A closed, code-owned vocabulary. */
  action: AuditAction;
  /** How many entries the enqueue lost. Omitted for the single-event path. */
  count?: number;
  /** The underlying error. Parsed, never a raw throwable. */
  error: unknown;
};

/** The throttle's key parts, kept so an eviction flush can name what it drops. */
type EnqueueFailureKeyParts = {
  organizationId: string;
  action: AuditAction;
};

/** Composite-key delimiter. Action values are fixed `<object>.<verb>` tokens, so `|` cannot collide. */
const KEY_DELIMITER = "|";

/**
 * Emit a suppressed count as ONE aggregate. Carries no `error`: the rollup
 * spans occurrences that may have failed for different reasons, and electing
 * one of them to stand for all of them would be a confident wrong answer.
 */
function emitEnqueueFailureRollup(
  parts: EnqueueFailureKeyParts,
  suppressedCount: number,
  cause: EmissionRollupCause
): void {
  try {
    log.error(AUDIT_OUTBOX_ENQUEUE_FAILED_EVENT, {
      organizationId: parts.organizationId,
      action: parts.action,
      occurrences: suppressedCount,
      rollupCause: cause,
    });
  } catch {
    // Reporting is best-effort; see `reportAuditOutboxEnqueueFailure`.
  }
}

/**
 * Process-local per-`(organizationId, action)` bound. Ephemeral per serverless
 * instance by design — each instance dedups independently, so a fleet still
 * reports the incident while no single hot instance can be replayed into an
 * unbounded emit stream.
 */
const enqueueFailureThrottle =
  new FixedWindowEmissionThrottle<EnqueueFailureKeyParts>({
    onFlush: emitEnqueueFailureRollup,
  });

/**
 * Emit for an audit event that never reached the outbox.
 *
 * Never throws. A failure to REPORT a lost emission must not become a second
 * failure on a path whose entire contract is that it cannot fail the caller's
 * write.
 */
export function reportAuditOutboxEnqueueFailure(
  failure: AuditOutboxEnqueueFailure
): void {
  try {
    const parts: EnqueueFailureKeyParts = {
      organizationId: failure.organizationId,
      action: failure.action,
    };
    const occurrences = failure.count ?? 1;
    const decision = enqueueFailureThrottle.recordOccurrences(
      `${failure.organizationId}${KEY_DELIMITER}${failure.action}`,
      parts,
      Date.now(),
      occurrences
    );

    if (decision.flushedSuppressedCount > 0) {
      emitEnqueueFailureRollup(
        parts,
        decision.flushedSuppressedCount,
        EmissionRollupCause.Window
      );
    }

    if (!decision.emit) {
      return;
    }

    log.error(AUDIT_OUTBOX_ENQUEUE_FAILED_EVENT, {
      organizationId: failure.organizationId,
      action: failure.action,
      ...(failure.count === undefined ? {} : { count: failure.count }),
      error: parseError(failure.error),
      occurrences,
    });
  } catch {
    // Reporting is best-effort; the user's write is the thing that matters.
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
export function clearAuditOutboxEnqueueFailureThrottle(): void {
  enqueueFailureThrottle.clear();
}
