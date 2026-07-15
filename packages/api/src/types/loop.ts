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
import {
  ExecutionResultV2Schema as ExecutionResultV2SchemaValue,
  parseExecutionResultFile as parseExecutionResultFileFromLoopsApi,
  RepoExecutionResultSchema as RepoExecutionResultSchemaValue,
} from "@closedloop-ai/loops-api/execution-result";
import type { TokensByModel } from "@closedloop-ai/loops-api/tokens";
import type { z } from "zod";
import type { ArtifactSubtype } from "./artifact";
import { ArtifactType } from "./artifact";
import type { JsonObject } from "./common";
import type { HarnessType } from "./compute-target";
import type { BranchInfo, PullRequestInfo } from "./document";
import type { TagSummary } from "./tag";
import type { BasicUser } from "./user";

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
  RunnerErrorSubcode,
  RunnerErrorSubcodeSchema,
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
  LoopEventSupportBundleUploaded,
  LoopEventsFilters,
  LoopEventsPaginatedResponse,
  LoopEventTokensCleared,
  LoopEventToolCall,
  StoredLoopEvent,
} from "@closedloop-ai/loops-api/events";
export { LoopEventType } from "@closedloop-ai/loops-api/events";
export type {
  ModelPricing,
  ModelTokenUsage,
  TokenUsage,
} from "@closedloop-ai/loops-api/tokens";
export {
  DEFAULT_PRICING,
  MODEL_PRICING,
  ModelTokenUsageSchema,
  TokensByModelSchema,
  TokenUsageSchema,
} from "@closedloop-ai/loops-api/tokens";
export { LoopCommand, LoopStatus, type TokensByModel };

// --- API-specific types (not in shared contract) ---

/**
 * Body shape for the 409 `loop_already_active` conflict response.
 * Defined here so frontend can import from @repo/api without reaching into apps/api.
 */
export type LoopAlreadyActiveBody = {
  error: "loop_already_active";
  loopId: string;
  command: LoopCommand;
  status: LoopStatus;
};

export type SourceContextType = typeof ArtifactType.Document;

// Compute target summary (for loop list/detail views)
export type ComputeTargetSummary = {
  id: string;
  machineName: string;
  isOnline: boolean;
};

export type LoopError = {
  code: string;
  message: string;
  result?: JsonObject;
};

// Core Loop entity
export type Loop = {
  id: string;
  organizationId: string;
  userId: string;
  status: LoopStatus;
  command: LoopCommand;
  harness: HarnessType;
  documentId: string | null;
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
  error: LoopError | null;
  documentVersion: number | null;
  metadata: JsonObject;
  activeTokenJti: string | null;
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
  tags?: TagSummary[];
};

// AdditionalRepoRef augmented with optional branch/PR projections for loop detail views.
export type AdditionalRepoRefWithPr = AdditionalRepoRef & {
  branchArtifact?: BranchInfo | null;
  pullRequest?: PullRequestInfo | null;
};

export type LoopSupportArtifact = {
  name: string;
  key: string;
  downloadUrl: string;
  sizeBytes?: number;
};

// Loop detail view — same as LoopWithUser but with PR-enriched additional repos
export type LoopDetail = Omit<LoopWithUser, "additionalRepos"> & {
  additionalRepos: AdditionalRepoRefWithPr[] | null;
  primaryBranch: BranchInfo | null;
  primaryPullRequest: PullRequestInfo | null;
  supportArtifacts?: LoopSupportArtifact[];
};

// Additional repository references for multi-repo loop execution
// Canonical source: @closedloop-ai/loops-api/context-pack
export type { AdditionalRepoRef, AdditionalRepoRefWithToken };

export const MAX_ADDITIONAL_REPOS = 5;

/**
 * PostHog flag gating the dark-launched `request_prd_changes` ("Amend PRD")
 * run-loop command. Shared so the PRD editor (which hides the menu item) and
 * the run-loop API route (which must fail closed before dispatch) agree on a
 * single key. See FEA-2925.
 */
export const PRD_REQUEST_CHANGES_FEATURE_FLAG_KEY =
  "prd-request-changes" as const;

export const INHERITANCE_ANCESTOR_MAX_DEPTH = 3;

export type InheritedAdditionalRepos = {
  additionalRepos: AdditionalRepoRef[];
  source: {
    loopId: string;
    command: LoopCommand;
    artifactId: string;
  } | null;
};

// Request/Response types
export type CreateLoopRequest = {
  command: LoopCommand;
  harness?: HarnessType;
  documentId?: string;
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
  user: BasicUser;
  isLocal: boolean;
  childSubtype: ArtifactSubtype | null;
  isDirectLoop: boolean;
  startedAt: Date | null;
  completedAt: Date | null;
  failedAt: Date | null;
  // updatedAt is used as the fallback "active timestamp" when comparing
  // against latestFailed for PENDING/CLAIMED loops where startedAt is null.
  updatedAt: Date;
};

export type LoopSummary = {
  activeLoop: LoopSummaryEntry | null;
  latestCompleted: LoopSummaryEntry | null;
  latestFailed: LoopSummaryEntry | null;
};

export type LoopSummariesResponse = Record<string, LoopSummary>;

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
  BootstrapAgent,
  BootstrapLoopResult,
  BootstrapRepoResult,
} from "@closedloop-ai/loops-api/bootstrap-result";
export {
  BootstrapAgentSchema,
  BootstrapLoopResultSchema,
  BootstrapRepoResultSchema,
} from "@closedloop-ai/loops-api/bootstrap-result";

export type RepoExecutionResult = z.infer<
  typeof RepoExecutionResultSchemaValue
>;
export type ExecutionResultV2 = z.infer<typeof ExecutionResultV2SchemaValue>;
export type ParsedExecutionResult =
  | {
      ok: true;
      results: RepoExecutionResult[];
      schemaVersion: 1 | 2;
      repoCount: number;
    }
  | {
      ok: false;
      error: string;
      schemaVersion?: number;
    };

/**
 * Parses execution-result.json payloads and returns the API facade's stable
 * RepoExecutionResult type, insulating API consumers from generated package
 * declaration drift in @closedloop-ai/loops-api.
 */
export const parseExecutionResultFile =
  parseExecutionResultFileFromLoopsApi as (
    data: unknown,
    fullName?: string
  ) => ParsedExecutionResult;
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

export type LoopEventReceivedResponse = {
  received: true;
  ignored?: true;
};

export const ManualLoopEventType = {
  Output: "output",
  Progress: "progress",
  Completed: "completed",
  Error: "error",
  Cancelled: "cancelled",
} as const;
export type ManualLoopEventType =
  (typeof ManualLoopEventType)[keyof typeof ManualLoopEventType];

// --- Loop runner JWT refresh and heartbeat types (re-exported from @closedloop-ai/loops-api) ---

export type {
  RefreshError,
  RefreshResult,
  RefreshSuccess,
} from "@closedloop-ai/loops-api/token-refresh";
export {
  HeartbeatErrorCode,
  RefreshTokenErrorCode,
} from "@closedloop-ai/loops-api/token-refresh";
