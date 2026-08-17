import {
  DISPLAYED_SESSION_STATUS,
  normalizeSessionStatus,
  SESSION_STATUS,
  type SessionStatus,
  TERMINAL_SESSION_STATUSES,
} from "@repo/api/src/types/session-status";
import type { AgentSessionUpsertTx } from "./records";

export type ReopenInput = {
  /**
   * The status the row ALREADY HELD, NORMALIZED at the read boundary —
   * `normalizeSessionStatus(existing.artifact.status)` — not the raw column and
   * not `upsertSessionSlice`'s `guardedStatus`.
   *
   * Typed as the enum because the boundary is where free-form input becomes a
   * modelled value: the column is validated once, on the way in, and every
   * decision below is written against the vocabulary rather than against
   * strings. `artifacts.status` is deliberately unbound (PRD-495: one column
   * carries several disjoint vocabularies) and pre-ISS-5981 rows can still hold
   * `waiting`, so the fold is real work — it just belongs at the read, not
   * scattered through the predicate.
   *
   * It must be the STORED value and not `upsertSessionSlice`'s `guardedStatus`
   * (the terminal-wins output about to be written). The question this gate asks
   * is "had this run finished?", which is a fact about the row as it stands —
   * the resolved value answers "what will this write leave behind?", a
   * different question that happens to agree most of the time.
   *
   * Where they part: `resolveGuardedStatus` returns the INCOMING status
   * whenever the stored one is non-terminal, so an `active` row receiving an
   * incoming `inactive` or `error` resolves to a terminal value and satisfies a
   * gate asking "had this run finished?".
   *
   * Be accurate about what that is worth, because an earlier draft of this note
   * was not (code review, #5156): it is NOT a bug fix. Every such row is refused
   * one line down by the incoming-status check, which admits only `active` and
   * `waiting` — so the swap is behaviour-preserving and no test can discriminate
   * it. What it buys is that the gate answers its own question from the row's
   * own state, instead of being correct by an interaction with a check that
   * exists to judge something else. The one real behaviour change on this path
   * is admitting `error`, below.
   *
   * `null` when there is no stored row (the create arm), where a reopen is
   * meaningless by definition.
   */
  persistedStatus: SessionStatus | null;
  /**
   * RAW, as the producer sent it — and the one field here that stays `string`,
   * deliberately.
   *
   * The wire schema validates it as `z.string().trim().min(1)` and nothing
   * more, so any non-empty spelling arrives; that IS the version-skew contract.
   * It is not normalized at the boundary like {@link persistedStatus} because
   * the decision below turns on the SPELLING rather than on what it folds to:
   * only the exact `active` and `waiting` admit a reopen, and folding first
   * would let every unmodelled word in. See {@link shouldReopenSession}.
   */
  incomingStatus: string;
  maxEventCreatedAt: Date | null;
  persistedSessionEndedAt: Date | null;
};

export type ReopenAction = {
  artifactId: string;
  /** Same wire value, same reason for `string` — see {@link ReopenInput}. */
  incomingStatus: string;
  incomingAwaitingInputSince: Date | null;
};

