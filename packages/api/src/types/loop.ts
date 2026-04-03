// Loop types for API contract
// These are explicitly defined to keep packages/api independent of database

import type { JsonObject } from "./common";
import type { EntityType } from "./entity-link";

// Loop Status
export const LoopStatus = {
  Pending: "PENDING",
  Claimed: "CLAIMED",
  Running: "RUNNING",
  Completed: "COMPLETED",
  Failed: "FAILED",
  Cancelled: "CANCELLED",
  TimedOut: "TIMED_OUT",
} as const;
export type LoopStatus = (typeof LoopStatus)[keyof typeof LoopStatus];

// Loop Command
export const LoopCommand = {
  Plan: "PLAN",
  Execute: "EXECUTE",
  Chat: "CHAT",
  Explore: "EXPLORE",
  RequestChanges: "REQUEST_CHANGES",
  Decompose: "DECOMPOSE",
  EvaluatePrd: "EVALUATE_PRD",
  GeneratePrd: "GENERATE_PRD",
  EvaluatePlan: "EVALUATE_PLAN",
  EvaluateCode: "EVALUATE_CODE",
} as const;
export type LoopCommand = (typeof LoopCommand)[keyof typeof LoopCommand];

// Lowercase command keys accepted by the /artifacts/:id/run-loop endpoint.
export const RunLoopCommand = {
  Plan: "plan",
  Execute: "execute",
  RequestChanges: "request_changes",
  Decompose: "decompose",
  EvaluatePrd: "evaluate_prd",
  GeneratePrd: "generate_prd",
  EvaluatePlan: "evaluate_plan",
  EvaluateCode: "evaluate_code",
} as const;
export type RunLoopCommand =
  (typeof RunLoopCommand)[keyof typeof RunLoopCommand];

export type SourceContextType = (typeof EntityType)[keyof Pick<
  typeof EntityType,
  "Artifact" | "Feature"
>];

// Compute target summary (for loop list/detail views)
export type ComputeTargetSummary = {
  id: string;
  machineName: string;
  isOnline: boolean;
};

// Core Loop entity
export type Loop = {
  id: string;
  organizationId: string;
  userId: string;
  status: LoopStatus;
  command: LoopCommand;
  artifactId: string | null;
  workstreamId: string | null;
  parentLoopId: string | null;
  computeTargetId: string | null;
  prompt: string | null;
  repo: { fullName: string; branch: string } | null;
  contextRefs: Array<{
    sourceId: string;
    sourceType?: SourceContextType;
    include: "full" | "summary";
  }> | null;
  containerId: string | null;
  s3StateKey: string | null;
  prUrl: string | null;
  prNumber: number | null;
  branchName: string | null;
  sessionId: string | null;
  tokensInput: number;
  tokensOutput: number;
  tokensByModel: TokensByModel | null;
  estimatedCost: number | null;
  startedAt: Date | null;
  completedAt: Date | null;
  error: { code: string; message: string } | null;
  artifactVersion: number | null;
  metadata: JsonObject;
  uploadedArtifacts: JsonObject | null;
  createdAt: Date;
  updatedAt: Date;
};

// Loop with related user info (for list views)
export type LoopWithUser = Loop & {
  user: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    avatarUrl: string | null;
    email: string;
  };
  computeTarget: ComputeTargetSummary | null;
};

// Request/Response types
export type CreateLoopRequest = {
  command: LoopCommand;
  artifactId?: string;
  workstreamId?: string;
  parentLoopId?: string;
  computeTargetId?: string;
  prompt?: string;
  repo?: {
    fullName: string;
    branch: string;
  };
  contextRefs?: Array<{
    sourceId: string;
    sourceType?: SourceContextType;
    include: "full" | "summary";
  }>;
  artifactVersion?: number;
  metadata?: JsonObject;
};

export type CreateLoopResponse = {
  loopId: string;
  status: LoopStatus;
};

export type ResumeLoopRequest = {
  prompt?: string;
  computeTargetId?: string;
};

