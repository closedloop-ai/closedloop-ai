import {
  type InsightsPeriod,
  SPEND_OUTCOME_ORDER,
  SpendOutcome,
} from "@closedloop-ai/loops-api/insights";
import {
  type ModelRightSizingRow,
  ModelVerdict,
  type RecoverableWasteEstimate,
  type SpendOutcomeRow,
  type TokenOpsWasteInsightsResponse,
  TokenOpsWidget,
} from "@repo/api/src/types/session-analytics";
import { createDbFanoutLimiter } from "@/lib/db-fanout";
import { resolvePeriodRange } from "./service/period";
import { type InsightsScopeContext, sessionScopeSql } from "./service/scope";
import {
  isLostSession,
  isRecoverableWasteBasis,
  type OutcomeSignals,
  outcomeOf,
} from "./session-analytics-classify";
import {
  fetchModelMedianTokens,
  fetchModelSpendGrid,
  fetchSpendGrid,
  type ModelMedianRow,
  type ModelSpendGridRow,
  type SpendGridRow,
} from "./tokenops-waste-queries";
import { runWidget, unavailableKeysOf, valueOr } from "./widget-fanout";

/**
 * The TokenOps waste-vs-leverage rollup (ISS-4988).
 *
 * Measured fact first, judgment second. The outcome split is a measurement; the
 * recoverable-waste figure is an ESTIMATE and is reported as a range with its
 * basis, its assumption, and the spend it deliberately excluded, so it can
 * never be mistaken for a measurement.
 *
 * Failure is keyed on the same shared classifier the Lost-work screen uses, so
 * the two cannot disagree about which sessions failed.
 */

const CENTS = 100;
const PERCENT = 100;
const TOKENS_PER_MILLION = 1_000_000;
const HALF = 2;

/**
 * The recovery assumption behind the estimate, stated here once and sent with
 * the estimate so no render site restates it differently. These are the reason
 * the headline is a RANGE: we do not know how much of a failed run's spend
 * would have been re-spent on the retry anyway.
 */
export const RECOVERY_LOW_RATE = 0.35;
export const RECOVERY_HIGH_RATE = 0.7;

/** Below this many sessions a model gets no verdict at all. */
export const MIN_GRADED_SESSIONS = 12;

/**
 * Over-powered: costs this many times the fleet's median rate per million
 * tokens WHILE being pointed at smaller-than-median jobs. Rate alone is not the
 * signal — a premium model on genuinely hard work is earning its price; the
 * same model on small work is not.
 *
 * The two halves are measured over DIFFERENT token bases, and that split is
 * load-bearing: the rate divides spend by every billed token so its population
 * matches the dollars, while the job-size proxy counts first-pass tokens only so
 * replaying one cached prefix is not counted as a bigger job. Grading both over
 * one all-inclusive total made them move together with a harness's cache reuse
 * rather than with price and job size, which left cache-heavy models
 * structurally unable to earn this verdict — see `BILLED_TOKEN_SUM` and
 * `WORK_TOKEN_SUM` in `tokenops-waste-queries.ts` (ISS-5189).
 */
export const OVERPOWERED_RATE_MULTIPLE = 3;

/**
 * Under-powered: fails this many times more often than the fleet, so its cheap
 * rate is being handed back in retries.
 */
export const UNDERPOWERED_ERROR_MULTIPLE = 1.4;

function round2(value: number): number {
  return Math.round(value * CENTS) / CENTS;
}

function signalsOfSpendRow(row: SpendGridRow): OutcomeSignals {
  return {
    endsWithError: row.endsWithError,
    producedArtifact: row.producedArtifact,
    status: row.status,
    // The grid groups on this predicate, so the bucket is homogeneous: every
    // session in it either consumed wall-clock or none of them did.
    wallClockMinutes: row.hasWallClock ? 1 : 0,
  };
}

function usdOf(row: SpendGridRow): number {
  return Number(row.usd ?? 0);
}

/**
 * Total spend split into exactly the three outcome buckets, in fixed order so
 * they never reshuffle between reads. Rounded ONCE, here, so the split and the
 * model breakdown reconcile to the same total.
 */
