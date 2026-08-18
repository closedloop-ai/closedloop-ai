import type {
  AnalyticsData,
  EventWithSession,
  WorkflowQueryData,
} from "../../../shared/agent-db-contract";
import type { CoachingPackInfo } from "../../../shared/coaching-pack-contract";
import type { DesktopApi } from "../../types/desktop-api";

export type { CoachingPackInfo } from "../../../shared/coaching-pack-contract";

/**
 * Max coaching tips surfaced (and requested from the LLM seam) per day. Shared
 * so the local model cap, the LLM `maxTips` request, and the API truncation
 * cannot drift apart.
 */
export const AGENT_COACHING_DAILY_TIP_LIMIT = 5;

export type AgentCoachingActionMode =
  | "read_only"
  | "draft"
  | "confirm_then_apply";

/**
 * How an "Apply" resolves the recommendation (FEA-3687 #4). Recommendations are
 * varied: a simple one writes ONE new `.claude` primitive; a complex one edits
 * across existing `.claude/*` files. `kind` is what the Apply dispatch keys on.
 *
 * - `create-new-file`: deterministically create + install a single new local
 *   primitive (a skill `.md` under `~/.claude/skills/<slug>/`, with correct
 *   frontmatter and wiring). No LLM edit — the artifact content is already the
 *   drafted `proposedArtifact`.
 * - `edit-existing`: an LLM-driven change that edits the relevant existing
 *   `.claude/*` files, surfaced as a reviewable diff before it's written (e.g.
 *   hoisting a pre-exploration step across an existing skill). Runs through the
 *   harness because it requires reasoning over the current files.
 *
 * Optional so existing heuristic seed tips and older generated tips (which
 * predate this field) keep working — an absent `kind` on a
 * `confirm_then_apply` action defaults to `create-new-file` (the historical
 * single-new-file behavior).
 */
export type AgentCoachingApplyKind = "create-new-file" | "edit-existing";

export type AgentCoachingAction = {
  id: string;
  label: string;
  mode: AgentCoachingActionMode;
  safety: "safe" | "moderate";
  result: string;
  /**
   * For `confirm_then_apply` actions: which Apply path resolves it. Absent
   * defaults to `create-new-file` (see `AgentCoachingApplyKind`). Ignored for
   * `read_only`/`draft` actions, which never install.
   */
  kind?: AgentCoachingApplyKind;
};

/**
 * The effective Apply kind for an action — defaulting an absent `kind` to
 * `create-new-file` so older tips (and heuristic seeds) resolve as a single
 * new-file install, matching pre-FEA-3687 behavior.
 */
export function resolveApplyKind(
  action: AgentCoachingAction
): AgentCoachingApplyKind {
  return action.kind ?? "create-new-file";
}

export type AgentCoachingTipCategory =
  | "context_management"
  | "speed_of_delivery"
  | "accuracy"
  | "opportunity_analysis"
  | "token_efficiency"
  // FEA-3399: resilience coaching — turns the "biggest crash out" (peak
  // frustration) signal into a constructive, evidence-first tip.
  | "resilience"
  // FEA-3265: new impact dimensions for the candidate-pool model. `wall_time`
  // ranks chronological/wall-clock levers (slow sessions, night-owl fatigue);
  // `cost` ranks overall-spend levers (model mix, absolute $). Category is no
  // longer a fixed slot — every candidate competes on impact, so these are just
  // more axes, not more guaranteed tips.
  | "wall_time"
  | "cost"
  // FEA-4153: capability-gap coaching — a best-practice capability the user's
  // real usage proves they are NOT using yet (plan mode, rtk routing, skills).
  // Its own display category so a gap tip never visually duplicates the lever it
  // borrows evidence from (e.g. a plan-mode gap and a context-hygiene tip can
  // both surface without reading as two context tips), and so the diversity
  // guarantee — enforced on lever — maps 1:1 to a distinct display category.
  | "capability_gap";