export type LoopListFilters = {
  status?: LoopStatus;
  command?: LoopCommand;
  artifactId?: string;
  workstreamId?: string;
  projectId?: string;
  userId?: string;
  limit?: number;
  offset?: number;
};

// Event types (streamed from container -> backend -> frontend)
export type LoopEventStarted = {
  type: "started";
  loopId: string;
  timestamp: string;
};

export type LoopEventOutput = {
  type: "output";
  chunk: string;
  timestamp: string;
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
  };
};

export type LoopEventProgress = {
  type: "progress";
  percent: number;
  stage: string;
  timestamp: string;
};

export type LoopEventToolCall = {
  type: "tool_call";
  tool: string;
  status: "start" | "end";
  input?: unknown;
  output?: unknown;
  timestamp: string;
};

export type LoopEventArtifactCreated = {
  type: "artifact_created";
  artifactId: string;
  artifactType: string;
  timestamp: string;
};

export type LoopEventCompleted = {
  type: "completed";
  result: JsonObject;
  tokensUsed: {
    input: number;
    output: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
    turns?: number;
    models?: string[];
  };
  tokensByModel?: TokensByModel;
  timestamp: string;
};

export type LoopEventError = {
  type: "error";
  code: string;
  message: string;
  timestamp: string;
  logTail?: string;
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
  };
  diagnosticsVersion?: string;
};

export type LoopEventCancelled = {
  type: "cancelled";
  reason?: string;
  timestamp: string;
};

export type LoopEvent =
  | LoopEventStarted
  | LoopEventOutput
  | LoopEventProgress
  | LoopEventToolCall
  | LoopEventArtifactCreated
  | LoopEventCompleted
  | LoopEventError
  | LoopEventCancelled;

export type LoopEventType = LoopEvent["type"];

export type LoopEventsFilters = {
  type?: LoopEventType;
  limit?: number;
  offset?: number;
};

export type LoopEventsPaginatedResponse = {
  data: LoopEvent[];
  total: number;
};

// Per-model token tracking
export type ModelTokenUsage = {
  input: number;
  output: number;
  cacheCreation?: number;
  cacheRead?: number;
};

export type TokensByModel = Record<string, ModelTokenUsage>;

// Model pricing (USD per million tokens)
export const MODEL_PRICING: Record<string, { input: number; output: number }> =
  {
    "claude-opus-4": { input: 15, output: 75 },
    "claude-sonnet-4-5": { input: 3, output: 15 },
    "claude-haiku-4-5": { input: 0.8, output: 4 },
    // Fallback for unknown models
    default: { input: 15, output: 75 },
  };

// Usage/cost summary types
export type LoopUsageByCommand = {
  command: LoopCommand;
  loopCount: number;
  tokensInput: number;
  tokensOutput: number;
  estimatedCost: number;
};

export type LoopUsageByUser = {
  userId: string;
  userName: string;
  userEmail: string;
  userAvatarUrl: string | null;
  loopCount: number;
  tokensInput: number;
  tokensOutput: number;
  estimatedCost: number;
};

export type LoopUsageSummary = {
  totalLoops: number;
  totalTokensInput: number;
  totalTokensOutput: number;
  totalEstimatedCost: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  byCommand: LoopUsageByCommand[];
  byUser: LoopUsageByUser[];
};

// Structured error codes emitted by the electron/runner harness.
export const LoopErrorCode = {
  NoWorkProduced: "NO_WORK_PRODUCED",
  ContextLimitExceeded: "CONTEXT_LIMIT_EXCEEDED",
} as const;
export type LoopErrorCode = (typeof LoopErrorCode)[keyof typeof LoopErrorCode];

// Feature decomposition types (output of DECOMPOSE command)
export type DecomposeUserStory = {
  id: string;
  story: string;
  acceptanceCriteria: Array<{
    id: string;
    criterion: string;
  }>;
};

export type DecomposeFeature = {
  title: string;
  description: string;
  priority?: "HIGH" | "MEDIUM" | "LOW";
  userStories?: DecomposeUserStory[];
};

export type DecomposeResult = {
  features: DecomposeFeature[];
};
