/**
 * FEA-4186 / ISS-5131: the single derivation of an AgentSession's "Duration" —
 * the session's WALL TIME, `now() - start` while it runs and `end - start` once
 * it is over. Session-specific lifecycle semantics, so it lives in the agents
 * feature slice (not `shared/lib`) and every Sessions surface that shows a
 * Duration — the table cell and the detail Properties/Overview cards — imports
 * from here so they never drift. {@link resolveSessionDurationWindow} states the
 * rule; nothing else in the repo restates it.
 *
 * ISS-4675: the session-detail timeline AXIS is deliberately NOT one of those
 * surfaces. It is a CALENDAR time axis: every bucket, marker, and event dot is
 * positioned as a fraction of `startedAt → axis end`, so its total is the span
 * the events are plotted across, which a terminal session's `endedAt` need not
 * bound. The two numbers are two different measures, so the axis total is
 * captioned ({@link SESSION_TIMELINE_AXIS_SPAN_PREFIX}) rather than silently
 * reading as a second, contradicting Duration. Its "end" instant still comes
 * from here ({@link resolveSessionTimelineAxisEnd}).
 */

import {
  resolveSessionDurationLifecycle,
  SessionDurationLifecycle,
} from "@repo/api/src/types/session-status";
import { formatDuration } from "@repo/app/shared/lib/format-utils";

/**
 * ISS-5131: the LEGACY end bound, retained ONLY for the session-timeline
 * flag-OFF path (`use-session-timeline-window.ts`, `session-timeline-geometry.ts`),
 * whose documented contract is to preserve prior geometry verbatim until the
 * ISS-4684 reconciliation flag flips. It is NO LONGER the Duration bound — see
 * {@link resolveSessionDurationWindow}, which owns that now.
 *
 * Do not add callers. The timeline axis is a calendar measure with its own
 * resolver ({@link resolveSessionTimelineAxisEnd}); this remains only so the
 * closed-by-default path does not move underneath ISS-4684.
 */
export function resolveSessionDurationEnd(
  endedAt: Date | string | null | undefined,
  lastActivityAt: Date | string | null | undefined,
  updatedAt?: Date | string | null | undefined
): Date | string | null {
  return lastActivityAt ?? endedAt ?? updatedAt ?? null;
}

/**
 * ISS-5131: the window a session's wall time is measured over. Three cases,
 * because "no end bound" means two different things and collapsing them is how
 * a finished session came to render a growing duration.
 */
export type SessionDurationWindow =
  /** Still running: measure `startedAt → now`. */
  | { readonly kind: "running" }
  /** Terminal with a real end: measure `startedAt → end`. */
  | { readonly kind: "ended"; readonly end: Date | string }
  /** Terminal with no end instant: not computable. Render the em-dash empty. */
  | { readonly kind: "unmeasurable" };

/**
 * ISS-5131: THE Duration rule, stated once (owner decision, 2026-08-04):
 *
 *   - **active** → wall time is `now() - start_time`
 *   - **error / inactive** → wall time is `end_time - start_time`
 *
 * That is all the UI needs to know. It reads exactly two inputs — the session's
 * status and its `endedAt` — and deliberately consults NEITHER `lastActivityAt`
 * NOR `updatedAt` NOR the collector's `wallClock`.
 *
 * WHY THE OLD RULE WENT: the previous bound preferred `lastActivityAt`
 * unconditionally, on the FEA-3594 reasoning that a sweeper/heal could stamp
 * `endedAt` with a wall-clock value hours after real work. That is the UI
 * compensating for a backend defect, and it produced a worse one — on session
 * `019fb3e3` a `lastActivityAt` tracking SYNC time ran six days past `endedAt`
 * and inflated a 31h session to 170h (5.5x). Two backend defects were cancelling
 * each other with the UI holding the compensation. The correct `endedAt` is the
 * backend's job (ISS-5182: `endedAt = max(activity.timestamp)`, set at activity
 * insert); this layer simply trusts it. Where the backend is wrong the UI now
 * shows the wrong number rather than quietly patching around it, which is the
 * point — it makes the defect visible where it lives.
 *
 * A terminal session whose `endedAt` is absent is `unmeasurable`, not `running`:
 * one instant is not a span, and measuring a finished session against `now()`
 * would render a duration that grows forever. This follows the ISS-4979 rule
 * that an uncomputable span is `null` (the em-dash), never a fabricated number.
 *
 * ONLY `Running` reaches `now()` (wongk / #4409 review). An `Indeterminate`
 * status — an unrecognized value, or the `stale`/`unknown` the Sessions list
 * projects for a stored-active row silent past the cutoff — takes the SAME
 * evidence-bounded branch as a terminal one. Two reasons, one for each half of
 * the pair the earlier cut split apart:
 *
 *   - it makes the Duration cell agree with the STATUS cell beside it. With
 *     `sessions-honest-unknown-states` on, the caller hands this the DISPLAYED
 *     status, so a row whose Status reads "Unknown" no longer sits next to a
 *     Duration confidently claiming "73h" and climbing. One row cannot both
 *     disclaim knowledge of the state and keep timing the run.
 *   - it closes the alias split. `resolveSessionDurationLifecycle` is the one
 *     classifier, so the desktop's `failed` — which `canonicalSharedStatus`
 *     writes before `mapListItem` — classifies exactly as the raw `error` does
 *     in the desktop sort. Hand-listing literals is what put those two
 *     spellings on opposite sides of the branch; that is also why this comment
 *     no longer lists them (ISS-6581 — the list it used to carry said the
 *     retired pair classified as `ended`, which stopped being true).
 */
