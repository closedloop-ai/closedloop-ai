import { formatDateForInput } from "@repo/app/shared/lib/date-utils";
import { redactSecrets } from "./agent-coaching-redaction";
import {
  AGENT_COACHING_DAILY_TIP_LIMIT,
  type AgentCoachingFeedbackEvent,
  type AgentCoachingInput,
  type AgentCoachingTip,
  type AgentCoachingTipCategory,
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

type Candidate = {
  family: string;
  count: number;
  estimatedTokenSavingsPercent: number;
  representativeCommands: string[];
};

type FeedbackInsights = Record<
  AgentCoachingTipCategory,
  { dismissed: number; opened: number; acted: number }
>;

export function buildAgentCoachingTips(
  input: AgentCoachingInput
): AgentCoachingTip[] {
  const analytics = input.analytics;
  const workflow = input.workflow;
  // Bail before running any tip builders when there is no local evidence at all
  // — otherwise we build five tips, filter them, and throw the result away.
  if (
    (analytics?.totalSessions ?? 0) === 0 &&
    (workflow?.stats.totalSessions ?? 0) === 0 &&
    input.recentEvents.length === 0
  ) {
    return [];
  }

  const today = toDayKey(input.generatedAt);
  const feedbackInsights = summarizeFeedback(input.feedback, today);
  const commandCandidate = findReusableCommandCandidate(input.recentEvents);
  const tips: AgentCoachingTip[] = [
    buildContextTip(input, feedbackInsights),
    buildWorkflowTip(input, feedbackInsights),
    buildAccuracyTip(input, feedbackInsights),
    buildHarnessTip(input, feedbackInsights),
    buildTokenEfficiencyTip(input, commandCandidate, feedbackInsights),
  ].filter((tip): tip is AgentCoachingTip => Boolean(tip));

  const excludedTipIds = excludedCoachingTipIds(
    input.feedback,
    input.generatedAt
  );

  return tips
    .filter((tip) => !excludedTipIds.has(tip.id))
    .map((tip) => ({
      tip,
      score: scoreTip(tip, input.feedback, today),
    }))
    .sort((a, b) => b.score - a.score || a.tip.title.localeCompare(b.tip.title))
    .slice(0, AGENT_COACHING_DAILY_TIP_LIMIT)
    .map(({ tip }) => tip);
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

function buildContextTip(
  input: AgentCoachingInput,
  feedbackInsights: FeedbackInsights
): AgentCoachingTip | null {
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
  if (totalSessions === 0 || (averageEvents < 50 && averageTokens < 15_000)) {
    return null;
  }

  const followUp = feedbackFollowUp("context_management", feedbackInsights);

  return {
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
}

function buildWorkflowTip(
  input: AgentCoachingInput,
  feedbackInsights: FeedbackInsights
): AgentCoachingTip | null {
  const candidate = findReusableCommandCandidate(input.recentEvents, [
    "nightly-review-worktree-preflight",
    "github-pr-review-preflight",
  ]);
  const skillCount = input.skills.reduce(
    (sum, skill) => sum + skill.invocationCount,
    0
  );
  if (!candidate && skillCount === 0) {
    return null;
  }

  const pattern = candidate?.family ?? "repeated review workflow";
  const followUp = feedbackFollowUp("speed_of_delivery", feedbackInsights);
  return {
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
}

function buildAccuracyTip(
  input: AgentCoachingInput,
  feedbackInsights: FeedbackInsights
): AgentCoachingTip | null {
  const subagents = input.workflow?.orchestration.subagentTypes ?? [];
  const generalCount = subagents
    .filter((item) => GENERAL_SUBAGENT_PATTERN.test(item.subagentType))
    .reduce((sum, item) => sum + item.count, 0);
  const testCount = subagents
    .filter((item) => TEST_SUBAGENT_PATTERN.test(item.subagentType))
    .reduce((sum, item) => sum + item.count, 0);
  if (generalCount < 3 && testCount < 3) {
    return null;
  }
  const followUp = feedbackFollowUp("accuracy", feedbackInsights);

  return {
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
}

function buildHarnessTip(
  input: AgentCoachingInput,
  feedbackInsights: FeedbackInsights
): AgentCoachingTip | null {
  const toolCounts = input.analytics?.toolUsage ?? [];
  const harnessLikeSignals = toolCounts.filter((tool) =>
    HARNESS_SIGNAL_PATTERN.test(tool.toolName)
  );
  if (harnessLikeSignals.length < 2) {
    return null;
  }
  const followUp = feedbackFollowUp("opportunity_analysis", feedbackInsights);

  return {
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
}

function buildTokenEfficiencyTip(
  input: AgentCoachingInput,
  candidate: Candidate | null,
  feedbackInsights: FeedbackInsights
): AgentCoachingTip | null {
  const toolCounts = input.analytics?.toolUsage ?? [];
  const topShellTool = toolCounts.find((tool) =>
    SHELL_TOOL_PATTERN.test(tool.toolName)
  );
  if (!(candidate || topShellTool)) {
    return null;
  }

  const pattern = candidate?.family ?? topShellTool?.toolName ?? "shell probes";
  const observedCalls = candidate?.count ?? topShellTool?.count ?? 0;
  const savings = candidate?.estimatedTokenSavingsPercent ?? 35;
  const skillName = `${slugify(pattern)}-skill`;
  const followUp = feedbackFollowUp("token_efficiency", feedbackInsights);

  return {
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
        result: "Writes the approved skill after confirmation.",
      },
    ],
  };
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
    const command = event.summary ?? event.data ?? event.toolName;
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

function scoreTip(
  tip: AgentCoachingTip,
  feedback: AgentCoachingFeedbackEvent[],
  today: string
): number {
  let score = 0;
  for (const event of feedback) {
    if (toDayKey(new Date(event.createdAt)) === today) {
      continue;
    }
    if (event.category !== tip.category) {
      continue;
    }
    if (event.action === "details_opened") {
      score += 3;
    } else if (event.action === "action_clicked") {
      score += 4;
    } else if (event.action === "dismissed") {
      score -= 2;
    }
  }
  return score;
}

function summarizeFeedback(
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

function emptyFeedbackInsights(): FeedbackInsights {
  return {
    accuracy: { acted: 0, dismissed: 0, opened: 0 },
    context_management: { acted: 0, dismissed: 0, opened: 0 },
    opportunity_analysis: { acted: 0, dismissed: 0, opened: 0 },
    speed_of_delivery: { acted: 0, dismissed: 0, opened: 0 },
    token_efficiency: { acted: 0, dismissed: 0, opened: 0 },
  };
}

function feedbackFollowUp(
  category: AgentCoachingTipCategory,
  feedbackInsights: FeedbackInsights
): { prefix: string; why: string } {
  const insight = feedbackInsights[category];
  if (insight.acted > 0) {
    return {
      prefix: "Follow-up from yesterday's action: ",
      why: "Because you acted on this coaching area before, today's recommendation advances it to the next concrete step. ",
    };
  }
  if (insight.opened > 0) {
    return {
      prefix:
        "You opened details on this coaching area before, so here's the next step: ",
      why: "Prior detail engagement is treated as interest, so this tip is generated as a more specific follow-up rather than a repeat. ",
    };
  }
  if (insight.dismissed > 0) {
    return {
      prefix: "Reframed after prior dismissal: ",
      why: "A previous dismissal lowers confidence in the generic version, so this recommendation is narrower and evidence-first. ",
    };
  }
  return { prefix: "", why: "" };
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
  return value
    .toLowerCase()
    .replace(NON_SLUG_CHARACTER_PATTERN, "-")
    .replace(SLUG_EDGE_PATTERN, "");
}
