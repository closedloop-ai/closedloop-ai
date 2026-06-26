import type {
  AnalyticsData,
  EventWithSession,
  WorkflowQueryData,
} from "../../../shared/agent-db-contract";
import type { DesktopApi } from "../../types/desktop-api";

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

export type AgentCoachingAction = {
  id: string;
  label: string;
  mode: AgentCoachingActionMode;
  safety: "safe" | "moderate";
  result: string;
};

export type AgentCoachingTipCategory =
  | "context_management"
  | "speed_of_delivery"
  | "accuracy"
  | "opportunity_analysis"
  | "token_efficiency";

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
  feedback: AgentCoachingFeedbackEvent[];
};

export type AgentCoachingApi = {
  loadTips: () => Promise<AgentCoachingTip[]>;
  recordFeedback: (event: AgentCoachingFeedbackEvent) => Promise<void>;
  /**
   * Install a user-reviewed drafted artifact via the local harness. Returns the
   * harness's confirmation output. Absent when no harness install seam is wired.
   */
  installArtifact?: (draft: string, harness?: string) => Promise<string>;
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
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number | null;
  avgSessionDurationSec: number | null;
  /** Share (0–1) of shell commands NOT already routed through `rtk`. */
  unwrappedShellCommandRatio: number | null;
  /** Repeated command families that are reuse/skill candidates. */
  repeatedCommandFamilies: Array<{
    family: string;
    count: number;
    avgCommandChars: number;
  }>;
  totalSkillInvocations: number;
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
};