export function resolveSessionDurationWindow(
  status: string | null | undefined,
  endedAt: Date | string | null | undefined
): SessionDurationWindow {
  if (
    resolveSessionDurationLifecycle(status) === SessionDurationLifecycle.Running
  ) {
    return { kind: "running" };
  }
  return endedAt == null
    ? { kind: "unmeasurable" }
    : { kind: "ended", end: endedAt };
}

/**
 * ISS-5131: the Duration caption for a session still running — the number is
 * measured to `now()`, so it keeps growing while the reader looks at it.
 *
 * FEA-4186 shipped ONE caption, "Start to last activity", for both lifecycle
 * cases. It was the wrong sentence in both: it named a bound the number is no
 * longer taken to, and it told a reader looking at a finished session that the
 * span reached some later activity instant rather than the session's own end —
 * the exact claim that made the inflated 170h look legitimate rather than wrong.
 * There are two measures now, so there are two captions, both derived by
 * {@link resolveSessionDurationDetail} so the caption cannot drift from the
 * window the number came from.
 */
export const SESSION_DURATION_RUNNING_DETAIL = "Start to now";

/**
 * ISS-5131: the Duration caption for a terminal session — bounded by its own
 * `endedAt`. See {@link SESSION_DURATION_RUNNING_DETAIL} for why the single
 * FEA-4186 caption was split in two.
 */
export const SESSION_DURATION_ENDED_DETAIL = "Start to end";

/**
 * ISS-5131: the caption naming the bounds the Duration was ACTUALLY measured
 * between, derived from the same window that produced the number.
 *
 * `null` on an unmeasurable window: there is no span, so there are no bounds to
 * name. Callers substitute their own absence caption (`DURATION_UNRECORDED_DETAIL`
 * on the session detail) rather than captioning an empty value slot with the two
 * bounds of a number that does not exist.
 */
export function resolveSessionDurationDetail(
  window: SessionDurationWindow
): string | null {
  if (window.kind === "unmeasurable") {
    return null;
  }
  return window.kind === "running"
    ? SESSION_DURATION_RUNNING_DETAIL
    : SESSION_DURATION_ENDED_DETAIL;
}

