import {
  normalizeSessionStatus,
  resolveSessionDurationLifecycle,
  SessionDurationLifecycle,
} from "@repo/api/src/types/session-status";
import { resolveDisplayedSessionStatusWithWaiting } from "@repo/app/agents/lib/session-displayed-status-with-waiting";
import {
  resolveSessionDurationWindow,
  resolveSessionWallClockMs,
  type SessionDurationWindow,
  toSessionInstant,
} from "@repo/app/agents/lib/session-duration";

/**
 * ISS-5575: the Duration window for a session on its DETAIL page, resolved from
 * the status that page DISPLAYS rather than from the raw stored column — the
 * same input `session-table-row.ts` already hands the Sessions LIST, so one run
 * cannot report two spans one click apart.
 *
 * INVARIANT: this must derive through `resolveDisplayedSessionStatusWithWaiting`,
 * the LIST mapper's own resolver (ISS-6455), and NOT through the sibling
 * `resolveSessionDetailDisplayStatus` — kept as two names for one behavior
 * (both are now thin aliases of `resolveDisplayedSessionStatus` since
 * ISS-10364) so a future divergence between the two surfaces has somewhere to
 * attach without a rename touching every call site.
 *
 * An ABSENT status short-circuits: the shared resolver takes a `string`, and
 * coercing a missing value into one would fold it to a real status and start
 * timing a run this build has no evidence about.
 */
export function resolveSessionDetailDurationWindow(input: {
  status?: string | null;
  awaitingInputSince?: Date | string | null;
  endedAt?: Date | string | null;
  lastActivityAt?: Date | string | null;
  startedAt?: Date | string | null;
  /**
   * The instant the staleness cutoff is measured against, injected so the
   * derivation stays a pure function of its arguments and a caller can advance
   * it on a coarse tick instead of freezing at mount.
   */
  now?: Date;
}): SessionDurationWindow {
  // ISS-6455: PARSED, the same normalization the list mapper applies. Passing
  // the raw value through let a present-but-unparseable `endedAt` read as "this
  // run has ended" here and as "no end recorded" in the list — the split this
  // module exists to close, one field over.
  const endedAt = toSessionInstant(input.endedAt);
  const status = input.status;
  if (status == null) {
    return resolveSessionDurationWindow(status, endedAt);
  }
  return resolveSessionDurationWindow(
    resolveDisplayedSessionStatusWithWaiting({
      awaitingInputSince: input.awaitingInputSince,
      // RAW (whitlockk, #5099 review): the parse above cannot tell an absent end
      // instant from an unreadable one, and the projection needs that
      // distinction to refuse to time a run on corrupt evidence.
      endedAt: input.endedAt,
      lastActivityAt: input.lastActivityAt,
      now: input.now,
      startedAt: input.startedAt,
      status,
    }),
    endedAt
  );
}

/**
 * ISS-5575: whether a detail Duration still needs a ticking clock.
 *
 * Owned here rather than re-derived per component so the two consumers
 * (`SessionDurationProperty`, `SessionTimelineSummary`) cannot tick differently.
 *
 * THE INVARIANT: a `running` window always ticks, because the alternative is a
 * frozen number under a "Start to now" caption.
 *
 * ISS-10364 broke that invariant and this fold is the repair. The WINDOW now
 * derives from a status that has already been folded to the lifecycle set, so an
 * unrecognized spelling — or a legacy literal `stale`/`unknown` — reaches
 * `running`. This predicate reads the RAW status, and
 * {@link resolveSessionDurationLifecycle} still answers `Indeterminate` for
 * those same spellings, so without the fold the window said "running" while the
 * gate said "do not tick". Folding here asks the question of the same value the
 * window was built from.
 *
 * It must still NOT be `window.kind === "running"`: the window is downstream of
 * `now`, so reading it to decide whether to advance that clock is a cycle. This
 * asks one step upstream, where the answer is clock-independent.
 */
export function isSessionDetailDurationClockRelevant(input: {
  status?: string | null;
}): boolean {
  if (input.status == null) {
    return false;
  }
  return (
    resolveSessionDurationLifecycle(normalizeSessionStatus(input.status)) ===
    SessionDurationLifecycle.Running
  );
}

/**
 * ISS-5575: WHY this session's Duration renders empty, or `null` when it does
 * not.
 *
 * Whether the Duration is empty is keyed off the SAME inputs the rendered label
 * is (`resolveSessionWallClockMs`), not off `window.kind` alone (whitlockk, #4971):
 * a `running` or `ended` window with no `startedAt` still renders the em-dash,
 * and keying on the window would drop the pre-existing "No start time recorded"
 * explanation for exactly that population.
 *
 * The window is a PARAMETER, not re-derived here (tamsinb, #4971). Both
 * consumers resolve it one line above to render the value, so deriving it again
 * would run `resolveDisplayedSessionStatus` twice per render on every 30s tick —
 * and would let the reason describe a different window than the number beside it.
 *
 * Both consumers read this rather than deciding locally, so the Properties row
 * and the timeline strip cannot explain one state two ways.
 *
 * ISS-10364 (operator ruling, 2026-09-23/24) retired the Stale fold this
 * function used to name as the reason for an `unmeasurable` window with no
 * start time: a reaper-silent `active` row now folds to plain `active`, so
 * `resolveDisplayedSessionStatusWithWaiting` can no longer answer Stale here.
 * The only remaining empty reason is the pre-existing no-start sentence.
 */
export function resolveSessionDetailDurationEmptyReason(input: {
  window: SessionDurationWindow;
  status?: string | null;
  awaitingInputSince?: Date | string | null;
  endedAt?: Date | string | null;
  lastActivityAt?: Date | string | null;
  startedAt?: Date | string | null;
  now?: Date;
}): string | null {
  const now = input.now ?? new Date();
  if (
    resolveSessionWallClockMs(
      input.startedAt ?? null,
      input.window,
      now.getTime()
    ) !== null
  ) {
    return null;
  }
  return input.startedAt == null ? DURATION_NO_START_REASON : null;
}

/**
 * The pre-existing sentence for the population that genuinely has no start
 * instant. Owned here now that two surfaces render it.
 */
export const DURATION_NO_START_REASON =
  "No start time recorded for this session";
