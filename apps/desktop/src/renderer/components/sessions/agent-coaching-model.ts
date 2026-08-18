import { formatDateForInput } from "@repo/app/shared/lib/date-utils";
import { buildCapabilityGapCandidates } from "./agent-coaching-capability-gap";
import {
  buildCostCandidate,
  buildWallTimeCandidate,
} from "./agent-coaching-dimensions";
import {
  ALL_COACHING_LEVERS,
  contextLeverWarranted,
  harnessRoutingLeverWarranted,
  type LeverSignals,
  leverWarranted,
  resilienceLeverWarranted,
  reuseLeverWarranted,
  testSequencingLeverWarranted,
} from "./agent-coaching-lever-gate";
import { computePeakFrustration } from "./agent-coaching-lookback";
import { redactSecrets } from "./agent-coaching-redaction";
import {
  type AgentCoachingCandidate,
  type AgentCoachingLever,
  candidateMetrics,
  contextImpactScore,
  type FeedbackInsights,
  feedbackFollowUp,
  harnessRoutingImpactScore,
  leverForCategory,
  rankCandidatePool,
  resilienceImpactScore,
  reuseImpactScore,
  reuseSkillImpactScore,
  summarizeFeedback,
  testSequencingImpactScore,
  toCandidate,
} from "./agent-coaching-scoring";
import {
  AGENT_COACHING_DAILY_TIP_LIMIT,
  type AgentCoachingFeedbackEvent,
  type AgentCoachingGroundedMetrics,
  type AgentCoachingInput,
  type AgentCoachingTip,
} from "./agent-coaching-types";

const TOP_COMMAND_LIMIT = 3;
const LOW_VALUE_COMMAND_FAMILIES = new Set([
  "cat",
  "cd",
  "echo",
  "git diff",
  "git status",
  "ls",
  "nl",
  "rg search",
  "sed read",
  "sleep",
]);
const MAX_EXAMPLE_CHARS = 320;
const GENERAL_SUBAGENT_PATTERN = /general|explore/i;
const TEST_SUBAGENT_PATTERN = /test|qa|review/i;
const HARNESS_SIGNAL_PATTERN = /bash|exec_command|agent|task|mcp|skill/i;
// Distinct harness work modes, each with the tool-name aliases that map to it.
// `bash`/`exec_command` are both execution; `agent`/`task` are both delegation —
// bucketing collapses those aliases so counting modes can't double-count them.
const WORK_MODE_PATTERNS: Array<{ mode: string; pattern: RegExp }> = [
  { mode: "execution", pattern: /bash|exec_command|shell/i },
  { mode: "delegation", pattern: /agent|task/i },
  { mode: "provider", pattern: /mcp/i },
  { mode: "skill", pattern: /skill/i },
];
const SHELL_TOOL_PATTERN = /bash|exec_command|shell/i;
const NIGHTLY_REVIEW_TMP_PATTERN = /\/tmp\/nrev\//;
const NIGHTLY_REVIEW_MARKER_PATTERN = /\.nightly-review/;
const NIGHTLY_WORD_PATTERN = /nightly/i;
const GH_PR_REVIEW_COMMAND_PATTERN = /gh pr (checks|view|list)/;
const REVIEW_CONTEXT_PATTERN = /pull|review|comment/i;
const GIT_STATE_COMMAND_PATTERN = /git (status|diff|merge|rev-parse)/;
const SEARCH_COMMAND_PATTERN = /rg |grep |find /;
const CD_AND_COMMAND_PATTERN = /^cd\s+\S+\s+&&\s+(.+)$/s;
const WHITESPACE_PATTERN = /\s+/;
const NON_SLUG_CHARACTER_PATTERN = /[^a-z0-9]+/g;
const SLUG_EDGE_PATTERN = /^-|-$/g;
// A skill slug is a short identifier (e.g. `git-diff`, `rg-search`); cap the
// segment count so a malformed/blobby family can never expand into a giant
// slugified identifier leaking into the skill name (FEA-3687).
const SLUG_MAX_SEGMENTS = 4;

type Candidate = {
  family: string;
  count: number;
  estimatedTokenSavingsPercent: number;
  representativeCommands: string[];
};

/**
 * FEA-3265: build the day's coaching tips from a scored candidate POOL, not a
 * fixed one-per-category array.
 *
 * Every builder emits zero or more candidates across dimensions (context, wall
 * time, reuse/skill, output quality, cost, harness routing, resilience). Each
 * candidate carries a grounded impact score derived from the lookback metrics —
 * so a non-skill lever can and does outrank skill-creation when the user's
 * sessions say so; there is no forced skill-creation quota and no guaranteed
 * per-category slot. The pool is then ranked by impact with a diversity
 * guarantee (at most one tip per underlying lever) and the surfaced set is
 * presented most → least impactful, so "Tip 1 of N" is the strongest lever
 * (the deck shows one tip at a time from index 0, so every tip is equally
 * close to the CTA and the highest-impact one must not be buried).
 */
