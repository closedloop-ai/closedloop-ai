"use client";

import type { SessionSpan } from "@repo/api/src/types/agent-session";
import type { SessionTimelineWindowState } from "@repo/app/agents/hooks/use-session-timeline-window";
import {
  SESSION_TIMELINE_AXIS_SPAN_PREFIX,
  SESSION_TIMELINE_AXIS_SPAN_TITLE,
} from "@repo/app/agents/lib/session-duration";
import {
  ensureDate,
  formatMonthDayTime,
  formatTime,
} from "@repo/app/shared/lib/date-utils";
import { isSameDay } from "date-fns";

/**
 * ISS-4675: the Session Timeline's axis row, extracted from
 * `agent-session-detail-view.tsx` (a shrink-only grandfathered file) into its own
 * module along with the {@link getSessionSpan} derivation that feeds it. One
 * responsibility: turning a session's first/last instants and its total span
 * into the three-slot row printed under the activity bars.
 */

/**
 * The axis row under the activity bars: START tick, qualified TOTAL, END tick.
 *
 * The order is deliberate and was not always this way. The total used to occupy
 * the RIGHT slot while `span.last` — already computed by {@link getSessionSpan}
 * and rendered nowhere — was dropped, and an empty styled `sd3-act-mid` sat
 * between the two ticks doing nothing. The right end of an axis is where a
 * reader looks for the END TIME, so a duration-plus-qualifier parked there was
 * fighting the tick for the slot. Start, span, end reads as an axis; start,
 * (nothing), span does not.
 */
export function SessionTimelineAxis({
  axisDurationLabel,
  span,
}: Readonly<{
  /**
   * ISS-4684: the axis total in the same `Hh Mm` unit system as the "Activity
   * phases" caption below it, so the two totals visibly reconcile.
   */
  axisDurationLabel: string;
  span: SessionSpan;
}>) {
  return (
    <div className="sd3-act-axis">
      <span>{span.first}</span>
      {/*
        ISS-4675: the qualifier leads (`calendar span 4h 54m`) so this scans as a
        set with the "Activity phases" caption below it (`phases span 4h 54m`)
        rather than as an unrelated second Duration — see
        SESSION_TIMELINE_AXIS_SPAN_PREFIX. `sd3-act-span` gives it the foreground
        colour against the muted ticks; both sit at `--text-xs`, because a
        caption load-bearing enough to disambiguate two contradicting numbers
        cannot live at a size nobody reads, and neither can the ticks it
        reconciles. It needs no `justify-self`: the axis grid's middle track is
        `auto`, so this cell is already exactly its own width and centred between
        the two `1fr` cheeks by construction (design review — a
        `justify-self-center` here measured as a no-op).
      */}
      <span className="sd3-act-span" title={SESSION_TIMELINE_AXIS_SPAN_TITLE}>
        {SESSION_TIMELINE_AXIS_SPAN_PREFIX} {axisDurationLabel}
      </span>
      {/* This one IS load-bearing: the third track is `1fr`, so without it the
          end tick left-aligns away from the axis's right edge. It stays a class
          here rather than moving into `.sd3-act-axis` because it is the row's
          one placement a jsdom render test can actually assert — no stylesheet
          is loaded there. */}
      <span className="justify-self-end">{span.last}</span>
    </div>
  );
}

/**
 * One plotted point on the Session Timeline: a commit, a failure, a frustration
 * signal, a rate limit, a PR, or a prompt. Lives here with the axis it is
 * positioned against; `x` is its position as a percentage of the axis span.
 */
export type ActivityMarker = {
  kind: "commit" | "fail" | "frust" | "limit" | "pr" | "prompt";
  label: string;
  t: string;
  tl: number;
  x: number;
  /**
   * ISS-5819 (#4753 review): the marker's ABSOLUTE instant, when the producer
   * knows it. Optional and additive — every existing producer and consumer keeps
   * working without it, and `x` remains the position the axis plots against.
   *
   * It exists because `x` is not always a wall-clock fraction. `buildTurnMarker`
   * derives `x` from the turn's ORDINAL when a session carries no persisted
   * markers, which the session-wide axis renders correctly (it is drawn in that
   * same ordinal geometry) but a CLOCK window cannot — see `resolveMarkerMs` in
   * `session-timeline-projection.ts`. A producer that has the real timestamp
   * passes it here instead of leaving the clock projection to reverse-engineer
   * one from a number that is not a time.
   */
  atMs?: number;
  illustrative?: boolean;
};