export function foldOutcomeRows(
  rows: readonly SpendGridRow[]
): SpendOutcomeRow[] {
  const usdByOutcome = new Map<SpendOutcome, number>();
  const sessionsByOutcome = new Map<SpendOutcome, number>();
  for (const row of rows) {
    const outcome = outcomeOf(signalsOfSpendRow(row));
    usdByOutcome.set(outcome, (usdByOutcome.get(outcome) ?? 0) + usdOf(row));
    sessionsByOutcome.set(
      outcome,
      (sessionsByOutcome.get(outcome) ?? 0) + row.sessions
    );
  }
  return SPEND_OUTCOME_ORDER.map((outcome) => ({
    outcome,
    sessions: sessionsByOutcome.get(outcome) ?? 0,
    usd: round2(usdByOutcome.get(outcome) ?? 0),
  }));
}

/**
 * The judgment half, kept visibly separate from the facts above it.
 *
 * Basis: spend on sessions that ended with a recorded error AND lost the work.
 * Outcome-unknown spend is excluded outright and the excluded amount is
 * reported, because we cannot claim a session wasted money when we never
 * observed that it failed.
 *
 * The EXCLUDED figure counts only outcome-unknown sessions that also lost the
 * work — the same population the Lost-work screen calls Unattributed. An
 * unknown-outcome session that shipped a PR and finished fine was never a
 * candidate for the basis, so folding its spend in would describe it on screen
 * as waste the estimate "had to leave out". On an org with many pre-ISS-4586
 * rows that would let a healthy screen read as unmeasurable.
 */
export function foldWasteEstimate(
  rows: readonly SpendGridRow[]
): RecoverableWasteEstimate {
  let errorOutcomeUsd = 0;
  let sessions = 0;
  let excludedUnknownUsd = 0;
  for (const row of rows) {
    const signals = signalsOfSpendRow(row);
    if (outcomeOf(signals) === SpendOutcome.Unknown) {
      if (isLostSession(signals)) {
        excludedUnknownUsd += usdOf(row);
      }
      continue;
    }
    if (isRecoverableWasteBasis(signals)) {
      errorOutcomeUsd += usdOf(row);
      sessions += row.sessions;
    }
  }
  return {
    errorOutcomeUsd: round2(errorOutcomeUsd),
    excludedUnknownUsd: round2(excludedUnknownUsd),
    highRate: RECOVERY_HIGH_RATE,
    highUsd: round2(errorOutcomeUsd * RECOVERY_HIGH_RATE),
    lowRate: RECOVERY_LOW_RATE,
    lowUsd: round2(errorOutcomeUsd * RECOVERY_LOW_RATE),
    sessions,
  };
}

type ModelAccumulator = {
  usd: number;
  errorOutcomeUsd: number;
  sessions: number;
  tokens: number;
};

type FleetBaseline = {
  errorShare: number;
  medianRate: number;
  medianSessionTokens: number;
};

/**
 * One model's two medians, kept apart all the way to the projection.
 *
 * `null` is "no median for this model", NOT zero, and it is never coerced to
 * one on the way to the verdict. A fabricated `0` was strictly worse than
 * unknown here: it satisfies the Over-powered small-jobs guard
 * (`0 < fleet.medianSessionTokens` for any positive fleet median), so a model
 * whose median simply failed to come back would have been convicted of running
 * small jobs on no evidence. The narrowed work basis also makes a REAL `0`
 * easier to reach — only input, output and cache writes have to be zero — so
 * the sentinel and the measurement would no longer be distinguishable.
 */
type ModelMedians = {
  /** Billed basis. Feeds the retired wire field only, never the verdict. */
  billed: number | null;
  /** New-work basis. The job-size half of the verdict, and what the screen renders. */
  work: number | null;
};

function shareOf(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0;
}

function median(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / HALF);
  if (sorted.length % HALF === 1) {
    return sorted[middle];
  }
  return (sorted[middle - 1] + sorted[middle]) / HALF;
}

/**
 * The blended price this model actually charged: spend over every token that
 * spend paid for. Numerator and denominator cover the same population by
 * construction — `estimated_cost` prices all four token classes and exposes no
 * per-class breakdown, so any narrower denominator would report a rate for a
 * bill it does not describe (ISS-5189). The job-size half of the verdict is the
 * separate `medianWorkTokens` basis, not this one.
 */
function ratePerMillion(accumulator: ModelAccumulator): number {
  return accumulator.tokens > 0
    ? (accumulator.usd / accumulator.tokens) * TOKENS_PER_MILLION
    : 0;
}

