import {
  BEHAVIORAL_CAUSE_LABELS,
  behavioralCauseOf,
  isLostSession,
  LOSS_CLASS_ORDER,
  LossClass,
  lossClassOf,
  MOCK_SESSIONS,
  type MockSession,
  minutesToHours,
  ORG_USAGE_LIMIT_DATE,
  RANGE_DAY_COUNT,
  THROTTLE_SOURCE_LABELS,
  toPercent,
} from "@/lib/analytics/session-fixture";

/**
 * Derivations for the lost-work screen. Everything here is computed from the
 * shared `MOCK_SESSIONS` population so this screen and the TokenOps screen
 * cannot drift on which sessions failed.
 *
 * A LOST session is one that consumed wall-clock and yielded no artifact. Its
 * cause is attributed to exactly one class and the classes are never summed
 * into a single headline figure.
 */

export type LossTotals = {
  sessionCount: number;
  totalMinutes: number;
  /** Minutes in sessions that DID yield an artifact. */
  productiveMinutes: number;
  minutesByClass: Record<LossClass, number>;
  sessionsByClass: Record<LossClass, number>;
};

export type TrendPoint = {
  date: string;
  values: Record<string, number | null>;
};

export type PersonRow = {
  engineer: string;
  sessionCount: number;
  totalMinutes: number;
  actionableMinutes: number;
  actionableSessions: number;
  systemicMinutes: number;
  systemicSessions: number;
  unattributedMinutes: number;
  unattributedSessions: number;
  /** Actionable lost sessions as a share of everything they ran. */
  actionableRatePct: number;
  /**
   * Change in actionable loss rate against this person's own first-half
   * baseline, in percentage points. `null` when the baseline half holds too
   * few sessions to say anything, which renders as a dash and never as 0.
   */
  baselineDeltaPts: number | null;
  dominantCause: string | null;
  /** Class of `dominantCause`, so the label can never be read as coachable when it is not. */
  dominantCauseClass: LossClass;
};

export type CauseRow = {
  key: string;
  label: string;
  minutes: number;
  sessions: number;
};

export type LostSessionRow = {
  id: string;
  title: string;
  engineer: string;
  repo: string;
  project: string;
  date: string;
  minutes: number;
  lossClass: LossClass;
  cause: string;
};

/** Below this, a person's baseline half is too thin to grade a change against. */
const MIN_BASELINE_SESSIONS = 8;
const BASELINE_SPLIT = RANGE_DAY_COUNT / 2;

export const lossTotals: LossTotals = buildTotals(MOCK_SESSIONS);
export const trendPoints: readonly TrendPoint[] = buildTrend(MOCK_SESSIONS);
export const personRows: readonly PersonRow[] = buildPersonRows(MOCK_SESSIONS);
export const systemicCauses: readonly CauseRow[] =
  buildSystemicCauses(MOCK_SESSIONS);
export const behavioralCauses: readonly CauseRow[] =
  buildBehavioralCauses(MOCK_SESSIONS);
export const lostSessionRows: readonly LostSessionRow[] =
  buildLostSessionRows(MOCK_SESSIONS);

/** The out-of-band event the trend chart annotates. */
export const orgUsageLimitDate = ORG_USAGE_LIMIT_DATE;

export function actionableHours(): number {
  return minutesToHours(lossTotals.minutesByClass[LossClass.Actionable]);
}

export function systemicHours(): number {
  return minutesToHours(lossTotals.minutesByClass[LossClass.Systemic]);
}

export function unattributedHours(): number {
  return minutesToHours(lossTotals.minutesByClass[LossClass.Unattributed]);
}

export function totalHours(): number {
  return minutesToHours(lossTotals.totalMinutes);
}

export function productiveHours(): number {
  return minutesToHours(lossTotals.productiveMinutes);
}

/** Actionable lost sessions as a share of every session in the window. */
export function actionableRatePct(): number {
  return toPercent(
    lossTotals.sessionsByClass[LossClass.Actionable],
    lossTotals.sessionCount
  );
}

function emptyClassRecord(): Record<LossClass, number> {
  return {
    [LossClass.Actionable]: 0,
    [LossClass.Systemic]: 0,
    [LossClass.Unattributed]: 0,
  };
}

