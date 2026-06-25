import { z } from "zod";
import { safeStorageTokenCountSchema } from "../token-counts.js";

export const CodexOtelTokenUsageSource = {
  JsonlParser: "jsonl_parser",
  OtelLogPayload: "otel_log_payload",
} as const;
export type CodexOtelTokenUsageSource =
  (typeof CodexOtelTokenUsageSource)[keyof typeof CodexOtelTokenUsageSource];

export const CodexOtelSpanStatus = {
  Unset: "unset",
  Ok: "ok",
  Error: "error",
} as const;
export type CodexOtelSpanStatus =
  (typeof CodexOtelSpanStatus)[keyof typeof CodexOtelSpanStatus];

export type CodexOtelBatch = z.infer<typeof codexOtelBatchSchema>;
export type CodexOtelSpan = z.infer<typeof codexOtelSpanSchema>;

export function parseCodexOtelBatch(input: unknown): CodexOtelBatch {
  return codexOtelBatchSchema.parse(input);
}

export const CODEX_OTEL_MAX_ATTRIBUTE_COUNT = 64;
export const CODEX_OTEL_MAX_ATTRIBUTE_KEY_LENGTH = 128;
export const CODEX_OTEL_MAX_ATTRIBUTE_STRING_LENGTH = 1024;
export const CODEX_OTEL_MAX_BATCH_SPANS = 256;
export const CODEX_OTEL_MAX_BATCH_TOKEN_USAGE = 256;
export const CODEX_OTEL_MAX_IDENTIFIER_LENGTH = 128;
export const CODEX_OTEL_MAX_MODEL_LENGTH = 128;
export const CODEX_OTEL_MAX_SPAN_NAME_LENGTH = 256;
export const CODEX_OTEL_MAX_STATUS_MESSAGE_LENGTH = 512;
export const CODEX_OTEL_MAX_REDACTED_ATTRIBUTE_COUNT = 32;

const nonEmptyIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(CODEX_OTEL_MAX_IDENTIFIER_LENGTH);
const spanNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(CODEX_OTEL_MAX_SPAN_NAME_LENGTH);
const modelSchema = z.string().trim().min(1).max(CODEX_OTEL_MAX_MODEL_LENGTH);
const statusMessageSchema = z
  .string()
  .trim()
  .max(CODEX_OTEL_MAX_STATUS_MESSAGE_LENGTH);
const timestampSchema = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: "Expected a parseable timestamp",
  });
const nonnegativeIntegerSchema = z.number().int().nonnegative();
const attributeRecordSchema = z
  .record(z.string().max(CODEX_OTEL_MAX_ATTRIBUTE_KEY_LENGTH), z.unknown())
  .optional()
  .default({})
  .refine(
    (attributes) =>
      Object.keys(attributes).length <= CODEX_OTEL_MAX_ATTRIBUTE_COUNT,
    {
      message: `Expected at most ${CODEX_OTEL_MAX_ATTRIBUTE_COUNT} attributes`,
    }
  );

const codexOtelSpanSchema = z
  .object({
    traceId: nonEmptyIdentifierSchema,
    spanId: nonEmptyIdentifierSchema,
    parentSpanId: nonEmptyIdentifierSchema.optional(),
    sessionId: nonEmptyIdentifierSchema,
    name: spanNameSchema,
    startTime: timestampSchema,
    endTime: timestampSchema,
    durationMs: nonnegativeIntegerSchema,
    status: z.enum(CodexOtelSpanStatus),
    statusMessage: statusMessageSchema.optional(),
    toolName: spanNameSchema.optional(),
    attributes: attributeRecordSchema,
    resourceAttributes: attributeRecordSchema,
  })
  .strict()
  .refine((span) => Date.parse(span.endTime) >= Date.parse(span.startTime), {
    message: "endTime must be greater than or equal to startTime",
    path: ["endTime"],
  });

const codexOtelTokenUsageSchema = z
  .object({
    sessionId: nonEmptyIdentifierSchema,
    model: modelSchema,
    inputTokens: safeStorageTokenCountSchema,
    outputTokens: safeStorageTokenCountSchema,
    cacheReadTokens: safeStorageTokenCountSchema,
    cacheWriteTokens: safeStorageTokenCountSchema,
    observedAt: timestampSchema,
  })
  .strict();

const codexOtelBatchSchema = z
  .object({
    spans: z
      .array(codexOtelSpanSchema)
      .max(CODEX_OTEL_MAX_BATCH_SPANS)
      .optional()
      .default([]),
    tokenUsage: z
      .array(codexOtelTokenUsageSchema)
      .max(CODEX_OTEL_MAX_BATCH_TOKEN_USAGE)
      .optional()
      .default([]),
  })
  .strict();