/**
 * ISS-4684: the "end" instant for the Session Timeline AXIS.
 *
 * The timeline axis TOTAL LABEL and the "Activity phases" strip caption on the
 * session-detail page are two derived total-duration claims for the SAME
 * session, and their headline numbers should reconcile. This helper resolves the
 * axis "end" instant; the caller renders it with the SAME `formatDuration` the
 * phases caption uses (`phases span 93h 42m`), so the two read in one unit
 * system instead of "5622m" vs "93h 42m".
 *
 * SCOPE: this reconciles the axis SCALE/label only. The phases strip does NOT
 * read `span.last`/`lastActivityAt` directly — its window is min/max over the
 * activity-segment rows (`activity-segments-projection.ts`), which can be a
 * truncated start-ordered prefix — and the bucket/marker/dot GEOMETRY on this
 * axis is still bounded by `session.endedAt ?? session.updatedAt` in
 * `getLimitDotPercent` / `alignBucketRowsToTranscript`. Making those windows
 * agree is a separate, broader change tracked in an ISS follow-up.
 *
 * The axis end is the LATER of the two real-activity/lifecycle bounds —
 * `max(endedAt, lastActivityAt)`:
 *   - a still-running session (no `endedAt`) reaches `lastActivityAt`;
 *   - a completed session whose activity continued past `endedAt` reaches that
 *     later `lastActivityAt`, so the label covers the events actually plotted;
 *   - a PRE-BACKFILL row whose `lastActivityAt` fell back to `startedAt`
 *     (projections fill `lastActivityAt ?? startedAt`) reaches `endedAt` rather
 *     than collapsing the axis to a 1-minute scale — the concrete case `max()`
 *     repairs that the plain `lastActivityAt` preference could not;
 *   - when only `endedAt` is available (an older/version-skewed detail with no
 *     `lastActivityAt`), it degrades gracefully to `endedAt` rather than lying.
 *
 * TRADEOFF (FEA-3594): when a sweeper/heal sets `endedAt` materially later than
 * the true last activity, `max()` will label the axis with that later end. This
 * is accepted for the LABEL because the axis geometry is already anchored to the
 * `endedAt ?? updatedAt` window (above), so the label matches the plotted extent
 * rather than under-reporting it.
 *
 * ISS-5131: the Duration METRIC no longer shares that distrust. It now trusts
 * `endedAt` outright ({@link resolveSessionDurationWindow}) — compensating in the
 * UI for a possibly-wrong backend timestamp is what inflated a 31h session to
 * 170h. The axis keeps `max()` for its own reason (it must cover every plotted
 * event), so the two resolvers are deliberately different and the axis total is
 * captioned to say so.
 *
 * `updatedAt` is deliberately NOT a max candidate: it is a DB row-update /
 * sync-bump timestamp, not observed activity, so extending the axis to it would
 * re-introduce the idle-wall-clock inflation FEA-4186 removed (an active session
 * synced hours after its last turn must still scale to that last turn). It is a
 * pure LAST-RESORT fallback, used only when both real bounds are absent.
 *
 * Returns `null` when no bound is available (the axis then falls back to its
 * minimum 1-minute scale). Accepts `Date` objects or ISO strings so the web
 * (Date) and desktop (ISO) surfaces share one derivation.
 */
export function resolveSessionTimelineAxisEnd(
  endedAt: Date | string | null | undefined,
  lastActivityAt: Date | string | null | undefined,
  updatedAt?: Date | string | null | undefined
): Date | string | null {
  const latestActivityBound = pickLaterInstant(endedAt, lastActivityAt);
  return latestActivityBound ?? updatedAt ?? null;
}

/**
 * ISS-4675: the qualifier appended to the session-timeline axis TOTAL.
 *
 * The same screen carries a Duration whose value legitimately differs ("3h 33m"
 * Duration against a "4h 54m" axis), and an unqualified second number reads as a
 * contradiction rather than as a second measure.
 *
 * The word is "calendar", NOT "elapsed". "Elapsed" and "wall-clock" are
 * synonyms in plain English, so captioning the axis "elapsed" would have
 * pointed two synonyms at the two measures we are trying to tell apart, and the
 * contradiction would have survived the caption. "Calendar" is the only phrasing
 * on this screen that separates them.
 *
 * ISS-5131 (#4409 review): it now separates them from an UNQUALIFIED Duration.
 * The Properties row used to answer with its own qualifier, "wall" — which
 * stopped doing any work the moment Duration became a plain start-to-end clock
 * span, because then both numbers were calendar measures and the two words named
 * one thing twice. The row dropped its qualifier; this one stays, because the
 * axis is the number that needs explaining: it stretches to cover every plotted
 * event ({@link resolveSessionTimelineAxisEnd}) while Duration stops at the
 * session's own end.
 *
 * QUALIFIER FIRST, so it scans as a set with the "Activity phases" caption
 * directly below it (`phases span 4h 54m`,
 * `packages/app/agents/components/activity/session-activity-segments.tsx`). Two
 * total-span captions stacked on one screen with inverted grammar — "4h 54m
 * calendar time" over "phases span 4h 54m" — read as two unrelated facts; the
 * shared `<what> span <duration>` shape reads as two measures of one session.
 */
export const SESSION_TIMELINE_AXIS_SPAN_PREFIX = "calendar span";

