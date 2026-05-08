import { z } from "zod";

import type { JsonObject } from "./common";
import type { RepoExecutionResult } from "./execution-result";
import { RepoExecutionResultSchema } from "./execution-result";
import type { TokensByModel, TokenUsage } from "./tokens";
import { TokensByModelSchema, TokenUsageSchema } from "./tokens";

// --- Event type enum ---

export const LoopEventType = {
  Started: "started",
  Output: "output",
  Progress: "progress",
  ToolCall: "tool_call",
  ArtifactCreated: "artifact_created",
  SupportBundleUploaded: "support_bundle_uploaded",
  Completed: "completed",
  Error: "error",
  Cancelled: "cancelled",
} as const;
export type LoopEventType = (typeof LoopEventType)[keyof typeof LoopEventType];

export const LoopEventTypeSchema = z.enum(LoopEventType);

// --- Completed event result shape ---

/**
 * Typed shape for the completed event `result` field.
 *
 * Both ECS harness and Electron gateway send these fields. The backend reads
 * specific fields via `extractPrSessionInfo()`. Extra fields are preserved
 * via `.passthrough()` on the schema.
 */
export type LoopCompletedResult = {
  exitCode?: number;
  signal?: string | null;
  durationSeconds?: number;
  prUrl?: string | null;
  prNumber?: number | null;
  branchName?: string | null;
  commitSha?: string | null;
  sessionId?: string | null;
};

export const LoopCompletedResultSchema = z.looseObject({
  exitCode: z.number().optional(),
  signal: z.string().nullable().optional(),
  durationSeconds: z.number().optional(),
  prUrl: z.string().nullable().optional(),
  prNumber: z.number().nullable().optional(),
  branchName: z.string().nullable().optional(),
  commitSha: z.string().nullable().optional(),
  sessionId: z.string().nullable().optional(),
});

// --- Individual event types + schemas ---

export type LoopEventStarted = {
  type: "started";
  loopId: string;
  timestamp: string;
  correlationId?: string;
};

export const LoopEventStartedSchema = z.object({
  type: z.literal("started"),
  loopId: z.string(),
  timestamp: z.string(),
  correlationId: z.string().optional(),
});

export type LoopEventOutput = {
  type: "output";
  chunk: string;
  timestamp?: string;
  tokenUsage?: TokenUsage;
  correlationId?: string;
  loopId?: string;
};

export const LoopEventOutputSchema = z.object({
  type: z.literal("output"),
  chunk: z.string(),
  timestamp: z.string().optional(),
  tokenUsage: TokenUsageSchema.optional(),
  correlationId: z.string().optional(),
  loopId: z.string().optional(),
});

export type LoopEventProgress = {
  type: "progress";
  percent: number;
  stage: string;
  timestamp: string;
  correlationId?: string;
  loopId?: string;
};

export const LoopEventProgressSchema = z.object({
  type: z.literal("progress"),
  percent: z.number(),
  stage: z.string(),
  timestamp: z.string(),
  correlationId: z.string().optional(),
  loopId: z.string().optional(),
});

export type LoopEventToolCall = {
  type: "tool_call";
  tool: string;
  status: "start" | "end";
  input?: unknown;
  output?: unknown;
  timestamp: string;
  correlationId?: string;
  loopId?: string;
};

export const LoopEventToolCallSchema = z.object({
  type: z.literal("tool_call"),
  tool: z.string(),
  status: z.enum(["start", "end"]),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  timestamp: z.string(),
  correlationId: z.string().optional(),
  loopId: z.string().optional(),
});

export type LoopEventArtifactCreated = {
  type: "artifact_created";
  artifactId: string;
  artifactType: string;
  timestamp: string;
  correlationId?: string;
  loopId?: string;
};

export const LoopEventArtifactCreatedSchema = z.object({
  type: z.literal("artifact_created"),
  artifactId: z.string(),
  artifactType: z.string(),
  timestamp: z.string(),
  correlationId: z.string().optional(),
  loopId: z.string().optional(),
});

export type LoopSupportBundleFile = {
  name: string;
  key: string;
  sizeBytes?: number;
};

