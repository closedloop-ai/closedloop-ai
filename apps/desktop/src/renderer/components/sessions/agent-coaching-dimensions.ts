import {
  costLeverWarranted,
  wallTimeLeverWarranted,
} from "./agent-coaching-lever-gate";
import {
  type AgentCoachingCandidate,
  costImpactScore,
  type FeedbackInsights,
  feedbackFollowUp,
  toCandidate,
  wallTimeImpactScore,
} from "./agent-coaching-scoring";
import type {
  AgentCoachingGroundedMetrics,
  AgentCoachingInput,
  AgentCoachingTip,
} from "./agent-coaching-types";

/** Format a USD amount with a thousands separator, matching the token counts. */
function formatUsd(amount: number): string {
  return `$${amount.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * FEA-3265 chronological / wall-clock lever. Long average session wall time
 * (getWorkflowData avgDurationSec) is a distinct cost from tokens — it is the
 * user's own time. Emitted only when the average clears a meaningful floor so
 * it competes on real evidence, not noise.
 */
export function buildWallTimeCandidate(
  input: AgentCoachingInput,
  metrics: AgentCoachingGroundedMetrics,
  feedbackInsights: FeedbackInsights
): AgentCoachingCandidate | null {
  const avgDurationSec = metrics.avgSessionDurationSec;
  // The null check narrows `avgDurationSec` for the tip body below; the floor
  // itself lives in wallTimeLeverWarranted (shared with the generated path).
  if (avgDurationSec == null || !wallTimeLeverWarranted(avgDurationSec)) {
    return null;
  }
  const followUp = feedbackFollowUp("wall_time", feedbackInsights);
  const avgMinutes = Math.round(avgDurationSec / 60);
  // Cadence is a whole clause ("night owl: 42% of activity after midnight"), so
  // it belongs only in the evidence list — never spliced into the body sentence,
  // which would read as two unrelated facts joined by a parenthetical, and would
  // degrade to a meaningless "(your usual hours)" when cadence is absent.
  const cadenceLabel = metrics.sessionCadence?.label ?? null;

  const tip: AgentCoachingTip = {
    id: "compress-session-wall-time",
    title: "Cut the wall-clock time your sessions burn",
    category: "wall_time",
    body: `${followUp.prefix}Your sessions average ${avgMinutes} min of wall-clock time. Front-load a plan and a tight success check so the agent converges before the long-tail turns pile up.`,
    whyItMatters:
      "Wall-clock time is your time, not just tokens. Long sessions usually mean late course-correction, not hard problems.",
    evidence: [
      `${avgMinutes} min average session wall time`,
      `${metrics.sessionsAnalyzed.toLocaleString()} sessions analyzed`,
      // The cadence label is already a complete sentence, so it stands alone —
      // no "cadence:" prefix (which produced a double colon) — and the row is
      // dropped entirely when no cadence signal exists rather than printing a
      // filler "your usual hours".
      ...(cadenceLabel ? [cadenceLabel] : []),
    ],
    experiment:
      "On the next task, write the plan and the done-check first, then measure whether the session finishes in fewer minutes.",
    detail: {
      whatThisMeans:
        "This is a chronological-efficiency recommendation. Acting on it means shortening the feedback loop so a session converges sooner.",
      howToAct: [
        "Open with a short plan and an explicit success check.",
        "Interrupt and re-scope the moment a session drifts past its plan.",
        "Compare minutes-to-done against your recent average.",
      ],
      whyThisRecommendation: `${followUp.why}Sessions average ${avgMinutes} minutes of wall time, so tightening the loop is the lever with the most clock to reclaim.`,
      autoApply:
        "Desktop can draft the plan-and-done-check prompt. It should not shorten or cancel a running session on its own.",
    },
    actions: [
      {
        id: "draft-plan-and-check",
        label: "Draft plan",
        mode: "draft",
        safety: "safe",
        result: "Drafts a plan + success-check prompt for the next session.",
      },
    ],
  };
  return toCandidate(
    tip,
    "wall_time",
    wallTimeImpactScore(avgDurationSec),
    input
  );
}

/**
 * FEA-3265 overall-cost lever. Grounded in the windowed token spend and the
 * estimated $ (when analytics carries it). Emitted only when there is real
 * spend to reason about so it competes on evidence — a token floor AND, when a
 * dollar estimate exists, a spend floor, so the tip never opens with a
 * sub-dollar figure under a "cut spend" title.
 */
export function buildCostCandidate(
  input: AgentCoachingInput,
  metrics: AgentCoachingGroundedMetrics,
  feedbackInsights: FeedbackInsights
): AgentCoachingCandidate | null {
  // Gate through the SSOT: a token floor AND, when a dollar estimate exists, a
  // spend floor (a 50k-token window can be well under a dollar, and "$0.31 over
  // the window" under a cut-spend title reads as broken). A null estimate still
  // qualifies on the token floor and frames on tokens.
  if (
    !costLeverWarranted({
      estimatedCostUsd: metrics.estimatedCostUsd,
      totalTokens: metrics.totalTokens,
    })
  ) {
    return null;
  }
  const followUp = feedbackFollowUp("cost", feedbackInsights);
  const costLabel =
    metrics.estimatedCostUsd == null
      ? null
      : formatUsd(metrics.estimatedCostUsd);
  // Only claim model concentration when we actually have per-model attribution.
  // With no attribution `topModel` is null; asserting "one model dominates" then
  // puts a guess into the Evidence list, which is the one section that must only
  // hold measured facts — so the tip stands on spend alone instead.
  const topModel = metrics.modelMix?.[0] ?? null;
  const modelLabel = topModel
    ? `${topModel.model} carries ${Math.round(topModel.share * 100)}% of your tokens`
    : null;
  const spendPhrase = costLabel
    ? `${costLabel} over the window`
    : `${metrics.totalTokens.toLocaleString()} tokens over the window`;
  const modelClause = modelLabel ? `, and ${modelLabel}` : "";

  const tip: AgentCoachingTip = {
    id: "rebalance-model-spend",
    title: "Right-size the model for the task to cut spend",
    category: "cost",
    body: `${followUp.prefix}You spent ${spendPhrase}${modelClause}. Route cheaper, well-scoped work to a smaller model and reserve the top model for genuinely hard turns.`,
    whyItMatters:
      "Overall cost is a first-class lever. Much spend goes to a top-tier model doing work a cheaper one would finish.",
    evidence: [
      costLabel
        ? `estimated spend: ${costLabel}`
        : `total tokens: ${metrics.totalTokens.toLocaleString()}`,
      // Only a measured model-attribution row here — never the fabricated
      // "one model dominates" placeholder when attribution is missing.
      ...(modelLabel ? [modelLabel] : []),
      `${metrics.sessionsAnalyzed.toLocaleString()} sessions analyzed`,
    ],
    experiment:
      "For the next batch of routine tasks, pick a smaller model and compare cost and rework against the default.",
    detail: {
      whatThisMeans:
        "This is a cost recommendation. Acting on it means matching model tier to task difficulty instead of defaulting to the strongest one.",
      howToAct: [
        "Classify the next task as routine or genuinely hard.",
        "Route routine work to a smaller, cheaper model.",
        "Compare spend and rework against the top-model baseline.",
      ],
      whyThisRecommendation: `${followUp.why}${
        modelLabel
          ? `Spend is concentrated (${modelLabel}), so re-tiering is the cost lever with the largest base to act on.`
          : "There is meaningful spend over the window, so re-tiering routine work to a cheaper model is the cost lever with the largest base to act on."
      }`,
      autoApply:
        "Desktop can prefill a model recommendation. It should not switch models on a running session silently.",
    },
    actions: [
      {
        id: "classify-model-tier",
        label: "Suggest model",
        mode: "draft",
        safety: "safe",
        result:
          "Drafts a per-task model recommendation with a cheaper default.",
      },
    ],
  };
  return toCandidate(
    tip,
    "cost",
    costImpactScore(metrics.totalTokens, metrics.estimatedCostUsd),
    input
  );
}
