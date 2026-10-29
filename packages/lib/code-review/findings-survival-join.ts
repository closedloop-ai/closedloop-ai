/**
 * ISS-10731 — join per-agent line SURVIVAL to the ISS-7796 findings funnel, to
 * test the two-numerator model's central claim: that valid findings CAUSE lines
 * to stick.
 *
 * THE CLAIM IS CAUSAL AND THIS IS A JOIN, WHICH IS WEAKER. Nothing here is
 * evidence of a cause. What it can do is refuse to be vacuous: put all three
 * operands on one row at ONE grain, publish the association with volume held
 * constant, and state the confounds in the same object so a reader cannot get
 * the number without them.
 *
 * ONE GRAIN: THE PRODUCER AGENT, over one anchor and one window. Every operand
 * on a row describes the same agent — lines it produced, survival of ITS lines,
 * and the confirmed findings of the reviewers that reviewed ITS work. A
 * per-invocation finding count divided by a per-session line count is a wrong
 * number that looks plausible, so a row that cannot supply all three at this
 * grain is EXCLUDED and COUNTED rather than completed with a zero.
 *
 * THE TIME SLICE IS PART OF THAT GRAIN. A survival observation states its own
 * window; the line and findings operands cannot, so the caller states theirs as
 * `observedSpanDays` and the join REFUSES a row whose span is not the window
 * the coefficients are taken at. Without it, findings gathered over 14d could
 * be paired against a 21d survival base on the caller's word alone.
 *
 * THE MOVED/REAL SPLIT IS NOT OPTIONAL AND NOT RE-DERIVED. Survival is taken on
 * the REAL-churn basis: a refactor that relocates code verbatim is not rework,
 * and judging on positional churn would charge a module reorganization to a
 * reviewer who missed nothing. The definition is `.claude/skills/code-stickiness`
 * (`sticky_core.compute_age_split` / `sticky_render`): base = lines at OLD by
 * `git blame`, survived = those still positionally present at NEW, moved = that
 * churned content still verbatim elsewhere, real churn = churned - moved. This
 * module does NOT compute a second "lines changed" definition; it takes those
 * four counts as operands and can therefore not be handed a positional-churn
 * number dressed as a real one — {@link AgentLineSurvivalObservation} cannot be
 * constructed without `movedLines`.
 *
 * UNKNOWN IS NEVER ZERO. An agent whose lines could not be attributed is absent
 * from the cohort, not present at zero survival; a reviewer reading Unknown does
 * not contribute a zero to a confirmed-findings count.
 *
 * NO DOLLARS PER FINDING (PRD-753 R3/R8). Spend is not an operand here and no
 * quotient of a cost by a count exists in this module.
 *
 * A NULL OR NEGATIVE RESULT IS A SUCCESSFUL OUTCOME. See
 * ./findings-survival-correlation.ts — every verdict is the same shape.
 */

import {
  type AgentComponentFindingsFunnelReading,
  AgentComponentFindingsFunnelState,
} from "@repo/api/src/types/agent-component-findings-funnel";
import {
  type FindingsSurvivalCorrelation,
  findingsSurvivalCorrelation,
  findingsSurvivalPartialPearson,
  findingsSurvivalPearson,
} from "./findings-survival-correlation.ts";

/** The benchmark windows the stickiness skill reports, in days. */
export const FINDINGS_SURVIVAL_WINDOW_DAYS = [14, 21] as const;

/**
 * The confounds, carried WITH the result because an unstated confound turns a
 * correlation into a claim the data cannot carry.
 */
export const FINDINGS_SURVIVAL_CONFOUNDS = [
  "Reverse causation: careful authors attract fewer findings AND write stickier code.",
  "Volume: stickiness is a ratio, so net new lines must be held constant or the comparison rewards whoever wrote least.",
  "Selection: reviewers are not randomly assigned to work.",
  "Moved/real split: survival is taken on the real-churn basis, because a verbatim relocation is not rework.",
  "Window length: a 14d or 21d window cannot see a defect found at 30d.",
] as const;

