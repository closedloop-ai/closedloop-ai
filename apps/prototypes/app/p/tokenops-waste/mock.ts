import {
  isLostSession,
  MOCK_SESSIONS,
  type MockSession,
  outcomeOf,
  SPEND_OUTCOME_LABELS,
  SPEND_OUTCOME_ORDER,
  SpendOutcome,
} from "@/lib/analytics/session-fixture";

/**
 * Derivations for the TokenOps waste-vs-leverage screen.
 *
 * The FACTS come first and are keyed on exactly one thing: the session's
 * terminal `endsWithError`, the same key PR #4282 / ISS-4463 shipped "Spend by
 * session outcome" on. Nothing here invents a second definition of failure, so
 * this screen and the Lost-work screen cannot disagree about which sessions
 * failed. The prototype's tests assert that.
 *
 * The JUDGMENTS (recoverable waste, right-sizing verdicts) are derived from
 * those facts and are labelled as estimates wherever they render.
 */

export type OutcomeRow = {
  outcome: SpendOutcome;
  label: string;
  usd: number;
  sessions: number;
};

export type WasteEstimate = {
  /** Spend on sessions that ended with a recorded error and produced nothing. */
  errorOutcomeUsd: number;
  lowUsd: number;
  highUsd: number;
  sessions: number;
  /** Spend deliberately kept OUT of the estimate because the outcome is unknown. */
  excludedUnknownUsd: number;
};

export const ModelVerdict = {
  Overpowered: "overpowered",
  RightSized: "right_sized",
  Underpowered: "underpowered",
  /** Not a verdict. The honest answer when the sample is too thin to grade. */
  Ungraded: "ungraded",
} as const;
export type ModelVerdict = (typeof ModelVerdict)[keyof typeof ModelVerdict];

export const MODEL_VERDICT_LABELS: Record<ModelVerdict, string> = {
  [ModelVerdict.Overpowered]: "Over-powered for the work",
  [ModelVerdict.RightSized]: "Right-sized",
  [ModelVerdict.Underpowered]: "Under-powered, retry-heavy",
  [ModelVerdict.Ungraded]: "Not enough data",
};

export type ModelRow = {
  model: string;
  usd: number;
  errorOutcomeUsd: number;
  sessions: number;
  /**
   * Median per-session FIRST-PASS tokens — the job-size half of the verdict.
   * Not the basis the rate beside it is taken over, which is every billed token;
   * see {@link ModelAccumulator} (ISS-5189).
   */
  medianTokens: number;
  usdPerSession: number;
  verdict: ModelVerdict;
  /**
   * Share of this model's sessions that carry the signal behind the verdict.
   * `null` for an ungraded model, because there is no verdict to be confident
   * about, and a `0%` there would read as "we are certain it is wrong".
   */
  confidencePct: number | null;
};

/**
 * The recovery assumption, stated here and repeated verbatim on screen. These
 * are the reason the headline is a RANGE and not a number: we do not know how
 * much of a failed run's spend would have been re-spent anyway.
 */
export const RECOVERY_LOW_RATE = 0.35;
export const RECOVERY_HIGH_RATE = 0.7;

/** Below this many sessions a model gets no verdict at all. */
export const MIN_GRADED_SESSIONS = 12;
/**
 * A model is graded against THE FLEET, not against a magic absolute. An
 * absolute dollar threshold goes stale the moment provider pricing moves, and
 * it cannot tell "expensive" from "expensive for what it is doing".
 *
 * Over-powered: costs this many times the fleet's median rate per million
 * tokens WHILE being pointed at smaller-than-median jobs. Rate alone is not the
 * signal, a premium model on genuinely hard work is earning its price; the same
 * model on small work is not.
 */
export const OVERPOWERED_RATE_MULTIPLE = 3;
/**
 * Under-powered: fails this many times more often than the fleet, so its cheap
 * rate is being handed back in retries.
 */
