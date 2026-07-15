import { z } from "zod";
import { TelemetryAttribute } from "./attributes";
import { TelemetrySchemaName } from "./schema-name";
import {
  boundedText,
  hasMaxCodePointLength,
  hasNoControlCharacters,
  TelemetryTextMaxLength,
} from "./schema-primitives";

const HTTP_METHOD_PATTERN = /^[A-Z][A-Z0-9!#$%&'*+.^_`|~-]{0,31}$/;
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/;
const ZERO_TRACE_ID = "00000000000000000000000000000000";
const ZERO_SPAN_ID = "0000000000000000";
const MAX_SPAN_LINKS = 32;
export const MAX_SPAN_NAME_LENGTH = 256;
export const MAX_SPAN_STATUS_MESSAGE_LENGTH = 1024;

/** OTel span kind values carried by span envelopes. */
export const SpanKind = {
  Internal: "internal",
  Server: "server",
  Client: "client",
  Producer: "producer",
  Consumer: "consumer",
} as const;

/** Literal union of supported OTel span kind values. */
export type SpanKind = (typeof SpanKind)[keyof typeof SpanKind];

/** OTel span status code values carried by span envelopes. */
export const SpanStatusCode = {
  Unset: "unset",
  Ok: "ok",
  Error: "error",
} as const;

/** Literal union of supported OTel span status code values. */
export type SpanStatusCode =
  (typeof SpanStatusCode)[keyof typeof SpanStatusCode];

const isPathOnlyUrlComponent = (value: string) => {
  if (!value.startsWith("/") || value.startsWith("//")) {
    return false;
  }
  if (value.includes("://") || value.includes("?") || value.includes("#")) {
    return false;
  }
  const firstSegment = value.slice(1).split("/")[0] ?? "";
  const colonIndex = firstSegment.indexOf(":");
  const atIndex = firstSegment.indexOf("@");
  if (colonIndex !== -1 && atIndex !== -1 && colonIndex < atIndex) {
    return false;
  }
  return hasNoControlCharacters(value);
};

/** Path-only URL schema; full URLs, query strings, fragments, and auth are rejected. */
export const UrlPathSchema = z
  .string()
  .min(1)
  .refine(
    (value) => hasMaxCodePointLength(value, TelemetryTextMaxLength.UrlPath),
    `must contain at most ${TelemetryTextMaxLength.UrlPath} Unicode code points`
  )
  .refine(isPathOnlyUrlComponent, "must be a path-only URL component");

/** Strict span attribute schema for HTTP, code, error, and duration metadata. */
export const SpanTelemetrySchema = z
  .object({
    [TelemetryAttribute.HttpRequestMethod]: z
      .string()
      .regex(HTTP_METHOD_PATTERN),
    [TelemetryAttribute.HttpResponseStatusCode]: z
      .number()
      .int()
      .min(100)
      .max(599),
    [TelemetryAttribute.UrlPath]: UrlPathSchema,
    [TelemetryAttribute.DurationMs]: z.number().int().min(0).max(86_400_000),
    [TelemetryAttribute.CodeFunctionName]: boundedText(
      TelemetryTextMaxLength.CodeFunctionName
    ).optional(),
    [TelemetryAttribute.CodeFilePath]: boundedText(
      TelemetryTextMaxLength.CodeFilePath
    ).optional(),
    [TelemetryAttribute.CodeLineNumber]: z
      .number()
      .int()
      .min(1)
      .max(1_000_000)
      .optional(),
    [TelemetryAttribute.CodeColumnNumber]: z
      .number()
      .int()
      .min(0)
      .max(1_000_000)
      .optional(),
    [TelemetryAttribute.ErrorType]: boundedText(
      TelemetryTextMaxLength.ErrorType
    ).optional(),
  })
  .strict();

/** Parsed span telemetry attribute shape. */
export type SpanTelemetry = z.infer<typeof SpanTelemetrySchema>;

/** Strict lowercase W3C trace id schema used by span envelopes and links. */
export const TraceIdSchema = z
  .string()
  .regex(TRACE_ID_PATTERN)
  .refine((value) => value !== ZERO_TRACE_ID, "must not be all zeroes");

/** Strict lowercase W3C span id schema used by span envelopes and links. */
export const SpanIdSchema = z
  .string()
  .regex(SPAN_ID_PATTERN)
  .refine((value) => value !== ZERO_SPAN_ID, "must not be all zeroes");

/** Strict G1 span link schema; link attributes are intentionally unsupported. */
export const SpanLinkSchema = z
  .object({
    trace_id: TraceIdSchema,
    span_id: SpanIdSchema,
  })
  .strict();

/** Strict span status schema with an optional bounded message. */
export const SpanStatusSchema = z
  .object({
    code: z.enum(SpanStatusCode),
    message: boundedText(MAX_SPAN_STATUS_MESSAGE_LENGTH).optional(),
  })
  .strict();

/** Strict span envelope schema; nested attributes are schema-validated later. */
export const SpanEnvelopeSchema = z
  .object({
    trace_id: TraceIdSchema,
    span_id: SpanIdSchema,
    parent_span_id: SpanIdSchema.optional(),
    name: boundedText(MAX_SPAN_NAME_LENGTH),
    kind: z.enum(SpanKind),
    status: SpanStatusSchema,
    duration_ms: z.number().int().min(0).max(86_400_000),
    links: z.array(SpanLinkSchema).max(MAX_SPAN_LINKS).optional(),
    schema_name: z.enum(TelemetrySchemaName),
    attributes: z.record(z.string(), z.unknown()),
  })
  .strict();

/** Parsed span envelope shape before schema-selected attribute narrowing. */
export type SpanEnvelope = z.infer<typeof SpanEnvelopeSchema>;
