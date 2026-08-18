import { resolveTimelineAxis } from "@repo/app/agents/hooks/use-session-timeline-window";
import { SESSION_TIMELINE_AXIS_SPAN_TITLE } from "@repo/app/agents/lib/session-duration";
import type { SessionTimelineWindowSource } from "@repo/app/agents/lib/session-timeline-geometry";
import {
  formatMonthDayTime,
  formatTime,
} from "@repo/app/shared/lib/date-utils";
import { formatDuration } from "@repo/app/shared/lib/format-utils";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { getSessionSpan, SessionTimelineAxis } from "../session-timeline-axis";

/**
 * ISS-4955: findings on the Session Timeline's axis row.
 *
 *  1. Both ticks were bare clock times, so a 93h session read as one day and the
 *     eye had to argue with the total between them.
 *  2. The no-window fallback could print the literal word "Unknown" as a tick.
 *     An axis tick that says "Unknown" is not a time.
 *  3. `.sd3-act-axis` was `flex` + `space-between`, so the middle caption only
 *     landed centred when the two edge labels happened to be equal width.
 *  4. The ticks carried seconds while the total rounded to minutes — two
 *     precisions on one row.
 *
 * Plus the three the stage review of that change added:
 *
 *  5. The tick precision has to FOLLOW the total, not drop seconds
 *     unconditionally: `formatDuration` only rounds to minutes above an hour.
 *  6. A half-resolved axis prints no ticks at all, not one real bound opposite
 *     a blank that reads as a value that failed to load.
 *  7. The persisted `session.span` is never consulted, so the ticks always come
 *     from the one axis formatter.
 *
 * ISS-5366 retired the `session-timeline-axis-reconciliation` gate these rode on
 * to its enabled state, so every case below runs unconditionally. The row's grid
 * TRACKS moved out of an inline style into `.sd3-act-axis` in
 * `styles-session-timeline.css` at the same time; jsdom loads no stylesheet, so
 * what this suite can still assert about layout is the per-cell placement the
 * component itself writes, which is what the caption's centring depends on.
 */

// Every window is built from LOCAL calendar parts, not UTC instants: the axis
// formats in the viewer's zone, so a UTC literal would be same-day in one CI
// timezone and multi-day in another and these cases would swap.
/** A window crossing four local midnights — the reported 93h case. */
const MULTI_DAY_WINDOW = {
  endMs: new Date(2026, 5, 14, 2, 46, 33).getTime(),
  startMs: new Date(2026, 5, 10, 9, 4, 11).getTime(),
};

/** A window inside one local calendar day, comfortably over an hour. */
const SAME_DAY_WINDOW = {
  endMs: new Date(2026, 5, 10, 14, 46, 33).getTime(),
  startMs: new Date(2026, 5, 10, 9, 4, 11).getTime(),
};

/** 47 seconds — `formatDuration` returns a bare `47s` here. */
const SUB_MINUTE_WINDOW = {
  endMs: new Date(2026, 5, 10, 9, 4, 58).getTime(),
  startMs: new Date(2026, 5, 10, 9, 4, 11).getTime(),
};

/** Two seconds ACROSS a minute boundary — `formatTime` truncates, not rounds. */
const MINUTE_STRADDLING_WINDOW = {
  endMs: new Date(2026, 5, 10, 9, 5, 1).getTime(),
  startMs: new Date(2026, 5, 10, 9, 4, 59).getTime(),
};

/** Just under an hour — `formatDuration` returns `Mm Ss` right up to 60m. */
const JUST_UNDER_AN_HOUR_WINDOW = {
  endMs: new Date(2026, 5, 10, 10, 3, 47).getTime(),
  startMs: new Date(2026, 5, 10, 9, 4, 11).getTime(),
};

