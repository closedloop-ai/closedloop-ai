import {
  type AgentCoachingCandidate,
  capabilityGapImpactScore,
  type FeedbackFollowUp,
  tipFollowUp,
  toCandidate,
} from "./agent-coaching-scoring";
import type {
  AgentCoachingGroundedMetrics,
  AgentCoachingInput,
  AgentCoachingTip,
} from "./agent-coaching-types";

// Every capability-gap tip carries the dedicated `capability_gap` display
// category (1:1 with the `capability_gap` lever), so a gap tip never visually
// duplicates the context/token/speed tip it borrows evidence from.
const CAPABILITY_GAP_CATEGORY = "capability_gap" as const;

/**
 * FEA-4153: capability-gap coaching dimension (FEA-3265 follow-up).
 *
 * FEA-3265 shipped the scored candidate pool but DEFERRED the capability-gap
 * dimension. It is added here: rather than let the static `AGENTIC_DEVELOPMENT_
 * SIGNALS` best-practice list drift as advice the user may already follow, this
 * grounds each best-practice capability in the user's ACTUAL usage (the lookback
 * metrics) and emits a candidate ONLY for a capability the metrics prove they
 * are not using — scored by estimated impact so it competes in the same
 * `rankCandidatePool()` with every other lever (no forced slot). A capability
 * the user already uses never surfaces; a capability with no corpus to apply it
 * to never surfaces.
 *
 * Each capability declares a `detect` that reads the real metrics and returns
 * an adoption shortfall (0–1, how far below healthy adoption the user sits) and
 * a benefit volume (0–1, how much analyzed activity stands to benefit). Both
 * feed `capabilityGapImpactScore`, so the gap is grounded in usage, never a
 * hardcoded constant. The highest-scoring detected gap becomes the candidate.
 */

/** A best-practice capability plus how to detect a genuine gap from usage. */
type CapabilityGap = {
  /** Stable, kebab-case tip id (per capability, so feedback tracks it). */
  id: string;
  title: string;
  /** Short capability name for prose. */
  capability: string;
  /**
   * Read the real usage metrics and decide whether this capability is a genuine
   * gap. Returns null when the signal to judge adoption is unavailable (so a
   * capability is never flagged as "missing" on absent data) or when the user
   * is already adopting it. When present, `shortfall`/`volume` are 0–1 and
   * `evidence` is the measured fact that grounds the gap.
   */
  detect: (
    metrics: AgentCoachingGroundedMetrics
  ) => { shortfall: number; volume: number; evidence: string } | null;
  body: (evidence: string) => string;
  whyItMatters: string;
  experiment: string;
  howToAct: string[];
  actionLabel: string;
  actionResult: string;
  /**
   * A plain-language statement of the gap in the reader's own words (never our
   * "capability_gap" lever jargon), shown as `detail.whatThisMeans`.
   */
  whatThisMeans: string;
};

// Minimum analyzed sessions before a plan-mode gap is worth flagging: a couple
// of sessions is too small a base to call plan mode "under-used".
const PLAN_MODE_MIN_SESSIONS = 5;
// Below this plan-mode adoption the capability is a genuine gap. Plan mode is
// situational (not every task needs it), so the target is deliberately modest —
// the point is "you essentially never use it", not "use it every time".
const PLAN_MODE_HEALTHY_RATIO = 0.25;
// Minimum SAMPLED shell commands (the denominator the unwrapped ratio is
// measured over) before an rtk-routing gap is worth flagging — a single
// unwrapped command on an otherwise-quiet corpus is not a confident gap.
const RTK_MIN_SHELL_COMMANDS = 5;
// Above this share of unwrapped shell, rtk routing is a genuine gap.
const RTK_HEALTHY_UNWRAPPED_RATIO = 0.3;
// Minimum repeated-family count before a skills gap is worth flagging: real
// repetition must exist before "you have no skills" is actionable.
const SKILLS_MIN_REPEATED_FAMILIES = 2;
// The skills-gap tip id, referenced by the reuse-tip dedupe gate.
const SKILLS_GAP_ID = "capability-gap-skills";

