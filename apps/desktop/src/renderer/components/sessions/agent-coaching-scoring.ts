import { formatDateForInput } from "@repo/app/shared/lib/date-utils";
import { summarizeLookback } from "./agent-coaching-lookback";
import type {
  AgentCoachingFeedbackEvent,
  AgentCoachingGroundedMetrics,
  AgentCoachingInput,
  AgentCoachingTip,
  AgentCoachingTipCategory,
} from "./agent-coaching-types";

/**
 * FEA-3265: a coaching recommendation plus the impact signal it competes on.
 *
 * The old model built a FIXED array of exactly one tip per category, so the
 * surfaced set was always the same five levers regardless of what the user's
 * sessions actually looked like. This replaces that with a POOL: every builder
 * emits zero or more candidates across dimensions (context, wall time, token
 * efficiency, output quality, cost, resilience, …), each carrying:
 *
 * - `impactScore`: a grounded, cross-dimension estimate of how much acting on
 *   this lever would help THIS user, derived from the lookback metrics — NOT a
 *   per-category constant. Higher = more impactful. Skill-creation (the token/
 *   speed levers) earns its score the same way everything else does; there is
 *   no forced skill-creation quota anymore.
 * - `lever`: the diversity key. Two candidates with the same `lever` are the
 *   same kind of advice ("route more shell through rtk" vs "promote this repeat
 *   into a skill" are both `reuse`), so the ranker keeps at most one per lever
 *   in the surfaced set — the five tips are five genuinely different levers.
 */
export type AgentCoachingCandidate = {
  tip: AgentCoachingTip;
  /** Grounded impact estimate (higher = more impactful). Never negative. */
  impactScore: number;
  /** Diversity key — the underlying lever, coarser than `tip.category`. */
  lever: AgentCoachingLever;
};

/**
 * The distinct levers a coaching tip can pull. Coarser than the display
 * category so the diversity guarantee groups genuinely-equivalent advice: e.g.
 * a token-efficiency skill tip and a speed-of-delivery workflow tip both pull
 * the `reuse` lever (turn a repeated pattern into a durable primitive), so only
 * the higher-impact one survives. Keeping this separate from category means we
 * can widen categories without weakening diversity.
 */
export type AgentCoachingLever =
  | "context_hygiene"
  | "reuse"
  | "test_sequencing"
  | "harness_routing"
  | "resilience"
  | "wall_time"
  | "cost"
  // FEA-4153: capability-gap lever — a best-practice capability the user's real
  // usage shows they are NOT using yet (e.g. plan mode, skills, rtk routing).
  // Grounded in the lookback metrics vs the best-practice signal list, so it
  // competes in the same pool as every other lever with no forced slot.
  | "capability_gap";

/**
 * Feedback-derived adjustment applied to a candidate's grounded impact. Prior
 * engagement nudges a lever up; a prior dismissal nudges it down — but only as
 * a modifier on the grounded score, never the sole ranking signal (the old
 * model ranked almost entirely on feedback). Excludes same-day events so a tip
 * acted on today does not immediately re-rank.
 */
export function feedbackAdjustment(
  category: AgentCoachingTipCategory,
  feedback: AgentCoachingFeedbackEvent[],
  today: string
): number {
  let adjustment = 0;
  for (const event of feedback) {
    if (toDayKey(new Date(event.createdAt)) === today) {
      continue;
    }
    if (event.category !== category) {
      continue;
    }
    if (event.action === "details_opened") {
      adjustment += FEEDBACK_OPENED_BONUS;
    } else if (event.action === "action_clicked") {
      adjustment += FEEDBACK_ACTED_BONUS;
    } else if (event.action === "dismissed") {
      adjustment += FEEDBACK_DISMISSED_PENALTY;
    }
  }
  return adjustment;
}

/**
 * Rank a candidate pool by impact and enforce the diversity guarantee, then
 * return the surfaced tips.
 *
 * 1. Sort by descending impact so the most impactful lever wins each diversity
 *    contest.
 * 2. Keep at most one candidate per `lever` (diversity): the first (highest
 *    impact) candidate claims the lever; later same-lever candidates are
 *    dropped. This is what guarantees the surfaced tips are N different levers,
 *    never five variations of "make a skill".
 * 3. Take the top `limit` diverse candidates.
 *
 * The surfaced set is presented MOST → LEAST impactful. The deck shows one tip
 * at a time from index 0 with a Next button, so every tip is equally close to
 * the CTA and "Tip 1 of N" should be the strongest lever, not the weakest — a
 * least→most order would bury the highest-impact recommendation four clicks
 * away. Ties break deterministically on title so the output is stable across
 * loads.
 */