const AXIS_ROW_SELECTOR = ".sd3-act-axis";
const END_TICK_CLASS = "justify-self-end";
/** The `Hh Mm` total the axis prints between the ticks. */
const AXIS_TOTAL_LABEL = "93h 42m";
/** A `h:mm:ss` clock label — second precision on a tick. */
const SECONDS_PRECISION_RE = /:\d{2}:\d{2}/;
/** A trailing `…s` component on a `formatDuration` total (`47s`, `5m 3s`). */
const TOTAL_SECONDS_RE = /\d+s$/;

/**
 * A window SOURCE with nothing that can resolve to an instant.
 *
 * ISS-5366: structural, not a full detail fixture. `getSessionSpan` now reads
 * the resolved `SessionTimelineWindowState`, so these cases drive the real
 * `resolveTimelineAxis` — and the shared detail fixture carries EVENTS, which
 * `resolveSessionTimelineWindow` happily turns into a plotted window. That would
 * quietly move every "no usable bound" case onto the windowed branch and stop
 * them testing the fallback at all. `SessionTimelineWindowSource` is structural
 * precisely so a test can state only the bounds under test.
 */
const NO_RESOLVABLE_INSTANTS: SessionTimelineWindowSource = {
  endedAt: null,
  lastActivityAt: undefined,
  startedAt: undefined,
  updatedAt: undefined,
};

/**
 * ISS-5366: the windowed-branch axis state, built exactly as `resolveTimelineAxis`
 * builds it (`new Date(window.startMs/endMs)`).
 *
 * `getSessionSpan` now takes the ONE `SessionTimelineWindowState` the axis total
 * is also measured from, instead of re-deriving its own bounds from the session
 * — that second derivation used a different end precedence and is what let the
 * right tick name `lastActivityAt` while the caption measured to `endedAt`. The
 * fallback cases below therefore go through the real `resolveTimelineAxis`
 * rather than passing a literal `null` window, so they exercise the production
 * precedence rather than a shape only this file constructs.
 */
function axisForWindow(window: { endMs: number; startMs: number }) {
  return {
    end: new Date(window.endMs),
    start: new Date(window.startMs),
    window,
  };
}

function renderAxis(span: { first: string; last: string }) {
  return render(
    <AppCoreStoryProviders>
      <SessionTimelineAxis axisDurationLabel={AXIS_TOTAL_LABEL} span={span} />
    </AppCoreStoryProviders>
  );
}

/**
 * Whether each tick, and the TOTAL between them, carries seconds for `window`.
 *
 * Read off `formatDuration`'s real output for the same window rather than a
 * literal, so an assertion over these three pins the two formatters to each
 * other and they cannot drift apart at the hour boundary again (stage review of
 * ISS-4955).
 */
function tickPrecisionReport(window: { endMs: number; startMs: number }) {
  const total = formatDuration(
    new Date(window.startMs),
    new Date(window.endMs)
  );
  const span = getSessionSpan(axisForWindow(window));
  const totalCarriesSeconds = TOTAL_SECONDS_RE.test(total);
  return {
    first: SECONDS_PRECISION_RE.test(span.first),
    last: SECONDS_PRECISION_RE.test(span.last),
    total: totalCarriesSeconds,
    // Named so a failure reports the window that broke, not a bare `false`.
    window: `${total} (${window.startMs}→${window.endMs})`,
  };
}