export function buildAgentCoachingTips(
  input: AgentCoachingInput
): AgentCoachingTip[] {
  const analytics = input.analytics;
  const workflow = input.workflow;
  // Bail before running any builders when there is no local evidence at all —
  // otherwise we build a pool, filter it, and throw the result away.
  if (
    (analytics?.totalSessions ?? 0) === 0 &&
    (workflow?.stats.totalSessions ?? 0) === 0 &&
    input.recentEvents.length === 0
  ) {
    return [];
  }

  const today = toDayKey(input.generatedAt);
  const feedbackInsights = summarizeFeedback(input.feedback, today);
  const metrics = candidateMetrics(input);
  const commandCandidate = findReusableCommandCandidate(input.recentEvents);
  const tokenEfficiency = buildTokenEfficiencyCandidate(
    input,
    metrics,
    commandCandidate,
    feedbackInsights
  );
  const pool: AgentCoachingCandidate[] = [
    buildContextCandidate(input, metrics, feedbackInsights),
    buildWorkflowCandidate(input, metrics, feedbackInsights),
    buildAccuracyCandidate(input, feedbackInsights),
    buildHarnessCandidate(input, feedbackInsights),
    tokenEfficiency,
    buildResilienceCandidate(input, feedbackInsights),
    buildWallTimeCandidate(input, metrics, feedbackInsights),
    buildCostCandidate(input, metrics, feedbackInsights),
    // Capability-gap returns one candidate PER detected gap (not just the
    // top one) so the dismiss/acted-today filter below runs before the
    // one-per-lever contest in rankCandidatePool — a dismissed plan-mode gap
    // must not suppress a live rtk or skills gap. `reuseTipActive` lets the
    // skills gap defer to the token-efficiency reuse tip when that tip is
    // already telling the user to promote a repeated pattern into a skill, so
    // the deck never shows two "make a skill" tips (one Reuse, one Unused).
    ...buildCapabilityGapCandidates(input, metrics, {
      reuseTipActive: tokenEfficiency !== null,
    }),
  ].filter((candidate): candidate is AgentCoachingCandidate =>
    Boolean(candidate)
  );

  const excludedTipIds = excludedCoachingTipIds(
    input.feedback,
    input.generatedAt
  );

  const eligible = pool.filter(
    (candidate) => !excludedTipIds.has(candidate.tip.id)
  );
  return rankCandidatePool(eligible, AGENT_COACHING_DAILY_TIP_LIMIT);
}

/**
 * Tip ids that must never appear in a tip set — dismissed (forever) or acted on
 * today. Shared by the heuristic model AND the harness-generated path so a
 * non-compliant generator can't re-serve a tip the user already cleared.
 */
export function excludedCoachingTipIds(
  feedback: AgentCoachingFeedbackEvent[],
  generatedAt: Date
): Set<string> {
  const today = toDayKey(generatedAt);
  const ids = new Set<string>();
  for (const event of feedback) {
    if (event.action === "dismissed") {
      ids.add(event.tipId);
    } else if (
      event.action === "action_clicked" &&
      toDayKey(new Date(event.createdAt)) === today
    ) {
      ids.add(event.tipId);
    }
  }
  return ids;
}

/**
 * FEA-4179: compute every per-lever adoption signal once from the user's input.
 * These are the SAME signals the deterministic seed builders compute for their
 * own gate — extracted here so the harness-generated path can gate any lever a
 * tip carries against real usage, using the shared `agent-coaching-lever-gate`
 * predicates (no duplicated thresholds).
 */
function computeLeverSignals(
  input: AgentCoachingInput,
  metrics: AgentCoachingGroundedMetrics
): LeverSignals {
  const analytics = input.analytics;
  const workflow = input.workflow;
  const totalSessions =
    analytics?.totalSessions ?? workflow?.stats.totalSessions ?? 0;
  const totalEvents = analytics?.totalEvents ?? 0;
  const totalTokens =
    (analytics?.tokens.totalInputTokens ?? 0) +
    (analytics?.tokens.totalOutputTokens ?? 0);
  const averageEvents =
    totalSessions > 0 ? Math.round(totalEvents / totalSessions) : 0;
  const averageTokens =
    totalSessions > 0 ? Math.round(totalTokens / totalSessions) : 0;

  const reusableCommandCandidate = findReusableCommandCandidate(
    input.recentEvents
  );
  const skillCount = input.skills.reduce(
    (sum, skill) => sum + skill.invocationCount,
    0
  );
  const toolCounts = analytics?.toolUsage ?? [];
  const hasShellTool = toolCounts.some((tool) =>
    SHELL_TOOL_PATTERN.test(tool.toolName)
  );

  const subagents = workflow?.orchestration.subagentTypes ?? [];
  const generalCount = subagents
    .filter((item) => GENERAL_SUBAGENT_PATTERN.test(item.subagentType))
    .reduce((sum, item) => sum + item.count, 0);
  const testCount = subagents
    .filter((item) => TEST_SUBAGENT_PATTERN.test(item.subagentType))
    .reduce((sum, item) => sum + item.count, 0);

  const harnessLikeSignals = toolCounts.filter((tool) =>
    HARNESS_SIGNAL_PATTERN.test(tool.toolName)
  );

  return {
    avgSessionDurationSec: metrics.avgSessionDurationSec,
    context: { averageEvents, averageTokens, totalSessions },
    cost: {
      estimatedCostUsd: metrics.estimatedCostUsd,
      totalTokens: metrics.totalTokens,
    },
    harnessDistinctModes: countDistinctWorkModes(harnessLikeSignals),
    // The capability-gap lever is warranted iff the SAME detection the seed
    // builder runs finds at least one genuine gap for these metrics, so both
    // paths gate on identical evidence.
    hasCapabilityGap: buildCapabilityGapCandidates(input, metrics).length > 0,
    hasPeakFrustration: computePeakFrustration(input.recentEvents) != null,
    reuse: {
      hasReusableCommandCandidate: Boolean(reusableCommandCandidate),
      hasShellTool,
      skillCount,
    },
    testSequencing: { generalCount, testCount },
  };
}

