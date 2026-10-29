/**
 * @file session-resume-health.ts
 * @description ISS-9823 — is the session lane's once-per-identity resume READ
 * currently failing?
 *
 * A LEVEL, not an edge, and not a counter. The fault it tracks is
 * self-reinforcing: the abort that stops the sync is the same thing that keeps
 * the outbox empty, so the lane reports `pending = 0`, classifies as `drained`,
 * and `detectNoProgressStall` — which requires `Draining` on both samples —
 * cannot fire. Nothing else in the burn-down can observe the condition, so this
 * has to be remembered across samples rather than re-derived from queue depth.
 *
 * It needs no timer and no decay. A {@link OutboxResumeOutcome.ReadFailed}
 * re-arms `hydratedSourceKey`, so the full hydration path re-runs on EVERY tick
 * while the fault lasts and re-asserts the level; the first tick whose read
 * lands answers `Seeded` and clears it.
 *
 * Held here rather than in `agent-session-sync-service.ts`, which is a
 * grandfathered over-ceiling file carrying three `biome.jsonc` entries. That
 * file's share of this ticket is zero lines: the tee sits in
 * `hydratePersistedCursorForPass`, next to the outcome it carries, and the
 * service still asks the same "did this identity hydrate" question it always
 * did.
 */

import { OutboxResumeOutcome } from "./session-outbox-engine-state.js";

/**
 * What each outcome does to the level, as an exhaustive map rather than two
 * comparisons — a fourth {@link OutboxResumeOutcome} member fails `tsc` here
 * instead of falling through to "leave it alone", which is the answer that would
 * silently un-report a new fault class.
 *
 * `Discarded` is `null` — LEAVE UNTOUCHED — and that is the whole point of
 * ISS-9823's S1. A superseded identity is an ordinary account or compute-target
 * switch, not a fault: setting on it would page on every sign-in, and CLEARING
 * on it would let a switch that races a genuinely failing read wipe the level.
 */
const RESUME_OUTCOME_BLOCKS_THE_LANE: Record<
  OutboxResumeOutcome,
  boolean | null
> = {
  [OutboxResumeOutcome.Seeded]: false,
  [OutboxResumeOutcome.Discarded]: null,
  [OutboxResumeOutcome.ReadFailed]: true,
};

/** Whether the session lane's resume read is currently blocking its pass. */
export class SessionResumeHealth {
  private blocked = false;

  /** Fold one hydration outcome into the level. */
  record(outcome: OutboxResumeOutcome): void {
    const next = RESUME_OUTCOME_BLOCKS_THE_LANE[outcome];
    if (next !== null) {
      this.blocked = next;
    }
  }

  isResumeBlocked(): boolean {
    return this.blocked;
  }

  /**
   * Forget the level. For a LIFECYCLE boundary only — the run that observed the
   * fault is over. Never call this per sampling window: the condition outlives a
   * window by construction, and a per-window clear would hide exactly the
   * persistent fault this exists for.
   *
   * ISS-9823 review: not for a compute-target switch either. An observer notices
   * that switch a sampling window after it happened, by which time the level
   * most likely carries the INCOMING identity's own first-hydration fault —
   * clearing there erases it and reports the wedged lane as drained for a whole
   * window. A `Seeded` from the new identity is what clears it, and that is one
   * tick away because a failed read re-arms `hydratedSourceKey`.
   */
  clear(): void {
    this.blocked = false;
  }
}