describe("Session Timeline axis ticks (ISS-4955)", () => {
  it("date-qualifies BOTH ticks when the session crosses a day boundary", () => {
    const span = getSessionSpan(axisForWindow(MULTI_DAY_WINDOW));

    // The month/day has to be on the labels themselves — that is the
    // information the reader was having to reconstruct from the total — and on
    // BOTH edges, so the row never mixes a qualified tick with a bare one.
    // Asserted against the canonical formatter rather than a literal, which is
    // also how "one formatter" is pinned. `formatMonthDayTime`, not
    // `formatDateTime`: the year and the "at" are noise on an axis, and two
    // labels that long wrap the row in the desktop detail pane.
    expect(span.first).toBe(
      formatMonthDayTime(new Date(MULTI_DAY_WINDOW.startMs))
    );
    expect(span.last).toBe(
      formatMonthDayTime(new Date(MULTI_DAY_WINDOW.endMs))
    );
    // No year, no "at" connector: `formatDateTime`'s prose shape is what wrapped
    // the row onto two lines in the desktop detail pane.
    const windowYear = String(new Date(MULTI_DAY_WINDOW.startMs).getFullYear());
    expect(span.first).not.toContain(windowYear);
    expect(span.first).not.toContain(" at ");
  });

  it("keeps bare clock times for a same-day session — the date would be noise", () => {
    const span = getSessionSpan(axisForWindow(SAME_DAY_WINDOW));

    expect(span.first).toBe(formatTime(new Date(SAME_DAY_WINDOW.startMs)));
    expect(span.last).toBe(formatTime(new Date(SAME_DAY_WINDOW.endMs)));
  });

  it("prints ONE precision, and it is the precision of the total between the ticks", () => {
    // Above an hour `formatDuration` is `Hh Mm`, so the ticks round to minutes;
    // under one it is `Mm Ss` / `Ss`, so the ticks must keep seconds. Asserted
    // as tick-vs-total rather than against literals, so the two formatters stay
    // pinned to each other at the boundary.
    const reports = [
      SAME_DAY_WINDOW,
      MULTI_DAY_WINDOW,
      JUST_UNDER_AN_HOUR_WINDOW,
      SUB_MINUTE_WINDOW,
      MINUTE_STRADDLING_WINDOW,
    ].map(tickPrecisionReport);

    expect(
      reports.filter(
        (report) =>
          report.first !== report.total || report.last !== report.total
      )
    ).toEqual([]);
    // …and the set genuinely spans the boundary, so this cannot pass by every
    // sampled window landing on the same side of it.
    expect(reports.some((report) => report.total)).toBe(true);
    expect(reports.some((report) => !report.total)).toBe(true);
  });

  it("never prints two identical ticks with a nonzero span claimed between them", () => {
    // The 47s case: at minute precision both edges rendered `9:04 AM`.
    const subMinute = getSessionSpan(axisForWindow(SUB_MINUTE_WINDOW));
    expect(subMinute.first).not.toBe(subMinute.last);

    // And the cut the other way — `formatTime` truncates, so 9:04:59 → 9:05:01
    // printed ticks a MINUTE apart over a `2s` total.
    const straddling = getSessionSpan(axisForWindow(MINUTE_STRADDLING_WINDOW));
    expect(straddling.first).toMatch(SECONDS_PRECISION_RE);
    expect(straddling.last).toMatch(SECONDS_PRECISION_RE);
  });

  it("renders NOTHING, never the word Unknown, when no instant resolves", () => {
    const span = getSessionSpan(resolveTimelineAxis(NO_RESOLVABLE_INSTANTS));

    expect(span.first).toBe("");
    expect(span.last).toBe("");
  });

  it("drops BOTH ticks when only one edge resolves — half an axis is worse than none", () => {
    // Only a start: no lastActivityAt / endedAt / updatedAt to close the span.
    const halfResolved: SessionTimelineWindowSource = {
      endedAt: null,
      lastActivityAt: undefined,
      startedAt: new Date(SAME_DAY_WINDOW.startMs),
      updatedAt: undefined,
    };

    const span = getSessionSpan(resolveTimelineAxis(halfResolved));

    // A real time opposite a blank reads as a tick that failed to render, and
    // the caption between them still claims a growing total. The centred
    // caption states the span alone instead.
    expect(span.first).toBe("");
    expect(span.last).toBe("");
  });

  it("ignores a persisted session.span", () => {
    // The stored string came from a different writer in a different precision,
    // so letting it through would put ticks the axis never measured beside a
    // total the axis derived — the ISS-4833 shape this closes.
    //
    // ISS-5366 made this STRUCTURAL rather than a matter of discipline:
    // `getSessionSpan` no longer receives the session at all, only the
    // `SessionTimelineWindowState` the axis total is measured from, so there is
    // no `span` field in scope for it to read. What is left to pin is that the
    // FALLBACK state (no usable window) still formats its own two instants.
    const fallbackAxis = {
      end: new Date(SAME_DAY_WINDOW.endMs),
      start: new Date(SAME_DAY_WINDOW.startMs),
      window: null,
    };

    const span = getSessionSpan(fallbackAxis);

    expect(span.first).toBe(formatTime(new Date(SAME_DAY_WINDOW.startMs)));
    expect(span.last).toBe(formatTime(new Date(SAME_DAY_WINDOW.endMs)));
    expect(span.first).not.toBe("stored-first");
    expect(span.last).not.toBe("stored-last");
  });

  /**
   * ISS-5366 (#4579 stage review): the tick and the caption used to resolve the
   * END instant on two DIFFERENT precedences — `getSessionSpan` took the first
   * PARSEABLE of `lastActivityAt, endedAt, updatedAt`, while the total between
   * the ticks measured to `resolveSessionTimelineAxisEnd`, which is
   * `max(endedAt, lastActivityAt) ?? updatedAt`.
   *
   * On a SWEPT session those disagree by hours in the one direction that
   * matters: `endedAt` stamped long after the last real activity. The right tick
   * named `lastActivityAt` while the caption measured to `endedAt`, so the row
   * contradicted itself — exactly what ISS-4833 opened to close.
   *
   * Clock skew (`startedAt` after every end bound) is the documented route to
   * the bare fallback, which is the only branch the divergence ever reached.
   */
  it("resolves the end tick on the SAME precedence as the caption for a swept session", () => {
    const lastActivityAt = new Date(2026, 5, 10, 9, 0, 0);
    const sweptEndedAt = new Date(2026, 5, 10, 17, 0, 0);
    const swept = {
      // Later than both end bounds, so `buildWindow` rejects the window and the
      // row lands on the fallback branch.
      endedAt: sweptEndedAt,
      lastActivityAt,
      startedAt: new Date(2026, 5, 10, 20, 0, 0),
      updatedAt: undefined,
    };

    const axis = resolveTimelineAxis(swept);
    const span = getSessionSpan(axis);

    // The caption is `formatDuration(axis.start, axis.end)`, so pinning the tick
    // to `axis.end` IS pinning it to what the caption measures.
    expect(axis.window).toBeNull();
    expect(new Date(axis.end as Date).getTime()).toBe(sweptEndedAt.getTime());
    expect(span.last).toBe(formatTime(sweptEndedAt));
    // The old first-parseable precedence would have printed this instead.
    expect(span.last).not.toBe(formatTime(lastActivityAt));
  });

  it("keeps the axis a three-cell row with the caption in the middle track and the end tick pushed right", () => {
    const { container } = renderAxis({
      first: "Jun 10, 9:04 AM",
      last: "Jun 14, 2:46 AM",
    });

    const row = container.querySelector<HTMLElement>(AXIS_ROW_SELECTOR);
    const cells = [...(row?.children ?? [])];
    // Equal `1fr` cheeks around an `auto` middle centre the caption BY
    // CONSTRUCTION (`.sd3-act-axis`), so the caption needs no `justify-self` of
    // its own — but that only holds while it really is the MIDDLE of three.
    expect(cells).toHaveLength(3);
    expect(cells[1]).toHaveAttribute("title", SESSION_TIMELINE_AXIS_SPAN_TITLE);
    // The third track is `1fr`, so the end tick would drift left off the axis's
    // right edge without this. It is the row's one placement a jsdom render can
    // assert — no stylesheet is loaded here.
    expect(cells[2]?.className).toContain(END_TICK_CLASS);
  });
});
