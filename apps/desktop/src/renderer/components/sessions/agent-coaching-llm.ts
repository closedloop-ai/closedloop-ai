import { summarizeLookback } from "./agent-coaching-lookback";
import { redactSecrets } from "./agent-coaching-redaction";
import {
  type AgentCoachingLever,
  categoriesForWarrantedLevers,
  categoryLeverContractEntries,
} from "./agent-coaching-scoring";
import {
  AGENT_COACHING_DAILY_TIP_LIMIT,
  type AgentCoachingGroundedMetrics,
  type AgentCoachingInput,
  type AgentCoachingLlmRequest,
  type AgentCoachingTip,
  type AgentCoachingTipCategory,
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
  bestPracticeSignals: string[] = AGENTIC_DEVELOPMENT_SIGNALS,
  // FEA-3722/FEA-3837: the caller's selected date range (`undefined` → default,
  // positive number → that window, `null` → all-time). Threaded into
  // summarizeLookback so the prompt's window label matches the selector — most
  // importantly so an all-time ("All") load renders as "all time" rather than
  // falling back to the 30-day default and framing all-time token totals as a
  // 30-day window.
  requestedLookbackDays?: number | null,
  // FEA-4179: the levers the user's real usage warrants — the SAME per-lever
  // adoption gate the seed builders enforce (see warrantedLeversForInput). The
  // request advertises ONLY the categories mapping to a warranted lever and the
  // category→lever contract, so the generator is told which lever each category
  // pulls and constrained to warranted ones up front, instead of emitting a tip
  // (e.g. an `accuracy`/typed-validation tip) that the post-filter later drops
  // on a delegation-count signal the generator never saw. Absent → every
  // category is allowed (backward-compatible: an unconstrained request).
  warrantedLevers?: ReadonlySet<AgentCoachingLever>
): AgentCoachingLlmRequest {
  const signals =
    bestPracticeSignals.length > 0
      ? bestPracticeSignals
      : AGENTIC_DEVELOPMENT_SIGNALS;
  // FEA-4179: constrain the generator to categories whose lever is warranted.
  // With no warranted set supplied (older/unconstrained caller) every category
  // is allowed, matching pre-FEA-4179 behavior.
  const allowedCategories = warrantedLevers
    ? categoriesForWarrantedLevers(warrantedLevers)
    : COACHING_TIP_CATEGORIES.slice();
  const categoryLeverContract = categoryLeverContractEntries();
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
    groundedMetrics: summarizeLookback(input, requestedLookbackDays),
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
    allowedCategories,
    categoryLeverContract,
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

// Every category the prompt lists as a focus area. `satisfies` binds this to
// the union so adding a category (e.g. FEA-3399 `resilience`) without listing it
// here — or listing a stale one — fails at compile time.
const COACHING_TIP_CATEGORIES = [
  "context_management",
  "speed_of_delivery",
  "accuracy",
  "opportunity_analysis",
  "token_efficiency",
  "resilience",
  // FEA-3265: candidate-pool impact dimensions — wall-clock time and overall
  // cost. Listed as focus areas so the harness path can also produce these
  // levers, not just the heuristic seed model.
  "wall_time",
  "cost",
  // FEA-4153: capability-gap lever — a best-practice capability the user's real
  // usage shows they are not using. Listed so the harness path can also produce
  // it, matching the heuristic capability-gap builder.
  "capability_gap",
] as const satisfies readonly AgentCoachingTipCategory[];

/**
 * Render the request into a single prompt for the local Claude harness
 * (`claude -p`). The hard requirement: every tip must make a concrete,
 * quantified claim grounded in the metrics below — not generic advice.
 */
export function renderAgentCoachingPrompt(
  request: AgentCoachingLlmRequest
): string {
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
    ...formatCoachingMetricBlocks(
      request.groundedMetrics,
      request.localEvidence.recentEvents.length
    ),
    "",
    "Recent session log excerpts (analyze these thoroughly — this is the actual",
    "activity to ground tips in):",
    ...logExcerpts,
    "",
    ...renderCategoryLeverContract(request),
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
    "one. Each action is { id, label, mode, safety: safe|moderate, result, kind };",
    "do NOT use read_only actions (the Details panel covers inspection).",
    "",
    'On every confirm_then_apply action set "kind": "create-new-file" when Apply',
    "should install ONE new local primitive (a self-contained new skill/agent/",
    "command whose full content is the proposedArtifact) — this is the common",
    'case. Use "kind": "edit-existing" ONLY when the fix must change EXISTING',
    ".claude/* files (e.g. hoisting a pre-exploration step across a skill already",
    "installed), which requires an LLM-driven, reviewable diff rather than a",
    "single new file. When in doubt, prefer create-new-file.",
  ].join("\n");
}

/**
 * Render the grounded metrics into three scope-labeled blocks so the model
 * never frames an unwindowed figure as within the selected date range. Only the
 * token/cost/model-mix totals come from the windowed `getAnalytics` query; the
 * session/duration/skill totals are all-time aggregates; and the event-derived
 * signals (shell ratio, repeats, frustration, plan mode, prompts, cadence) are
 * computed over `recentEvents` — the latest ≤200 captured events (getEventFeed),
 * a recency-capped SAMPLE, not a time window. Keeping them apart stops the model
 * from making false quantified claims like "in the last 7 days you…" about data
 * that never honored the window. `sampleSize` is the count of captured events
 * the sample block draws from.
 */