/** Why an agent is not in the cohort. Each is counted, never silently dropped. */
export const FindingsSurvivalExclusion = {
  /** No produced-line figure reached this agent at all. */
  UnattributableLines: "unattributable_lines",
  /**
   * A produced-line figure arrived and cannot describe a real run — negative,
   * fractional, or past the safe-integer range. Deliberately NOT folded into
   * {@link UnattributableLines}: a missing number is a normal coverage gap, a
   * malformed one is a defect upstream, and one count cannot say which.
   */
  InadmissibleLines: "inadmissible_lines",
  /** No survival observation at one or more of the requested windows. */
  MissingSurvivalWindow: "missing_survival_window",
  /** A survival observation with no base, so it has no rate at all. */
  EmptySurvivalBase: "empty_survival_base",
  /**
   * A survival observation whose operands cannot describe a real run (more
   * survivors than base, a negative or fractional count). Same reason as
   * {@link InadmissibleLines} for keeping it apart from the benign case.
   */
  InadmissibleSurvivalObservation: "inadmissible_survival_observation",
  /** Every reviewer that COULD report read Unknown, and at least one could. */
  NoReportingReviewer: "no_reporting_reviewer",
  /**
   * Every reviewer of this agent's work declares no findings output, so no
   * reviewer could have reported. Not a silence to chase.
   */
  NoApplicableReviewer: "no_applicable_reviewer",
  /**
   * Individually admissible confirmed-findings counts whose SUM left the safe
   * integer range. Each addend is validated by the funnel reader; the total is
   * this module's to check, and a silently rounded total would be rendered and
   * correlated as a real measurement.
   */
  InadmissibleConfirmedFindings: "inadmissible_confirmed_findings",
  /**
   * The same agent arrived more than once. Every copy is excluded rather than
   * one being picked: an upstream aggregation that emitted two rows for one
   * agent has said nothing about which is right, and counting both would give
   * that agent two votes in both coefficients and overstate the cohort.
   */
  DuplicateAgent: "duplicate_agent",
  /**
   * The span the produced-line and findings operands were gathered over cannot
   * describe a real span — absent, negative, fractional, or past the
   * safe-integer range.
   */
  InadmissibleSpan: "inadmissible_span",
  /**
   * The operands were gathered over a different span than the survival window
   * the coefficients are taken at, so the row's three numbers do not describe
   * one slice of time. Refused rather than trusted: survival at 21d paired with
   * findings gathered over 14d is a wrong number that looks plausible.
   */
  SpanMismatch: "span_mismatch",
} as const;
export type FindingsSurvivalExclusion =
  (typeof FindingsSurvivalExclusion)[keyof typeof FindingsSurvivalExclusion];

/**
 * One window's survival for one agent, on the stickiness skill's own operands.
 * `movedLines` is required so the real basis cannot be bypassed.
 */
export type AgentLineSurvivalObservation = {
  windowDays: number;
  baseLines: number;
  survivedLines: number;
  movedLines: number;
};

/** What the caller supplies per agent. */
export type AgentFindingsSurvivalInput = {
  agentId: string;
  /**
   * The span the line and findings operands below were gathered over, in days.
   * Required, for the reason `movedLines` is: survival states its own window
   * per observation, so without this the time grain is the caller's word and a
   * mismatch cannot be refused. It must equal the window the coefficients are
   * taken at, or the agent is excluded and counted.
   */
  observedSpanDays: number;
  /** From ISS-10730's per-invocation columns, aggregated by `agent_id`. */
  linesAdded?: number;
  linesRemoved?: number;
  /** The WHOLE reviewer population for this agent's work, Unknown included. */
  reviewerFindings: readonly AgentComponentFindingsFunnelReading[];
  survival: readonly AgentLineSurvivalObservation[];
};

