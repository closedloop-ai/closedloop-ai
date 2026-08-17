import type { InsightsPeriod } from "@closedloop-ai/loops-api/insights";
import {
  BEHAVIORAL_CAUSE_LABELS,
  FAILURE_THROTTLE_SOURCE_LABELS,
  LOSS_CLASS_ORDER,
  LossClass,
  type LostWorkCauseRow,
  type LostWorkInsightsResponse,
  type LostWorkPersonRow,
  type LostWorkSessionRow,
  type LostWorkTotals,
  type LostWorkTrendPoint,
  LostWorkWidget,
} from "@repo/api/src/types/session-analytics";
import { createDbFanoutLimiter } from "@/lib/db-fanout";
import { eachDayKey } from "./lib/daily-buckets";
import {
  fetchLossGrid,
  fetchLossPersonGrid,
  fetchLossTrendGrid,
  fetchLostSessionCandidates,
  type LossPersonGridRow,
  type LossTrendGridRow,
  type LostSessionCandidate,
} from "./lost-work-queries";
import {
  type InsightsScopeContext,
  resolvePeriodRange,
  sessionScopeSql,
} from "./service";
import {
  behavioralCauseOf,
  isLostSession,
  lossClassOf,
} from "./session-analytics-classify";
import { type SignalGridRow, signalsOf } from "./session-analytics-sql";
import { runWidget, unavailableKeysOf, valueOr } from "./widget-fanout";

/**
 * The Lost-work rollup (ISS-4987): wall-clock spent on sessions that produced
 * nothing, attributed to exactly one cause class and NEVER summed into a single
 * headline failure number.
 *
 * Every figure here is derived from the shared classifier in
 * `session-analytics-classify.ts`, so this screen and the TokenOps screen
 * (ISS-4988) cannot disagree about which sessions failed.
 */

const MINUTES_PER_HOUR = 60;
const PERCENT = 100;

/** Below this, a person's baseline half is too thin to grade a change against. */
export const MIN_BASELINE_SESSIONS = 8;

/** Rows shown in the "sessions with no artifact" table. */
export const LOST_SESSION_ROW_LIMIT = 12;

/**
 * Candidates fetched before re-classification. Over-fetched so that rows the
 * SQL prefilter admits but the authoritative TypeScript classifier rejects
 * cannot leave the table short.
 */
const LOST_SESSION_CANDIDATE_MULTIPLE = 2;

function emptyClassRecord(): Record<LossClass, number> {
  return {
    [LossClass.Actionable]: 0,
    [LossClass.Systemic]: 0,
    [LossClass.Unattributed]: 0,
  };
}

function toPercent(part: number, whole: number): number {
  return whole > 0 ? (part / whole) * PERCENT : 0;
}

function minutesOf(row: SignalGridRow): number {
  return signalsOf(row).wallClockMinutes;
}

export function foldTotals(rows: readonly SignalGridRow[]): LostWorkTotals {
  const minutesByClass = emptyClassRecord();
  const sessionsByClass = emptyClassRecord();
  let sessionCount = 0;
  let totalMinutes = 0;
  let productiveMinutes = 0;
  for (const row of rows) {
    const minutes = minutesOf(row);
    sessionCount += row.sessions;
    totalMinutes += minutes;
    const lossClass = lossClassOf(signalsOf(row));
    if (lossClass === null) {
      productiveMinutes += minutes;
      continue;
    }
    minutesByClass[lossClass] += minutes;
    sessionsByClass[lossClass] += row.sessions;
  }
  return {
    minutesByClass,
    productiveMinutes,
    sessionCount,
    sessionsByClass,
    totalMinutes,
  };
}

function upsertCause(
  causes: Map<string, LostWorkCauseRow>,
  key: string,
  label: string,
  minutes: number,
  sessions: number
): void {
  const existing = causes.get(key);
  if (existing) {
    existing.minutes += minutes;
    existing.sessions += sessions;
    return;
  }
  causes.set(key, { key, label, minutes, sessions });
}

function byMinutesDesc(a: LostWorkCauseRow, b: LostWorkCauseRow): number {
  return b.minutes - a.minutes;
}

/** Platform-caused loss, ranked. Nothing here belongs on a person's record. */
export function foldSystemicCauses(
  rows: readonly SignalGridRow[]
): LostWorkCauseRow[] {
  const causes = new Map<string, LostWorkCauseRow>();
  for (const row of rows) {
    const signals = signalsOf(row);
    if (
      lossClassOf(signals) !== LossClass.Systemic ||
      row.throttleSource === null
    ) {
      continue;
    }
    upsertCause(
      causes,
      row.throttleSource,
      FAILURE_THROTTLE_SOURCE_LABELS[row.throttleSource] ?? row.throttleSource,
      signals.wallClockMinutes,
      row.sessions
    );
  }
  return [...causes.values()].sort(byMinutesDesc);
}

