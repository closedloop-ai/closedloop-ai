/**
 * ISS-10731 — render the findings/survival join as the result a human reads.
 *
 * EVERY VERDICT IS RENDERED ON THE SAME LINES. A positive association, a
 * negative one, a null one and an unmeasurable one all print the same three
 * fields in the same place, because a null or negative result is a successful
 * outcome of this analysis and a renderer that handled the positive case more
 * fully would quietly demote the others.
 *
 * NO BARE RATE. Every percentage printed here is followed by the population it
 * was measured over and the window it was taken at, and the cohort line states
 * how many agents were excluded and why. A reader must never be able to lift a
 * percentage out of this text without its denominator.
 *
 * NO BARE COEFFICIENT EITHER. Every `r` is printed with the confidence interval
 * the verdict was read off, so a direction drawn through five points cannot be
 * quoted as one drawn through five hundred.
 *
 * The anchor is printed first because it is what makes two runs comparable.
 */

import {
  type FindingsSurvivalCorrelation,
  FindingsSurvivalCorrelationVerdict,
} from "./findings-survival-correlation.ts";
import {
  type AgentFindingsSurvivalJoin,
  type FindingsSurvivalExclusion,
  findingsSurvivalExclusionCounts,
} from "./findings-survival-join.ts";

const FINDINGS_SURVIVAL_EXCLUSION_LABEL: Record<
  FindingsSurvivalExclusion,
  string
> = {
  unattributable_lines: "no produced-line figure reached the agent",
  inadmissible_lines: "produced-line figure could not describe a real run",
  missing_survival_window: "no survival observation at a requested window",
  empty_survival_base: "survival observation with no base",
  inadmissible_survival_observation:
    "survival observation could not describe a real run",
  no_reporting_reviewer: "no reviewer that could report did",
  no_applicable_reviewer: "every reviewer declares no findings output",
  inadmissible_confirmed_findings:
    "confirmed-findings total left the safe integer range",
  duplicate_agent: "the agent arrived more than once",
  inadmissible_span: "operand span could not describe a real span",
  span_mismatch: "operands gathered over a different span than the window",
};

/**
 * Name the reviewers that could never report, so the shortfall between
 * reporting and population is not read as silence they are part of.
 */
function notApplicableNote(notApplicableReviewers: number): string {
  return notApplicableReviewers === 0
    ? ""
    : ` (${notApplicableReviewers} declare no findings output)`;
}

const FINDINGS_SURVIVAL_QUESTION =
  "Does survival rise with reviewer confirmed findings?";

function percent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function correlationLine(
  label: string,
  correlation: FindingsSurvivalCorrelation
): string {
  const coefficient =
    correlation.coefficient === undefined
      ? "no coefficient"
      : `r = ${correlation.coefficient.toFixed(3)}`;
  return `${label}: ${correlation.verdict.toUpperCase()} (${coefficient}, ${intervalText(correlation)}, across ${correlation.pairs} agents, null threshold |r| < ${correlation.nullThreshold})`;
}

/**
 * The interval beside every coefficient, because `r` without it cannot say
 * whether a direction was measured or merely drawn through too few points.
 */
function intervalText(correlation: FindingsSurvivalCorrelation): string {
  const { interval } = correlation;
  if (interval === undefined) {
    return "no interval at this cohort size";
  }
  // Written without a percent sign on purpose: a confidence level is not a rate
  // over a population, and every percentage in this report carries one.
  return `CI [${interval.low.toFixed(3)}, ${interval.high.toFixed(3)}] at ${interval.confidence} confidence`;
}

/**
 * The question this analysis was built to answer, answered in one sentence
 * whichever way it came out.
 */
function headline(join: AgentFindingsSurvivalJoin): string {
  const { verdict } = join.volumeControlledCorrelation;
  const scope = `at ${join.correlationWindowDays}d, across ${join.volumeControlledCorrelation.pairs} agents, holding net new lines constant`;
  switch (verdict) {
    case FindingsSurvivalCorrelationVerdict.Unknown:
      return `${FINDINGS_SURVIVAL_QUESTION} NOT DECIDABLE from this cohort ${scope}: ${intervalText(join.volumeControlledCorrelation)}, which admits both a direction and none. This is an absence of evidence, not evidence that the association is zero.`;
    case FindingsSurvivalCorrelationVerdict.Null:
      return `${FINDINGS_SURVIVAL_QUESTION} NO ASSOCIATION ${scope}, with the whole interval inside the null threshold. A null result is a result: it is evidence against the two-numerator model's causal claim, and is reported here with the same prominence a positive one would get.`;
    case FindingsSurvivalCorrelationVerdict.Negative:
      return `${FINDINGS_SURVIVAL_QUESTION} NO — the association is NEGATIVE ${scope}. A negative result is a result, and it is the most valuable thing the two-numerator model could learn.`;
    case FindingsSurvivalCorrelationVerdict.Positive:
      return `${FINDINGS_SURVIVAL_QUESTION} POSITIVE association ${scope}. An association is not a cause; the confounds below are why.`;
    default: {
      // A verdict added later must be given its own sentence here rather than
      // inheriting whichever arm happened to be last.
      const unhandled: never = verdict;
      throw new Error(`Unhandled correlation verdict: ${String(unhandled)}`);
    }
  }
}

/** The whole result as text: anchor, cohort, rows, verdict, confounds. */
export function renderAgentFindingsSurvivalReport(
  join: AgentFindingsSurvivalJoin
): string {
  const counts = findingsSurvivalExclusionCounts(join);
  const lines = [
    "Findings funnel x line survival",
    `anchor commit: ${join.anchorCommit}`,
    `windows: ${join.windowDays.map((days) => `${days}d`).join(", ")} (survival on the real-churn basis: moved lines are relocation, not rework)`,
    `cohort: ${join.cohortAgents} of ${join.populationAgents} agents; ${join.excludedAgents} excluded`,
  ];
  for (const reason of Object.keys(counts) as FindingsSurvivalExclusion[]) {
    lines.push(
      `  excluded — ${FINDINGS_SURVIVAL_EXCLUSION_LABEL[reason]}: ${counts[reason]}`
    );
  }
  lines.push("", "Per agent:");
  if (join.rows.length === 0) {
    lines.push("  (no agent supplied all three operands at this grain)");
  }
  for (const row of join.rows) {
    const survival = row.survival
      .map(
        (figure) =>
          `${figure.windowDays}d ${percent(figure.survivalRate)} of ${figure.baseLines} lines (${figure.realChurnedLines} real-churned)`
      )
      .join("; ");
    lines.push(
      `  ${row.agentId}: over ${row.observedSpanDays}d, net new ${row.netNewLines} lines (+${row.linesAdded}/-${row.linesRemoved}); ${survival}; confirmed findings ${row.confirmedFindings} across ${row.reportingReviewers} of ${row.populationReviewers} reviewers${notApplicableNote(row.notApplicableReviewers)}`
    );
  }
  lines.push(
    "",
    headline(join),
    correlationLine("volume-controlled", join.volumeControlledCorrelation),
    correlationLine("raw (volume NOT held constant)", join.rawCorrelation),
    "",
    "Confounds — this is an association, not a cause:"
  );
  for (const confound of join.confounds) {
    lines.push(`  - ${confound}`);
  }
  return lines.join("\n");
}