/** One window's survival, published with the population it was taken over. */
export type AgentLineSurvivalFigure = {
  windowDays: number;
  baseLines: number;
  realSurvivedLines: number;
  realChurnedLines: number;
  /** 0..1. Multiply at the render, so the stored form stays a ratio. */
  survivalRate: number;
};

export type AgentFindingsSurvivalRow = {
  agentId: string;
  /** The span the line and findings operands on this row were gathered over. */
  observedSpanDays: number;
  linesAdded: number;
  linesRemoved: number;
  netNewLines: number;
  survival: readonly AgentLineSurvivalFigure[];
  confirmedFindings: number;
  /** Reviewers that actually reported, and the whole population they sit in. */
  reportingReviewers: number;
  /**
   * Reviewers that COULD NOT report because their kind declares no findings
   * output. Carried separately so `populationReviewers - reportingReviewers` is
   * never read as a coverage gap that includes them.
   */
  notApplicableReviewers: number;
  populationReviewers: number;
};

export type FindingsSurvivalExclusionRecord = {
  agentId: string;
  reason: FindingsSurvivalExclusion;
};

export type AgentFindingsSurvivalJoin = {
  /** `git rev-parse origin/main` at the run, so two runs are comparable. */
  anchorCommit: string;
  windowDays: readonly number[];
  rows: readonly AgentFindingsSurvivalRow[];
  cohortAgents: number;
  populationAgents: number;
  excludedAgents: number;
  exclusions: readonly FindingsSurvivalExclusionRecord[];
  /** The primary answer: association with volume held constant. */
  volumeControlledCorrelation: FindingsSurvivalCorrelation;
  /** The same association WITHOUT that control, published for contrast. */
  rawCorrelation: FindingsSurvivalCorrelation;
  /** The window the correlations were taken at. */
  correlationWindowDays: number;
  confounds: readonly string[];
};

/**
 * The real-churn figure for one observation, or `undefined` when the operands
 * cannot support one.
 *
 * `movedLines` is clamped to the churned count for the same reason
 * `sticky_render` clamps it: a move claim can only relocate a line that
 * positionally churned, and an unclamped claim would mint survival above the
 * base.
 */
export function agentLineSurvivalFigure(
  observation: AgentLineSurvivalObservation
): AgentLineSurvivalFigure | undefined {
  const { windowDays, baseLines, survivedLines, movedLines } = observation;
  if (
    isAgentLineSurvivalObservationAdmissible(observation) === false ||
    baseLines <= 0
  ) {
    return undefined;
  }
  const positionallyChurned = baseLines - survivedLines;
  const relocated = Math.min(movedLines, positionallyChurned);
  const realSurvivedLines = survivedLines + relocated;
  return {
    windowDays,
    baseLines,
    realSurvivedLines,
    realChurnedLines: positionallyChurned - relocated,
    survivalRate: realSurvivedLines / baseLines,
  };
}

/**
 * Fold a reviewer population into its three states, kept apart.
 *
 * A reviewer that DECLARES no findings output could never have reported, so
 * folding it into the shortfall would make the report claim a coverage gap that
 * does not exist. That distinction is the whole reason the funnel has a third
 * state; collapsing it here would undo it one layer later.
 */
function reviewerTotals(
  readings: readonly AgentComponentFindingsFunnelReading[]
): {
  confirmedFindings: number | undefined;
  reportingReviewers: number;
  notApplicableReviewers: number;
} {
  let confirmedFindings = 0;
  let reportingReviewers = 0;
  let notApplicableReviewers = 0;
  for (const reading of readings) {
    if (reading.state === AgentComponentFindingsFunnelState.NotApplicable) {
      notApplicableReviewers += 1;
      continue;
    }
    if (reading.state !== AgentComponentFindingsFunnelState.Measured) {
      continue;
    }
    reportingReviewers += 1;
    confirmedFindings += reading.findingsConfirmed;
  }
  return {
    confirmedFindings: Number.isSafeInteger(confirmedFindings)
      ? confirmedFindings
      : undefined,
    reportingReviewers,
    notApplicableReviewers,
  };
}