function accumulateModels(
  rows: readonly ModelSpendGridRow[]
): Map<string, ModelAccumulator> {
  const byModel = new Map<string, ModelAccumulator>();
  for (const row of rows) {
    let accumulator = byModel.get(row.model);
    if (!accumulator) {
      accumulator = { errorOutcomeUsd: 0, sessions: 0, tokens: 0, usd: 0 };
      byModel.set(row.model, accumulator);
    }
    accumulator.sessions += row.sessions;
    accumulator.usd += usdOf(row);
    accumulator.tokens += Number(row.tokens ?? 0);
    if (outcomeOf(signalsOfSpendRow(row)) === SpendOutcome.Errored) {
      accumulator.errorOutcomeUsd += usdOf(row);
    }
  }
  return byModel;
}

/**
 * The fleet baselines every verdict is measured against. Only models with
 * enough sessions contribute, so a four-session trial cannot move the bar it is
 * then judged by.
 */
function fleetBaselineOf(
  byModel: Map<string, ModelAccumulator>,
  medians: Map<string, ModelMedians>
): FleetBaseline {
  const graded = [...byModel.entries()].filter(
    ([, accumulator]) => accumulator.sessions >= MIN_GRADED_SESSIONS
  );
  return {
    errorShare: shareOf(
      graded.reduce((sum, [, item]) => sum + item.errorOutcomeUsd, 0),
      graded.reduce((sum, [, item]) => sum + item.usd, 0)
    ),
    medianRate: median(graded.map(([, item]) => ratePerMillion(item))),
    // Models with no work median are DROPPED from the baseline rather than
    // folded in as zeros. A zero here is not a neutral placeholder: it drags
    // the fleet's median job size down and makes every OTHER model look large
    // by comparison, which suppresses the verdict fleet-wide on a read that
    // partially failed. `median([])` is 0, so a fleet with no medians at all
    // withholds the Over-powered verdict instead of handing it out.
    medianSessionTokens: median(workMediansOf(graded, medians)),
  };
}

function resolveVerdict(
  model: { rate: number; errorShare: number; medianWorkTokens: number | null },
  fleet: FleetBaseline
): ModelVerdict {
  // Failing more than its peers comes first: a model handing its cheap rate
  // back in retries is the more expensive problem, whatever its sticker price.
  if (model.errorShare > fleet.errorShare * UNDERPOWERED_ERROR_MULTIPLE) {
    return ModelVerdict.Underpowered;
  }
  // Over-powered is a CONJUNCTION, and an unknown job size cannot satisfy half
  // of it. Without the explicit null check this reads a fabricated `0`, which
  // is below any positive fleet median and would convict the model on the
  // strength of a number nobody measured.
  if (
    model.medianWorkTokens !== null &&
    model.rate > fleet.medianRate * OVERPOWERED_RATE_MULTIPLE &&
    model.medianWorkTokens < fleet.medianSessionTokens
  ) {
    return ModelVerdict.Overpowered;
  }
  return ModelVerdict.RightSized;
}

function toModelRow(
  model: string,
  accumulator: ModelAccumulator,
  medians: ModelMedians,
  fleet: FleetBaseline
): ModelRightSizingRow {
  const errorShare = shareOf(accumulator.errorOutcomeUsd, accumulator.usd);
  const graded = accumulator.sessions >= MIN_GRADED_SESSIONS;
  const row: ModelRightSizingRow = {
    errorOutcomeUsd: round2(accumulator.errorOutcomeUsd),
    // The RETIRED field, on its original billed basis and with its original
    // required shape, including the `0` it has always projected for a missing
    // median. Nothing in this repo reads it any more — not the verdict above,
    // not the screen — so its sentinel can no longer decide anything; it is
    // here only for the `apps/app` build that predates `medianWorkTokens`, and
    // narrowing it now would break exactly the client it exists to serve.
    medianTokens: medians.billed ?? 0,
    model,
    sessions: accumulator.sessions,
    usd: round2(accumulator.usd),
    usdPerSession:
      accumulator.sessions > 0
        ? round2(accumulator.usd / accumulator.sessions)
        : 0,
    verdict: graded
      ? resolveVerdict(
          {
            errorShare,
            medianWorkTokens: medians.work,
            rate: ratePerMillion(accumulator),
          },
          fleet
        )
      : ModelVerdict.Ungraded,
  };
  // OMITTED, not null and emphatically not 0, when there is no work median:
  // the screen renders its unavailable dash for an absent key, and a `0` would
  // be indistinguishable from a model that really did no first-pass work.
  if (medians.work !== null) {
    row.medianWorkTokens = medians.work;
  }
  // OMITTED, not null and emphatically not 0, for an ungraded model: there is
  // no verdict to be confident about, and a `0%` would read as "we are certain
  // it is wrong".
  if (graded) {
    row.confidencePct = Math.round(errorShare * PERCENT);
  }
  return row;
}

