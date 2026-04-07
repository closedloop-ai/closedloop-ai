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

const RE_DATE_SUFFIX = /-\d{8}$/;

const CANONICAL_MODEL_NAMES: Record<string, string> = {
  "claude-opus-4-6": "claude-opus-4",
  "claude-opus-4": "claude-opus-4",
  "claude-sonnet-4-5": "claude-sonnet-4-5",
  "claude-haiku-4-5": "claude-haiku-4-5",
};

/**
 * Normalize model names to canonical short forms for consistent pricing lookup.
 *
 * Strips date suffixes (e.g., `-20250929`) and maps known variants to
 * canonical names (e.g., `claude-opus-4-6` → `claude-opus-4`).
 */
export function normalizeModelName(rawName: string): string {
  const stripped = rawName.replace(RE_DATE_SUFFIX, "");
  return CANONICAL_MODEL_NAMES[stripped] ?? stripped;
}