function agentRow(
  input: AgentFindingsSurvivalInput,
  windowDays: readonly number[],
  correlationWindowDays: number
): AgentFindingsSurvivalRow | FindingsSurvivalExclusion {
  const { linesAdded, linesRemoved, observedSpanDays } = input;
  if (!(Number.isSafeInteger(observedSpanDays) && observedSpanDays > 0)) {
    return FindingsSurvivalExclusion.InadmissibleSpan;
  }
  if (observedSpanDays !== correlationWindowDays) {
    return FindingsSurvivalExclusion.SpanMismatch;
  }
  if (linesAdded === undefined || linesRemoved === undefined) {
    return FindingsSurvivalExclusion.UnattributableLines;
  }
  if (
    !(Number.isSafeInteger(linesAdded) && Number.isSafeInteger(linesRemoved)) ||
    linesAdded < 0 ||
    linesRemoved < 0
  ) {
    return FindingsSurvivalExclusion.InadmissibleLines;
  }
  const survival: AgentLineSurvivalFigure[] = [];
  for (const days of windowDays) {
    const observation = input.survival.find(
      (candidate) => candidate.windowDays === days
    );
    if (observation === undefined) {
      return FindingsSurvivalExclusion.MissingSurvivalWindow;
    }
    if (isAgentLineSurvivalObservationAdmissible(observation) === false) {
      return FindingsSurvivalExclusion.InadmissibleSurvivalObservation;
    }
    const figure = agentLineSurvivalFigure(observation);
    if (figure === undefined) {
      return FindingsSurvivalExclusion.EmptySurvivalBase;
    }
    survival.push(figure);
  }
  const { confirmedFindings, reportingReviewers, notApplicableReviewers } =
    reviewerTotals(input.reviewerFindings);
  if (confirmedFindings === undefined) {
    return FindingsSurvivalExclusion.InadmissibleConfirmedFindings;
  }
  if (reportingReviewers === 0) {
    return notApplicableReviewers === input.reviewerFindings.length &&
      notApplicableReviewers > 0
      ? FindingsSurvivalExclusion.NoApplicableReviewer
      : FindingsSurvivalExclusion.NoReportingReviewer;
  }
  return {
    agentId: input.agentId,
    observedSpanDays,
    linesAdded,
    linesRemoved,
    netNewLines: linesAdded - linesRemoved,
    survival,
    confirmedFindings,
    reportingReviewers,
    notApplicableReviewers,
    populationReviewers: input.reviewerFindings.length,
  };
}

/**
 * Whether an observation's operands can describe a real run. An EMPTY base is
 * admissible here and rejected separately, so "this agent had no lines at the
 * window start" and "the collector handed back more survivors than base" stay
 * two different answers.
 */
function isAgentLineSurvivalObservationAdmissible(
  observation: AgentLineSurvivalObservation
): boolean {
  const { baseLines, survivedLines, movedLines } = observation;
  return (
    Number.isSafeInteger(baseLines) &&
    Number.isSafeInteger(survivedLines) &&
    Number.isSafeInteger(movedLines) &&
    baseLines >= 0 &&
    survivedLines >= 0 &&
    movedLines >= 0 &&
    survivedLines <= baseLines
  );
}

/**
 * Build the join.
 *
 * `correlationWindowDays` selects which window the two coefficients are taken
 * at; every row still carries every requested window, so the other one is not
 * lost. Defaults to the longest requested window, the LinearB rework window
 * where both are present.
 */
