import {
  DISPLAYED_SESSION_STATUS,
  type DisplayedSessionStatus,
  isDisplayOnlySessionStatus,
  normalizeDisplayedSessionStatus,
  resolveDisplayedSessionStatus,
  SESSION_STATUS,
  TERMINAL_SESSION_STATUSES,
} from "@repo/api/src/types/session-status";
import {
  AwaitingInputEvidence,
  classifyAwaitingInputEvidence,
} from "@repo/app/agents/lib/session-displayed-status-with-waiting";

/**
 * ISS-5818 (#4739 review, wongk): the DISPLAYED status of the session whose
 * DETAIL page is open — the value the title chip badges.
 *
 * It is not `resolveDisplayedSessionStatus` alone, and that gap is the bug this
 * module exists to close. That shared resolver owns the two honesty folds
 * (unrecognized → Unknown, silent-past-the-cutoff → Stale) but it cannot see
 * `awaitingInputSince`, so the Waiting projection sits AHEAD of it in every
 * producer that has one:
 *
 *  - the cloud read path projects it server-side
 *    (`projectDisplayedSessionStatus`, `apps/api`), so a web detail payload
 *    already arrives carrying `waiting`;
 *  - the desktop local read projects it in `projectDisplayedSharedStatus`, but
 *    only from `mapListItem` — and `mapDetail` inherits whatever `mapListItem`
 *    produced, which is the RAW canonical status unless the INDEPENDENT
 *    `sessions-displayed-status-parity` Labs flag is on.
 *
 * So a title chip that trusted the producer would badge an awaiting-input local
 * session "Active" on desktop while the same session reads "Waiting" on web —
 * a cross-surface split created by turning on a LAYOUT flag, which is exactly
 * what a shared view must not do. Deriving the projection here from fields both
 * producers already put on the DTO (`awaitingInputSince`, `endedAt`) makes the
 * chip surface-independent, and it is idempotent on the surface that already
 * projected: a payload whose `status` is already `waiting` takes the same branch
 * and lands on the same word.
 *
 * `waiting` is DISPLAY vocabulary, never a lifecycle value (root `AGENTS.md`):
 * nothing persists it, the awaiting-input signal is the `awaitingInputSince`
 * TIMESTAMP, and this function is a render-time derivation of it. It writes
 * nothing and no producer reads it.
 */
export function resolveSessionDetailDisplayStatus(input: {
  status: string;
  awaitingInputSince?: Date | string | null;
  endedAt?: Date | string | null;
  lastActivityAt?: Date | string | null;
  startedAt?: Date | string | null;
  /**
   * The instant the staleness cutoff is measured against. Injected rather than
   * read from an ambient clock so the derivation stays a pure function of its
   * arguments — and so the caller can advance it on a coarse tick instead of
   * freezing at mount (see {@link isSessionDetailStatusClockRelevant}).
   */
  now?: Date;
}): DisplayedSessionStatus {
  const evidence = projectableEvidence(input);
  if (evidence === AwaitingInputEvidence.Waiting) {
    return DISPLAYED_SESSION_STATUS.WAITING;
  }
  // ISS-6455 (wongk, #5099 review): the SAME answer the Duration derivations
  // reach for corrupt evidence. This chip and the Properties Duration row sit on
  // one screen, so a chip still badging "Waiting" over a Duration that had
  // already given up on the record would be the contradiction this module
  // exists to close, re-created one field over.
  if (evidence === AwaitingInputEvidence.Unreadable) {
    return DISPLAYED_SESSION_STATUS.UNKNOWN;
  }
  return resolveDisplayedSessionStatus({
    lastActivityAt: input.lastActivityAt,
    now: input.now,
    // The SAME `lastActivityAt ?? startedAt` anchor the Sessions LIST mapper,
    // the cloud projection and the desktop projection all use: a row with no
    // activity timestamp has no evidence of recent life, so falling back to the
    // start time keeps the least-evidenced rows from being the ones exempted
    // from the fold.
    startedAt: input.startedAt,
    status: input.status,
  });
}

/**
 * Whether {@link resolveSessionDetailDisplayStatus} can still CHANGE for this
 * session purely because time passed — i.e. whether the detail page needs a
 * ticking clock at all.
 *
 * The staleness fold is the only clock-dependent branch, and it is reachable
 * only from a non-waiting, non-display-only status that folds to `active`. A
 * terminal run's chip is fixed, so a detail page left open on one must not
 * re-render the whole view on a timer forever (the same rule
 * `SessionDurationProperty` applies to its own tick).
 *
 * Deliberately a SUPERSET of the exact condition: `normalizeDisplayedSessionStatus`
 * fail-opens an unrecognized value to `active`, so a version-skewed status keeps
 * the tick running even though its chip is already pinned to "Unknown". That
 * direction is the safe one — a spare tick costs a re-render, a missing tick
 * costs a badge that keeps claiming "Active" for a run that went quiet hours ago.
 */
export function isSessionDetailStatusClockRelevant(input: {
  status: string;
  awaitingInputSince?: Date | string | null;
  endedAt?: Date | string | null;
}): boolean {
  // Already folded by a producer that ran the derivation for us — "Stale" and
  // "Unknown" are where the clock-driven transitions END, so there is nothing
  // left for a tick to discover.
  if (isDisplayOnlySessionStatus(input.status)) {
    return false;
  }
  // A run blocked on a human is deliberately exempt from the staleness fold, so
  // that it keeps saying so after three days rather than fading to "Stale".
  // ISS-6455: `Unreadable` stands the clock down for the SAME reason the
  // display-only test above does — that chip is already pinned to "Unknown" and
  // no amount of elapsed time re-reads a corrupt timestamp.
  if (projectableEvidence(input) !== AwaitingInputEvidence.None) {
    return false;
  }
  return (
    normalizeDisplayedSessionStatus(input.status) === SESSION_STATUS.ACTIVE
  );
}

/**
 * The Waiting projection both producers encode (`projectDisplayedSessionStatus`
 * in `apps/api`, `projectDisplayedSharedStatus` in `apps/desktop`) — awaiting
 * input, not yet ended, not already terminal — with the shared
 * {@link classifyAwaitingInputEvidence} reading the two timestamps and this
 * surface's own gate applied on top.
 *
 * The gate is deliberately WIDER than the Duration derivations': it excludes
 * only TERMINAL statuses, where they narrow to the ones this build RECOGNIZES as
 * live. What the two must NOT disagree about is the evidence, and before ISS-6455
 * they did — read by truthiness here, an unusable `endedAt` meant "this run has
 * ended" while the Duration beside it read "no end recorded".
 *
 * The gate comes LAST for the reason ISS-4654 states: a straggler terminal row
 * that still carries `awaitingInputSince` must not be projected Waiting just
 * because the timestamp survived.
 */
function projectableEvidence(input: {
  status: string;
  awaitingInputSince?: Date | string | null;
  endedAt?: Date | string | null;
}): AwaitingInputEvidence {
  const evidence = classifyAwaitingInputEvidence(input);
  if (
    TERMINAL_SESSION_STATUSES.has(normalizeDisplayedSessionStatus(input.status))
  ) {
    return AwaitingInputEvidence.None;
  }
  return evidence;
}