export type AgentCoachingTip = {
  id: string;
  title: string;
  category: AgentCoachingTipCategory;
  body: string;
  whyItMatters: string;
  evidence: string[];
  experiment: string;
  /**
   * The actual, durable artifact that resolves the tip — the complete,
   * ready-to-install file content (e.g. the real workflow or skill definition),
   * NOT a description of one. "Draft" reveals this verbatim and "Apply" installs
   * it. Optional: heuristic seed tips don't carry one (they fall back to a
   * synthesized draft).
   */
  proposedArtifact?: string;
  detail: {
    whatThisMeans: string;
    howToAct: string[];
    whyThisRecommendation: string;
    candidateFromThisDryRun?: {
      pattern: string;
      observedCalls: number;
      estimatedTokenSavingsPercent: number;
      moveThis: string;
      suggestedWrapper: string;
      outputContract: string[];
      representativeCommands: string[];
    };
    autoApply: string;
  };
  actions: AgentCoachingAction[];
};

export type AgentCoachingFeedbackEvent = {
  tipId: string;
  category: AgentCoachingTipCategory;
  action: "dismissed" | "details_opened" | "action_clicked";
  actionId?: string;
  createdAt: string;
};

export type AgentCoachingInput = {
  generatedAt: Date;
  analytics: AnalyticsData | null;
  workflow: WorkflowQueryData | null;
  recentEvents: EventWithSession[];
  skills: Array<{ invocationCount: number }>;
  /**
   * True when the local skills read FAILED (so `skills` is an empty fallback,
   * not a real "no skills" result). Absent/false means `skills` is authoritative.
   * Consumers must not read an empty `skills` as "the user has no skills" when
   * this is set — a failed read is unavailable, never zero.
   */
  skillsUnavailable?: boolean;
  feedback: AgentCoachingFeedbackEvent[];
};

/**
 * One load pass: the day's tips plus the coaching pack that powered them. The
 * pack is returned alongside the tips (rather than fetched separately) so the
 * "Powered by …" badge and the signals that actually generated the tips come
 * from the same resolution — no second IPC round-trip, no divergence window.
 * `activePack` is null when the built-in signals are in effect.
 */
export type AgentCoachingLoadResult = {
  tips: AgentCoachingTip[];
  activePack: CoachingPackInfo | null;
  /**
   * The same lookback-windowed metrics handed to the tip generator, surfaced to
   * the renderer so the "Coding Wrapped" deck (FEA-3403) can render playful
   * fun-fact cards from the already-computed signals — no extra LLM cost, no
   * second IPC round-trip. `null` when the lookback could not be computed (e.g.
   * the DB reads failed), so the Wrapped deck simply renders nothing.
   */
  groundedMetrics: AgentCoachingGroundedMetrics | null;
};

export type AgentCoachingApi = {
  /**
   * FEA-3722: `lookbackDays` windows the analytics/Coding-Wrap metrics to the
   * caller's selected date range — omitted keeps the default window, a positive
   * number sets that rolling window, `null` means all-time.
   */
  loadTips: (lookbackDays?: number | null) => Promise<AgentCoachingLoadResult>;
  recordFeedback: (event: AgentCoachingFeedbackEvent) => Promise<void>;
  /**
   * Install a user-reviewed drafted artifact. `kind` (FEA-3687 #4) dispatches:
   * `create-new-file` writes a single new skill deterministically;
   * `edit-existing` runs the LLM-driven edit across existing `.claude/*` files
   * via `harness`. Returns the install confirmation output (e.g. the created
   * path). Absent when no install seam is wired.
   */
  installArtifact?: (
    draft: string,
    harness?: string,
    kind?: AgentCoachingApplyKind
  ) => Promise<string>;
  /**
   * The active coaching pack powering tips (for the "Powered by …" badge), or
   * null when the built-in signals are in effect. Optional so existing api
   * fakes (and any pre-pack caller) keep working — absent means "no badge".
   * `loadTips` returns the same value, so the component reads it from there;
   * this remains for callers that want the pack without generating tips.
   */
  loadActivePack?: () => Promise<CoachingPackInfo | null>;
  /**
   * Subscribe to local activity-data changes (SQLite writes from the startup
   * backfill and live sync); returns an unsubscribe fn. The renderer uses this
   * to defer coaching until the local sessions/events/tokens corpus is
   * populated: the panel mounts before backfill finishes, so the first load
   * sees nothing. Rather than reveal an empty panel forever, it re-loads once
   * data lands and only then kicks off generation. Optional so api fakes and
   * older preload bridges without a DB-change push degrade to "load once on
   * mount" (no wait).
   */
  subscribeToActivity?: (onChange: () => void) => () => void;
};

