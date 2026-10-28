import {
  BranchLastActiveClassification,
  classifyBranchLastActive,
} from "@repo/api/src/types/branch-list-cohort";
import {
  BranchMetricAvailability,
  type BranchMetricComparison,
  BranchMetricComparisonLabel,
  BranchMetricDisclosure,
  BranchMetricPeriod,
  type BranchMetricResult,
  type BranchMetricWindow,
} from "@repo/api/src/types/branch-metrics";
import { pctDelta } from "@repo/loops-api/insights";

const DAY_MS = 24 * 60 * 60 * 1000;

export type AdjacentBranchMetricWindows = {
  period: BranchMetricPeriod;
  label: BranchMetricComparisonLabel;
  current: BranchMetricWindow;
  prior: BranchMetricWindow | null;
  /**
   * The bounds the caller asked for when they are not a preset period, which
   * resolves to all-time. Only the pull-request metrics read it (ISS-11589).
   */
  requested?: BranchMetricWindow;
};

/**
 * Build adjacent half-open UTC periods ending at the supplied pinned instant.
 *
 * `now` is the real current instant, and is what keeps the two periods
 * comparable when `end` is in the FUTURE. Since ISS-5809 the request boundary
 * ends with the in-progress UTC day, so the current window's population runs only
 * as far as `now` while a full-width prior window is complete — which reports the
 * time of day as a WoW/MoM/QoQ trend (a steady org reads ≈ -14% on a 7d period
 * just after UTC midnight, recovering by the next one). The prior window is
 * therefore truncated to the span the current one has actually ELAPSED, so the
 * two cover equal elapsed time rather than merely equal nominal width.
 *
 * Omit `now`, or pass one at/after `end`, and the prior window keeps its full
 * width — a period already fully in the past is unaffected. A period that has not
 * opened yet has no elapsed span and so gets no prior window at all, which
 * `buildBranchMetricComparison` renders as "no comparison" rather than a
 * clock-driven percentage.
 *
 * `currentStartAt` is the start the CALLER actually requested, and it wins over
 * the reconstruction below whenever it is supplied (ISS-9619, whitlockk review).
 * Deriving the start as `end - N*24h` is only correct while a calendar day is
 * exactly 24 hours. A window the classifier admitted at some OTHER width — one
 * with a civil UTC-offset transition inside it, or one admitted by the
 * start-only tolerance arms — then gets a current window that begins at a
 * different instant than the row list was read over, so the summary cards count
 * a span the table never showed. Omit it and the reconstruction stands, which is
 * what every caller holding only a period and an end still gets.
 */
export function buildAdjacentBranchMetricWindows(
  period: BranchMetricPeriod,
  end: Date,
  now?: Date,
  currentStartAt?: Date
): AdjacentBranchMetricWindows {
  const endMs = validEpoch(end);
  if (period === BranchMetricPeriod.All) {
    return {
      period,
      label: BranchMetricComparisonLabel.AllTime,
      current: { startAt: null, endAt: new Date(endMs).toISOString() },
      prior: null,
    };
  }
  const durationMs = periodDays(period) * DAY_MS;
  const currentStartMs =
    currentStartAt === undefined
      ? endMs - durationMs
      : validEpoch(currentStartAt);
  return {
    period,
    label: comparisonLabel(period),
    current: {
      startAt: new Date(currentStartMs).toISOString(),
      endAt: new Date(endMs).toISOString(),
    },
    prior: buildElapsedMatchedPriorWindow(currentStartMs, endMs, now),
  };
}

/** Half-open membership: lower bound inclusive, upper bound exclusive. */
export function isTimestampInBranchMetricWindow(
  timestamp: string | Date | null | undefined,
  window: BranchMetricWindow
): boolean {
  if (timestamp == null) {
    return false;
  }
  const valueMs =
    timestamp instanceof Date ? timestamp.getTime() : parseInstantMs(timestamp);
  const { startMs, endMs } = windowBoundsMs(window);
  if (
    Number.isNaN(valueMs) ||
    Number.isNaN(endMs) ||
    (startMs !== null && Number.isNaN(startMs))
  ) {
    return false;
  }
  return valueMs < endMs && (startMs === null || valueMs >= startMs);
}

/**
 * Whether a half-open interval `[startAt, endAt)` overlaps a window at all.
 *
 * The interval sibling of {@link isTimestampInBranchMetricWindow}, for a
 * shortfall that spans time rather than happening at an instant: a window lying
 * wholly INSIDE the interval contains neither endpoint, so testing the endpoints
 * alone would read it as unaffected. Unparseable bounds answer TRUE, matching
 * how unplaceable evidence is already treated — an interval nobody can locate
 * might belong here.
 */
