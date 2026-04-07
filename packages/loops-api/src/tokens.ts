import { z } from "zod";

// Per-model token tracking
export type ModelTokenUsage = {
  input: number;
  output: number;
  cacheCreation?: number;
  cacheRead?: number;
};

export const ModelTokenUsageSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheCreation: z.number().optional(),
  cacheRead: z.number().optional(),
});

export type TokensByModel = Record<string, ModelTokenUsage>;

export const TokensByModelSchema = z.record(z.string(), ModelTokenUsageSchema);

// Per-event token usage (reported in output/error/completed events)
export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
};

export const TokenUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheCreationInputTokens: z.number().optional(),
  cacheReadInputTokens: z.number().optional(),
});

// Model pricing (USD per million tokens)
export const MODEL_PRICING: Record<string, { input: number; output: number }> =
  {
    "claude-opus-4": { input: 15, output: 75 },
    "claude-sonnet-4-5": { input: 3, output: 15 },
    "claude-haiku-4-5": { input: 0.8, output: 4 },
    // Fallback for unknown models
    default: { input: 15, output: 75 },
  };
