import { summarizeLookback } from "./agent-coaching-lookback";
import { redactSecrets } from "./agent-coaching-redaction";
import {
  AGENT_COACHING_DAILY_TIP_LIMIT,
  type AgentCoachingInput,
  type AgentCoachingLlmRequest,
  type AgentCoachingTip,
} from "./agent-coaching-types";

/**
 * Built-in best-practice signals — the DEFAULT coaching knowledge. An
 * installed, active coaching pack (see agent-coaching-packs.ts) supplies its
 * own `signals` which REPLACE these for the prompt; with no pack active, these
 * apply. Exported so the default is one canonical source.
 */
export const AGENTIC_DEVELOPMENT_SIGNALS = [
  "Claude Code: use explicit config, fallback-model, compaction, and checkpoint habits to keep long sessions recoverable.",
  "Claude Code: use closest-directory skills and workflows when repeated local patterns emerge, and keep nested subagents bounded.",
  "Claude Code: prefer batched or cached tool loading and avoid prompt-cache churn from needless setting or context changes.",
  "Codex: remote execution now preserves executor-native cwd, shell, and filesystem permissions, so coaching should distinguish local and remote command assumptions.",
  "Codex: plugin MCP discovery and per-thread activation make provider/tool routing part of setup, not an afterthought.",
  "Codex: child-thread and imported-agent correlation make decomposition quality measurable across spawned work.",
  "Codex: large tool-heavy sessions benefit from cached tool search, fewer repeated request copies, and tighter context transfer.",
  "OpenCode: session timelines, MCP progress, MCP error details, provider schema compatibility, and workspace roots are active improvement areas.",
  "OpenCode: stale MCP clients, duplicated file injection, and wrong workspace scoping are examples of issues avoided by compact contracts and explicit roots.",
];

export function buildAgentCoachingLlmRequest(
  input: AgentCoachingInput,
  seedTips: AgentCoachingTip[],
  // The active coaching pack's signals override the built-in defaults; callers
  // pass an empty array when a pack is "active" but carries no signals — guard
  // against that by falling back to the defaults so the prompt is never empty.
  bestPracticeSignals: string[] = AGENTIC_DEVELOPMENT_SIGNALS
): AgentCoachingLlmRequest {
  const signals =
    bestPracticeSignals.length > 0
      ? bestPracticeSignals
      : AGENTIC_DEVELOPMENT_SIGNALS;
  // Permanently-dismissed tips are never regenerated (matches the local model's
  // dismissed-forever rule).
  const excludeTipIds = [
    ...new Set(
      input.feedback
        .filter((event) => event.action === "dismissed")
        .map((event) => event.tipId)
    ),
  ];
  return {
    maxTips: AGENT_COACHING_DAILY_TIP_LIMIT,
    generationMode: "non_deterministic_high_reasoning",
    reasoningEffort: "high",
    temperature: 0.8,
    bestPracticeSignals: signals,
    groundedMetrics: summarizeLookback(input),
    localEvidence: {
      analytics: input.analytics,
      workflow: input.workflow,
      // Free-text event fields can carry secrets (sk_live…, Bearer …). Scrub
      // them here so a non-local LLM provider never receives raw credentials —
      // matching the redaction already applied to representative commands.
      recentEvents: input.recentEvents.map((event) => ({
        ...event,
        summary: event.summary ? redactSecrets(event.summary) : event.summary,
        data: event.data ? redactSecrets(event.data) : event.data,
      })),
      skills: input.skills,
    },
    priorFeedback: input.feedback,
    excludeTipIds,
    seedTips,
  };
}

const MAX_LOG_EXCERPTS = 40;
const MAX_EXCERPT_CHARS = 240;

/** Render recent events as readable log lines for the harness to analyze. */
function formatSessionLogExcerpts(
  recentEvents: AgentCoachingLlmRequest["localEvidence"]["recentEvents"]
): string[] {
  if (recentEvents.length === 0) {
    return ["- (no recent session activity captured yet)"];
  }
  return recentEvents.slice(-MAX_LOG_EXCERPTS).map((event) => {
    const text = (event.summary ?? event.data ?? "")
      .slice(0, MAX_EXCERPT_CHARS)
      .replaceAll("\n", " ");
    const label = event.sessionName ?? "session";
    return `- [${label}] ${event.toolName ?? "event"}: ${text}`;
  });
}

