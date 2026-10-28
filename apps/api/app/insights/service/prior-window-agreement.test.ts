import { stableUtcPriorWindow } from "@closedloop-ai/loops-api/stable-utc-window";
import { describe, expect, it } from "vitest";
import { resolvePriorUsageWindow } from "@/app/agent-sessions/service/usage-comparison";

/**
 * ISS-10583 — the mechanical guard that the insights prior window and the
 * Sessions prior window are the SAME rule.
 *
 * The rule (one full period back at the same phase, closed after the elapsed
 * span) has two owners that predate this ticket: `resolvePriorUsageWindow` for
 * the Sessions summary cards and `buildAdjacentBranchMetricWindows` for the
 * Branches ones. The insights dashboard now holds it too, through
 * `stableUtcPriorWindow`. Prose in three headers saying they agree is not a
 * guard — this is, and it is the point of the ticket: those surfaces answer for
 * the same "Last 7 days", so if one copy's phase rule ever moves without the
 * others, the two surfaces silently disagree again.
 *
 * `buildAdjacentBranchMetricWindows` is deliberately NOT compared here: its
 * windows are half-open, so it omits the `+ 1` these two carry, and the
 * arithmetic is only equivalent once that convention is accounted for.
 *
 * A GUARD AND NOT A MERGE, deliberately — do not "fix" the duplication this
 * pins. Collapsing `resolvePriorUsageWindow` onto `stableUtcPriorWindow` would
 * change a heavily-tested Sessions path to satisfy a DRY argument, and the two
 * genuinely differ at `elapsedEnd === start`: this helper declines, that one
 * returns a zero-width window. Adopting either semantics for both would then
 * diverge from `buildAdjacentBranchMetricWindows`, which uses the stricter
 * guard — one drift traded for another, across more code. A test that fails
 * when they disagree costs nothing and moves nothing.
 */
const CASES: { name: string; start: string; end: string; now: string }[] = [
  {
    name: "7 UTC days, midday",
    start: "2026-09-11T00:00:00.000Z",
    end: "2026-09-17T23:59:59.999Z",
    now: "2026-09-17T12:00:00.000Z",
  },
  {
    name: "7 UTC days, just after UTC midnight",
    start: "2026-09-11T00:00:00.000Z",
    end: "2026-09-17T23:59:59.999Z",
    now: "2026-09-17T00:00:00.001Z",
  },
  {
    name: "30 UTC days across a month boundary",
    start: "2026-08-19T00:00:00.000Z",
    end: "2026-09-17T23:59:59.999Z",
    now: "2026-09-17T18:30:00.000Z",
  },
  {
    name: "90 UTC days across a year boundary",
    start: "2025-12-02T00:00:00.000Z",
    end: "2026-03-01T23:59:59.999Z",
    now: "2026-03-01T06:00:00.000Z",
  },
  {
    name: "a window already fully in the past",
    start: "2026-09-11T00:00:00.000Z",
    end: "2026-09-17T23:59:59.999Z",
    now: "2026-10-01T00:00:00.000Z",
  },
];

describe("the insights and Sessions prior windows are one rule (ISS-10583)", () => {
  it.each(CASES)("$name", ({ start, end, now }) => {
    const sessions = resolvePriorUsageWindow(start, end, new Date(now));
    const insights = stableUtcPriorWindow(
      new Date(start),
      new Date(end),
      new Date(Math.min(Date.parse(now), Date.parse(end)))
    );
    // Both must answer, and answer the same instants. A null on either side is
    // itself a disagreement worth failing on, which is why this is not guarded.
    expect({
      startDate: insights?.start.toISOString(),
      endDate: insights?.end.toISOString(),
    }).toEqual({
      startDate: sessions?.startDate,
      endDate: sessions?.endDate,
    });
    expect(sessions).not.toBeNull();
  });
});
