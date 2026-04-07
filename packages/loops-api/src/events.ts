import { z } from "zod";

import type { JsonObject } from "./common";
import type { TokensByModel, TokenUsage } from "./tokens";
import { TokensByModelSchema, TokenUsageSchema } from "./tokens";

// --- Event type enum ---

export const LoopEventType = {
  Started: "started",
  Output: "output",
  Progress: "progress",
  ToolCall: "tool_call",
  ArtifactCreated: "artifact_created",
  Completed: "completed",
  Error: "error",
  Cancelled: "cancelled",
} as const;
export type LoopEventType = (typeof LoopEventType)[keyof typeof LoopEventType];

export const LoopEventTypeSchema = z.enum(LoopEventType);

// --- Individual event types + schemas ---

export type LoopEventStarted = {
  type: "started";
  loopId: string;
  timestamp: string;
};

export const LoopEventStartedSchema = z.object({
  type: z.literal("started"),
  loopId: z.string(),
  timestamp: z.string(),
});

export type LoopEventOutput = {
  type: "output";
  chunk: string;
  timestamp?: string;
  tokenUsage?: TokenUsage;
};

export const LoopEventOutputSchema = z.object({
  type: z.literal("output"),
  chunk: z.string(),
  timestamp: z.string().optional(),
  tokenUsage: TokenUsageSchema.optional(),
});

export type LoopEventProgress = {
  type: "progress";
  percent: number;
  stage: string;
  timestamp: string;
};

export const LoopEventProgressSchema = z.object({
  type: z.literal("progress"),
  percent: z.number(),
  stage: z.string(),
  timestamp: z.string(),
});

export type LoopEventToolCall = {
  type: "tool_call";
  tool: string;
  status: "start" | "end";
  input?: unknown;
  output?: unknown;
  timestamp: string;
};

export const LoopEventToolCallSchema = z.object({
  type: z.literal("tool_call"),
  tool: z.string(),
  status: z.enum(["start", "end"]),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  timestamp: z.string(),
});

export type LoopEventArtifactCreated = {
  type: "artifact_created";
  artifactId: string;
  artifactType: string;
  timestamp: string;
};

export const LoopEventArtifactCreatedSchema = z.object({
  type: z.literal("artifact_created"),
  artifactId: z.string(),
  artifactType: z.string(),
  timestamp: z.string(),
});

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
  apiKeySource?: string;
  timestamp: string;
};

export const LoopEventCompletedSchema = z.object({
  type: z.literal("completed"),
  result: z.record(z.string(), z.unknown()),
  tokensUsed: z.object({
    input: z.number(),
    output: z.number(),
    cacheCreationInputTokens: z.number().optional(),
    cacheReadInputTokens: z.number().optional(),
    turns: z.number().optional(),
    models: z.array(z.string()).optional(),
  }),
  tokensByModel: TokensByModelSchema.optional(),
  apiKeySource: z.string().optional(),
  timestamp: z.string(),
});

export type LoopEventError = {
  type: "error";
  code: string;
  message: string;
  timestamp: string;
  logTail?: string;
  tokenUsage?: TokenUsage;
  tokensByModel?: TokensByModel;
  diagnosticsVersion?: string;
  apiKeySource?: string;
};

export const LoopEventErrorSchema = z.object({
  type: z.literal("error"),
  code: z.string(),
  message: z.string(),
  timestamp: z.string(),
  logTail: z.string().optional(),
  tokenUsage: TokenUsageSchema.optional(),
  tokensByModel: TokensByModelSchema.optional(),
  diagnosticsVersion: z.string().optional(),
  apiKeySource: z.string().optional(),
});

export type LoopEventCancelled = {
  type: "cancelled";
  reason?: string;
  timestamp: string;
};

export const LoopEventCancelledSchema = z.object({
  type: z.literal("cancelled"),
  reason: z.string().optional(),
  timestamp: z.string(),
});

// --- Discriminated union ---

export type LoopEvent =
  | LoopEventStarted
  | LoopEventOutput
  | LoopEventProgress
  | LoopEventToolCall
  | LoopEventArtifactCreated
  | LoopEventCompleted
  | LoopEventError
  | LoopEventCancelled;

export const LoopEventSchema = z.discriminatedUnion("type", [
  LoopEventStartedSchema,
  LoopEventOutputSchema,
  LoopEventProgressSchema,
  LoopEventToolCallSchema,
  LoopEventArtifactCreatedSchema,
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