function buildTotals(sessions: readonly MockSession[]): LossTotals {
  const minutesByClass = emptyClassRecord();
  const sessionsByClass = emptyClassRecord();
  let totalMinutes = 0;
  let productiveMinutes = 0;
  for (const session of sessions) {
    totalMinutes += session.wallClockMinutes;
    const lossClass = lossClassOf(session);
    if (lossClass === null) {
      productiveMinutes += session.wallClockMinutes;
      continue;
    }
    minutesByClass[lossClass] += session.wallClockMinutes;
    sessionsByClass[lossClass] += 1;
  }
  return {
    minutesByClass,
    productiveMinutes,
    sessionCount: sessions.length,
    sessionsByClass,
    totalMinutes,
  };
}

function buildTrend(sessions: readonly MockSession[]): TrendPoint[] {
  const byDate = new Map<string, Record<LossClass, number>>();
  for (const session of sessions) {
    const lossClass = lossClassOf(session);
    if (lossClass === null) {
      continue;
    }
    let bucket = byDate.get(session.date);
    if (!bucket) {
      bucket = emptyClassRecord();
      byDate.set(session.date, bucket);
    }
    bucket[lossClass] += session.wallClockMinutes;
  }
  const dates = [...new Set(sessions.map((session) => session.date))].sort();
  return dates.map((date) => {
    const bucket = byDate.get(date) ?? emptyClassRecord();
    const values: Record<string, number | null> = {};
    for (const lossClass of LOSS_CLASS_ORDER) {
      // Deliberately NOT rounded here. Rounding each of the 30 daily buckets to
      // a tenth of an hour let the drift accumulate to about four minutes, so
      // the charted series no longer summed to the headline it is split from.
      // Display rounding belongs in the chart's value formatter, not in the
      // data the totals are read against.
      values[lossClass] = minutesToHours(bucket[lossClass]);
    }
    return { date, values };
  });
}

