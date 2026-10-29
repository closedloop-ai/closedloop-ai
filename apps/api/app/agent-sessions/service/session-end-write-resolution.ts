import type { SessionStatus } from "@repo/api/src/types/session-status";
import {
  didDropContradictorySessionEnd,
  didRefuseImplausibleSessionEnd,
  resolveSessionEndForStatus,
} from "./field-regression-guards";

/**
 * ISS-8552: the `sessionEndedAt` each upsert arm may write.
 *
 * Resolved per arm because the two arms deliberately write DIFFERENT statuses:
 * the update arm writes `guardedStatus` (terminal-wins), the create arm writes
 * `incomingStatus` (see its ISS-5648 note on the READ COMMITTED race). Gating
 * either end on the other arm's status would leave the row asserting an end its
 * own committed status denies — the exact disagreement this guard exists to
 * prevent, reintroduced at a different seam.
 *
 * Deliberately says NOTHING about which arm the database will take, and reports
 * no refusal: which arm committed is knowable only from the upsert's own
 * read-back, so the diagnostic is derived there by
 * {@link didDropContradictorySessionEnd} instead (whitlockk, PR #6284).
 */
export function resolveSessionEndWrites(params: {
  /** The update arm's max-wins end, pre-status-gate. */
  resolvedSessionEndedAt: Date | null;
  /**
   * The create arm's end: the payload's, after ISS-8681's
   * `resolveStorableSessionEnd` and before the status gate below. NOT the raw
   * payload value — the create arm would otherwise be the one hole through
   * which an implausibly-future end still reached the column.
   */
  incomingSessionEndedAt: Date | null;
  guardedStatus: SessionStatus;
  incomingStatus: SessionStatus;
}): { create: Date | null; update: Date | null } {
  return {
    update: resolveSessionEndForStatus(
      params.resolvedSessionEndedAt,
      params.guardedStatus
    ),
    create: resolveSessionEndForStatus(
      params.incomingSessionEndedAt,
      params.incomingStatus
    ),
  };
}

/**
 * ISS-8552 / ISS-8681: whether this apply refused the `sessionEndedAt` the
 * payload carried, for EITHER reason — the one signal behind
 * `SessionSyncMetric.ContradictorySessionEndDropped`.
 *
 * The two detectors are not interchangeable and neither covers the other's case;
 * `UpsertSessionSliceResult.droppedContradictorySessionEnd` carries why. The
 * skew arm is evaluated first only because it needs no committed read.
 *
 * Extracted rather than left as a `||` at the call site for the same reason
 * {@link resolveSessionEndWrites} above was: the pre-ISS-8619
 * `upsertSessionSlice` sat at the cognitive-complexity ceiling, and the
 * disjunction pushed it to 21 against a max of 20.
 */
export function didRefusePayloadSessionEnd(params: {
  payloadSessionEndedAt: Date | null;
  /** The payload's end after `resolveStorableSessionEnd`, pre-max-wins. */
  storableSessionEndedAt: Date | null;
  /** The end read back off the upsert — the only authority on which arm ran. */
  committedSessionEndedAt: Date | null;
}): boolean {
  return (
    didRefuseImplausibleSessionEnd(
      params.payloadSessionEndedAt,
      params.storableSessionEndedAt
    ) ||
    didDropContradictorySessionEnd(
      params.payloadSessionEndedAt,
      params.committedSessionEndedAt
    )
  );
}