/**
 * Quantified, data-grounded facts derived from a rolling lookback of local
 * sessions. These are handed to the generator so tips can make concrete claims
 * ("enabling RTK would save ~X% of token spend over the last N days",
 * "promoting this repeated task to a skill saves ~Y minutes per build") instead
 * of vague advice.
 */
export type AgentCoachingGroundedMetrics = {
  lookbackDays: number;
  sessionsAnalyzed: number;
  eventsAnalyzed: number;
  /**
   * FEA-3837: whether `eventsAnalyzed` is the true all-time event count
   * (`getAnalytics.totalEvents`) or the recency-capped fallback. When analytics
   * is unavailable, `eventsAnalyzed` falls back to `recentEvents.length` — the
   * latest ≤200 captured events (`getEventFeed`), a SAMPLE, not an all-time
   * total — so the prompt must not label that value as "all time".
   */
  eventsAnalyzedIsAllTime: boolean;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number | null;
  avgSessionDurationSec: number | null;
  /** Share (0–1) of shell commands NOT already routed through `rtk`. */
  unwrappedShellCommandRatio: number | null;
  /**
   * Count of shell commands the `unwrappedShellCommandRatio` was measured over
   * (the sampled denominator). This is the sampled shell-command count, NOT the
   * lifetime `eventsAnalyzed` total, so a confidence gate on the ratio uses the
   * same base the ratio came from. 0 when no shell command was sampled.
   */
  shellCommandsSampled: number;
  /** Repeated command families that are reuse/skill candidates. */
  repeatedCommandFamilies: Array<{
    family: string;
    count: number;
    avgCommandChars: number;
  }>;
  /**
   * Total local skill invocations. `null` when the skills read was UNAVAILABLE
   * (failed), so a failed read reads as "unknown", never as a false 0 — a
   * consumer must not treat null as "no skills".
   */
  totalSkillInvocations: number | null;
  /**
   * FEA-3399: the "biggest crash out" — the single user turn in the lookback
   * with the highest heuristic frustration score (caps/repetition/"stop"/
   * "again" plus nearby error-event spikes), or null when no confident peak
   * exists. The excerpt is redacted (see agent-coaching-redaction.ts) so no raw
   * prompt text leaves the device. Consumed by the resilience coaching tip.
   */
  peakFrustration: PeakFrustrationSignal | null;
  /**
   * FEA-3397 "fun-fact" lookback signals (Paxel-parity). Each is derived only
   * from data already in `AgentCoachingInput` and is `null`/empty when the
   * underlying signal is absent — mirroring the `unwrappedShellCommandRatio`
   * null-when-absent convention, so no consumer ever reads a fabricated value.
   */

  /**
   * Share (0–1) of total tokens attributed to each model over the window,
   * sorted highest-share first (favorite model). `null` when there is no
   * per-model token attribution to reason about.
   */
  modelMix: Array<{
    model: string;
    /** Combined input+output tokens attributed to this model. */
    tokens: number;
    /** Fraction (0–1) of windowed tokens this model accounts for. */
    share: number;
    /** Distinct sessions that used this model. */
    sessions: number;
  }> | null;
  /**
   * Fraction (0–1) of analyzed sessions that used plan mode. `null` — never a
   * false `false` — when no plan-mode marker appears in the evidence at all, so
   * a harness that simply does not surface plan markers is reported as
   * "undetectable" rather than "never used plan mode".
   */
  planModeRatio: number | null;
  /**
   * Most-frequent normalized user prompts plus the average prompt length.
   * `null` when no user-turn text is captured. Prompt text is redacted before
   * it is stored here so nothing raw leaves local generation.
   */
  topPrompts: {
    prompts: Array<{ text: string; count: number }>;
    avgPromptChars: number;
  } | null;
  /**
   * Hour-of-day / day-of-week activity histogram over event timestamps plus a
   * derived label (e.g. "night owl: 42% after midnight"). `null` when no
   * timestamped events are available to bucket.
   */
  sessionCadence: {
    /** 24-slot array indexed by local hour (0–23); counts of events. */
    byHour: number[];
    /** 7-slot array indexed by local weekday (0=Sun … 6=Sat); event counts. */
    byWeekday: number[];
    /** Fraction (0–1) of events between midnight and 6am local time. */
    nightOwlRatio: number;
    /** Human-readable cadence label derived from the histograms. */
    label: string;
  } | null;
};