type PersonAccumulator = {
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

function newAccumulator(): PersonAccumulator {
  return {
    causeMinutes: new Map(),
    earlyActionable: 0,
    earlySessions: 0,
    lateActionable: 0,
    lateSessions: 0,
    minutesByClass: emptyClassRecord(),
    sessionCount: 0,
    sessionsByClass: emptyClassRecord(),
    totalMinutes: 0,
  };
}

function buildPersonRows(sessions: readonly MockSession[]): PersonRow[] {
  const byEngineer = new Map<string, PersonAccumulator>();
  const dates = [...new Set(sessions.map((session) => session.date))].sort();
  const splitDate = dates[Math.floor(BASELINE_SPLIT)] ?? dates[0];
  for (const session of sessions) {
    let accumulator = byEngineer.get(session.engineer);
    if (!accumulator) {
      accumulator = newAccumulator();
      byEngineer.set(session.engineer, accumulator);
    }
    accumulateSession(accumulator, session, splitDate);
  }
  return [...byEngineer.entries()]
    .map(([engineer, accumulator]) => toPersonRow(engineer, accumulator))
    .sort((a, b) => b.actionableMinutes - a.actionableMinutes);
}

function accumulateSession(
  accumulator: PersonAccumulator,
  session: MockSession,
  splitDate: string
): void {
  accumulator.sessionCount += 1;
  accumulator.totalMinutes += session.wallClockMinutes;
  const lossClass = lossClassOf(session);
  const isActionable = lossClass === LossClass.Actionable;
  if (session.date < splitDate) {
    accumulator.earlySessions += 1;
    accumulator.earlyActionable += isActionable ? 1 : 0;
  } else {
    accumulator.lateSessions += 1;
    accumulator.lateActionable += isActionable ? 1 : 0;
  }
  if (lossClass === null) {
    return;
  }
  accumulator.minutesByClass[lossClass] += session.wallClockMinutes;
  accumulator.sessionsByClass[lossClass] += 1;
  const cause = causeLabelOf(session);
  if (cause !== null) {
    const existing = accumulator.causeMinutes.get(cause);
    accumulator.causeMinutes.set(cause, {
      lossClass,
      minutes: (existing?.minutes ?? 0) + session.wallClockMinutes,
    });
  }
}

function toPersonRow(
  engineer: string,
  accumulator: PersonAccumulator
): PersonRow {
  return {
    actionableMinutes: accumulator.minutesByClass[LossClass.Actionable],
    actionableRatePct: toPercent(
      accumulator.sessionsByClass[LossClass.Actionable],
      accumulator.sessionCount
    ),
    actionableSessions: accumulator.sessionsByClass[LossClass.Actionable],
    baselineDeltaPts: baselineDelta(accumulator),
    ...dominantCause(accumulator.causeMinutes),
    engineer,
    sessionCount: accumulator.sessionCount,
    systemicMinutes: accumulator.minutesByClass[LossClass.Systemic],
    systemicSessions: accumulator.sessionsByClass[LossClass.Systemic],
    totalMinutes: accumulator.totalMinutes,
    unattributedMinutes: accumulator.minutesByClass[LossClass.Unattributed],
    unattributedSessions: accumulator.sessionsByClass[LossClass.Unattributed],
  };
}

/**
 * A person against their OWN earlier baseline, not against the team. Comparing
 * people to each other ranks whoever ran the most sessions; comparing a person
 * to their own trailing half answers "is this getting worse".
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
 * belongs to. The two travel together so a render site cannot show the cause
 * without saying whether it was theirs to prevent.
 */
function dominantCause(
  causeMinutes: Map<string, { minutes: number; lossClass: LossClass }>
): { dominantCause: string | null; dominantCauseClass: LossClass } {
  let best: string | null = null;
  let bestClass: LossClass = LossClass.Unattributed;
  let bestMinutes = 0;
  for (const [cause, entry] of causeMinutes) {
    if (entry.minutes > bestMinutes) {
      best = cause;
      bestClass = entry.lossClass;
      bestMinutes = entry.minutes;
    }
  }
  return { dominantCause: best, dominantCauseClass: bestClass };
}

function buildSystemicCauses(sessions: readonly MockSession[]): CauseRow[] {
  const rows = new Map<string, CauseRow>();
  for (const session of sessions) {
    if (
      lossClassOf(session) !== LossClass.Systemic ||
      !session.throttleSource
    ) {
      continue;
    }
    upsertCause(
      rows,
      session.throttleSource,
      THROTTLE_SOURCE_LABELS[session.throttleSource],
      session.wallClockMinutes
    );
  }
  return [...rows.values()].sort((a, b) => b.minutes - a.minutes);
}

function buildBehavioralCauses(sessions: readonly MockSession[]): CauseRow[] {
  const rows = new Map<string, CauseRow>();
  for (const session of sessions) {
    const cause = behavioralCauseOf(session);
    if (cause === null) {
      continue;
    }
    upsertCause(
      rows,
      cause,
      BEHAVIORAL_CAUSE_LABELS[cause],
      session.wallClockMinutes
    );
  }
  return [...rows.values()].sort((a, b) => b.minutes - a.minutes);
}

function upsertCause(
  rows: Map<string, CauseRow>,
  key: string,
  label: string,
  minutes: number
): void {
  const existing = rows.get(key);
  if (existing) {
    existing.minutes += minutes;
    existing.sessions += 1;
    return;
  }
  rows.set(key, { key, label, minutes, sessions: 1 });
}

function causeLabelOf(session: MockSession): string | null {
  if (session.throttleSource !== null) {
    return THROTTLE_SOURCE_LABELS[session.throttleSource];
  }
  const behavioral = behavioralCauseOf(session);
  if (behavioral !== null) {
    return BEHAVIORAL_CAUSE_LABELS[behavioral];
  }
  return null;
}

function buildLostSessionRows(
  sessions: readonly MockSession[]
): LostSessionRow[] {
  return sessions
    .filter((session) => isLostSession(session))
    .map((session) => ({
      cause: causeLabelOf(session) ?? "Not recorded",
      date: session.date,
      engineer: session.engineer,
      id: session.id,
      lossClass: lossClassOf(session) ?? LossClass.Unattributed,
      minutes: session.wallClockMinutes,
      project: session.project,
      repo: session.repo,
      title: session.title,
    }))
    .sort((a, b) => b.minutes - a.minutes);
}