/**
 * FEA-4179: the set of levers the user's actual usage warrants — the SAME
 * per-lever gates the deterministic seed builders enforce. Used to drop
 * harness-generated tips for levers the metrics don't justify (e.g. a
 * "you're not using plan mode" tip shown to someone who is), so the generated
 * path can't bypass the determinism gates the seed path enforces.
 */
export function warrantedLeversForInput(
  input: AgentCoachingInput
): Set<AgentCoachingLever> {
  const signals = computeLeverSignals(input, candidateMetrics(input));
  const warranted = new Set<AgentCoachingLever>();
  for (const lever of ALL_COACHING_LEVERS) {
    if (leverWarranted(lever, signals)) {
      warranted.add(lever);
    }
  }
  return warranted;
}

/**
 * FEA-4179: drop harness-generated tips whose lever isn't in the pre-computed
 * warranted set (from `warrantedLeversForInput`). The caller computes the set
 * ONCE per load and reuses it across the bounded generation rounds — the input
 * is invariant across rounds, so recomputing the metrics/peak/reuse signals per
 * round would be wasted work. The tip→lever mapping is the canonical
 * `leverForCategory`.
 */
export function filterGeneratedTipsByWarrantedLevers(
  tips: AgentCoachingTip[],
  warrantedLevers: Set<AgentCoachingLever>
): AgentCoachingTip[] {
  return tips.filter((tip) =>
    warrantedLevers.has(leverForCategory(tip.category))
  );
}

/**
 * FEA-4179: drop harness-generated tips whose lever isn't warranted by the
 * user's real usage. A nonempty generated batch REPLACES the deterministically
 * gated seed tips, so without this a lever the model emits but the metrics don't
 * justify would reach the user — the exact determinism bypass this closes.
 * Reuses the seed gate (`warrantedLeversForInput`) so the two paths stay at
 * parity. Convenience wrapper over `filterGeneratedTipsByWarrantedLevers` for
 * single-batch callers (and tests); the generation loop hoists the set instead.
 */
export function filterGeneratedTipsByAdoptionSignal(
  tips: AgentCoachingTip[],
  input: AgentCoachingInput
): AgentCoachingTip[] {
  return filterGeneratedTipsByWarrantedLevers(
    tips,
    warrantedLeversForInput(input)
  );
}

function buildContextCandidate(
  input: AgentCoachingInput,
  metrics: AgentCoachingGroundedMetrics,
  feedbackInsights: FeedbackInsights
): AgentCoachingCandidate | null {
  const analytics = input.analytics;
  const workflow = input.workflow;
  const totalSessions =
    analytics?.totalSessions ?? workflow?.stats.totalSessions ?? 0;
  const totalEvents = analytics?.totalEvents ?? 0;
  const totalTokens =
    (analytics?.tokens.totalInputTokens ?? 0) +
    (analytics?.tokens.totalOutputTokens ?? 0);
  const averageEvents =
    totalSessions > 0 ? Math.round(totalEvents / totalSessions) : 0;
  const averageTokens =
    totalSessions > 0 ? Math.round(totalTokens / totalSessions) : 0;
  if (!contextLeverWarranted({ averageEvents, averageTokens, totalSessions })) {
    return null;
  }

  const followUp = feedbackFollowUp("context_management", feedbackInsights);

  const tip: AgentCoachingTip = {
    id: "context-checkpoint",
    title: "Set a hard context checkpoint before sessions sprawl",
    category: "context_management",
    body: `${followUp.prefix}Your local desktop history averages ${averageEvents.toLocaleString()} events and ${averageTokens.toLocaleString()} tokens per session. Add a checkpoint before long sessions become the only decision trail.`,
    whyItMatters:
      "Checkpointing reduces repeated context, keeps decisions inspectable, and makes compaction or restart safer.",
    evidence: [
      `${totalSessions.toLocaleString()} local sessions analyzed`,
      `${totalEvents.toLocaleString()} captured events`,
      `${averageTokens.toLocaleString()} average tokens per session`,
    ],
    experiment:
      "Before the next long task crosses 120 turns, ask for decisions, changed files, risks, and next commands, then continue from that recap.",
    detail: {
      whatThisMeans:
        "This is a context-management habit. Acting on it means creating a compact local checkpoint before the transcript becomes the only source of truth.",
      howToAct: [
        "Ask for a recap with decisions, changed files, open risks, and next commands.",
        "Start the next phase from that recap when the task gets large.",
        "Track whether the next session needs fewer corrective turns.",
      ],
      whyThisRecommendation: `${followUp.why}The local sessions average ${averageEvents.toLocaleString()} events, so the main risk is stale context and repeated rediscovery.`,
      autoApply:
        "Desktop can draft the checkpoint prompt. Starting a new session or pruning context should stay user-confirmed.",
    },
    actions: [
      {
        id: "draft-checkpoint-prompt",
        label: "Draft checkpoint",
        mode: "draft",
        safety: "safe",
        result: "Creates a compact prompt for the current agent session.",
      },
    ],
  };
  // Impact scales with how far this user's sessions exceed the sprawl floor:
  // heavier per-session event and token load = more to gain from a checkpoint.
  return toCandidate(
    tip,
    "context_hygiene",
    contextImpactScore(averageEvents, averageTokens, metrics),
    input
  );
}

