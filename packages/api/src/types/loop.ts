// Loop types for API contract
// Shared contract types are re-exported from @closedloop-ai/loops-api.
// API-specific types (Loop entity, request/response, usage) are defined here.

/** biome-ignore-all lint/style/useImportType: imported type re-exported as values. */
/** biome-ignore-all lint/style/noExportedImports: re-exporting shared loop types for backwards compatibility. */

import { LoopCommand, LoopStatus } from "@closedloop-ai/loops-api/commands";
import type {
  AdditionalRepoRef,
  AdditionalRepoRefWithToken,
} from "@closedloop-ai/loops-api/context-pack";
import { TokensByModel } from "@closedloop-ai/loops-api/tokens";
import type { ArtifactSubtype } from "./artifact";
import { ArtifactType } from "./artifact";
import type { JsonObject } from "./common";

// --- Re-exports from @closedloop-ai/loops-api ---

// biome-ignore lint/performance/noBarrelFile: Shared contract types are re-exported from @closedloop-ai/loops-api.
export {
  LoopCommandSchema,
  LoopStatusSchema,
  RunLoopCommand,
  RunLoopCommandSchema,
} from "@closedloop-ai/loops-api/commands";
export {
  LoopErrorCode,
  LoopErrorCodeSchema,
} from "@closedloop-ai/loops-api/error-codes";
export type {
  LoopEvent,
  LoopEventArtifactCreated,
  LoopEventCancelled,
  LoopEventCompleted,
  LoopEventError,
  LoopEventOutput,
  LoopEventProgress,
  LoopEventStarted,
  LoopEventsFilters,
  LoopEventsPaginatedResponse,
  LoopEventToolCall,
  LoopEventType,
} from "@closedloop-ai/loops-api/events";
export type {
  ModelTokenUsage,
  TokenUsage,
} from "@closedloop-ai/loops-api/tokens";
export {
  MODEL_PRICING,
  ModelTokenUsageSchema,
  TokensByModelSchema,
  TokenUsageSchema,
} from "@closedloop-ai/loops-api/tokens";
export { LoopCommand, LoopStatus, type TokensByModel };

// --- API-specific types (not in shared contract) ---

export type SourceContextType = typeof ArtifactType.Document;

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
  documentId: string | null;
  workstreamId: string | null;
  parentLoopId: string | null;
  computeTargetId: string | null;
  prompt: string | null;
  repo: { fullName: string; branch: string } | null;
  additionalRepos: AdditionalRepoRef[] | null;
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
  documentVersion: number | null;
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

// Additional repository references for multi-repo loop execution
// Canonical source: @closedloop-ai/loops-api/context-pack
export type { AdditionalRepoRef, AdditionalRepoRefWithToken };

export const MAX_ADDITIONAL_REPOS = 5;

// Request/Response types
export type CreateLoopRequest = {
  command: LoopCommand;
  documentId?: string;
  workstreamId?: string;
  parentLoopId?: string;
  computeTargetId?: string;
  prompt?: string;
  repo?: {
    fullName: string;
    branch: string;
  };
  additionalRepos?: AdditionalRepoRef[];
  contextRefs?: Array<{
    sourceId: string;
    sourceType?: SourceContextType;
    include: "full" | "summary";
  }>;
  documentVersion?: number;
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
  documentId?: string;
  workstreamId?: string;
  projectId?: string;
  userId?: string;
  limit?: number;
  offset?: number;
};

// Loop summary types: aggregated loop state per document, recursive across
// PRODUCES descendants. Powers the LoopCell variants in document tables.
export type LoopSummaryEntry = {
  loopId: string;
  command: LoopCommand;
  status: LoopStatus;
  userName: string;
  isLocal: boolean;
  childSubtype: ArtifactSubtype | null;
  isDirectLoop: boolean;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
};

export type LoopSummary = {
  activeLoop: LoopSummaryEntry | null;
  latestCompleted: LoopSummaryEntry | null;
  latestFailed: LoopSummaryEntry | null;
};

export type LoopSummariesResponse = Record<string, LoopSummary>;

export type LoopSummariesRequest = {
  documentIds: string[];
};

export const LOOP_SUMMARIES_MAX_DOCUMENT_IDS = 100;
export const LOOP_SUMMARIES_MAX_DEPTH = 10;

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

export type {
  ExecutionResultV2,
  ParsedExecutionResult,
  RepoExecutionResult,
} from "@closedloop-ai/loops-api/execution-result";
export {
  BRANCH_NAME_REGEX,
  createRepoExecutionResultsSchema,
  ExecutionResultV2Schema,
  getPrimaryRepoResult,
  isSupportedExecutionResultSchemaVersion,
  normalizeV1ExecutionResult,
  RepoExecutionResultBaseSchema,
  RepoExecutionResultSchema,
  RepoExecutionResultsSchema,
  SUPPORTED_EXECUTION_RESULT_SCHEMA_VERSIONS,
} from "@closedloop-ai/loops-api/execution-result";