const COACHING_TIP_CATEGORIES = [
  "context_management",
  "speed_of_delivery",
  "accuracy",
  "opportunity_analysis",
  "token_efficiency",
] as const;

/**
 * Render the request into a single prompt for the local Claude harness
 * (`claude -p`). The hard requirement: every tip must make a concrete,
 * quantified claim grounded in the metrics below — not generic advice.
 */
export function renderAgentCoachingPrompt(
  request: AgentCoachingLlmRequest
): string {
  const m = request.groundedMetrics;
  const cost =
    m.estimatedCostUsd == null
      ? "unknown"
      : `$${m.estimatedCostUsd.toFixed(2)}`;
  const shellRatio =
    m.unwrappedShellCommandRatio == null
      ? "unknown"
      : `${Math.round(m.unwrappedShellCommandRatio * 100)}%`;
  const duration =
    m.avgSessionDurationSec == null
      ? "unknown"
      : `${Math.round(m.avgSessionDurationSec)}s`;
  const repeated =
    m.repeatedCommandFamilies.length > 0
      ? m.repeatedCommandFamilies
          .map(
            (family) =>
              `${family.family} ×${family.count} (~${family.avgCommandChars} chars each)`
          )
          .join(", ")
      : "none";

  const logExcerpts = formatSessionLogExcerpts(
    request.localEvidence.recentEvents
  );

  return [
    "You are an agentic-development coach embedded in a local desktop app.",
    `Produce up to ${request.maxTips} short, high-signal coaching tips as JSON.`,
    "",
    "Do a THOROUGH analysis of the actual session activity below — read the log",
    "excerpts closely and reason about what really happened. The headline metrics",
    "are only for DIRECTION; the substance of each tip must come from the logs.",
    "HARD REQUIREMENT: every tip must make a concrete, QUANTIFIED claim grounded",
    'in the evidence — e.g. "enabling RTK would save ~X% of token spend over the',
    'last N days" or "promoting this repeated task into a skill saves ~Y minutes',
    'per build". Never give generic advice with no number.',
    "",
    `Lookback metrics (last ${m.lookbackDays} days) — for direction:`,
    `- sessions analyzed: ${m.sessionsAnalyzed}`,
    `- events analyzed: ${m.eventsAnalyzed}`,
    `- tokens: ${m.totalTokens.toLocaleString()} (in ${m.totalInputTokens.toLocaleString()}, out ${m.totalOutputTokens.toLocaleString()})`,
    `- estimated cost: ${cost}`,
    `- avg session duration: ${duration}`,
    `- shell commands NOT routed through rtk: ${shellRatio}`,
    `- repeated command families: ${repeated}`,
    `- total skill invocations: ${m.totalSkillInvocations}`,
    "",
    "Recent session log excerpts (analyze these thoroughly — this is the actual",
    "activity to ground tips in):",
    ...logExcerpts,
    "",
    `Focus areas (use as the tip "category"): ${COACHING_TIP_CATEGORIES.join(", ")}.`,
    "Best-practice signals to draw on:",
    ...request.bestPracticeSignals.map((signal) => `- ${signal}`),
    "",
    request.excludeTipIds.length > 0
      ? `Do NOT regenerate these permanently-dismissed tip ids: ${request.excludeTipIds.join(", ")}.`
      : "No tips have been dismissed yet.",
    "",
    "Output ONLY a JSON array of tips. Each tip object must have: id (kebab-case,",
    "stable per recommendation), title, category (one of the focus areas), body",
    "(must contain the quantified claim), whyItMatters, evidence (string[]),",
    "experiment, detail { whatThisMeans, howToAct (string[]), whyThisRecommendation,",
    "autoApply }, and actions (array).",
    "",
    "ONLY when the fix is a concrete, installable artifact (a skill, agent, or",
    'workflow) include "proposedArtifact": the COMPLETE, durable file content for',
    "it — the actual definition, ready to save and use, NOT a description or plan",
    '— and give it two actions: { mode: "draft" } (previews the artifact) and',
    '{ mode: "confirm_then_apply" } (installs it).',
    "",
    "If the tip is behavioral/heuristic with no installable artifact (e.g. a",
    "habit or sequencing change), omit proposedArtifact and use an empty actions",
    "array — the advice stands on its own. Never invent an artifact just to have",
    "one. Each action is { id, label, mode, safety: safe|moderate, result }; do",
    "NOT use read_only actions (the Details panel covers inspection).",
  ].join("\n");
}