function buildWorkflowCandidate(
  input: AgentCoachingInput,
  metrics: AgentCoachingGroundedMetrics,
  feedbackInsights: FeedbackInsights
): AgentCoachingCandidate | null {
  const candidate = findReusableCommandCandidate(input.recentEvents, [
    "nightly-review-worktree-preflight",
    "github-pr-review-preflight",
  ]);
  const skillCount = input.skills.reduce(
    (sum, skill) => sum + skill.invocationCount,
    0
  );
  // Workflow builder pulls the shared `reuse` lever on the repeated-command or
  // skill-usage half of the gate; the token-efficiency builder covers the
  // shell-tool fallback half. Gate through the SSOT so the generated `reuse`
  // filter can't diverge.
  if (
    !reuseLeverWarranted({
      hasReusableCommandCandidate: Boolean(candidate),
      hasShellTool: false,
      skillCount,
    })
  ) {
    return null;
  }

  const pattern = candidate?.family ?? "repeated review workflow";
  const followUp = feedbackFollowUp("speed_of_delivery", feedbackInsights);
  const tip: AgentCoachingTip = {
    id: "promote-review-workflow",
    title: "Promote repeated review orchestration into a workflow",
    category: "speed_of_delivery",
    body: `${followUp.prefix}Desktop found ${candidate?.count ?? skillCount} repeated ${pattern} signals. Turn the stable discovery and validation steps into a named workflow or skill.`,
    whyItMatters:
      "Stable operational prompts are expensive to re-send and easy to drift. A workflow makes the agent faster and more consistent.",
    evidence: [
      `${candidate?.count ?? 0} repeated ${pattern} command events`,
      `${skillCount.toLocaleString()} local skill invocations`,
    ],
    experiment:
      "Draft one reusable workflow for the repeated review path and compare whether the next run needs fewer corrective turns.",
    detail: {
      whatThisMeans:
        "This is a workflow-extraction recommendation. Acting on it means turning a repeated orchestration path into a named, reusable routine.",
      howToAct: [
        "Inspect representative commands from the repeated pattern.",
        "Draft a workflow with required inputs and a compact final report.",
        "Use it once, then compare turn count and rework.",
      ],
      whyThisRecommendation: `${followUp.why}${
        candidate
          ? `${pattern} appeared ${candidate.count} times in recent local events. That is enough repetition to justify a reusable workflow.`
          : "Your local skill history shows enough repeated command-library usage to make workflow extraction useful."
      }`,
      autoApply:
        "Desktop can draft the workflow. Installing it should require confirmation.",
    },
    actions: [
      {
        id: "draft-workflow",
        label: "Draft workflow",
        mode: "draft",
        safety: "safe",
        result: "Creates a workflow spec from the repeated orchestration path.",
      },
    ],
  };
  // Reuse lever — impact scales with repetition volume (a workflow amortizes
  // over every future run). Shares the `reuse` lever with the token-efficiency
  // skill tip, so the ranker surfaces whichever repetition signal is stronger,
  // not both.
  return toCandidate(
    tip,
    "reuse",
    reuseImpactScore(candidate?.count ?? 0, skillCount, metrics),
    input
  );
}