/** Coachable loss, ranked by the behavior behind it. */
export function foldBehavioralCauses(
  rows: readonly SignalGridRow[]
): LostWorkCauseRow[] {
  const causes = new Map<string, LostWorkCauseRow>();
  for (const row of rows) {
    const signals = signalsOf(row);
    const cause = behavioralCauseOf(signals);
    if (cause === null) {
      continue;
    }
    upsertCause(
      causes,
      cause,
      BEHAVIORAL_CAUSE_LABELS[cause],
      signals.wallClockMinutes,
      row.sessions
    );
  }
  return [...causes.values()].sort(byMinutesDesc);
}

/**
 * Daily lost hours per class, over EVERY day in the window.
 *
 * The axis is enumerated rather than derived from the rows that came back, the
 * same way every sibling Insights daily series does it. A day with no sessions
 * is an explicit zero, not an absent point: the chart draws its points as
 * adjacent categories and fills between them, so dropping quiet days would put
 * Aug 1 next to Aug 12 and render ten days of nothing as a smooth ramp of
 * continuously accruing lost hours. It also makes the "series sums back to the
 * class totals" invariant hold on a sparse population, not only on a dense one.
 *
 * `days` must be enumerated in the zone the database actually bucketed in (see
 * `fetchLossTrendGrid`), or local-zone axis keys would not line up with UTC row
 * keys near day boundaries and real buckets would be dropped.
 *
 * The values are deliberately NOT rounded here. Rounding each daily bucket let
 * the drift accumulate across the window until the charted series no longer
 * summed to the headline it is split from; display rounding belongs in the
 * chart's value formatter.
 */
export function foldTrend(
  rows: readonly LossTrendGridRow[],
  days: readonly string[]
): LostWorkTrendPoint[] {
  const byDate = new Map<string, Record<LossClass, number>>();
  for (const date of days) {
    byDate.set(date, emptyClassRecord());
  }
  for (const row of rows) {
    let bucket = byDate.get(row.day);
    if (!bucket) {
      // A row outside the enumerated axis can only come from a day-boundary
      // edge; keep it rather than silently dropping loss that was measured.
      bucket = emptyClassRecord();
      byDate.set(row.day, bucket);
    }
    const signals = signalsOf(row);
    const lossClass = lossClassOf(signals);
    if (lossClass !== null) {
      bucket[lossClass] += signals.wallClockMinutes / MINUTES_PER_HOUR;
    }
  }
  return [...byDate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, values]) => ({ date, values }));
}

function toDateKey(day: Date): string {
  return new Date(day).toISOString().slice(0, 10);
}

type PersonAccumulator = {
  engineer: string;
  sessionCount: number;
  totalMinutes: number;
  minutesByClass: Record<LossClass, number>;
  sessionsByClass: Record<LossClass, number>;
  causeMinutes: Map<string, { minutes: number; lossClass: LossClass }>;
  earlySessions: number;
  earlyActionable: number;
  lateSessions: number;
  lateActionable: number;
};

function newAccumulator(engineer: string): PersonAccumulator {
  return {
    causeMinutes: new Map(),
    earlyActionable: 0,
    earlySessions: 0,
    engineer,
    lateActionable: 0,
    lateSessions: 0,
    minutesByClass: emptyClassRecord(),
    sessionCount: 0,
    sessionsByClass: emptyClassRecord(),
    totalMinutes: 0,
  };
}

function causeLabelOf(row: SignalGridRow): string | null {
  if (row.throttleSource !== null) {
    return (
      FAILURE_THROTTLE_SOURCE_LABELS[row.throttleSource] ?? row.throttleSource
    );
  }
  const behavioral = behavioralCauseOf(signalsOf(row));
  return behavioral === null ? null : BEHAVIORAL_CAUSE_LABELS[behavioral];
}

function accumulatePerson(
  accumulator: PersonAccumulator,
  row: LossPersonGridRow
): void {
  const signals = signalsOf(row);
  const minutes = signals.wallClockMinutes;
  const lossClass = lossClassOf(signals);
  const isActionable = lossClass === LossClass.Actionable;
  accumulator.sessionCount += row.sessions;
  accumulator.totalMinutes += minutes;
  if (row.isEarly) {
    accumulator.earlySessions += row.sessions;
    accumulator.earlyActionable += isActionable ? row.sessions : 0;
  } else {
    accumulator.lateSessions += row.sessions;
    accumulator.lateActionable += isActionable ? row.sessions : 0;
  }
  if (lossClass === null) {
    return;
  }
  accumulator.minutesByClass[lossClass] += minutes;
  accumulator.sessionsByClass[lossClass] += row.sessions;
  const cause = causeLabelOf(row);
  if (cause !== null) {
    const existing = accumulator.causeMinutes.get(cause);
    accumulator.causeMinutes.set(cause, {
      lossClass,
      minutes: (existing?.minutes ?? 0) + minutes,
    });
  }
}