const CAPABILITY_GAPS: CapabilityGap[] = [
  {
    id: "capability-gap-plan-mode",
    title: "Try plan mode before you start building",
    capability: "plan mode",
    detect: (metrics) => {
      // A null ratio means plan markers are undetectable in this harness — never
      // flag a gap we cannot measure (matches the null-when-absent convention).
      // A 0 ratio (harness surfaces plan markers, but this user never used them)
      // is the exact case this gap targets.
      if (metrics.planModeRatio == null) {
        return null;
      }
      if (metrics.sessionsAnalyzed < PLAN_MODE_MIN_SESSIONS) {
        return null;
      }
      if (metrics.planModeRatio >= PLAN_MODE_HEALTHY_RATIO) {
        return null;
      }
      const shortfall =
        (PLAN_MODE_HEALTHY_RATIO - metrics.planModeRatio) /
        PLAN_MODE_HEALTHY_RATIO;
      const volume = metrics.sessionsAnalyzed / 40;
      return {
        shortfall,
        volume,
        evidence: `Plan mode showed up in ${Math.round(metrics.planModeRatio * 100)}% of your sessions.`,
      };
    },
    body: () =>
      "On multi-step tasks, let the agent draft and confirm a plan before it edits, so it converges on the right approach instead of course-correcting mid-build.",
    whyItMatters:
      "Plan mode front-loads alignment on hard tasks, cutting the mid-session rework that a build-first approach invites.",
    experiment:
      "On the next multi-step task, start in plan mode and compare how much rework the session needs against your recent average.",
    howToAct: [
      "Open the next non-trivial task in plan mode.",
      "Confirm the plan before allowing edits.",
      "Compare rework against a build-first session.",
    ],
    actionLabel: "Draft plan-mode habit",
    actionResult:
      "Drafts a plan-mode-first prompt to reach for on the next multi-step task.",
    whatThisMeans: "You are not using plan mode yet.",
  },
  {
    id: "capability-gap-rtk-routing",
    title: "Route shell commands through rtk",
    capability: "rtk shell routing",
    detect: (metrics) => {
      if (metrics.unwrappedShellCommandRatio == null) {
        return null;
      }
      if (metrics.shellCommandsSampled < RTK_MIN_SHELL_COMMANDS) {
        return null;
      }
      if (metrics.unwrappedShellCommandRatio <= RTK_HEALTHY_UNWRAPPED_RATIO) {
        return null;
      }
      // Shortfall is how far the unwrapped share exceeds the healthy ceiling,
      // normalized against the remaining headroom to 100% unwrapped.
      const shortfall =
        (metrics.unwrappedShellCommandRatio - RTK_HEALTHY_UNWRAPPED_RATIO) /
        (1 - RTK_HEALTHY_UNWRAPPED_RATIO);
      // Volume scales with the sampled shell-command count that the ratio was
      // actually measured over, not the unrelated lifetime event total.
      const volume = metrics.shellCommandsSampled / 40;
      return {
        shortfall,
        volume,
        evidence: `${Math.round(metrics.unwrappedShellCommandRatio * 100)}% of your shell commands are not routed through rtk.`,
      };
    },
    body: (evidence) =>
      `rtk is our token-saving CLI proxy that rewrites routine shell output. ${evidence} Routing shell through rtk trims the token cost of that output, which compounds over a busy session corpus.`,
    whyItMatters:
      "rtk cuts the token cost of common dev commands; unrouted shell pays full price on output you rarely need verbatim.",
    experiment:
      "Route the next batch of routine commands through rtk and compare token spend against an unrouted baseline.",
    howToAct: [
      "Install the rtk hook in your Claude Code settings so shell rewrites happen automatically.",
      "Verify common commands (git, ls, grep) proxy through rtk.",
      "Compare token spend against your recent baseline.",
    ],
    actionLabel: "Draft rtk setup",
    actionResult: "Drafts the rtk routing setup steps for your shell hook.",
    whatThisMeans: "You are not routing shell commands through rtk yet.",
  },
  {
    id: SKILLS_GAP_ID,
    title: "Promote repeated patterns into skills",
    capability: "skills",
    detect: (metrics) => {
      if (
        metrics.repeatedCommandFamilies.length < SKILLS_MIN_REPEATED_FAMILIES
      ) {
        return null;
      }
      // A failed skills read is reported as `null` (unavailable), never 0 — do
      // not read "couldn't load your skills" as "you have no skills".
      if (metrics.totalSkillInvocations == null) {
        return null;
      }
      // Only a gap when there is repetition to capture AND no skills already in
      // use — a user with skills is already adopting the capability.
      if (metrics.totalSkillInvocations > 0) {
        return null;
      }
      // Full shortfall: repeated patterns exist and zero skills are used.
      const shortfall = 1;
      const volume = metrics.repeatedCommandFamilies.length / 5;
      return {
        shortfall,
        volume,
        evidence: `You have ${metrics.repeatedCommandFamilies.length} repeated command families and no skills in use.`,
      };
    },
    body: (evidence) =>
      `${evidence} Promoting a recurring pattern into a skill turns an ad-hoc sequence into a one-shot, durable primitive.`,
    whyItMatters:
      "Skills capture a proven sequence once so it runs deterministically thereafter, saving both tokens and the time to re-derive it.",
    experiment:
      "Promote your most-repeated pattern into a skill and measure the time and tokens it saves on the next run.",
    howToAct: [
      "Pick your most-repeated command family.",
      "Capture its steps and output contract as a skill.",
      "Invoke the skill instead of re-typing the sequence.",
    ],
    actionLabel: "Draft skill starter",
    // Honest about what buildActionDraft produces without a proposedArtifact or
    // candidateFromThisDryRun: a scaffold to author the skill from, not a
    // finished definition.
    actionResult:
      "Drafts a skill-authoring starter from these steps to fill in for your most-repeated pattern.",
    whatThisMeans: "You have repeated patterns but no skills capturing them.",
  },
];

