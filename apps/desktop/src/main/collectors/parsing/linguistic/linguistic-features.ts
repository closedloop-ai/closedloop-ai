/**
 * @file linguistic-features.ts
 * @description FEA-2274 (PRD-488): the DETERMINISTIC natural-language feature
 * extractor — the "linguistic labeler" the offline distillation harness runs
 * over the prose of residual segments. Per Q-002 (resolved: offline-only) this is
 * a pure rules/heuristics prototype, NOT a model: no network, no prose leaves the
 * device, and identical text yields an identical label (the harness's
 * reproducibility contract).
 *
 * Each rule pairs a natural-language cue with the activity phase that cue
 * suggests. Rules are evaluated in a fixed, most-specific-first order and the
 * FIRST match wins, so the labeler is total and order-deterministic. The output
 * is deliberately a CANDIDATE signal, not a verdict: the harness tallies which
 * rules fire, over how much residual spend, so a human can judge which
 * natural-language signatures are robust enough to promote into FEA-2269's
 * deterministic structural classifier. It is never wired into the runtime
 * classifier here.
 *
 * ANTI-OVER-FITTING: cues are generic activity language ("run the tests", "fix
 * the bug", "let's plan"), never a repo-specific path, skill name, or one user's
 * workflow token (PRD-488's stated #1 risk). Regexes are module-level constants
 * per AGENTS.md (`useTopLevelRegex`).
 */
import { ACTIVITY_PHASE, type ActivityPhase } from "../activity-taxonomy.js";

/** Upper bound on prose scanned per segment — defends against pathological input. */
export const MAX_PROSE_SCAN_CHARS = 20_000;

// ── Cue patterns (module-level per `useTopLevelRegex`) ────────────────────────

/** Review intent: reviewing code / reacting to a review. */
const REVIEW_CUE =
  /\b(lgtm|code review|review (?:this|the|these|my|it)|looks good|nitpick|address(?:ing)? (?:the )?(?:review )?comments?)\b/i;

/** Validate intent: running tests / checks to confirm behaviour. */
const VALIDATE_CUE =
  /\b(run (?:the )?tests?|type[- ]?check|lint(?:ing)?|does it pass|make sure (?:it|this|everything) (?:works|passes)|verify that|reproduce)\b/i;

/** Rework intent: fixing a defect / responding to breakage. */
const REWORK_CUE =
  /\b(fix (?:the |this )?(?:bug|error|failing|test|regression|issue)|still (?:failing|broken)|is broken|does(?:n't| not) work|revert)\b/i;

/** Plan intent: deciding an approach before building. */
const PLAN_CUE =
  /\b(let'?s plan|plan (?:the|this|out|for)|(?:the |an )approach|design (?:the|a|an)|think through|outline (?:the|a)|high[- ]level plan)\b/i;

/** Explore intent: understanding the codebase before acting. */
const EXPLORE_CUE =
  /\b(understand (?:how|the|this|why)|investigate|how does|what does|look into|trace (?:through|the)|where (?:is|are)|figure out (?:how|what|why))\b/i;

/** Implement intent: building the change. */
const IMPLEMENT_CUE =
  /\b(implement|add (?:a|the|support)|build (?:the|a)|create (?:a|the)|write (?:the|a)|refactor|wire up|hook up)\b/i;

/** A single natural-language signature and the phase it suggests. */
export type LinguisticRule = {
  /** Stable id used to tally per-rule support in the distillation report. */
  id: string;
  phase: ActivityPhase;
  /** Human-readable description of the cue, surfaced in the report. */
  cue: string;
  pattern: RegExp;
};

/**
 * The ordered rule set — the SSOT of candidate natural-language signatures.
 * Order is load-bearing: {@link detectLinguisticSignal} returns the first match,
 * so more-specific/less-ambiguous cues come first. Every phase here is a real
 * active-work phase (never `other`/`idle`), so a matched relabel always moves
 * spend from residual into a covered bucket.
 */
export const LINGUISTIC_RULES: readonly LinguisticRule[] = [
  {
    id: "review.cue",
    phase: ACTIVITY_PHASE.Review,
    cue: "review language (lgtm, code review, address comments)",
    pattern: REVIEW_CUE,
  },
  {
    id: "validate.cue",
    phase: ACTIVITY_PHASE.Validate,
    cue: "validation language (run the tests, typecheck, lint, verify)",
    pattern: VALIDATE_CUE,
  },
  {
    id: "rework.cue",
    phase: ACTIVITY_PHASE.Rework,
    cue: "defect-fixing language (fix the bug, still failing, revert)",
    pattern: REWORK_CUE,
  },
  {
    id: "plan.cue",
    phase: ACTIVITY_PHASE.Plan,
    cue: "planning language (let's plan, approach, design the, outline)",
    pattern: PLAN_CUE,
  },
  {
    id: "explore.cue",
    phase: ACTIVITY_PHASE.Explore,
    cue: "exploration language (understand how, investigate, how does, trace)",
    pattern: EXPLORE_CUE,
  },
  {
    id: "implement.cue",
    phase: ACTIVITY_PHASE.Implement,
    cue: "implementation language (implement, add, build, refactor, wire up)",
    pattern: IMPLEMENT_CUE,
  },
];

/** A candidate label produced from a residual segment's prose. */
export type LinguisticSignal = {
  ruleId: string;
  phase: ActivityPhase;
  cue: string;
};

/**
 * The first linguistic rule whose cue appears in `text`, or null when the prose
 * carries no recognized activity signature. Deterministic: scans
 * {@link LINGUISTIC_RULES} in order over a bounded prefix of the text.
 */
export function detectLinguisticSignal(
  text: string | null | undefined
): LinguisticSignal | null {
  if (!text) {
    return null;
  }
  const scanned =
    text.length > MAX_PROSE_SCAN_CHARS
      ? text.slice(0, MAX_PROSE_SCAN_CHARS)
      : text;
  for (const rule of LINGUISTIC_RULES) {
    if (rule.pattern.test(scanned)) {
      return { ruleId: rule.id, phase: rule.phase, cue: rule.cue };
    }
  }
  return null;
}
