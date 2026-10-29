/**
 * The Layer-3 window twin: the insights date window, reimplemented from its
 * CONTRACT rather than imported from `local-insights-range`.
 *
 * Split out of `golden-layer3-derive.ts` (ISS-10583) so that file keeps its one
 * job — deriving aggregates from L3 rows — and the window edges, which are the
 * subject under test rather than an input to it, sit alone with the reuse policy
 * that governs them.
 */
import { InsightsPeriod } from "@closedloop-ai/loops-api/insights";

/** The trend cap, declared here rather than imported: the production constant
 *  is part of the contract this module exists to check independently. */
export const TREND_LOOKBACK_DAYS = 90;

export type RangeTwin = {
  startIso: string;
  endIso: string;
  elapsedEndIso: string;
  trendStartIso: string;
  priorStartIso: string;
  priorEndIso: string;
};

/**
 * ISS-10583: the contract is now the STABLE UTC DAY window — the inclusive
 * N-UTC-day span ending with the in-progress UTC day — rather than a rolling
 * instant window ending at `now`. Reimplemented here from that contract, per
 * this module's reuse policy: window edges are the subject under test, so
 * importing the production resolver would make the twin unable to see it move.
 */
export function rangeTwin(period: InsightsPeriod, refIso: string): RangeTwin {
  const now = new Date(refIso);
  const utcMidnight = (dayOffset: number) =>
    new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + dayOffset
      )
    );
  const end = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      23,
      59,
      59,
      999
    )
  );
  const endIso = end.toISOString();
  const elapsedEnd = now.getTime() < end.getTime() ? now : end;
  const elapsedEndIso = elapsedEnd.toISOString();
  const trendDays =
    period === InsightsPeriod.All
      ? TREND_LOOKBACK_DAYS
      : Math.min(Number(period), TREND_LOOKBACK_DAYS);
  const trendStartIso = utcMidnight(-trendDays + 1).toISOString();
  if (period === InsightsPeriod.All) {
    return {
      startIso: new Date(0).toISOString(),
      endIso,
      elapsedEndIso,
      trendStartIso,
      priorStartIso: new Date(0).toISOString(),
      priorEndIso: new Date(0).toISOString(),
    };
  }
  const start = utcMidnight(-Number(period) + 1);
  // One full period earlier at the same phase, closed after the span the
  // current window has elapsed.
  const priorStart = new Date(
    start.getTime() - (end.getTime() - start.getTime() + 1)
  );
  return {
    startIso: start.toISOString(),
    endIso,
    elapsedEndIso,
    trendStartIso,
    priorStartIso: priorStart.toISOString(),
    priorEndIso: new Date(
      priorStart.getTime() + (elapsedEnd.getTime() - start.getTime())
    ).toISOString(),
  };
}