export function branchMetricWindowOverlapsInterval(
  startAt: string | Date | null | undefined,
  endAt: string | Date | null | undefined,
  window: BranchMetricWindow
): boolean {
  const intervalStartMs = instantMs(startAt);
  const intervalEndMs = instantMs(endAt);
  const { startMs, endMs } = windowBoundsMs(window);
  if (
    intervalStartMs === null ||
    intervalEndMs === null ||
    Number.isNaN(endMs) ||
    (startMs !== null && Number.isNaN(startMs))
  ) {
    return true;
  }
  return (
    intervalStartMs < endMs && (startMs === null || intervalEndMs > startMs)
  );
}

function instantMs(value: string | Date | null | undefined): number | null {
  if (value == null) {
    return null;
  }
  const valueMs =
    value instanceof Date ? value.getTime() : parseInstantMs(value);
  return Number.isNaN(valueMs) ? null : valueMs;
}

type BranchMetricWindowBoundsMs = { startMs: number | null; endMs: number };

/**
 * One window's bounds, parsed once (ISS-10363, tamsinb review on #7448).
 *
 * This predicate is called once per evidence row, and it re-parsed the window's
 * OWN two bounds on every one of those calls — two thirds of its `Date.parse`
 * work was the same two strings, over and over. The series made that matter:
 * twelve sub-window folds over the same evidence multiplied the same waste by
 * twelve. Keyed on the window object, which every caller already holds for the
 * whole fold.
 *
 * A `WeakMap` and not a cache: an entry lives exactly as long as the window
 * object does, so it cannot grow with request volume and there is no sweep to
 * get wrong. The parsed values are what the inline parses produced, `NaN`
 * included, so an unparseable bound still fails the guard above.
 */
const windowBoundsCache = new WeakMap<
  BranchMetricWindow,
  BranchMetricWindowBoundsMs
>();

function windowBoundsMs(
  window: BranchMetricWindow
): BranchMetricWindowBoundsMs {
  const cached = windowBoundsCache.get(window);
  if (cached) {
    return cached;
  }
  const bounds: BranchMetricWindowBoundsMs = {
    startMs: window.startAt === null ? null : parseInstantMs(window.startAt),
    endMs: parseInstantMs(window.endAt),
  };
  windowBoundsCache.set(window, bounds);
  return bounds;
}

/**
 * Compare the two windows whenever BOTH carry a number, over a usable prior.
 *
 * ISS-10540 (reversing the refusal ISS-10208 measured): this returned
 * `Unavailable` the moment either side was `Partial`, and on real data every
 * non-count Branch metric is Partial, so the comparison slot read "No
 * comparison" on every card in every window while both operands were in hand.
 * A percentage off two incomplete-but-real populations is a real percentage,
 * so a comparison that consumed a partial window is itself `Partial` and
 * carries the sentence naming what was short (`deltaPct.disclosure`). That
 * sentence is a WIRE fact, not a rendered one: the card captions the CURRENT
 * window's own disclosure, so a Partial current is disclosed beside the chip
 * and a Complete current over a Partial prior is not — the chip renders under
 * the window label with the prior's shortfall carried on the wire only. Copy
 * for that arm is the operator's call (ISS-10540 PR Key Decisions), not this
 * producer's. Only a side with NO number still stops the comparison:
 * `Unavailable` when a side's evidence is missing, `NotApplicable` when the
 * prior window has nothing usable to divide by.
 *
 * The percentage comes from `pctDelta`, the cross-surface SSOT the Sessions
 * cards already read, rather than arithmetic spelled out here: it rounds to a
 * whole percent (`13` against `9` reaches the chip as `+44%`, not
 * `+44.44444444444444%`) and it declines at the ±999 ceiling (ISS-5003) instead
 * of returning a figure `formatDeltaPct` would render as the `>999%` label that
 * is reserved for a version-skewed producer's clamp.
 */
export function buildBranchMetricComparison(
  label: BranchMetricComparison["label"],
  priorWindow: BranchMetricWindow,
  current: BranchMetricResult<number>,
  prior: BranchMetricResult<number>
): BranchMetricComparison {
  if (!(isMeasuredBranchMetric(current) && isMeasuredBranchMetric(prior))) {
    return {
      label,
      priorWindow,
      deltaPct: { state: absentComparisonState(current, prior), value: null },
    };
  }
  const value = pctDelta(current.value, prior.value);
  // `pctDelta` declines a near-zero base (the zero prior this used to test for
  // itself) and any magnitude at or past its ceiling. Both are "there is no
  // percentage this product asserts here", the state the zero prior already
  // reported, so they stay one branch; the card's placeholder copy is
  // cause-agnostic for that state (`branch-list-comparison-copy.ts`).
  if (value === null) {
    return {
      label,
      priorWindow,
      deltaPct: { state: BranchMetricAvailability.NotApplicable, value: null },
    };
  }
  const disclosure = comparisonDisclosure(current, prior);
  if (disclosure === undefined) {
    return {
      label,
      priorWindow,
      deltaPct: { state: BranchMetricAvailability.Complete, value },
    };
  }
  return {
    label,
    priorWindow,
    deltaPct: { state: BranchMetricAvailability.Partial, value, disclosure },
  };
}

