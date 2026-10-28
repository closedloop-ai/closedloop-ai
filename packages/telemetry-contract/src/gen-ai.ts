import { z } from "zod";
import { TelemetryAttribute } from "./attributes";
import { boundedText, TelemetryTextMaxLength } from "./schema-primitives";

const MAX_TOKEN_COUNT = 1_000_000_000;

const tokenCount = z.number().int().min(0).max(MAX_TOKEN_COUNT);

const usdCost = z.number().finite().min(0);

/**
 * `gen_ai.operation.name` values this contract admits. Closed on purpose: it is
 * the one attribute PostHog's OTLP ingestion reads to name the event, and only
 * `chat` becomes a `$ai_generation` (ISS-11347).
 */
export const GenAiOperationName = {
  Chat: "chat",
} as const;

/** Literal union of admitted `gen_ai.operation.name` values. */
export type GenAiOperationName =
  (typeof GenAiOperationName)[keyof typeof GenAiOperationName];

/** Strict GenAI attribute schema for model, response, token, and cost metadata. */
export const GenAiTelemetrySchema = z
  .object({
    [TelemetryAttribute.GenAiRequestModel]: boundedText(
      TelemetryTextMaxLength.GenAiRequestModel
    ),
    [TelemetryAttribute.GenAiResponseId]: boundedText(
      TelemetryTextMaxLength.GenAiResponseId
    ).optional(),
    [TelemetryAttribute.GenAiUsageInputTokens]: tokenCount.optional(),
    [TelemetryAttribute.GenAiUsageOutputTokens]: tokenCount.optional(),
    [TelemetryAttribute.GenAiUsageCacheCreationInputTokens]:
      tokenCount.optional(),
    [TelemetryAttribute.GenAiUsageCacheReadInputTokens]: tokenCount.optional(),
    [TelemetryAttribute.GenAiCostUsage]: usdCost.optional(),
    [TelemetryAttribute.GenAiOperationName]: z
      .enum(GenAiOperationName)
      .optional(),
  })
  .strict();

/** Parsed GenAI telemetry attribute shape. */
export type GenAiTelemetry = z.infer<typeof GenAiTelemetrySchema>;