/**
 * Pure decision predicate: should a session be reopened?
 *
 * Fires iff the STORED status is TERMINAL (`inactive` or `error`), the incoming
 * status is EXACTLY `active` or `waiting`, and a strictly newer event exists
 * beyond the persisted `sessionEndedAt`. The raw event maximum
 * (`maxEventCreatedAt`) is used — NOT the floored `lastActivityAt` — because a
 * stale retry that only advances `startedAt` (no new events) would move the
 * floor past `sessionEndedAt` and falsely reopen.
 *
 * A FAILED run is reopenable (Chris, 2026-08-16). It previously was not, on the
 * stated grounds that this "mirrors the desktop `maybeReactivate`, which never
 * revives a failed run" — and that was simply untrue of the code it named.
 * `maybeReactivate` (`apps/desktop/src/main/database/live-hook.ts`) reads:
 *
 *     const reactivate = isUserActivity || (…) || (…)
 *
 * where `isUserActivity` is `UserPromptSubmit`/`PreToolUse`. It short-circuits,
 * so desktop DOES revive an `error` session the moment a human touches it; only
 * the Stop-like arm refuses one. Cloud was the stricter surface while claiming
 * to be the mirror, and a resumed run that had failed stayed pinned terminal
 * here no matter how much new activity arrived.
 *
 * The evidence bar is the same for both terminal states, and it is higher than
 * desktop's: not merely a hook firing, but an event STRICTLY NEWER than the
 * recorded end. That is the cloud's available analogue of "a human came back",
 * and it cannot be produced by a resync of already-known work.
 *
 * "Exactly `active` or `waiting`" is deliberate and narrower than "non-terminal"
 * — an earlier version of this docstring said the latter, which reads as though
 * the fold decides. It does not: the comparison is RAW, so an unmodelled
 * spelling is refused even though the fold would call it live. Folding it would
 * let any unrecognised word resurrect a finished run, clear its
 * `session_ended_at`, and restart its duration. See the call site in
 * `upsert-session-slice.ts` for the full argument; do not "simplify" it.
 */
export function shouldReopenSession(input: ReopenInput): boolean {
  // No stored row, nothing to reopen. Also the create arm, where `existing` is
  // undefined and a reopen is meaningless by definition.
  if (input.persistedStatus == null) {
    return false;
  }
  // Terminal — either terminal. Read from the shared set rather than spelled
  // out, so this cannot drift from the definition of "finished" that the
  // display, the sort, and the terminal-wins guard all share. An `active` row
  // is refused because there is nothing to reopen, and an unrecognised stored
  // spelling never reaches here: the boundary fold resolved it to `active`.
  if (!TERMINAL_SESSION_STATUSES.has(input.persistedStatus)) {
    return false;
  }
  // ISS-5974: `waiting` is admitted here ON PURPOSE and must stay admitted — a
  // version-skewed desktop build still sends it for an awaiting-input run, and
  // rejecting it would strand that run pinned terminal. This is an INPUT
  // tolerance only; `maybeReopenTerminalSession` folds the value before it is
  // persisted, because `waiting` is never a stored status.
  if (
    input.incomingStatus !== SESSION_STATUS.ACTIVE &&
    input.incomingStatus !== DISPLAYED_SESSION_STATUS.WAITING
  ) {
    return false;
  }
  if (
    input.maxEventCreatedAt == null ||
    input.persistedSessionEndedAt == null
  ) {
    return false;
  }
  return input.maxEventCreatedAt > input.persistedSessionEndedAt;
}

/**
 * If the reopen predicate fires, update the artifact status and session detail
 * within the same sync transaction (under the advisory locks).
 *
 * Three columns move together and none is optional: the status comes back to
 * life, `sessionEndedAt` is cleared because the run has not ended, and
 * `endsWithError` is cleared because the previous run's verdict must not
 * outlive it — see the inline note, which matters more now that a failed run
 * can reopen at all.
 *
 * ISS-5974: the status is FOLDED before it is written. `waiting` is never a
 * persisted value — it is a calculated display term — so an incoming `waiting`
 * lands as `active`, the lifecycle state it actually denotes. The awaiting-input
 * signal moves to `session_detail.awaitingInputSince`, which the very next
 * statement writes, and `projectDisplayedSessionStatus` re-derives the Waiting
 * badge from it at read time. Accepting `waiting` as INPUT stays deliberate
 * (version-skewed desktop builds still send it); only the persisted value
 * changed. `normalizeSessionStatus` is the canonical STORED fold, so this cannot
 * drift from the vocabulary it enforces.
 *
 * The fold is only lossless because the anchor is guaranteed — see
 * {@link resolveReopenAwaitingInputSince}, which supplies one when the payload
 * carried none.
 */
