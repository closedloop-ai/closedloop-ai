/**
 * @file collector-manager-pass-session-ledger.ts
 * @description What one import pass has WRITTEN, and the two questions that
 * answer from it. Extracted from `collector-manager.ts` under the root
 * AGENTS.md line-count contract (ISS-12036 pushed that file past the ceiling).
 *
 * The seam is real rather than a slice at a line count: both predicates read the
 * same pair of session-id sets and both ask the same underlying question — does
 * the sink hold this session — differing only in what they do with the answer.
 * `existingSessionIds` is a snapshot taken BEFORE the pass began, so a session
 * written a moment ago is absent from it; `importedThisPass` is what covers
 * that, and keeping the two sets behind one object is what stops a caller
 * consulting one without the other.
 *
 * Holds no `CollectorManager` state and no I/O.
 */
import type { HarnessCollector } from "../types.js";
import { willSourceBeRescanned } from "./collector-pending-sources.js";

/** The pass's record of what it wrote, and what that record implies. */
export type PassSessionLedger = {
  /**
   * ISS-5028: note that this pass durably wrote `sessionId`. Called only for a
   * fully-committed session — a failed, refused, or `incomplete` import wrote no
   * row the two predicates below may trust.
   */
  noteImported(sessionId: string): void;
  /**
   * ISS-5028: is a source this pass finished DURABLE — will no later pending
   * scan return it? The first-pass progress denominator is `processed + pending`
   * and only reconciles while a source counted as finished cannot also reappear
   * as pending.
   *
   * `yieldedNoSession` (ISS-12036) says this pass parsed the source to ZERO
   * sessions, which is the one way an orphaned source is nonetheless finished:
   * no row will ever exist under its derived id, and the mark the pass writes to
   * the catchup cache keeps the next scan's orphan check off it.
   */
  isSourceDurable(source: string, yieldedNoSession?: boolean): boolean;
  /**
   * ISS-5161 (whitlockk review): may the batch resume cursor skip `sessionId`?
   *
   * The store fingerprint proves only that the SOURCE has not moved — it says
   * nothing about the SINK. `agent-dashboard.sqlite` lives at a sibling path and
   * can be rebuilt (a DB reset/migration) while the cursor file survives, the
   * same divergence `loadExistingSessionIds` already self-heals for file
   * collectors. Fast-forwarding then skips ids out of an EMPTY sink and
   * `markSourceImported` seals the source over rows that were never written. So
   * a cursor may only skip a session the sink still holds.
   *
   * An absent `existingSessionIds` loader leaves the pre-ISS-5161 behavior
   * (trust the cursor) rather than replaying everything.
   */
  sinkStillHolds(sessionId: string): boolean;
};

/**
 * Open the ledger for one pass over one collector.
 *
 * `existingSessionIds` is the pass's pre-flight snapshot of the sink, or
 * `undefined` when no loader answered — which both predicates read as "cannot
 * tell", conservatively, in the direction that avoids claiming progress the sink
 * may not hold.
 */
export function createPassSessionLedger(
  collector: HarnessCollector,
  existingSessionIds: ReadonlySet<string> | undefined
): PassSessionLedger {
  const importedThisPass = new Set<string>();
  return {
    noteImported(sessionId: string): void {
      importedThisPass.add(sessionId);
    },
    isSourceDurable(source: string, yieldedNoSession = false): boolean {
      return !willSourceBeRescanned(
        collector,
        source,
        existingSessionIds,
        importedThisPass,
        yieldedNoSession
      );
    },
    sinkStillHolds(sessionId: string): boolean {
      return (
        existingSessionIds === undefined ||
        existingSessionIds.has(sessionId) ||
        importedThisPass.has(sessionId)
      );
    },
  };
}