export function buildAgentFindingsSurvivalJoin(options: {
  anchorCommit: string;
  inputs: readonly AgentFindingsSurvivalInput[];
  windowDays?: readonly number[];
  correlationWindowDays?: number;
}): AgentFindingsSurvivalJoin {
  const windowDays = assertWindowDays(
    options.windowDays ?? FINDINGS_SURVIVAL_WINDOW_DAYS
  );
  const correlationWindowDays =
    options.correlationWindowDays ?? Math.max(...windowDays);
  if (!windowDays.includes(correlationWindowDays)) {
    throw new Error(
      `correlationWindowDays ${correlationWindowDays} is not one of the requested windows ${windowDays.join(", ")}`
    );
  }
  const duplicated = duplicateAgentIds(options.inputs);
  const rows: AgentFindingsSurvivalRow[] = [];
  const exclusions: FindingsSurvivalExclusionRecord[] = [];
  for (const input of options.inputs) {
    if (duplicated.has(input.agentId)) {
      exclusions.push({
        agentId: input.agentId,
        reason: FindingsSurvivalExclusion.DuplicateAgent,
      });
      continue;
    }
    const result = agentRow(input, windowDays, correlationWindowDays);
    if (typeof result === "string") {
      exclusions.push({ agentId: input.agentId, reason: result });
      continue;
    }
    rows.push(result);
  }
  const paired = rows.flatMap((row) => {
    const figure = row.survival.find(
      (candidate) => candidate.windowDays === correlationWindowDays
    );
    return figure === undefined ? [] : [{ row, figure }];
  });
  const findings = paired.map(({ row }) => row.confirmedFindings);
  const survivalRates = paired.map(({ figure }) => figure.survivalRate);
  const volumes = paired.map(({ row }) => row.netNewLines);
  return {
    anchorCommit: options.anchorCommit,
    windowDays,
    rows,
    cohortAgents: rows.length,
    populationAgents: options.inputs.length,
    excludedAgents: exclusions.length,
    exclusions,
    volumeControlledCorrelation: findingsSurvivalCorrelation(
      findingsSurvivalPartialPearson(findings, survivalRates, volumes),
      paired.length,
      1
    ),
    rawCorrelation: findingsSurvivalCorrelation(
      findingsSurvivalPearson(findings, survivalRates),
      paired.length,
      0
    ),
    correlationWindowDays,
    confounds: FINDINGS_SURVIVAL_CONFOUNDS,
  };
}

/** How many agents were excluded for each reason, zeroes included. */
export function findingsSurvivalExclusionCounts(
  join: AgentFindingsSurvivalJoin
): Record<FindingsSurvivalExclusion, number> {
  const counts = Object.fromEntries(
    Object.values(FindingsSurvivalExclusion).map((reason) => [reason, 0])
  ) as Record<FindingsSurvivalExclusion, number>;
  for (const exclusion of join.exclusions) {
    counts[exclusion.reason] += 1;
  }
  return counts;
}

/**
 * The requested windows, refused unless they can describe real windows. An
 * empty list is the one that matters: `Math.max()` of nothing is `-Infinity`,
 * which selected a correlation window no row can carry and printed "at
 * -Infinityd" while every verdict read unknown for no stated reason.
 */
function assertWindowDays(windowDays: readonly number[]): readonly number[] {
  if (windowDays.length === 0) {
    throw new Error("windowDays must name at least one window");
  }
  for (const days of windowDays) {
    if (!(Number.isSafeInteger(days) && days > 0)) {
      throw new Error(`windowDays must be whole positive days, got ${days}`);
    }
  }
  if (new Set(windowDays).size !== windowDays.length) {
    throw new Error(
      `windowDays must not repeat a window: ${windowDays.join(", ")}`
    );
  }
  return windowDays;
}

/** Agent ids that arrived more than once, so every copy can be excluded. */
function duplicateAgentIds(
  inputs: readonly AgentFindingsSurvivalInput[]
): ReadonlySet<string> {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const input of inputs) {
    if (seen.has(input.agentId)) {
      duplicated.add(input.agentId);
      continue;
    }
    seen.add(input.agentId);
  }
  return duplicated;
}