/**
 * The axis total's hover explanation — supplementary detail only. The
 * distinguishing word lives in the VISIBLE label
 * ({@link SESSION_TIMELINE_AXIS_SPAN_PREFIX}), not here, because a native
 * `title` is not keyboard-reachable, does not fire on touch, and has uneven
 * assistive-tech support; nothing load-bearing may live in it alone.
 *
 * It deliberately does NOT restate what the Duration metric measures. ISS-5131
 * settled that question — Duration is the session's wall time, `start → end`
 * (or `→ now` while running) — but the two remain different measures, because
 * this axis stretches to cover every plotted event
 * ({@link resolveSessionTimelineAxisEnd}) and Duration stops at the session's own
 * end. "Counts something different" states exactly that, without inviting the
 * reader to reconcile two numbers that are not supposed to match.
 *
 * It also does NOT claim geometry parity — no "the span these events are plotted
 * across". That sentence was false in both directions: this label's end is
 * `max(endedAt, lastActivityAt)` ({@link resolveSessionTimelineAxisEnd}) while
 * the bucket/marker/dot geometry is still bounded by `endedAt ?? updatedAt`
 * (`getLimitDotPercent` / `alignBucketRowsToTranscript`), so whichever bound
 * wins, the plotted window can be the other one. Reconciling the two windows is
 * the ISS-4684 follow-up; until it lands the caption describes only the axis end
 * it actually selected. Repeating the Duration card's own caption verbatim was
 * the other problem: it told the reader twice that both numbers measure the same
 * thing, sharpening the contradiction the caption exists to soften.
 *
 * No "above"/"below": the timeline is sticky-headed and the Duration row ships
 * collapsed, so the two are rarely on screen together and never in a fixed order.
 */
export const SESSION_TIMELINE_AXIS_SPAN_TITLE =
  "Calendar time between the first and last event on this axis. The Duration metric counts something different, so the two can differ.";

/**
 * Return whichever of two instants is later, ignoring absent or unparseable
 * bounds. Returns `null` when neither is a usable timestamp. Preserves the
 * original `Date`/ISO-string value (does not coerce the winner to a `Date`).
 */
function pickLaterInstant(
  a: Date | string | null | undefined,
  b: Date | string | null | undefined
): Date | string | null {
  const aMs = toInstantMs(a);
  const bMs = toInstantMs(b);
  if (aMs === null) {
    return bMs === null ? null : (b ?? null);
  }
  if (bMs === null) {
    return a ?? null;
  }
  return bMs > aMs ? (b ?? null) : (a ?? null);
}

/** Coerce a `Date`/ISO string to epoch ms, or `null` when absent/unparseable. */
function toInstantMs(value: Date | string | null | undefined): number | null {
  if (value == null) {
    return null;
  }
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}
/**
 * ISS-5131: the Duration in milliseconds, resolved from the window
 * {@link resolveSessionDurationWindow} selected. The numeric twin of
 * {@link resolveSessionWallClockLabel} — both read the same window, so anything
 * derived from the number reconciles with the string the reader is shown.
 *
 * `null` means "no measurement": either the window is `unmeasurable`, or the
 * start bound is missing/unparseable. Callers render their em-dash empty; none
 * may substitute a fabricated zero.
 *
 * A negative span (an `end` before its `start` — clock skew, or a backend that
 * stamped an end instant from a different clock) is also `null` rather than
 * clamped to a displayed `0s`: an end before its start is nonsensical data, and
 * "unknown" is the honest representation of it (the ISS-4979 rule).
 *
 * `nowMs` IS REQUIRED, and reading the ambient clock here is forbidden (#4409
 * review). A `Date.now()` inside this function makes the derivation impure while
 * looking pure, and every consumer of a running session's Duration is a memo:
 * `SyncedSessionsTable` keys its row build on `[items, …]` and TanStack
 * structural sharing keeps `items` referentially stable across polls that return
 * an unchanged page, so the number would freeze at whatever the clock said on
 * the last real input change — and the caption "Start to now" would then be not
 * stale but FALSE. Making it a parameter turns "where does my clock come from?"
 * into a compile error at every call site: the render surfaces feed it
 * `useCoarseNow`, and the two server comparators pin one quantized instant per
 * request. It also makes every running-session test assert an exact span under
 * `setSystemTime` instead of a bounded range.
 */