export function rankCandidatePool(
  candidates: AgentCoachingCandidate[],
  limit: number
): AgentCoachingTip[] {
  const byImpactDesc = [...candidates].sort(compareByImpactDesc);
  const seenLevers = new Set<AgentCoachingLever>();
  const diverse: AgentCoachingCandidate[] = [];
  for (const candidate of byImpactDesc) {
    if (seenLevers.has(candidate.lever)) {
      continue;
    }
    seenLevers.add(candidate.lever);
    diverse.push(candidate);
    if (diverse.length >= limit) {
      break;
    }
  }
  return diverse.map((candidate) => candidate.tip);
}

/**
 * Per-category tally of prior (non-today) feedback, used to phrase a tip as a
 * follow-up and to nudge its impact. Exhaustive over the category union.
 */
export type FeedbackInsights = Record<
  AgentCoachingTipCategory,
  { dismissed: number; opened: number; acted: number }
>;

/** Prose prefix + rationale a builder prepends when prior feedback exists. */
export type FeedbackFollowUp = { prefix: string; why: string };

/** Empty insight tallies for every category (exhaustive by construction). */
export function emptyFeedbackInsights(): FeedbackInsights {
  return {
    accuracy: { acted: 0, dismissed: 0, opened: 0 },
    capability_gap: { acted: 0, dismissed: 0, opened: 0 },
    context_management: { acted: 0, dismissed: 0, opened: 0 },
    cost: { acted: 0, dismissed: 0, opened: 0 },
    opportunity_analysis: { acted: 0, dismissed: 0, opened: 0 },
    resilience: { acted: 0, dismissed: 0, opened: 0 },
    speed_of_delivery: { acted: 0, dismissed: 0, opened: 0 },
    token_efficiency: { acted: 0, dismissed: 0, opened: 0 },
    wall_time: { acted: 0, dismissed: 0, opened: 0 },
  };
}

/** Tally prior (non-today) feedback per category. */
export function summarizeFeedback(
  feedback: AgentCoachingFeedbackEvent[],
  today: string
): FeedbackInsights {
  const insights = emptyFeedbackInsights();
  for (const event of feedback) {
    if (toDayKey(new Date(event.createdAt)) === today) {
      continue;
    }
    const bucket = insights[event.category];
    if (!bucket) {
      continue;
    }
    if (event.action === "dismissed") {
      bucket.dismissed += 1;
    } else if (event.action === "details_opened") {
      bucket.opened += 1;
    } else if (event.action === "action_clicked") {
      bucket.acted += 1;
    }
  }
  return insights;
}

/** Phrase a tip as a follow-up when the user engaged with the category before. */
export function feedbackFollowUp(
  category: AgentCoachingTipCategory,
  feedbackInsights: FeedbackInsights
): FeedbackFollowUp {
  return followUpFromTally(feedbackInsights[category]);
}

/**
 * Phrase a tip as a follow-up keyed on THIS tip's own id, not its category.
 * Categories that map many distinct tips to one display category (e.g.
 * `capability_gap` covers plan mode, rtk, and skills) must not let engagement
 * with one tip bleed into an unrelated sibling — so this tallies prior
 * (non-today) feedback for `tipId` alone.
 */
export function tipFollowUp(
  tipId: string,
  feedback: AgentCoachingFeedbackEvent[],
  generatedAt: Date
): FeedbackFollowUp {
  const today = toDayKey(generatedAt);
  const tally = { acted: 0, dismissed: 0, opened: 0 };
  for (const event of feedback) {
    if (event.tipId !== tipId) {
      continue;
    }
    if (toDayKey(new Date(event.createdAt)) === today) {
      continue;
    }
    if (event.action === "action_clicked") {
      tally.acted += 1;
    } else if (event.action === "details_opened") {
      tally.opened += 1;
    } else if (event.action === "dismissed") {
      tally.dismissed += 1;
    }
  }
  return followUpFromTally(tally);
}