function buildAccuracyCandidate(
  input: AgentCoachingInput,
  feedbackInsights: FeedbackInsights
): AgentCoachingCandidate | null {
  const subagents = input.workflow?.orchestration.subagentTypes ?? [];
  const generalCount = subagents
    .filter((item) => GENERAL_SUBAGENT_PATTERN.test(item.subagentType))
    .reduce((sum, item) => sum + item.count, 0);
  const testCount = subagents
    .filter((item) => TEST_SUBAGENT_PATTERN.test(item.subagentType))
    .reduce((sum, item) => sum + item.count, 0);
  if (!testSequencingLeverWarranted({ generalCount, testCount })) {
    return null;
  }
  const followUp = feedbackFollowUp("accuracy", feedbackInsights);

  const tip: AgentCoachingTip = {
    id: "test-design-earlier",
    title: "Move test design earlier in the delegation tree",
    category: "accuracy",
    body: `${followUp.prefix}Your local subagent mix shows ${generalCount} explore/general delegations versus ${testCount} test or review delegations. Add test design before implementation on risky work.`,
    whyItMatters:
      "The next accuracy gain is catching the missing regression shape before code is written.",
    evidence: [
      `${generalCount} explore/general subagent runs`,
      `${testCount} test/review subagent runs`,
    ],
    experiment:
      "For the next shared-contract or UI-state change, draft a test-engineer prompt before editing.",
    detail: {
      whatThisMeans:
        "This is a sequencing recommendation. Acting on it means making test design a first-class planning step, not cleanup after implementation.",
      howToAct: [
        "Detect contract, migration, UI state, or compatibility changes.",
        "Draft a test-design prompt from the acceptance criteria.",
        "Have implementation answer the regression cases before editing.",
      ],
      whyThisRecommendation: `${followUp.why}The observed local mix leans toward ${generalCount} exploratory/general runs and ${testCount} test/review runs.`,
      autoApply:
        "Desktop can draft the test-design prompt. Blocking work on it should require opt-in.",
    },
    actions: [
      {
        id: "draft-test-design-prompt",
        label: "Draft test prompt",
        mode: "draft",
        safety: "safe",
        result: "Creates a test-engineer prompt scoped to the next task.",
      },
    ],
  };
  // Test-sequencing lever — impact scales with how skewed the delegation mix is
  // toward exploration over test/review (more explore-heavy = more accuracy to
  // gain by moving test design earlier).
  return toCandidate(
    tip,
    "test_sequencing",
    testSequencingImpactScore(generalCount, testCount),
    input
  );
}

function buildHarnessCandidate(
  input: AgentCoachingInput,
  feedbackInsights: FeedbackInsights
): AgentCoachingCandidate | null {
  const toolCounts = input.analytics?.toolUsage ?? [];
  const harnessLikeSignals = toolCounts.filter((tool) =>
    HARNESS_SIGNAL_PATTERN.test(tool.toolName)
  );
  // Rank on DISTINCT work modes, not raw matching-tool rows: `bash` and
  // `exec_command` are both the execution mode, `agent`/`task` are both
  // delegation, so counting rows lets aliases inflate the routing signal. Bucket
  // each matching tool into its work mode and dedupe before scoring/gating —
  // deliberate routing only pays off when genuinely different modes are in play.
  const distinctModes = countDistinctWorkModes(harnessLikeSignals);
  if (!harnessRoutingLeverWarranted(distinctModes)) {
    return null;
  }
  const followUp = feedbackFollowUp("opportunity_analysis", feedbackInsights);

  const tip: AgentCoachingTip = {
    id: "harness-routing",
    title: "Choose the harness from the task shape",
    category: "opportunity_analysis",
    body: `${followUp.prefix}Your desktop history mixes tool-heavy execution, delegation, and local skill use. Pick the harness deliberately before starting the next task.`,
    whyItMatters:
      "Different agent tools are improving in different places. Matching task shape to tool strength is now part of agentic-development skill.",
    evidence: harnessLikeSignals
      .slice(0, 3)
      .map((tool) => `${tool.toolName}: ${tool.count.toLocaleString()} events`),
    experiment:
      "Classify the next task as decomposition-heavy, remote-execution-heavy, MCP/provider-heavy, or review-heavy before launch.",
    detail: {
      whatThisMeans:
        "This is a routing recommendation. Acting on it means deciding the harness before the session starts, rather than defaulting from habit.",
      howToAct: [
        "Classify the incoming task shape.",
        "Pick the harness whose current strengths match that shape.",
        "Record when you override the recommendation so tomorrow's coaching can adapt.",
      ],
      whyThisRecommendation: `${followUp.why}The local tool mix shows several distinct work modes rather than one dominant execution pattern.`,
      autoApply:
        "Desktop can prefill launch settings after confirmation. It should not switch execution environments silently.",
    },
    actions: [
      {
        id: "classify-next-task",
        label: "Classify task",
        mode: "draft",
        safety: "safe",
        result: "Drafts a harness recommendation with alternatives.",
      },
    ],
  };
  // Harness-routing lever — impact scales with how many distinct work modes the
  // tool mix shows (more distinct modes = more to gain from deliberate routing).
  return toCandidate(
    tip,
    "harness_routing",
    harnessRoutingImpactScore(distinctModes),
    input
  );
}

