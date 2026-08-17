import {
  DISPLAYED_SESSION_STATUS,
  resolveSessionDurationLifecycle,
  SessionDurationLifecycle,
} from "@repo/api/src/types/session-status";
import { SESSION_STALE_TOOLTIP } from "@repo/api/src/types/session-status-display";
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
 * `resolveSessionDetailDisplayStatus`. That sibling normalizes its Waiting
 * projection with `normalizeDisplayedSessionStatus`, which fail-opens `unknown`,
 * `stale`, and unrecognized values to `active` — so a version-skewed payload
 * spelling `unknown` alongside `awaitingInputSince` would project to `waiting`
 * and start timing a run the list shows an em-dash for.
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
      // RAW (wongk, #5099 review): the parse above cannot tell an absent end
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
 * It CANNOT be `window.kind === "running"`: the window is downstream of `now`
 * once the displayed status feeds it, so reading it to decide whether to advance
 * that clock is a cycle. This asks the same question one step upstream, off the
 * RAW status, where it is clock-independent.
 *
 * It must also NOT be `isSessionDetailStatusClockRelevant` — that predicate
 * answers "can the displayed STATUS still change" and returns false for a
 * waiting run, which would freeze every awaiting-input Duration at mount under a
 * "Start to now" caption.
 *
 * THE INVARIANT: a `running` window always ticks. It holds because the window
 * only reaches `running` through a displayed `active` or `waiting`, and both
 * fold to `Running` on the raw status too. The one deliberate SUPERSET is the
 * safe direction — a stale-folded run keeps ticking over a static em-dash,
 * costing a re-render rather than a frozen number.
 */
export function isSessionDetailDurationClockRelevant(input: {
  status?: string | null;
}): boolean {
  return (
    resolveSessionDurationLifecycle(input.status) ===
    SessionDurationLifecycle.Running
  );
}

/**
 * ISS-5575: WHY this session's Duration renders empty, or `null` when it does
 * not.
 *
 * Whether the Duration is empty is keyed off the SAME inputs the rendered label
 * is (`resolveSessionWallClockMs`), not off `window.kind` alone (wongk, #4971):
 * a `running` or `ended` window with no `startedAt` still renders the em-dash,
 * and keying on the window would drop the pre-existing "No start time recorded"
 * explanation for exactly that population.
 *
 * The window is a PARAMETER, not re-derived here (thadeusb, #4971). Both
 * consumers resolve it one line above to render the value, so deriving it again
 * would run `resolveDisplayedSessionStatus` twice per render on every 30s tick —
 * and would let the reason describe a different window than the number beside it.
 *
 * Both consumers read this rather than deciding locally, so the Properties row
 * and the timeline strip cannot explain one state two ways.
 *
 * Staleness is checked FIRST because a stale run can also be missing an end
 * instant, and "we stopped believing it is running" is the fact that explains
 * the dash. Gating it on `unmeasurable` is what keeps the sentence off an
 * awaiting-input run: that one projects to a RUNNING window, so a missing
 * `startedAt` there falls through to the no-start sentence rather than being
 * told its agent has gone quiet. A measurable-looking window whose span is
 * non-positive (an end before its start) has no honest sentence and gets none.
 *
 * ISS-6455 (wongk, #5099 review): the staleness test runs through the SAME
 * resolver the window did, so a dash the window refused on UNREADABLE evidence
 * is not attributed to silence. Both facts can be true of one row — corrupt
 * timestamps AND no activity for a day — but the sentence names the reason this
 * number is missing, and that reason is the corruption. Such a row gets no
 * sentence here, as the non-positive span above does; the title chip beside it
 * carries the Unknown explanation, and inventing a second one for the same state
 * is what would put two words on one fact.
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
  if (
    input.window.kind === "unmeasurable" &&
    input.status != null &&
    resolveDisplayedSessionStatusWithWaiting({
      awaitingInputSince: input.awaitingInputSince,
      endedAt: input.endedAt,
      lastActivityAt: input.lastActivityAt,
      now,
      startedAt: input.startedAt,
      status: input.status,
    }) === DISPLAYED_SESSION_STATUS.STALE
  ) {
    return SESSION_STALE_TOOLTIP;
  }
  return input.startedAt == null ? DURATION_NO_START_REASON : null;
}

/**
 * The pre-existing sentence for the population that genuinely has no start
 * instant. Owned here now that two surfaces render it.
 */
export const DURATION_NO_START_REASON =
  "No start time recorded for this session";