export async function maybeReopenTerminalSession(
  tx: AgentSessionUpsertTx,
  input: ReopenInput,
  action: ReopenAction
): Promise<void> {
  if (!shouldReopenSession(input)) {
    return;
  }
  await tx.artifact.update({
    where: { id: action.artifactId },
    data: { status: normalizeSessionStatus(action.incomingStatus) },
  });
  await tx.sessionDetail.update({
    where: { artifactId: action.artifactId },
    data: {
      sessionEndedAt: null,
      // Cleared as the row comes back to life, and REQUIRED now that a failed
      // run is reopenable (Chris, 2026-08-16). The schema states the hazard:
      // the stale-session reaper reads this flag "to declare an orphaned
      // still-active session ERROR vs INACTIVE without re-deriving from
      // events". Left set, a reopened error session that later goes quiet is
      // re-declared ERROR on the strength of the run that already ended —
      // reviving it only to kill it with the old verdict.
      //
      // NULL, not `false`, and the difference is not cosmetic (code review,
      // #5156). This column carries THREE states, and `@closedloop-ai/loops-api/insights`
      // is explicit that folding the third into `Clean` "would overstate
      // healthy work": `false` asserts the run ended and its own logs recorded
      // success, while `null` reports "no verdict was ever recorded" and renders
      // "Not recorded". A run that has just RESUMED has no outcome at all, so
      // `null` is the true statement and `false` is a fabricated success —
      // permanently, since an older desktop build that omits the field can never
      // restore the null.
      //
      // The reaper is satisfied either way: it reads `endsWithError ? ERROR :
      // INACTIVE`, so null and false are the same disposition to it. That is the
      // deliberate divergence insights.ts documents — a disposition must pick
      // some terminal status, an attribution must not invent one.
      endsWithError: null,
      awaitingInputSince: resolveReopenAwaitingInputSince(input, action),
    },
  });
}

/**
 * The `awaitingInputSince` value a reopen writes — the awaiting-input signal in
 * its ONLY persisted form, now that `waiting` is never a stored status.
 *
 * ISS-5974 (wongk, #4810): folding the status without this is a silent data
 * loss. The wire schema declares `awaitingInputSince` as
 * `.nullable().optional()` (`desktop-agent-sessions-schema.ts`), so a
 * version-skewed desktop build can send `waiting` carrying NO timestamp — and
 * `toDate(undefined)` delivers it here as `null`, indistinguishable from an
 * explicit one. Before the fold that payload still displayed correctly, because
 * the STORED `waiting` string was itself the signal:
 * `resolveDisplayedSessionStatus` returns WAITING from the raw value before it
 * consults any timestamp. Rewriting the status to `active` while leaving the
 * anchor null would drop the run's only claim to be blocked on a human — it
 * would read Active, then Stale once it aged past the display cutoff.
 *
 * So when — and ONLY when — the incoming status is the `waiting` spelling and no
 * anchor came with it, the anchor is synthesized from `maxEventCreatedAt`. That
 * is the soundest signal available on this write and it needs no new plumbing:
 * {@link shouldReopenSession} has already proven it is non-null and strictly
 * newer than the persisted `sessionEndedAt`, it is the moment the run last did
 * anything (i.e. when it asked), and — unlike the sync/`updatedAt` clock — it is
 * stable across resyncs, so a run blocked for three days keeps reporting three
 * days instead of resetting to "just now" on every batch.
 *
 * Every other case keeps the incoming value verbatim, including a null: a
 * non-`waiting` reopen asserts no awaiting-input state, so clearing a stale
 * anchor is the honest write rather than a loss.
 *
 * The raw comparison (not a fold) mirrors the predicate's own `waiting` clause,
 * so the value that ADMITS a reopen is the same value that anchors it.
 */
function resolveReopenAwaitingInputSince(
  input: ReopenInput,
  action: ReopenAction
): Date | null {
  if (action.incomingAwaitingInputSince) {
    return action.incomingAwaitingInputSince;
  }
  if (action.incomingStatus !== DISPLAYED_SESSION_STATUS.WAITING) {
    return null;
  }
  return input.maxEventCreatedAt;
}