/**
 * FEA-4153: build a capability-gap candidate for EVERY best-practice capability
 * the user's real usage proves they are NOT using. Returns an empty array when
 * every capability is either already adopted or has no measurable gap, so the
 * lever competes on genuine evidence and drops out cleanly when the user is
 * following best practice.
 *
 * All detected gaps are returned (not just the highest-scoring one) so the
 * downstream dismiss/acted-today filter runs BEFORE the one-per-lever contest:
 * if the strongest gap was permanently dismissed (e.g. plan mode), a
 * lower-scoring rtk or skills gap can still surface instead of the whole
 * `capability_gap` dimension going dark. `rankCandidatePool()` still keeps at
 * most one `capability_gap` lever, so the surfaced deck never shows two gaps.
 */
export function buildCapabilityGapCandidates(
  input: AgentCoachingInput,
  metrics: AgentCoachingGroundedMetrics,
  options: BuildCapabilityGapOptions = {}
): AgentCoachingCandidate[] {
  const candidates: AgentCoachingCandidate[] = [];
  for (const gap of CAPABILITY_GAPS) {
    // The skills gap and the token-efficiency reuse tip give the same advice
    // ("promote a repeated pattern into a skill"). They sit on different levers
    // so the diversity guarantee won't collapse them — so when the reuse tip is
    // already active, defer to it and let Reuse own the "make a skill" story
    // rather than surface a second, redundant skills tip badged Unused.
    if (gap.id === SKILLS_GAP_ID && options.reuseTipActive) {
      continue;
    }
    const detected = gap.detect(metrics);
    if (!detected) {
      continue;
    }
    const score = capabilityGapImpactScore(detected.shortfall, detected.volume);
    if (score <= 0) {
      continue;
    }
    candidates.push(buildGapCandidate(gap, detected.evidence, score, input));
  }
  return candidates;
}

function buildGapCandidate(
  gap: CapabilityGap,
  evidence: string,
  score: number,
  input: AgentCoachingInput
): AgentCoachingCandidate {
  // Follow-up prose is keyed on THIS gap's own tip id, not the shared
  // `capability_gap` category — acting on the plan-mode gap yesterday must not
  // make an unrelated rtk or skills gap claim it is a follow-up.
  const followUp: FeedbackFollowUp = tipFollowUp(
    gap.id,
    input.feedback,
    input.generatedAt
  );
  const tip: AgentCoachingTip = {
    id: gap.id,
    title: gap.title,
    category: CAPABILITY_GAP_CATEGORY,
    // The measured fact renders once, as the first Evidence row. The body
    // carries the advice so the same string is not repeated verbatim across
    // body, Why, and Evidence.
    body: `${followUp.prefix}${gap.body(evidence)}`,
    whyItMatters: gap.whyItMatters,
    evidence: [evidence],
    experiment: gap.experiment,
    detail: {
      whatThisMeans: gap.whatThisMeans,
      howToAct: gap.howToAct,
      whyThisRecommendation: `${followUp.why}This is grounded in your real usage, not a static checklist, so adopting ${gap.capability} is a lever with concrete room to improve.`,
      autoApply: `Desktop can draft the ${gap.capability} setup. It should not change your configuration on its own.`,
    },
    actions: [
      {
        id: `${gap.id}-draft`,
        label: gap.actionLabel,
        mode: "draft",
        safety: "safe",
        result: gap.actionResult,
      },
    ],
  };
  return toCandidate(tip, "capability_gap", score, input);
}

/** Options for `buildCapabilityGapCandidates`. */
type BuildCapabilityGapOptions = {
  /**
   * True when the token-efficiency reuse tip ("promote a repeated pattern into
   * a skill") is already surfacing this pass. When set, the skills gap defers
   * to it so the deck never shows two "make a skill" tips.
   */
  reuseTipActive?: boolean;
};