/** `null` and `undefined` alike mean "no median", never zero. */
function toMedian(value: number | null | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}

const NO_MEDIANS: ModelMedians = { billed: null, work: null };

function workMediansOf(
  graded: readonly (readonly [string, ModelAccumulator])[],
  medians: Map<string, ModelMedians>
): number[] {
  const values: number[] = [];
  for (const [model] of graded) {
    const work = medians.get(model)?.work;
    if (work !== null && work !== undefined) {
      values.push(work);
    }
  }
  return values;
}

export function foldModelRows(
  rows: readonly ModelSpendGridRow[],
  medianRows: readonly ModelMedianRow[]
): ModelRightSizingRow[] {
  const byModel = accumulateModels(rows);
  const medians = new Map<string, ModelMedians>(
    medianRows.map((row) => [
      row.model,
      {
        billed: toMedian(row.medianTokens),
        work: toMedian(row.medianWorkTokens),
      },
    ])
  );
  const fleet = fleetBaselineOf(byModel, medians);
  return [...byModel.entries()]
    .map(([model, accumulator]) =>
      toModelRow(model, accumulator, medians.get(model) ?? NO_MEDIANS, fleet)
    )
    .sort((a, b) => b.usd - a.usd);
}

function emptyWaste(): RecoverableWasteEstimate {
  return {
    errorOutcomeUsd: 0,
    excludedUnknownUsd: 0,
    highRate: RECOVERY_HIGH_RATE,
    highUsd: 0,
    lowRate: RECOVERY_LOW_RATE,
    lowUsd: 0,
    sessions: 0,
  };
}

/**
 * Fetch the whole TokenOps screen.
 *
 * Three reads fan out through ONE shared limiter (bounds compose by addition,
 * so a limiter per read would multiply the in-flight query budget) and each
 * settles independently. A widget whose read fails is reported in
 * `unavailableWidgets` and renders as a dash with a reason — never as a `$0`,
 * which would read as "nothing was wasted here".
 */
export async function fetchTokenOpsWaste(
  ctx: InsightsScopeContext,
  period: InsightsPeriod,
  now: Date = new Date()
): Promise<TokenOpsWasteInsightsResponse> {
  const range = resolvePeriodRange(period, now);
  const scopeSql = sessionScopeSql(ctx);
  const limiter = createDbFanoutLimiter();
  const correlation = {
    organizationId: ctx.organizationId,
    scope: ctx.scope,
    userId: ctx.userId,
  };

  const [spend, models, medians] = await Promise.all([
    runWidget(
      limiter,
      TokenOpsWidget.Outcomes,
      () => fetchSpendGrid(scopeSql, range.start, range.end),
      correlation
    ),
    runWidget(
      limiter,
      TokenOpsWidget.Models,
      () => fetchModelSpendGrid(scopeSql, range.start, range.end),
      correlation
    ),
    runWidget(
      limiter,
      TokenOpsWidget.Models,
      () => fetchModelMedianTokens(scopeSql, range.start, range.end),
      correlation
    ),
  ]);

  const outcomes = spend.ok ? foldOutcomeRows(spend.value) : [];
  const modelsAvailable = models.ok && medians.ok;
  const unavailableWidgets: TokenOpsWidget[] = unavailableKeysOf([spend]);
  if (!spend.ok) {
    // The waste estimate is derived from the same read as the outcome split,
    // so it settles unavailable with it rather than reporting a $0 range.
    unavailableWidgets.push(TokenOpsWidget.Waste);
  }
  if (!modelsAvailable) {
    unavailableWidgets.push(TokenOpsWidget.Models);
  }

  return {
    minGradedSessions: MIN_GRADED_SESSIONS,
    models: modelsAvailable
      ? foldModelRows(valueOr(models, []), valueOr(medians, []))
      : [],
    outcomes,
    totalSpendUsd: round2(outcomes.reduce((sum, row) => sum + row.usd, 0)),
    unavailableWidgets,
    waste: spend.ok ? foldWasteEstimate(spend.value) : emptyWaste(),
  };
}