/**
 * FEA-3399: a per-window peak-frustration moment. `score` is the unitless
 * heuristic intensity; `nearbyErrorCount` is the count of error/fail events in
 * a short window around the turn; `excerpt` is a short, redacted snippet of the
 * user turn (never raw prompt text off-device).
 */
export type PeakFrustrationSignal = {
  score: number;
  nearbyErrorCount: number;
  excerpt: string;
  sessionName: string | null;
};

export type AgentCoachingLlmRequest = {
  maxTips: number;
  generationMode: "non_deterministic_high_reasoning";
  reasoningEffort: "high";
  temperature: number;
  bestPracticeSignals: string[];
  groundedMetrics: AgentCoachingGroundedMetrics;
  localEvidence: {
    analytics: AgentCoachingInput["analytics"];
    workflow: AgentCoachingInput["workflow"];
    recentEvents: AgentCoachingInput["recentEvents"];
    skills: AgentCoachingInput["skills"];
  };
  priorFeedback: AgentCoachingFeedbackEvent[];
  /** Tip ids the user has permanently dismissed — never regenerate these. */
  excludeTipIds: string[];
  seedTips: AgentCoachingTip[];
  /**
   * FEA-4179: the ONLY categories the generator may use — those whose lever the
   * user's real usage warrants (the same per-lever adoption gate the seed
   * builders enforce). The prompt states this constraint plus the
   * `categoryLeverContract` below so the generator produces only warranted-lever
   * tips up front, rather than emitting tips that are silently dropped
   * afterwards by a usage signal it never reasoned about. Empty means no lever
   * is warranted (the caller short-circuits before generating in that case).
   */
  allowedCategories: AgentCoachingTipCategory[];
  /**
   * FEA-4179: the canonical category→lever pairs, so the prompt can tell the
   * generator which lever each category pulls (and thus which usage signal gates
   * it). Derived from the runtime `CATEGORY_LEVER` map so prompt and gate can't
   * drift.
   */
  categoryLeverContract: [AgentCoachingTipCategory, string][];
};

export type AgentCoachingLlmProvider = (
  request: AgentCoachingLlmRequest
) => Promise<AgentCoachingTip[]>;

export type AgentCoachingDesktopApi = Pick<
  DesktopApi,
  "agentSessionsApi" | "generateCoachingTips" | "installCoachingArtifact"
> & {
  db: Pick<
    DesktopApi["db"],
    "getAnalytics" | "getWorkflowData" | "getEventFeed" | "getAllSkills"
  >;
  /**
   * The active coaching pack, or null for built-in signals. Optional so older
   * preload bridges (and test fakes) that predate coaching packs simply fall
   * back to the built-in defaults.
   */
  getCoachingPack?: () => Promise<CoachingPackInfo | null>;
  /**
   * Live local-DB change push; drives "wait for the corpus to populate before
   * kicking off coaching" on the startup backfill race. Optional (declared
   * here rather than via `Pick`) so preload bridges / test fakes without it
   * degrade to generate-on-mount. Returns an unsubscribe fn.
   */
  onDbChanged?: DesktopApi["onDbChanged"];
};