export const UNDERPOWERED_ERROR_MULTIPLE = 1.4;
const TOKENS_PER_MILLION = 1_000_000;
const CENTS = 100;
const PERCENT = 100;
// Declared above the derived exports below, which run at module load.
const HALF = 2;

export const outcomeRows: readonly OutcomeRow[] =
  buildOutcomeRows(MOCK_SESSIONS);
export const totalSpendUsd: number = round2(
  outcomeRows.reduce((sum, row) => sum + row.usd, 0)
);
export const wasteEstimate: WasteEstimate = buildWasteEstimate(MOCK_SESSIONS);
export const modelRows: readonly ModelRow[] = buildModelRows(MOCK_SESSIONS);

function round2(value: number): number {
  return Math.round(value * CENTS) / CENTS;
}

function buildOutcomeRows(sessions: readonly MockSession[]): OutcomeRow[] {
  const usdByOutcome = new Map<SpendOutcome, number>();
  const sessionsByOutcome = new Map<SpendOutcome, number>();
  for (const session of sessions) {
    const outcome = outcomeOf(session);
    usdByOutcome.set(
      outcome,
      (usdByOutcome.get(outcome) ?? 0) + session.costUsd
    );
    sessionsByOutcome.set(outcome, (sessionsByOutcome.get(outcome) ?? 0) + 1);
  }
  // Fixed order, so the buckets never reshuffle between reads.
  return SPEND_OUTCOME_ORDER.map((outcome) => ({
    label: SPEND_OUTCOME_LABELS[outcome],
    outcome,
    sessions: sessionsByOutcome.get(outcome) ?? 0,
    usd: round2(usdByOutcome.get(outcome) ?? 0),
  }));
}

/**
 * The judgment half of ISS-4463, scoped out of the factual tiles on purpose.
 *
 * Basis: spend on sessions that ended with a recorded error AND produced no
 * artifact. Outcome-unknown spend is excluded outright, and the amount excluded
 * is reported on screen, because we cannot claim a session wasted money when we
 * never observed that it failed.
 */
function buildWasteEstimate(sessions: readonly MockSession[]): WasteEstimate {
  let errorOutcomeUsd = 0;
  let count = 0;
  let excludedUnknownUsd = 0;
  for (const session of sessions) {
    const outcome = outcomeOf(session);
    if (outcome === SpendOutcome.Unknown) {
      excludedUnknownUsd += session.costUsd;
      continue;
    }
    if (outcome === SpendOutcome.Errored && isLostSession(session)) {
      errorOutcomeUsd += session.costUsd;
      count += 1;
    }
  }
  return {
    errorOutcomeUsd: round2(errorOutcomeUsd),
    excludedUnknownUsd: round2(excludedUnknownUsd),
    highUsd: round2(errorOutcomeUsd * RECOVERY_HIGH_RATE),
    lowUsd: round2(errorOutcomeUsd * RECOVERY_LOW_RATE),
    sessions: count,
  };
}

/**
 * The two halves of the Over-powered verdict are graded on DIFFERENT token
 * bases, and that split is the point (ISS-5189).
 *
 * `billedTokens` — every token the provider charged for — stays the RATE
 * denominator, so it covers the same population as the `usd` above it. Dividing
 * a bill that prices cache reads by a count that excludes them is not a
 * cache-neutral rate, just an incoherent one.
 *
 * `workTokens` — first-pass tokens only — is the JOB-SIZE proxy, because
 * replaying one cached prefix is not a bigger job. Grading both halves over one
 * all-inclusive total made them move together with a harness's cache reuse
 * rather than with price and job size, which left a cache-heavy model
 * structurally unable to earn the verdict at all.
 */
type ModelAccumulator = {
  usd: number;
  errorOutcomeUsd: number;
  sessions: number;
  errorSessions: number;
  billedTokens: number;
  workTokens: number[];
};