function buildTokenEfficiencyCandidate(
  input: AgentCoachingInput,
  metrics: AgentCoachingGroundedMetrics,
  candidate: Candidate | null,
  feedbackInsights: FeedbackInsights
): AgentCoachingCandidate | null {
  const toolCounts = input.analytics?.toolUsage ?? [];
  const topShellTool = toolCounts.find((tool) =>
    SHELL_TOOL_PATTERN.test(tool.toolName)
  );
  // Token-efficiency pulls the shared `reuse` lever on the shell-tool-fallback
  // half of the gate (the workflow builder covers repeated-command/skill usage).
  if (
    !reuseLeverWarranted({
      hasReusableCommandCandidate: Boolean(candidate),
      hasShellTool: Boolean(topShellTool),
      skillCount: 0,
    })
  ) {
    return null;
  }

  const pattern = candidate?.family ?? topShellTool?.toolName ?? "shell probes";
  const observedCalls = candidate?.count ?? topShellTool?.count ?? 0;
  const savings = candidate?.estimatedTokenSavingsPercent ?? 35;
  const skillName = commandSkillName(pattern);
  const followUp = feedbackFollowUp("token_efficiency", feedbackInsights);

  const tip: AgentCoachingTip = {
    id: "shell-probe-reusable-skill",
    title: "Move repeated shell probes into a reusable skill",
    category: "token_efficiency",
    body: `${followUp.prefix}These shell calls were often repeated. Move ${pattern} to a reusable skill and save about ${savings}% of the repeated probe tokens.`,
    whyItMatters:
      "This cuts token load, reduces command quoting mistakes, and gives the agent a smaller action surface to reason over.",
    evidence: [
      `${observedCalls.toLocaleString()} observed ${pattern} calls or events`,
      `${input.recentEvents.length.toLocaleString()} recent local events inspected`,
      candidate
        ? `representative commands: ${candidate.representativeCommands.length}`
        : "no representative commands were available from summaries",
    ],
    experiment:
      "Draft one reusable skill for this repeated probe and compare output size against the original command cluster.",
    detail: {
      whatThisMeans:
        "For this recommendation, acting on it means promoting the repeated probe into a higher-level operation with a compact output contract.",
      howToAct: [
        "Inspect the command cluster that triggered this tip.",
        "Draft a reusable skill with inputs and a short output contract.",
        "Confirm before writing the skill locally.",
        "Check tomorrow whether the repeated probe count drops.",
      ],
      whyThisRecommendation: `${followUp.why}${pattern} appeared ${observedCalls.toLocaleString()} times in local desktop evidence. Promoting it to ${skillName} should reduce repeated command text and raw output by about ${savings}%.`,
      candidateFromThisDryRun: {
        pattern,
        observedCalls,
        estimatedTokenSavingsPercent: savings,
        moveThis: `Move repeated ${pattern} probes into ${skillName}.`,
        suggestedWrapper: `Create ${skillName}, a reusable skill that returns the compact facts normally gathered by repeated ${pattern} calls.`,
        outputContract: [
          "current branch and base branch",
          "dirty file count plus top paths",
          "open PR/check status when available",
          "recommended next validation command",
        ],
        representativeCommands: candidate?.representativeCommands ?? [],
      },
      autoApply:
        "Desktop can draft the wrapper spec now. Writing the skill should require confirmation.",
    },
    actions: [
      {
        id: "draft-command-wrapper",
        label: "Draft skill",
        mode: "draft",
        safety: "safe",
        result: `Drafts ${skillName} for the repeated ${pattern} pattern.`,
      },
      {
        id: "apply-command-wrapper",
        label: "Apply skill",
        mode: "confirm_then_apply",
        safety: "moderate",
        // A repeated-command wrapper is a single new skill file — the
        // deterministic new-file install path (FEA-3687 #4).
        kind: "create-new-file",
        result: "Writes the approved skill after confirmation.",
      },
    ],
  };
  // Reuse lever — impact scales with observed REPETITION AND the estimated
  // per-call savings. Only a real repeated command family (`candidate.count`)
  // is repetition; the `topShellTool` fallback is the aggregate shell-tool count
  // across UNRELATED commands, so feeding it to the reuse scorer would let 80
  // one-off shell calls rank like 80 repetitions of one probe (wongk review).
  // When there is no repeated family, the reuse repetition signal is 0 and the
  // tip stands on savings alone, so a genuinely-grounded lever outranks it.
  const repeatedCallCount = candidate?.count ?? 0;
  // Skill-creation earns its rank here like any other lever: when repetition is
  // thin, a stronger non-skill lever (cost, wall time, context) outranks it.
  // Shares the `reuse` lever with the workflow tip.
  return toCandidate(
    tip,
    "reuse",
    reuseSkillImpactScore(repeatedCallCount, savings, metrics),
    input
  );
}