export const LoopSupportBundleFileSchema = z.object({
  name: z.string().min(1),
  key: z.string().min(1),
  sizeBytes: z.number().int().nonnegative().optional(),
});

export type LoopEventSupportBundleUploaded = {
  type: "support_bundle_uploaded";
  keys: string[];
  files?: LoopSupportBundleFile[];
  timestamp: string;
  correlationId?: string;
  loopId?: string;
};

export const LoopEventSupportBundleUploadedSchema = z.object({
  type: z.literal("support_bundle_uploaded"),
  keys: z.array(z.string().min(1)).min(1).max(2),
  files: z.array(LoopSupportBundleFileSchema).max(2).optional(),
  timestamp: z.string(),
  correlationId: z.string().optional(),
  loopId: z.string().optional(),
});

export type LoopEventCompleted = {
  type: "completed";
  result: LoopCompletedResult;
  tokensUsed: {
    input: number;
    output: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
    turns?: number;
    models?: string[];
  };
  tokensByModel?: TokensByModel | null;
  apiKeySource?: string;
  timestamp: string;
  correlationId?: string;
  loopId?: string;
  warnings?: string[];
  results?: RepoExecutionResult[];
};

export const LoopEventCompletedSchema = z.object({
  type: z.literal("completed"),
  result: LoopCompletedResultSchema,
  tokensUsed: z.object({
    input: z.number(),
    output: z.number(),
    cacheCreationInputTokens: z.number().optional(),
    cacheReadInputTokens: z.number().optional(),
    turns: z.number().optional(),
    models: z.array(z.string()).optional(),
  }),
  tokensByModel: TokensByModelSchema.nullable().optional(),
  apiKeySource: z.string().optional(),
  timestamp: z.string(),
  correlationId: z.string().optional(),
  loopId: z.string().optional(),
  warnings: z.array(z.string()).optional(),
  results: z.array(RepoExecutionResultSchema).optional(),
});

export type LoopEventError = {
  type: "error";
  code: string;
  message: string;
  timestamp: string;
  logTail?: string;
  tokenUsage?: TokenUsage;
  tokensByModel?: TokensByModel | null;
  diagnosticsVersion?: string;
  apiKeySource?: string;
  result?: JsonObject;
  correlationId?: string;
  loopId?: string;
  warnings?: string[];
};

export const LoopEventErrorSchema = z.object({
  type: z.literal("error"),
  code: z.string(),
  message: z.string(),
  timestamp: z.string(),
  logTail: z.string().optional(),
  tokenUsage: TokenUsageSchema.optional(),
  tokensByModel: TokensByModelSchema.nullable().optional(),
  diagnosticsVersion: z.string().optional(),
  apiKeySource: z.string().optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  correlationId: z.string().optional(),
  loopId: z.string().optional(),
  warnings: z.array(z.string()).optional(),
});

export type LoopEventCancelled = {
  type: "cancelled";
  reason?: string;
  timestamp: string;
  correlationId?: string;
  loopId?: string;
};

export const LoopEventCancelledSchema = z.object({
  type: z.literal("cancelled"),
  reason: z.string().optional(),
  timestamp: z.string(),
  correlationId: z.string().optional(),
  loopId: z.string().optional(),
});

// --- Discriminated union ---

export type LoopEvent =
  | LoopEventStarted
  | LoopEventOutput
  | LoopEventProgress
  | LoopEventToolCall
  | LoopEventArtifactCreated
  | LoopEventSupportBundleUploaded
  | LoopEventCompleted
  | LoopEventError
  | LoopEventCancelled;

export const LoopEventSchema = z.discriminatedUnion("type", [
  LoopEventStartedSchema,
  LoopEventOutputSchema,
  LoopEventProgressSchema,
  LoopEventToolCallSchema,
  LoopEventArtifactCreatedSchema,
  LoopEventSupportBundleUploadedSchema,
  LoopEventCompletedSchema,
  LoopEventErrorSchema,
  LoopEventCancelledSchema,
]);

// --- Query/response types ---

export type LoopEventsFilters = {
  type?: LoopEventType;
  limit?: number;
  offset?: number;
  sort?: "asc" | "desc";
};

export type LoopEventsPaginatedResponse = {
  data: LoopEvent[];
  total: number;
};