function formatCoachingMetricBlocks(
  m: AgentCoachingGroundedMetrics,
  sampleSize: number
): string[] {
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
  const favoriteModel =
    m.modelMix && m.modelMix.length > 0
      ? m.modelMix
          .map((entry) => `${entry.model} ${Math.round(entry.share * 100)}%`)
          .join(", ")
      : "unknown";
  const planMode =
    m.planModeRatio == null
      ? "unknown"
      : `${Math.round(m.planModeRatio * 100)}% of sessions`;
  const topPrompts =
    m.topPrompts && m.topPrompts.prompts.length > 0
      ? `${m.topPrompts.prompts
          .map((prompt) => `"${prompt.text}" ×${prompt.count}`)
          .join(", ")} (avg ${m.topPrompts.avgPromptChars} chars)`
      : "unknown";
  const cadence = m.sessionCadence ? m.sessionCadence.label : "unknown";
  // FEA-3399: the "biggest crash out" — surfaced so the LLM path can also
  // produce a resilience tip. Already redacted upstream in summarizeLookback.
  const peakFrustration =
    m.peakFrustration == null
      ? "none detected"
      : `score ${m.peakFrustration.score}, ${m.peakFrustration.nearbyErrorCount} nearby errors, excerpt: "${m.peakFrustration.excerpt}"`;
  // FEA-3722: `lookbackDays === 0` is the all-time sentinel; render it as
  // "all time" rather than "last 0 days".
  const windowLabel =
    m.lookbackDays === 0 ? "all time" : `last ${m.lookbackDays} days`;

  return [
    `Windowed metrics (${windowLabel}) — the ONLY figures that honor the selected date range:`,
    `- tokens: ${m.totalTokens.toLocaleString()} (in ${m.totalInputTokens.toLocaleString()}, out ${m.totalOutputTokens.toLocaleString()})`,
    `- estimated cost: ${cost}`,
    `- favorite model (token share): ${favoriteModel}`,
    "",
    // FEA-3837: session/event counts, average duration, and skill invocations
    // are all-time aggregates over every row ever recorded (getAnalytics
    // totalSessions/totalEvents, getWorkflowData avgDurationSec, getAllSkills
    // invocation counts), NOT windowed to the range above. Label them lifetime
    // so the model never frames them as within-window — that produced false
    // claims like "you ran 4,000 sessions in the last N days".
    "Lifetime totals (every row ever recorded — NOT limited to the window above;",
    "never describe these as within the selected range):",
    `- sessions analyzed (all time): ${m.sessionsAnalyzed}`,
    `- avg session duration (all time): ${duration}`,
    `- total skill invocations (all time): ${m.totalSkillInvocations ?? "unknown"}`,
    // Only the analytics-backed count is a true all-time total; the fallback is
    // the recent sample (see the sample block below), so it is emitted there.
    ...(m.eventsAnalyzedIsAllTime
      ? [`- events analyzed (all time): ${m.eventsAnalyzed}`]
      : []),
    "",
    // FEA-3837 (review follow-up): these are computed over recentEvents — the
    // latest ≤200 captured events (getEventFeed), with NO date cutoff — so they
    // are a recency-capped sample, not a 7d/30d/90d window. The model must not
    // frame them as within the selected range.
    "Recent-activity sample (computed from the latest captured events — a",
    `recency-capped SAMPLE of ${sampleSize} events, NOT a time window; never`,
    'frame these as occurring "in the last N days"):',
    ...(m.eventsAnalyzedIsAllTime
      ? []
      : [
          `- events analyzed (recent sample, not all-time): ${m.eventsAnalyzed}`,
        ]),
    `- shell commands NOT routed through rtk: ${shellRatio}`,
    `- repeated command families: ${repeated}`,
    `- peak frustration ("biggest crash out"): ${peakFrustration}`,
    `- plan mode usage: ${planMode}`,
    `- most common prompts: ${topPrompts}`,
    `- session cadence: ${cadence}`,
  ];
}

/**
 * FEA-4179: render the category→lever contract and the warranted-category
 * constraint into the prompt. The generator learns which lever each category
 * pulls and is told to produce ONLY the categories the user's real usage
 * warrants — so it never emits a tip (e.g. an `accuracy`/typed-validation one)
 * whose lever the post-generation adoption gate would drop on a usage signal
 * the generator never reasoned about. This makes the gate a stated contract,
 * not a silent filter.
 */
function renderCategoryLeverContract(
  request: AgentCoachingLlmRequest
): string[] {
  const mapping = request.categoryLeverContract
    .map(([category, lever]) => `${category} → ${lever}`)
    .join(", ");
  // No warranted category means no lever is warranted; the caller
  // short-circuits before generating, so this branch renders defensively only.
  if (request.allowedCategories.length === 0) {
    return [
      "The user's current usage warrants NO coaching lever — do not emit any",
      "tips (return an empty JSON array).",
      `For reference, each category pulls this lever: ${mapping}.`,
    ];
  }
  return [
    'Each category pulls exactly one underlying "lever", and a tip only helps',
    "when the user's real usage warrants that lever. The category→lever",
    `contract is: ${mapping}.`,
    "Produce tips ONLY in these categories — the ones the user's usage warrants",
    `(use as the tip "category"): ${request.allowedCategories.join(", ")}.`,
    "Do NOT emit a tip in any other category; a tip whose lever is not",
    "warranted will be discarded, so spend your effort on the warranted ones.",
  ];
}