// FEA-3399: turn the peak-frustration signal ("your biggest crash out") into a
// constructive, evidence-first resilience tip. Emitted only when a confident
// peak exists (computePeakFrustration returns null otherwise), reusing the same
// zero-evidence discipline as the other builders — no forced/fake crash-out.
function buildResilienceCandidate(
  input: AgentCoachingInput,
  feedbackInsights: FeedbackInsights
): AgentCoachingCandidate | null {
  const peak = computePeakFrustration(input.recentEvents);
  // The resilience gate is "a confident peak exists" — the null check here IS
  // that gate, mirrored in resilienceLeverWarranted for the generated path (the
  // inline form is kept so TS narrows `peak` for the tip body below).
  if (!(peak && resilienceLeverWarranted(Boolean(peak)))) {
    return null;
  }
  const followUp = feedbackFollowUp("resilience", feedbackInsights);
  const sessionLabel = peak.sessionName ?? "a recent session";
  const errorContext =
    peak.nearbyErrorCount > 0
      ? ` with ${peak.nearbyErrorCount} error${peak.nearbyErrorCount === 1 ? "" : "s"} clustered right around it`
      : "";

  const tip: AgentCoachingTip = {
    id: "resilience-frustration-reset",
    title: "Reset before the next crash-out moment",
    category: "resilience",
    body: `${followUp.prefix}Your sharpest frustration peak was in ${sessionLabel}${errorContext}. When a turn heats up like that, a quick reset — plan mode or a smaller scope — usually lands faster than pushing through.`,
    whyItMatters:
      "Frustration peaks correlate with rework loops. Catching the moment and re-scoping beats steering an agent that has already drifted.",
    evidence: [
      `peak frustration excerpt: "${peak.excerpt}"`,
      `frustration intensity score: ${peak.score}`,
      `${peak.nearbyErrorCount.toLocaleString()} error/fail events near the peak turn`,
    ],
    experiment:
      "Next time a turn spikes like this, stop and switch to plan mode or halve the scope before re-prompting, then note whether it resolved in fewer turns.",
    detail: {
      whatThisMeans:
        "This is a resilience habit. Acting on it means recognizing your own frustration signal early and re-scoping instead of re-steering a drifted agent.",
      howToAct: [
        "Notice the moment a turn spikes (repeated 'stop'/'again', shouting, a burst of errors).",
        "Switch to plan mode or cut the task to a smaller, verifiable slice.",
        "Re-prompt from the reset and compare turns-to-resolution against the crash-out run.",
      ],
      whyThisRecommendation: `${followUp.why}The sharpest local frustration peak scored ${peak.score}${errorContext}, which is the pattern most associated with rework loops.`,
      autoApply:
        "Desktop can draft a plan-mode reset prompt for the session. Switching modes or cancelling work should stay user-confirmed.",
    },
    actions: [
      {
        id: "draft-reset-prompt",
        label: "Draft reset",
        mode: "draft",
        safety: "safe",
        result: `Drafts a plan-mode reset prompt scoped to ${sessionLabel}.`,
      },
    ],
  };
  // Resilience lever — impact scales with the peak intensity and the errors
  // clustered around it. `peak.score` already FOLDS IN nearbyErrorCount (see
  // computePeakFrustration), so pass the text-only frustration score
  // (score − nearbyErrorCount) as the intensity input; otherwise the nearby
  // errors would be counted twice and over-rank resilience (wongk review).
  const textFrustrationScore = peak.score - peak.nearbyErrorCount;
  return toCandidate(
    tip,
    "resilience",
    resilienceImpactScore(textFrustrationScore, peak.nearbyErrorCount),
    input
  );
}

/**
 * A field that still looks like serialized JSON (a `{...}` object or `[...]`
 * array) after we've tried to pull a real command out of it. We must never
 * classify, slugify, or interpolate such a blob into prose — that leaked the
 * raw `{"session_id":…}` JSON and the `session-id-…-command-cd-skill`
 * identifier into the UI (FEA-3687). Trailing text after a close brace still
 * counts as blobby.
 */