/**
 * A person against their OWN earlier baseline, never against the team.
 * Comparing people to each other ranks whoever ran the most sessions; comparing
 * a person to their own trailing half answers "is this getting worse".
 *
 * Returns `null` when either half is too thin to support a verdict. That is a
 * settled dash on screen, never a fabricated 0.
 */
function baselineDelta(accumulator: PersonAccumulator): number | null {
  if (
    accumulator.earlySessions < MIN_BASELINE_SESSIONS ||
    accumulator.lateSessions < MIN_BASELINE_SESSIONS
  ) {
    return null;
  }
  const baseline = toPercent(
    accumulator.earlyActionable,
    accumulator.earlySessions
  );
  const current = toPercent(
    accumulator.lateActionable,
    accumulator.lateSessions
  );
  return Math.round(current - baseline);
}

/**
 * The cause that cost this person the most time, returned WITH the class it
 * belongs to, so a render site cannot show the cause without saying whether it
 * was theirs to prevent.
 */
function dominantCauseOf(accumulator: PersonAccumulator): {
  dominantCause: string | null;
  dominantCauseClass: LossClass;
} {
  let dominantCause: string | null = null;
  let dominantCauseClass: LossClass = LossClass.Unattributed;
  let best = 0;
  for (const [cause, entry] of accumulator.causeMinutes) {
    if (entry.minutes > best) {
      dominantCause = cause;
      dominantCauseClass = entry.lossClass;
      best = entry.minutes;
    }
  }
  return { dominantCause, dominantCauseClass };
}

export function foldPeople(
  rows: readonly LossPersonGridRow[]
): LostWorkPersonRow[] {
  const byUser = new Map<string, PersonAccumulator>();
  for (const row of rows) {
    const key = row.userId ?? `unknown:${row.engineer}`;
    let accumulator = byUser.get(key);
    if (!accumulator) {
      accumulator = newAccumulator(row.engineer);
      byUser.set(key, accumulator);
    }
    accumulatePerson(accumulator, row);
  }
  return [...byUser.entries()]
    .map(([userId, accumulator]) => ({
      actionableMinutes: accumulator.minutesByClass[LossClass.Actionable],
      actionableRatePct: toPercent(
        accumulator.sessionsByClass[LossClass.Actionable],
        accumulator.sessionCount
      ),
      actionableSessions: accumulator.sessionsByClass[LossClass.Actionable],
      baselineDeltaPts: baselineDelta(accumulator),
      ...dominantCauseOf(accumulator),
      engineer: accumulator.engineer,
      sessionCount: accumulator.sessionCount,
      systemicMinutes: accumulator.minutesByClass[LossClass.Systemic],
      systemicSessions: accumulator.sessionsByClass[LossClass.Systemic],
      totalMinutes: accumulator.totalMinutes,
      unattributedMinutes: accumulator.minutesByClass[LossClass.Unattributed],
      unattributedSessions: accumulator.sessionsByClass[LossClass.Unattributed],
      userId,
    }))
    .sort((a, b) => b.actionableMinutes - a.actionableMinutes);
}

/**
 * Re-classifies each SQL candidate with the authoritative TypeScript
 * classifier and drops any the classifier rejects, so the SQL prefilter can
 * never widen what the screen calls lost work.
 */
export function toLostSessionRows(
  candidates: readonly LostSessionCandidate[],
  limit: number
): LostWorkSessionRow[] {
  const rows: LostWorkSessionRow[] = [];
  for (const candidate of candidates) {
    const signals = {
      endsWithError: candidate.endsWithError,
      hasFailureThrottle: candidate.throttleSource !== null,
      producedArtifact: candidate.producedArtifact,
      state: candidate.state,
      wallClockMinutes: Number(candidate.minutes ?? 0),
    };
    const lossClass = lossClassOf(signals);
    if (!isLostSession(signals) || lossClass === null) {
      continue;
    }
    rows.push({
      cause: candidateCause(candidate) ?? "Not recorded",
      date: toDateKey(candidate.startedAt),
      engineer: candidate.engineer,
      id: candidate.id,
      lossClass,
      minutes: signals.wallClockMinutes,
      repo: candidate.repositoryFullName ?? "Unknown repository",
      title: candidate.name ?? "Untitled session",
    });
    if (rows.length === limit) {
      break;
    }
  }
  return rows;
}