function buildModelRows(sessions: readonly MockSession[]): ModelRow[] {
  const byModel = new Map<string, ModelAccumulator>();
  for (const session of sessions) {
    let accumulator = byModel.get(session.model);
    if (!accumulator) {
      accumulator = {
        billedTokens: 0,
        errorOutcomeUsd: 0,
        errorSessions: 0,
        sessions: 0,
        usd: 0,
        workTokens: [],
      };
      byModel.set(session.model, accumulator);
    }
    accumulator.sessions += 1;
    accumulator.usd += session.costUsd;
    accumulator.billedTokens += session.tokens;
    accumulator.workTokens.push(session.firstPassTokens);
    if (outcomeOf(session) === SpendOutcome.Errored) {
      accumulator.errorOutcomeUsd += session.costUsd;
      accumulator.errorSessions += 1;
    }
  }
  // The fleet baselines every verdict is measured against. Only models with
  // enough sessions contribute, so a four-session trial cannot move the bar it
  // is then judged by.
  const graded = [...byModel.entries()].filter(
    ([, accumulator]) => accumulator.sessions >= MIN_GRADED_SESSIONS
  );
  const fleet = {
    errorShare: shareOf(
      graded.reduce((sum, [, item]) => sum + item.errorOutcomeUsd, 0),
      graded.reduce((sum, [, item]) => sum + item.usd, 0)
    ),
    medianRate: median(graded.map(([, item]) => ratePerMillion(item))),
    medianSessionTokens: median(
      graded.map(([, item]) => median(item.workTokens))
    ),
  };
  return [...byModel.entries()]
    .map(([model, accumulator]) => toModelRow(model, accumulator, fleet))
    .sort((a, b) => b.usd - a.usd);
}

type FleetBaseline = {
  errorShare: number;
  medianRate: number;
  medianSessionTokens: number;
};

function toModelRow(
  model: string,
  accumulator: ModelAccumulator,
  fleet: FleetBaseline
): ModelRow {
  const errorShare = shareOf(accumulator.errorOutcomeUsd, accumulator.usd);
  const graded = accumulator.sessions >= MIN_GRADED_SESSIONS;
  const medianTokens = median(accumulator.workTokens);
  const verdict = graded
    ? resolveVerdict(
        { errorShare, medianTokens, rate: ratePerMillion(accumulator) },
        fleet
      )
    : ModelVerdict.Ungraded;
  return {
    confidencePct: graded ? Math.round(errorShare * PERCENT) : null,
    errorOutcomeUsd: round2(accumulator.errorOutcomeUsd),
    medianTokens,
    model,
    sessions: accumulator.sessions,
    usd: round2(accumulator.usd),
    usdPerSession: round2(accumulator.usd / accumulator.sessions),
    verdict,
  };
}

function shareOf(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0;
}

/**
 * The blended price this model actually charged: spend over every token that
 * spend paid for, so numerator and denominator cover the same population.
 */
function ratePerMillion(accumulator: ModelAccumulator): number {
  return accumulator.billedTokens > 0
    ? (accumulator.usd / accumulator.billedTokens) * TOKENS_PER_MILLION
    : 0;
}

function resolveVerdict(
  model: { rate: number; errorShare: number; medianTokens: number },
  fleet: FleetBaseline
): ModelVerdict {
  // Failing more than its peers comes first: a model handing its cheap rate
  // back in retries is the more expensive problem, whatever its sticker price.
  if (model.errorShare > fleet.errorShare * UNDERPOWERED_ERROR_MULTIPLE) {
    return ModelVerdict.Underpowered;
  }
  if (
    model.rate > fleet.medianRate * OVERPOWERED_RATE_MULTIPLE &&
    model.medianTokens < fleet.medianSessionTokens
  ) {
    return ModelVerdict.Overpowered;
  }
  return ModelVerdict.RightSized;
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
  return Math.round((sorted[middle - 1] + sorted[middle]) / HALF);
}