function validEpoch(end: Date): number {
  const epoch = end.getTime();
  if (!Number.isFinite(epoch)) {
    throw new TypeError("Branch metric window requires a valid end instant");
  }
  return epoch;
}

/**
 * The same slice of the period one duration earlier: it OPENS a full period
 * before the current window does — same weekday, same hour — and closes after the
 * span the current window has ELAPSED. Null when none of it has elapsed.
 *
 * Truncating the END rather than sliding the START is the point. Both keep the
 * spans equal, but only this one keeps them at the same PHASE of the period; the
 * other lets ordinary diurnal and weekday shape read as WoW/MoM/QoQ movement.
 * The two windows are therefore not adjacent while the current period is still
 * running, which is what "period-to-date vs. same period-to-date" means.
 */
function buildElapsedMatchedPriorWindow(
  currentStartMs: number,
  currentEndMs: number,
  now: Date | undefined
): BranchMetricWindow | null {
  const nowMs = now === undefined ? currentEndMs : now.getTime();
  const elapsedEndMs = Number.isFinite(nowMs)
    ? Math.min(currentEndMs, nowMs)
    : currentEndMs;
  const elapsedMs = elapsedEndMs - currentStartMs;
  if (elapsedMs <= 0) {
    return null;
  }
  const priorStartMs = currentStartMs - (currentEndMs - currentStartMs);
  return {
    startAt: new Date(priorStartMs).toISOString(),
    endAt: new Date(priorStartMs + elapsedMs).toISOString(),
  };
}

function periodDays(
  period: Exclude<BranchMetricPeriod, typeof BranchMetricPeriod.All>
): number {
  switch (period) {
    case BranchMetricPeriod.SevenDays:
      return 7;
    case BranchMetricPeriod.ThirtyDays:
      return 30;
    case BranchMetricPeriod.SixtyDays:
      return 60;
    case BranchMetricPeriod.NinetyDays:
      return 90;
    default:
      return assertNever(period);
  }
}

function comparisonLabel(
  period: Exclude<BranchMetricPeriod, typeof BranchMetricPeriod.All>
): Exclude<
  BranchMetricComparisonLabel,
  typeof BranchMetricComparisonLabel.AllTime