/**
 * The first/last instants printed on the axis ticks.
 *
 * ONE INPUT, ON PURPOSE (ISS-5366). The ticks are formatted from the very
 * {@link SessionTimelineWindowState} whose `start`/`end` the axis TOTAL beside
 * them is measured over (`formatDuration(axis.start, axis.end)` in
 * `agent-session-detail-view.tsx`), so the labels and the number between them
 * cannot name different instants — not because two derivations were checked
 * against each other, but because there is only one.
 *
 * WHAT THIS REPLACED. This function used to re-derive its own bounds from the
 * session: `resolveAxisInstant(lastActivityAt, endedAt, updatedAt)` — FIRST
 * PARSEABLE wins — while the total measured to `resolveSessionTimelineAxisEnd`,
 * which is `max(endedAt, lastActivityAt) ?? updatedAt`. Those are different
 * precedences, and they diverge on a real row: a swept session whose `endedAt`
 * lands hours after its true `lastActivityAt` had its right tick NAME
 * `lastActivityAt` while the caption MEASURED to `endedAt`, so the row
 * contradicted itself — the exact shape ISS-4833 opened to close, reintroduced
 * one branch down. The windowed branch was already consistent; the bare
 * fallback was not, and a divergence that only fires on the fallback is a
 * divergence that ships.
 *
 * `resolveSessionTimelineAxisEnd` is the considered contract and therefore the
 * survivor: it documents why the axis takes `max()` (the label must cover every
 * plotted event, and a pre-backfill `lastActivityAt` that fell back to
 * `startedAt` must not collapse the scale) and why `updatedAt` is a last resort
 * rather than a peer. The start bound reconciles the same way — it is now
 * `axis.start`, so a session with no `startedAt` drops BOTH ticks instead of
 * printing a `updatedAt`-derived left tick opposite a total that could not be
 * measured.
 *
 * On the windowed branch nothing moves: `axis.start`/`axis.end` there are
 * already `new Date(window.startMs/endMs)`, the two ends of the
 * PLOTTED-ACTIVITY window, so the ticks still name the instants the scale
 * measures between and still reconcile with the "Activity phases" span below.
 *
 * ISS-4955: BOTH edges go through the one axis formatter
 * ({@link formatAxisSpan}), so the row can never print a full `Jun 10, 2026 at
 * 2:46 AM` opposite a bare `9:04:11 AM`, and an axis that cannot resolve both of
 * its bounds prints no ticks rather than the literal word "Unknown", which is
 * not a time.
 *
 * The bare fallback — no usable window — deliberately does NOT consult the
 * server-provided `session.span`, nor the marker labels. `span` is parsed
 * straight out of the persisted `sessionSpan` JSON column in whatever precision
 * its writer used, and the marker labels are already formatted by whoever built
 * them; reading either would print foreign-precision bounds beside a total this
 * module derived — the two-formatter row ISS-4833 opened to close.
 * `buildWindow` returns null on a clock-skewed session (`endMs < startMs`),
 * which is exactly how a row reaches the fallback WITH a stored span, so the
 * case is reachable rather than theoretical. This module is the only writer of
 * these ticks.
 */
export function getSessionSpan(axis: SessionTimelineWindowState): SessionSpan {
  return formatAxisSpan(
    resolveAxisInstant(axis.start),
    resolveAxisInstant(axis.end)
  );
}

/**
 * The first parseable instant among `candidates`, or `null` when none of them
 * resolves. `null` is the honest "no such instant" — {@link formatAxisSpan}
 * then drops BOTH ticks rather than naming a bound it does not have or leaving
 * a lone one opposite a blank.
 */
function resolveAxisInstant(
  ...candidates: (Date | string | null | undefined)[]
): Date | null {
  for (const candidate of candidates) {
    const parsed = ensureDate(candidate);
    if (parsed && Number.isFinite(parsed.getTime())) {
      return parsed;
    }
  }
  return null;
}

/**
 * The window length at or above which the ticks drop seconds.
 *
 * This is not a taste call, it is the threshold `formatDuration` itself uses:
 * an hour or more prints `Hh Mm`, under an hour prints `Mm Ss`, under a minute
 * a bare `Ss` (`shared/lib/format-utils.ts`). {@link formatAxisSpan} keys off
 * the same boundary so the ticks and the total between them always agree about
 * whether seconds matter.
 */
const AXIS_SECONDS_PRECISION_THRESHOLD_MS = 3_600_000;

/**
 * Format one axis tick. Both ticks share `qualifyDate` and `includeSeconds`, so
 * the row carries ONE precision and it is the SAME precision as the total
 * between them.
 */
function formatAxisTick(
  instant: Date,
  qualifyDate: boolean,
  includeSeconds: boolean
): string {
  if (qualifyDate) {
    return formatMonthDayTime(instant, { includeSeconds });
  }
  return formatTime(instant, { includeSeconds });
}

/**
 * Format both axis ticks, date-qualifying them when the session's two edges fall
 * on different days (ISS-4955).
 *
 * On a 93h session the row used to read `9:04:11 AM … calendar span 93h 42m …
 * 2:46:33 AM`: the eye takes the two bare clock times as a single day and then
 * has to argue with the total. The edges should carry that information, not the
 * total. Same-day sessions keep the bare time — the date would be noise there.
 *
 * Two rules keep the row honest, both from the stage review of this change:
 *
 * 1. **All bounds or none.** An unresolvable edge used to print an empty tick
 *    opposite a real one, which reads as a value that failed to load rather
 *    than one we do not have — and `spansDays` is false whenever an edge is
 *    null, so the surviving tick printed a bare clock time even on a session
 *    the total claimed ran for days. Half an axis is worse than none: if either
 *    edge will not resolve, both ticks are dropped and the centred caption
 *    states the span alone.
 * 2. **Tick precision follows the total.** Dropping seconds unconditionally was
 *    only right above an hour. Under one, `formatDuration` returns `Mm Ss` (and
 *    under a minute a bare `Ss`), so a 47-second window rendered two IDENTICAL
 *    minute-precision ticks with a nonzero span claimed between them — and,
 *    because `formatTime` truncates rather than rounds, a 9:04:59 → 9:05:01
 *    window printed ticks a minute apart over a `2s` total.
 */
function formatAxisSpan(first: Date | null, last: Date | null): SessionSpan {
  if (first === null || last === null) {
    return { first: "", last: "" };
  }
  const includeSeconds =
    Math.abs(last.getTime() - first.getTime()) <
    AXIS_SECONDS_PRECISION_THRESHOLD_MS;
  const spansDays = !isSameDay(first, last);
  return {
    first: formatAxisTick(first, spansDays, includeSeconds),
    last: formatAxisTick(last, spansDays, includeSeconds),
  };
}
