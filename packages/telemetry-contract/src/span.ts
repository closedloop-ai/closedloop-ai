import { z } from "zod";
import { TelemetryAttribute } from "./attributes";
import { TelemetrySchemaName } from "./schema-name";
import {
  boundedText,
  hasMaxCodePointLength,
  hasNoControlCharacters,
  TELEMETRY_UUID_PATTERN,
  TelemetryDurationMsMax,
  TelemetryTextMaxLength,
} from "./schema-primitives";

const HTTP_METHOD_PATTERN = /^[A-Z][A-Z0-9!#$%&'*+.^_`|~-]{0,31}$/;
const ERROR_TYPE_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$.]*$/;
const ARTIFACT_TOKEN_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/;
const ZERO_TRACE_ID = "00000000000000000000000000000000";
const ZERO_SPAN_ID = "0000000000000000";
export const MAX_SPAN_LINKS = 32;
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

/**
 * Closed set naming WHICH LAYER produced a 5xx response, carried on
 * `app.error.source` (ISS-7217).
 *
 * One axis only — the reporting layer. What the failure *was* is `error.type`,
 * which already distinguishes a Prisma class from an upstream fetch class, so
 * folding "db" or "upstream" in here would have overlapped two axes on one
 * attribute and made both unqueryable.
 */
export const SpanErrorSource = {
  /** A route handler's own catch produced the 5xx, with the error in hand. */
  RouteHandler: "route_handler",
  /** The auth wrapper's catch produced it — the handler was never reached, or threw past it. */
  AuthWrapper: "auth_wrapper",
  /**
   * A 5xx reached the emitter with no recorded cause. A MEMBER, not an
   * omission: a 5xx nobody instrumented has to stay countable and visibly
   * distinct from an attributed one, or the attributed counts silently claim
   * to describe the whole population.
   */
  Unattributed: "unattributed",
} as const;

/** Literal union of span error-source values. */
export type SpanErrorSource =
  (typeof SpanErrorSource)[keyof typeof SpanErrorSource];

/**
 * Identifier-shaped exception class or stable error code, bounded.
 *
 * Deliberately NARROWER than {@link boundedText} (ISS-7217): the span is a
 * keyless lane, and an error *message* is the classic place user content
 * escapes — a query string, a filesystem path, an email, a prompt fragment, a
 * database value. Every one of those needs a character this pattern forbids
 * (space, `/`, `@`, `?`, `=`, `:`), so the schema itself refuses prose rather
 * than trusting each producer to have sanitized it.
 */
export const SpanErrorTypeSchema = boundedText(
  TelemetryTextMaxLength.ErrorType
).refine(
  (value) => ERROR_TYPE_PATTERN.test(value),
  "must be an identifier-shaped exception class or error code"
);

/**
 * Low-cardinality SCREAMING_SNAKE token, for the artifact subtype and status
 * (ISS-7224). Same reasoning as {@link SpanErrorTypeSchema}: the shape makes a
 * title, a path, or a slug structurally unrepresentable, so the enum values are
 * the only thing that fits.
 */
const artifactToken = (maxLength: number) =>
  boundedText(maxLength).refine(
    (value) => ARTIFACT_TOKEN_PATTERN.test(value),
    "must be an uppercase enum token"
  );

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
    [TelemetryAttribute.DurationMs]: z
      .number()
      .int()
      .min(0)
      .max(TelemetryDurationMsMax),
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
    [TelemetryAttribute.ErrorType]: SpanErrorTypeSchema.optional(),
    [TelemetryAttribute.AppErrorSource]: z.enum(SpanErrorSource).optional(),
    [TelemetryAttribute.AppOrganizationId]: boundedText(
      TelemetryTextMaxLength.AppOrganizationId
    ).optional(),
    // ISS-8749: the caller-attested Desktop install and build. `boundedText`
    // with the SAME bound the App schema gives `app.installation.id`, not a
    // stricter span-only shape — one attribute accepting two different sets
    // across two schemas is a contract that cannot be stated. The narrowing
    // that matters happens at the trust boundary instead: the API validates
    // both headers before they ever reach an attribution store.
    [TelemetryAttribute.AppInstallationId]: boundedText(
      TelemetryTextMaxLength.AppInstallationId
    ).optional(),
    [TelemetryAttribute.AppClientVersion]: boundedText(
      TelemetryTextMaxLength.AppClientVersion
    ).optional(),
    // ISS-8748: the internal database user id, constrained to a UUID rather
    // than bounded text. The narrower shape is the privacy control — an email,
    // a display name, a Clerk id, or anything else a caller might reach for
    // instead is structurally unrepresentable, so the keyless lane cannot carry
    // a personal identifier even if a producer passes one.
    [TelemetryAttribute.UserId]: z
      .string()
      .regex(TELEMETRY_UUID_PATTERN)
      .optional(),
    [TelemetryAttribute.ArtifactType]: artifactToken(
      TelemetryTextMaxLength.ArtifactType
    ).optional(),
    [TelemetryAttribute.ArtifactStatus]: artifactToken(
      TelemetryTextMaxLength.ArtifactStatus
    ).optional(),
    // ISS-7227: the client-generated sync batch id, the one value both halves
    // of a sync attempt can name. Same `TELEMETRY_UUID_PATTERN` the Sync schema
    // constrains `sync.batch_id` to, not a span-local re-spelling — one
    // attribute accepting two different sets across two schemas is a contract
    // that cannot be stated, and the shared pattern is what stops a session id,
    // a path, or transcript text riding the join key.
    [TelemetryAttribute.SyncBatchId]: z
      .string()
      .regex(TELEMETRY_UUID_PATTERN)
      .optional(),
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
    duration_ms: z.number().int().min(0).max(TelemetryDurationMsMax),
    links: z.array(SpanLinkSchema).max(MAX_SPAN_LINKS).optional(),
    schema_name: z.enum(TelemetrySchemaName),
    attributes: z.record(z.string(), z.unknown()),
  })
  .strict();

/** Parsed span envelope shape before schema-selected attribute narrowing. */
export type SpanEnvelope = z.infer<typeof SpanEnvelopeSchema>;