function candidateCause(candidate: LostSessionCandidate): string | null {
  if (candidate.throttleSource !== null) {
    return (
      FAILURE_THROTTLE_SOURCE_LABELS[candidate.throttleSource] ??
      candidate.throttleSource
    );
  }
  const behavioral = behavioralCauseOf({
    endsWithError: candidate.endsWithError,
    hasFailureThrottle: false,
    producedArtifact: candidate.producedArtifact,
    state: candidate.state,
    wallClockMinutes: Number(candidate.minutes ?? 0),
  });
  return behavioral === null ? null : BEHAVIORAL_CAUSE_LABELS[behavioral];
}

function emptyTotals(): LostWorkTotals {
  return {
    minutesByClass: emptyClassRecord(),
    productiveMinutes: 0,
    sessionCount: 0,
    sessionsByClass: emptyClassRecord(),
    totalMinutes: 0,
  };
}

/** Midpoint of the baseline window, splitting each person's early and late halves. */
function baselineSplit(start: Date, end: Date): Date {
  return new Date((start.getTime() + end.getTime()) / 2);
}

/**
 * Fetch the whole Lost-work screen.
 *
 * The four reads fan out through ONE shared limiter — bounds compose by
 * addition, so a per-read limiter would multiply the in-flight query budget —
 * and each settles independently. A widget whose read fails is reported in
 * `unavailableWidgets` and renders as a dash with a reason; it never blanks the
 * page and never degrades into a `0`, which on this surface would read as "no
 * problem here".
 */
export async function fetchLostWork(
  ctx: InsightsScopeContext,
  period: InsightsPeriod,
  now: Date = new Date()
): Promise<LostWorkInsightsResponse> {
  const range = resolvePeriodRange(period, now);
  const scopeSql = sessionScopeSql(ctx);
  const limiter = createDbFanoutLimiter();
  const correlation = {
    organizationId: ctx.organizationId,
    scope: ctx.scope,
    userId: ctx.userId,
  };

  const [grid, trend, people, candidates] = await Promise.all([
    runWidget(
      limiter,
      LostWorkWidget.Totals,
      () => fetchLossGrid(scopeSql, range.start, range.end),
      correlation
    ),
    runWidget(
      limiter,
      LostWorkWidget.Trend,
      () =>
        fetchLossTrendGrid(scopeSql, range.trendStart, range.end, ctx.timeZone),
      correlation
    ),
    // The person grid reads the SAME window as the totals grid above, so the
    // rows sum back to the headline they sit under. Reading the trend window
    // here instead would, on period "all", cover the last 90 days while the
    // attribution strip directly above covered all time — a per-engineer table
    // that silently falls short of the total it appears to decompose, with no
    // date axis to reveal the narrower window.
    runWidget(
      limiter,
      LostWorkWidget.People,
      () =>
        fetchLossPersonGrid(
          scopeSql,
          range.start,
          range.end,
          baselineSplit(range.start, range.end)
        ),
      correlation
    ),
    runWidget(
      limiter,
      LostWorkWidget.LostSessions,
      () =>
        fetchLostSessionCandidates(
          scopeSql,
          range.start,
          range.end,
          LOST_SESSION_ROW_LIMIT * LOST_SESSION_CANDIDATE_MULTIPLE
        ),
      correlation
    ),
  ]);

  const gridRows = valueOr(grid, []);
  // Enumerate the trend axis in the zone the DB actually bucketed in. When the
  // read failed there is no bucketedZone to trust, so fall back to the
  // requested one — the widget settles unavailable either way.
  const trendResult = valueOr(trend, {
    bucketedZone: ctx.timeZone,
    rows: [],
  });
  const trendDays = eachDayKey(
    range.trendStart,
    range.end,
    trendResult.bucketedZone
  );
  // The totals grid feeds three widgets: it IS one rollup read, so when it
  // fails all three settle unavailable together rather than one of them
  // silently rendering an empty list that would read as "no failures".
  const unavailableWidgets: LostWorkWidget[] = unavailableKeysOf([
    trend,
    people,
    candidates,
  ]);
  if (!grid.ok) {
    unavailableWidgets.push(
      LostWorkWidget.Totals,
      LostWorkWidget.SystemicCauses,
      LostWorkWidget.BehavioralCauses
    );
  }

  return {
    behavioralCauses: foldBehavioralCauses(gridRows),
    lostSessions: toLostSessionRows(
      valueOr(candidates, []),
      LOST_SESSION_ROW_LIMIT
    ),
    people: foldPeople(valueOr(people, [])),
    systemicCauses: foldSystemicCauses(gridRows),
    totals: grid.ok ? foldTotals(gridRows) : emptyTotals(),
    trend: trend.ok ? foldTrend(trendResult.rows, trendDays) : [],
    unavailableWidgets,
  };
}

/** Presentation order for the loss classes. Re-exported for the render layer. */
export const LOST_WORK_CLASS_ORDER = LOSS_CLASS_ORDER;