/** Shared follow-up prose from a per-category or per-tip engagement tally. */
function followUpFromTally(tally: {
  acted: number;
  opened: number;
  dismissed: number;
}): FeedbackFollowUp {
  if (tally.acted > 0) {
    return {
      prefix: "Follow-up from yesterday's action: ",
      why: "Because you acted on this coaching area before, today's recommendation advances it to the next concrete step. ",
    };
  }
  if (tally.opened > 0) {
    return {
      prefix:
        "You opened details on this coaching area before, so here's the next step: ",
      why: "Prior detail engagement is treated as interest, so this tip is generated as a more specific follow-up rather than a repeat. ",
    };
  }
  if (tally.dismissed > 0) {
    return {
      prefix: "Reframed after prior dismissal: ",
      why: "A previous dismissal lowers confidence in the generic version, so this recommendation is narrower and evidence-first. ",
    };
  }
  return { prefix: "", why: "" };
}

/**
 * Wrap a built tip into a scored candidate. `rawDimensionScore` (0–100) is the
 * builder's grounded estimate of how strong THIS lever is for THIS user; the
 * shared scorer folds in the feedback adjustment and floors at 0. `lever` is
 * the diversity key (coarser than category) so equivalent advice can't fill two
 * of the surfaced slots.
 */
export function toCandidate(
  tip: AgentCoachingTip,
  lever: AgentCoachingLever,
  rawDimensionScore: number,
  input: AgentCoachingInput
): AgentCoachingCandidate {
  return {
    tip,
    lever,
    impactScore: candidateImpactScore(
      rawDimensionScore,
      tip.category,
      input.feedback,
      toDayKey(input.generatedAt)
    ),
  };
}

/**
 * Grounded impact of a candidate, blending the builder's raw dimension score
 * (0–100, how strong THIS lever's signal is for THIS user) with a feedback
 * adjustment, floored at 0. Pure and deterministic so the ranking is testable
 * without the DB or the harness.
 */
export function candidateImpactScore(
  rawDimensionScore: number,
  category: AgentCoachingTipCategory,
  feedback: AgentCoachingFeedbackEvent[],
  today: string
): number {
  const adjusted =
    rawDimensionScore + feedbackAdjustment(category, feedback, today);
  return Math.max(0, adjusted);
}

/**
 * The lookback metrics a candidate builder scores against. Computed once per
 * load (pure over the already-gathered input) and threaded to every builder so
 * the impact estimates share one grounded source and cannot drift.
 */
export function candidateMetrics(
  input: AgentCoachingInput
): AgentCoachingGroundedMetrics {
  return summarizeLookback(input);
}

/**
 * Raw dimension scorers (0–100). Each maps a builder's grounded signal to a
 * cross-dimension impact estimate so every lever is ranked on the SAME scale —
 * the whole point of FEA-3265: a strong non-skill lever (cost, wall time,
 * context) can outrank a weak skill/reuse lever. Kept here (not in the model)
 * so the model stays under the 1000-line ceiling and the scoring rules live in
 * one place. All clamp to [0, 100].
 */

/** Context sprawl: heavier per-session event + token load above the floor. */
export function contextImpactScore(
  averageEvents: number,
  averageTokens: number,
  metrics: AgentCoachingGroundedMetrics
): number {
  const eventPressure = clampUnit((averageEvents - 50) / 250) * 40;
  const tokenPressure = clampUnit((averageTokens - 15_000) / 60_000) * 40;
  // A larger analyzed corpus makes a hygiene habit compound more.
  const corpusPressure = clampUnit(metrics.sessionsAnalyzed / 40) * 20;
  return clampScore(eventPressure + tokenPressure + corpusPressure);
}

/** Workflow reuse: repetition volume of the review orchestration path. */
export function reuseImpactScore(
  repeatedCount: number,
  skillCount: number,
  metrics: AgentCoachingGroundedMetrics
): number {
  const repeatPressure = clampUnit(repeatedCount / 12) * 55;
  const skillPressure = clampUnit(skillCount / 30) * 25;
  const familyPressure =
    clampUnit(metrics.repeatedCommandFamilies.length / 4) * 20;
  return clampScore(repeatPressure + skillPressure + familyPressure);
}