export function resolveSessionWallClockMs(
  startedAt: Date | string | null | undefined,
  window: SessionDurationWindow,
  nowMs: number
): number | null {
  if (window.kind === "unmeasurable") {
    return null;
  }
  const startMs = toInstantMs(startedAt);
  if (startMs === null) {
    return null;
  }
  const endMs = window.kind === "running" ? nowMs : toInstantMs(window.end);
  if (endMs === null || !Number.isFinite(endMs)) {
    return null;
  }
  const spanMs = endMs - startMs;
  return spanMs > 0 ? spanMs : null;
}

/**
 * ISS-5131: the Duration LABEL. Formats the same span
 * {@link resolveSessionWallClockMs} computes, via the shared `formatDuration`
 * so every surface renders one unit system.
 *
 * `null` on an unmeasurable window or an unresolvable start — the caller renders
 * its own em-dash rather than this helper inventing a sentinel string.
 */
export function resolveSessionWallClockLabel(
  startedAt: Date | string | null | undefined,
  window: SessionDurationWindow,
  nowMs: number
): string | null {
  const spanMs = resolveSessionWallClockMs(startedAt, window, nowMs);
  if (spanMs === null) {
    return null;
  }
  // Formatted from the RESOLVED SPAN, not by handing `formatDuration` a null end
  // and letting it read its own clock: the label and the number
  // `resolveSessionWallClockMs` returns must be the same measurement, and a
  // second ambient clock read between them is exactly how a caption and its
  // value drift apart.
  return formatDuration(EPOCH, new Date(spanMs));
}

/**
 * The zero instant {@link resolveSessionWallClockLabel} formats a resolved span
 * against. Module-level so the label path allocates one shared `Date` rather
 * than one per row, and so nothing is tempted to pass the literal `0` —
 * `formatDuration` treats a falsy `startedAt` as "no data" and would return its
 * `"-"` sentinel for a perfectly good span.
 */
const EPOCH = new Date(0);

/**
 * ISS-5131 (#4409 review): how often a Sessions surface re-reads the clock so a
 * RUNNING session's Duration keeps telling the truth.
 *
 * The derivations here are pure functions of `(startedAt, window, nowMs)`, which
 * is what makes them testable — but it also means nothing re-runs them on its
 * own. Every consumer is a `useMemo` keyed on the session data, and TanStack
 * Query's structural sharing keeps that data referentially stable across polls
 * that return an unchanged row, so during an idle window the memo's inputs never
 * change and a running Duration would sit frozen at whatever the clock said when
 * the page last received new data — under a caption reading "Start to now",
 * which makes it false rather than merely stale.
 *
 * THIRTY SECONDS, and it supersedes the ISS-4998 five-minute
 * `SESSION_STALENESS_REFRESH_MS` at every Sessions call site, because one clock
 * now feeds two derivations and the finer requirement wins. Five minutes was
 * calibrated against a 24-hour staleness threshold; `formatDuration` renders a
 * sub-hour span at SECOND granularity, so a five-minute cadence would leave a
 * young running session visibly minutes behind. The cost is one cheap re-map of
 * the visible page (bounded by page size) twice a minute.
 *
 * It is NOT gated. The staleness tick rode `sessions-honest-unknown-states` and
 * ran no timer while that flag was off, which was correct when the only thing it
 * fed was a flag-gated badge. Duration is not gated, so a gated tick would have
 * frozen the list cell at its own mount instant for every user with the flag off
 * — the same session then reading one number in the list and another on its
 * detail, and neither being `now`. Consumers still pass `enabled: false` for a
 * session whose window is BOUNDED: a terminal span cannot change, so there is
 * nothing for a timer to discover.
 */
export const SESSION_DURATION_TICK_MS = 30 * 1000;

/**
 * ISS-6455: the first PARSEABLE reading of a session instant, or `null` when the
 * value is absent or unparseable.
 *
 * Exported so the Sessions LIST and the session DETAIL normalize a wire
 * timestamp the same way before it reaches a derivation. They did not: the list
 * parsed `endedAt` and the detail passed it through raw, so a present-but-
 * unparseable value read as "no end instant" on one surface and as "this run has
 * ended" on the other — one more way for one record to tell two stories.
 *
 * `null` is the honest representation of an unusable timestamp; it is never
 * coerced into a date the data does not support.
 */
export function toSessionInstant(
  value: Date | string | null | undefined
): Date | null {
  const ms = toInstantMs(value);
  return ms === null ? null : new Date(ms);
}