> {
  switch (period) {
    case BranchMetricPeriod.SevenDays:
      return BranchMetricComparisonLabel.WeekOverWeek;
    case BranchMetricPeriod.ThirtyDays:
      return BranchMetricComparisonLabel.MonthOverMonth;
    case BranchMetricPeriod.SixtyDays:
      return BranchMetricComparisonLabel.PriorSixtyDays;
    case BranchMetricPeriod.NinetyDays:
      return BranchMetricComparisonLabel.QuarterOverQuarter;
    default:
      return assertNever(period);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported Branch metric period: ${String(value)}`);
}

/**
 * Does a Branch belong to the cohort a finite range actually lists?
 *
 * Delegates to `classifyBranchLastActive`, the canonical owner of this rule —
 * the same one Desktop's `filterBranchItemsByWindow` reads, and the peer of the
 * list SQL in `apps/api/app/branches/branch-candidate-read.ts`. Re-deriving the
 * retention arms here is what would let the tile and the pagination footer
 * disagree again the next time the rule moves.
 *
 * An all-time window admits every Branch, which is what makes this safe to apply
 * unconditionally.
 */
export function branchIsInMetricCohortWindow(
  lastActivityAt: string | null | undefined,
  window: BranchMetricWindow,
  evaluationNow: string | null | undefined
): boolean {
  if (window.startAt === null) {
    return true;
  }
  return (
    classifyBranchLastActive(
      { legacy: lastActivityAt ?? null },
      {
        evaluationNow: evaluationNow ?? "",
        startDate: window.startAt,
        endDate: window.endAt,
      }
    ) !== BranchLastActiveClassification.KnownOutOfWindow
  );
}

/**
 * Most distinct instant strings held between clears.
 *
 * Sized for one large org's whole evidence set — the reuse this exists for is
 * WITHIN a fold, where the same rows are re-tested by every predicate and every
 * sub-window, so an entry that outlives its request buys nothing and is simply
 * dropped when the bound is reached.
 */
const INSTANT_CACHE_MAX_ENTRIES = 50_000;
const instantMsCache = new Map<string, number>();

/**
 * `Date.parse`, paid once per distinct instant string (ISS-10363, tamsinb
 * review on #7448).
 *
 * The metric fold visits one evidence row from several predicates — in window,
 * coverage-affecting, trustworthy — and the series re-runs all of them over
 * twelve sub-windows of the same evidence. Measured on a synthetic 400-branch
 * cohort (20k cost rows, 8k LOC rows, 3k pull requests), one 90-day fold made
 * ~1.5M `Date.parse` calls over ~31k distinct instants.
 *
 * `NaN` is cached like any other answer, because an unparseable string is a
 * stable fact about that string and every caller already guards on it. The map
 * is CLEARED rather than evicted one key at a time when it reaches its bound:
 * the reuse this serves is within a single fold, so there is no LRU worth
 * maintaining, and a clear cannot leave the map holding more than the bound.
 */
export function parseInstantMs(value: string): number {
  const cached = instantMsCache.get(value);
  if (cached !== undefined) {
    return cached;
  }
  const parsed = Date.parse(value);
  if (instantMsCache.size >= INSTANT_CACHE_MAX_ENTRIES) {
    instantMsCache.clear();
  }
  instantMsCache.set(value, parsed);
  return parsed;
}

type MeasuredBranchMetricResult = Extract<
  BranchMetricResult<number>,
  { value: number }
>;

/** Did this window produce a number at all? Partial counts — it has one. */
function isMeasuredBranchMetric(
  result: BranchMetricResult<number>
): result is MeasuredBranchMetricResult {
  return (
    result.state === BranchMetricAvailability.Complete ||
    result.state === BranchMetricAvailability.Partial
  );
}

/**
 * Why there is no comparison when a side produced no number.
 *
 * `Unavailable` when EITHER side's evidence could not be read — the placeholder
 * sentence for that state names both sides, so it is true whichever one was
 * short. Otherwise `NotApplicable`: the prior (or, for a `NoData` current over
 * a complete prior, the pair) has nothing to divide. That second shape does not
 * reach a card today — `CanonicalMetricCard` early-returns on a non-numeric
 * current and never renders a comparison beside a value it did not print — and
 * that was equally true before ISS-10540.
 */
function absentComparisonState(
  current: BranchMetricResult<number>,
  prior: BranchMetricResult<number>
):
  | typeof BranchMetricAvailability.Unavailable
  | typeof BranchMetricAvailability.NotApplicable {
  return current.state === BranchMetricAvailability.Unavailable ||
    prior.state === BranchMetricAvailability.Unavailable
    ? BranchMetricAvailability.Unavailable
    : BranchMetricAvailability.NotApplicable;
}

/**
 * The ONE sentence a partial comparison carries, or nothing when both windows
 * were complete.
 *
 * A result carries a single disclosure, so two partial windows naming two
 * different causes cannot both be stated. The current window's sentence wins
 * when it is the only partial one — it is the window the reader is looking at —
 * and two DIFFERENT causes fall back to the sentence that names no cause rather
 * than publishing one of them as though it were the whole story.
 */
function comparisonDisclosure(
  current: MeasuredBranchMetricResult,
  prior: MeasuredBranchMetricResult
): BranchMetricDisclosure | undefined {
  if (current.state === BranchMetricAvailability.Partial) {
    if (
      prior.state === BranchMetricAvailability.Partial &&
      prior.disclosure !== current.disclosure
    ) {
      return BranchMetricDisclosure.DefaultIncomplete;
    }
    return current.disclosure;
  }
  return prior.state === BranchMetricAvailability.Partial
    ? prior.disclosure
    : undefined;
}

/**
 * Whether evidence stamped `occurredAt` can affect this window's totals.
 * Unplaceable evidence answers TRUE: a record that cannot be located in time
 * might belong here, so assuming it elsewhere would hide a gap.
 *
 * ISS-9959 gave it a second caller: both coverage-gap kinds carry the instant of
 * an event their producer OBSERVED, so this is the same exact question for a
 * publication gap and a pull-request gap alike.
 */
export function locEvidenceAffectsWindow(
  occurredAt: string | null,
  window: BranchMetricWindow
): boolean {
  if (!timestampIsTrustworthy(occurredAt)) {
    return true;
  }
  return isTimestampInBranchMetricWindow(occurredAt, window);
}

/**
 * Can this instant be placed in time at all?
 *
 * Lives here, not with the cost evidence that first needed it (marisolashgrove
 * review on #8237): it is a time primitive over `parseInstantMs`, and keeping it
 * in `branch-cost-evidence.ts` made these two modules import each other.
 */
export function timestampIsTrustworthy(occurredAt: string | null): boolean {
  return occurredAt !== null && !Number.isNaN(parseInstantMs(occurredAt));
}