/** Skill reuse: observed repetition × estimated per-call token savings. */
export function reuseSkillImpactScore(
  observedCalls: number,
  savingsPercent: number,
  metrics: AgentCoachingGroundedMetrics
): number {
  const callPressure = clampUnit(observedCalls / 12) * 45;
  const savingsPressure = clampUnit(savingsPercent / 70) * 35;
  // Only meaningful when there is unwrapped shell to consolidate.
  const unwrapped = metrics.unwrappedShellCommandRatio ?? 0;
  const unwrappedPressure = clampUnit(unwrapped) * 20;
  return clampScore(callPressure + savingsPressure + unwrappedPressure);
}

/**
 * Test sequencing: how skewed the delegation mix is toward exploration. Volume
 * only AMPLIFIES a positive exploration skew — it never creates impact on its
 * own. A test-heavy history (negative skew) already follows this tip's advice
 * ("move test design earlier"), so a large volume of test delegations must not
 * manufacture a high score from volume alone.
 */
export function testSequencingImpactScore(
  generalCount: number,
  testCount: number
): number {
  const total = generalCount + testCount;
  if (total === 0) {
    return 0;
  }
  const skew = clampUnit((generalCount - testCount) / total);
  if (skew === 0) {
    return 0;
  }
  const volume = clampUnit(total / 20);
  // skew is the base signal; volume scales it up (0.6 → 1.0) so a bigger
  // explore-heavy corpus ranks higher, but a test-only corpus (skew 0) stays 0.
  return clampScore(skew * (60 + volume * 40));
}

/** Harness routing: number of distinct work modes in the tool mix. */
export function harnessRoutingImpactScore(distinctSignals: number): number {
  return clampScore(clampUnit(distinctSignals / 5) * 100);
}

/**
 * Resilience: peak frustration intensity plus nearby error clustering.
 * `textFrustrationScore` is the frustration signal from the turn TEXT ALONE
 * (caps/repetition/"stop"/"again"), i.e. `peak.score - peak.nearbyErrorCount`,
 * because `computePeakFrustration` already folds the nearby error count into
 * `peak.score`. Passing the raw `peak.score` here would count the errors twice
 * — once inside intensity and again in errorPressure — so the caller subtracts
 * them out first and this scorer treats the two inputs as independent.
 */
export function resilienceImpactScore(
  textFrustrationScore: number,
  nearbyErrorCount: number
): number {
  const intensity = clampUnit(textFrustrationScore / 8) * 70;
  const errorPressure = clampUnit(nearbyErrorCount / 5) * 30;
  return clampScore(intensity + errorPressure);
}

/** Wall time: average session wall-clock minutes above the floor. */
export function wallTimeImpactScore(avgDurationSec: number): number {
  const minutes = avgDurationSec / 60;
  return clampScore(clampUnit((minutes - 10) / 50) * 100);
}

/** Overall cost: windowed token spend and estimated dollars. */
export function costImpactScore(
  totalTokens: number,
  estimatedCostUsd: number | null
): number {
  const tokenPressure = clampUnit(totalTokens / 2_000_000) * 60;
  const dollarPressure =
    estimatedCostUsd == null ? 0 : clampUnit(estimatedCostUsd / 200) * 40;
  return clampScore(tokenPressure + dollarPressure);
}

/**
 * FEA-4153 capability gap: a best-practice capability the user is provably not
 * using scored by how much room there is to adopt it AND how much corpus stands
 * to benefit. `adoptionShortfall` is 0–1 (how far BELOW the healthy-adoption
 * target the user's real usage sits — 1 = not using it at all); `benefitVolume`
 * is 0–1 (how much analyzed activity would benefit — a gap on a busy corpus
 * matters more than on an idle one). Both must be positive for the gap to score,
 * so a capability the user already uses (shortfall 0) or has no activity to
 * apply it to (volume 0) never surfaces.
 */
export function capabilityGapImpactScore(
  adoptionShortfall: number,
  benefitVolume: number
): number {
  const shortfall = clampUnit(adoptionShortfall);
  const volume = clampUnit(benefitVolume);
  // Shortfall is the base signal (how missing the capability is); volume scales
  // it (0.6 → 1.0) so a gap on a large corpus outranks the same gap on a tiny
  // one, but a fully-adopted capability (shortfall 0) always stays at 0.
  return clampScore(shortfall * (60 + volume * 40));
}

const FEEDBACK_OPENED_BONUS = 6;
const FEEDBACK_ACTED_BONUS = 8;
const FEEDBACK_DISMISSED_PENALTY = -10;