const JSON_BLOB_PATTERN = /^\s*[[{]/;

/**
 * Pull the real shell command out of a shell/exec event. Prefers the parsed
 * `tool_input.command` (or `command`) from `event.data` when it is serialized
 * tool JSON; otherwise falls back to a plain `summary`/`data` string. Returns
 * null when nothing usable remains OR the recovered value still looks like a
 * JSON blob — so a malformed field can never reach the slug/name/prose path.
 */
export function extractShellCommand(
  event: AgentCoachingInput["recentEvents"][number]
): string | null {
  const fromData = parseCommandFromEventData(event.data);
  const candidate = fromData ?? event.summary ?? event.data ?? null;
  if (!candidate) {
    return null;
  }
  const trimmed = candidate.trim();
  if (!trimmed || JSON_BLOB_PATTERN.test(trimmed)) {
    return null;
  }
  return trimmed;
}

/**
 * Best-effort parse of a serialized tool-event `data` string into its command.
 * Tool events serialize as `{"tool_input":{"command":"…"}}` (or a bare
 * `{"command":"…"}`); return that string. Returns null when `data` is absent,
 * not JSON, or carries no command field — the caller then falls back to a plain
 * string, and the JSON-blob guard drops anything still blobby.
 */
function parseCommandFromEventData(data: string | null): string | null {
  if (!data) {
    return null;
  }
  const trimmed = data.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const toolInput = record.tool_input;
  if (toolInput && typeof toolInput === "object") {
    const command = (toolInput as Record<string, unknown>).command;
    if (typeof command === "string" && command.trim().length > 0) {
      return command;
    }
  }
  if (typeof record.command === "string" && record.command.trim().length > 0) {
    return record.command;
  }
  return null;
}

function findReusableCommandCandidate(
  events: AgentCoachingInput["recentEvents"],
  preferredFamilies: string[] = []
): Candidate | null {
  const families = new Map<
    string,
    { count: number; totalChars: number; examples: string[] }
  >();
  for (const event of events) {
    if (!(event.toolName && SHELL_TOOL_PATTERN.test(event.toolName))) {
      continue;
    }
    // Extract the actual shell command, never a raw serialized event blob.
    // `event.data` can be the whole tool event JSON
    // (`{"session_id":…,"tool_input":{"command":"cd …"}}`); feeding that into
    // classify/slug/prose is exactly what produced the garbled
    // `session-id-…-command-cd-skill` identifier and JSON-in-a-sentence output.
    const command = extractShellCommand(event);
    if (!command) {
      // No recoverable command text (blobby/empty field) — skip rather than
      // slug or interpolate whatever raw string was there.
      continue;
    }
    const family = classifyCommand(command);
    if (LOW_VALUE_COMMAND_FAMILIES.has(family)) {
      continue;
    }
    const existing = families.get(family) ?? {
      count: 0,
      totalChars: 0,
      examples: [],
    };
    const redacted = truncateExample(redactSecrets(command));
    existing.count += 1;
    existing.totalChars += command.length;
    if (redacted && existing.examples.length < TOP_COMMAND_LIMIT) {
      existing.examples.push(redacted);
    }
    families.set(family, existing);
  }

  const candidates = [...families.entries()]
    .filter(([, stats]) => stats.count >= 3)
    .map(([family, stats]) => {
      const averageCommandChars = Math.round(stats.totalChars / stats.count);
      return {
        family,
        count: stats.count,
        estimatedTokenSavingsPercent: estimateTokenSavingsPercent(
          stats.count,
          averageCommandChars
        ),
        representativeCommands: stats.examples,
      };
    })
    .sort((a, b) => {
      const preferredDelta =
        Number(preferredFamilies.includes(b.family)) -
        Number(preferredFamilies.includes(a.family));
      return (
        preferredDelta ||
        b.estimatedTokenSavingsPercent - a.estimatedTokenSavingsPercent ||
        b.count - a.count
      );
    });

  return candidates[0] ?? null;
}

function classifyCommand(value: string): string {
  const text = value.trim();
  if (
    NIGHTLY_REVIEW_TMP_PATTERN.test(text) ||
    NIGHTLY_REVIEW_MARKER_PATTERN.test(text) ||
    NIGHTLY_WORD_PATTERN.test(text)
  ) {
    return "nightly-review-worktree-preflight";
  }
  if (
    GH_PR_REVIEW_COMMAND_PATTERN.test(text) &&
    REVIEW_CONTEXT_PATTERN.test(text)
  ) {
    return "github-pr-review-preflight";
  }
  if (
    GIT_STATE_COMMAND_PATTERN.test(text) &&
    SEARCH_COMMAND_PATTERN.test(text)
  ) {
    return "repo-state-inspection";
  }

  const cdAndCommand = text.match(CD_AND_COMMAND_PATTERN);
  if (cdAndCommand?.[1]) {
    return classifyCommand(cdAndCommand[1]);
  }

  const tokens = text.split(WHITESPACE_PATTERN);
  const offset = tokens[0] === "rtk" ? 1 : 0;
  const first = tokens[offset] ?? tokens[0];
  const second = tokens[offset + 1];
  if (first === "git" && second) {
    return `git ${second}`;
  }
  if (first === "gh" && second) {
    return `gh ${second}`;
  }
  if (first === "rg") {
    return "rg search";
  }
  if (first === "sed") {
    return "sed read";
  }
  if (first === "pnpm" && second) {
    return `pnpm ${second}`;
  }
  if (first === "node") {
    return "node script";
  }
  return first || "shell";
}

function estimateTokenSavingsPercent(
  count: number,
  averageCommandChars: number
) {
  const repeatPressure = Math.min(40, count * 3);
  const verbosityPressure = Math.min(30, Math.round(averageCommandChars / 12));
  return Math.max(20, Math.min(70, repeatPressure + verbosityPressure));
}

function truncateExample(value: string): string {
  if (value.length <= MAX_EXAMPLE_CHARS) {
    return value;
  }
  return `${value.slice(0, MAX_EXAMPLE_CHARS)}... [truncated]`;
}

// FEA-2430: LOCAL calendar day (was UTC via toISOString) so "today" for tip
// feedback suppression flips at the user's midnight, not at 00:00 UTC.
function toDayKey(date: Date): string {
  return formatDateForInput(date);
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(NON_SLUG_CHARACTER_PATTERN, "-")
      .replace(SLUG_EDGE_PATTERN, "")
      // Never let an over-long/blobby input produce a giant slugified identifier
      // like `session-id-…-command-cd-skill` (FEA-3687). A skill slug is short;
      // cap it so a malformed family can't leak a long identifier into the name.
      .split("-")
      .slice(0, SLUG_MAX_SEGMENTS)
      .join("-")
  );
}

/**
 * Derive a clean, human skill name from a command family. Falls back to a
 * generic name when slugification yields nothing usable, so the "…-skill" name
 * is never empty or a raw blob.
 */
function commandSkillName(pattern: string): string {
  const slug = slugify(pattern);
  return slug ? `${slug}-skill` : "reusable-command-skill";
}

/**
 * Count the DISTINCT harness work modes present in a set of harness-like tools.
 * A tool row is bucketed into the first work mode whose pattern it matches, and
 * only the number of distinct buckets is returned — so `bash` + `exec_command`
 * (both execution) count as ONE mode, not two, and aliases can't inflate the
 * routing signal (wongk review, FEA-3265).
 */
function countDistinctWorkModes(tools: Array<{ toolName: string }>): number {
  const modes = new Set<string>();
  for (const tool of tools) {
    const mode = WORK_MODE_PATTERNS.find((entry) =>
      entry.pattern.test(tool.toolName)
    )?.mode;
    if (mode) {
      modes.add(mode);
    }
  }
  return modes.size;
}