/** Clamp a raw ratio to [0, 1]. */
function clampUnit(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

/** Clamp a composed dimension score to [0, 100]. */
function clampScore(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function compareByImpactDesc(
  a: AgentCoachingCandidate,
  b: AgentCoachingCandidate
): number {
  return (
    b.impactScore - a.impactScore || a.tip.title.localeCompare(b.tip.title)
  );
}

// Local calendar day (FEA-2430) — matches the model's day key so feedback
// suppression flips at the user's midnight, via the canonical date helper.
function toDayKey(date: Date): string {
  return formatDateForInput(date);
}

/**
 * The lever each display category pulls — the same mapping the heuristic
 * builders assign when they call `toCandidate`. Exhaustive over the category
 * union (a `Record`), so a new category fails typecheck until it is mapped here.
 * Used to enforce the diversity guarantee on harness-GENERATED tips too, which
 * don't carry a scored `lever` the way pool candidates do.
 */
const CATEGORY_LEVER: Record<AgentCoachingTipCategory, AgentCoachingLever> = {
  accuracy: "test_sequencing",
  capability_gap: "capability_gap",
  context_management: "context_hygiene",
  cost: "cost",
  opportunity_analysis: "harness_routing",
  resilience: "resilience",
  speed_of_delivery: "reuse",
  token_efficiency: "reuse",
  wall_time: "wall_time",
};

/**
 * The lever a display category pulls, via the canonical `CATEGORY_LEVER` map
 * (exhaustive over the category union). Exported so the harness-generated path
 * can resolve a tip's lever for BOTH the diversity dedup and the FEA-4179
 * adoption-signal gate without re-declaring the mapping.
 */
export function leverForCategory(
  category: AgentCoachingTipCategory
): AgentCoachingLever {
  return CATEGORY_LEVER[category];
}

/**
 * FEA-4179: the display categories whose lever is in `warrantedLevers` — the
 * inverse of `leverForCategory` over the canonical `CATEGORY_LEVER` map. The LLM
 * prompt states this category→lever contract and constrains the generator to
 * these categories, so a tip's lever is decided by evidence the generator was
 * TOLD about up front rather than being silently filtered out afterwards by a
 * signal it never reasoned over (e.g. an `accuracy` tip gated on delegation
 * counts). The post-generation `filterGeneratedTipsByWarrantedLevers` stays as
 * defense-in-depth for a non-compliant provider.
 */
export function categoriesForWarrantedLevers(
  warrantedLevers: ReadonlySet<AgentCoachingLever>
): AgentCoachingTipCategory[] {
  const categories: AgentCoachingTipCategory[] = [];
  for (const category of Object.keys(
    CATEGORY_LEVER
  ) as AgentCoachingTipCategory[]) {
    if (warrantedLevers.has(CATEGORY_LEVER[category])) {
      categories.push(category);
    }
  }
  return categories;
}

/**
 * FEA-4179: the canonical category→lever pairs, for stating the contract in the
 * LLM prompt so the generator knows which lever each category pulls (and thus
 * which usage signal gates it). Derived from `CATEGORY_LEVER` so the prompt can
 * never drift from the runtime gate.
 */
export function categoryLeverContractEntries(): [
  AgentCoachingTipCategory,
  AgentCoachingLever,
][] {
  return (Object.keys(CATEGORY_LEVER) as AgentCoachingTipCategory[]).map(
    (category) => [category, CATEGORY_LEVER[category]]
  );
}

/**
 * Enforce the FEA-3265 diversity guarantee on a list of already-ordered tips
 * (e.g. harness-generated ones), keeping the FIRST tip per lever and capping at
 * `limit`. The heuristic pool already ranks + dedupes by lever inside
 * `rankCandidatePool`; the harness path has no impact scores, so it can't be
 * re-ranked, but it MUST still not surface two tips that pull the same lever
 * (e.g. two "make a skill" reuse tips). Preserves the generator's own ordering.
 */
export function dedupeGeneratedTipsByLever(
  tips: AgentCoachingTip[],
  limit: number
): AgentCoachingTip[] {
  const seenLevers = new Set<AgentCoachingLever>();
  const diverse: AgentCoachingTip[] = [];
  for (const tip of tips) {
    const lever = CATEGORY_LEVER[tip.category];
    if (seenLevers.has(lever)) {
      continue;
    }
    seenLevers.add(lever);
    diverse.push(tip);
    if (diverse.length >= limit) {
      break;
    }
  }
  return diverse;
}
