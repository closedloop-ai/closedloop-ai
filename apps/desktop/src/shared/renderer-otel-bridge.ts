import { AppExceptionOrigin } from "@closedloop-ai/telemetry-contract/app-exception-origin";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import {
  SpanIdSchema,
  SpanKind,
  SpanStatusCode,
  SpanStatusSchema,
  TraceIdSchema,
} from "@closedloop-ai/telemetry-contract/span";
import type { AttributeValue } from "@opentelemetry/api";
import { z } from "zod";
import {
  containsSensitivePathOrUrlValue,
  containsSensitiveSecretValue,
  containsSensitiveUrlValue,
  sanitizeDesktopExceptionAttributes,
} from "./exception-sanitizer.js";
import {
  type DesktopOtelInstrumentationScope,
  DesktopOtelSignal,
  RENDERER_OTEL_MAX_ATTRIBUTES_PER_RECORD,
  RENDERER_OTEL_MAX_BATCH_BYTES,
  RENDERER_OTEL_MAX_RECORDS_PER_BATCH,
  RENDERER_OTEL_MAX_STRING_BYTES,
  RendererOtelAllowedAttributeKey,
  type RendererOtelBridgePayload,
  type RendererOtelBridgeRecord,
  RendererOtelExceptionAttributeKey,
  type RendererOtelExceptionAttributes,
  RendererOtelExportFailureReason,
  type RendererOtelExportResult,
  type RendererOtelGenericAttributes,
  type RendererOtelGenericBridgeRecord,
} from "./renderer-otel-bridge-constants.js";
import { containsControlCharacter } from "./renderer-otel-bridge-utils.js";

export type RendererOtelBridgeParseResult =
  | { ok: true; payload: RendererOtelBridgePayload }
  | { ok: false; result: RendererOtelExportResult };

const SENSITIVE_KEY_PATTERN =
  /(api[_-]?key|authorization|body|cwd|device\.id|endpoint|error|file|home|host|installation|org|path|prompt|resource|session|stack|token|url|user)/i;
const ALLOWED_ATTRIBUTE_KEYS = new Set<string>(
  Object.values(RendererOtelAllowedAttributeKey)
);
const ALLOWED_EXCEPTION_ATTRIBUTE_KEYS = new Set<string>(
  Object.values(RendererOtelExceptionAttributeKey)
);

const attributeValueSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.array(z.string()).max(16),
  z.array(z.number().finite()).max(16),
  z.array(z.boolean()).max(16),
]);

/**
 * Field validators for each bridged shape, kept as standalone literals so the
 * keys-covered guards can see them.
 *
 * `satisfies Record<keyof T, z.ZodTypeAny>` is the compile-time guard (FEA-3701,
 * root AGENTS.md). Every schema below is `.strict()` and sits on the
 * renderer→main trust boundary: a field added to one of the bridge record types
 * in `renderer-otel-bridge-constants.ts` and emitted by the renderer without
 * being taught here would make main reject the ENTIRE batch, dropping up to
 * `RENDERER_OTEL_MAX_RECORDS_PER_BATCH` records at once — and re-dropping every
 * subsequent batch — while the in-process producer never sees this schema.
 * `satisfies` turns that into a `tsc` failure: a missing key and an extra key
 * are both errors.
 */
const instrumentationScopeShape = {
  name: z.string(),
  version: z.string().optional(),
} satisfies Record<keyof DesktopOtelInstrumentationScope, z.ZodTypeAny>;

const instrumentationScopeSchema = z.object(instrumentationScopeShape).strict();

/**
 * Every key of every arm of a union.
 *
 * A bare `keyof (A | B)` is the INTERSECTION of the arms' keys, so it silently
 * shrinks to the keys the arms already share — the opposite of what a
 * keys-covered guard needs. This conditional type is distributive, so it
 * resolves to `keyof A | keyof B`: the UNION of the arms' keys.
 */
type KeysOfUnion<T> = T extends unknown ? keyof T : never;

/**
 * Guarded against every arm of the `RendererOtelBridgeRecord` union, not just
 * the generic one.
 *
 * `bridgeRecordSchema` is `.strict()` and parses BOTH arms, so an untaught key
 * on EITHER arm makes main reject the whole batch. Guarding only
 * `keyof RendererOtelGenericBridgeRecord` left the exception arm uncovered:
 * `RendererOtelExceptionBridgeRecord` is declared independently and is not
 * constrained to extend the generic record, so the fact that its keys are
 * currently a subset is a coincidence this guard must not rely on. A field
 * added only to the exception arm — the renderer's crash-reporting path —
 * compiled green and was then rejected at runtime, dropping the entire batch.
 *
 * `KeysOfUnion` makes that a `tsc` failure, and keeps covering any arm added to
 * the union later.
 */
const bridgeRecordShape = {
  signal: z.enum([
    DesktopOtelSignal.Trace,
    DesktopOtelSignal.Metric,
    DesktopOtelSignal.Log,
  ]),
  instrumentationScope: instrumentationScopeSchema.optional(),
  timestampUnixNano: z.string().optional(),
  traceId: TraceIdSchema.optional(),
  spanId: SpanIdSchema.optional(),
  parentSpanId: SpanIdSchema.optional(),
  kind: z.enum(SpanKind).optional(),
  status: SpanStatusSchema.optional(),
  name: z.string().optional(),
  value: attributeValueSchema.optional(),
  attributes: z.record(z.string(), attributeValueSchema).optional(),
  droppedAttributesCount: z.number().int().nonnegative().optional(),
  droppedEventsCount: z.number().int().nonnegative().optional(),
  droppedLinksCount: z.number().int().nonnegative().optional(),
} satisfies Record<KeysOfUnion<RendererOtelBridgeRecord>, z.ZodTypeAny>;

const bridgeRecordSchema = z.object(bridgeRecordShape).strict();

const bridgePayloadShape = {
  records: z
    .array(bridgeRecordSchema)
    .min(1)
    .max(RENDERER_OTEL_MAX_RECORDS_PER_BATCH),
} satisfies Record<keyof RendererOtelBridgePayload, z.ZodTypeAny>;

const bridgePayloadSchema = z.object(bridgePayloadShape).strict();

export function parseRendererOtelBridgePayload(
  payload: unknown
): RendererOtelBridgeParseResult {
  if (serializedPayloadBytes(payload) > RENDERER_OTEL_MAX_BATCH_BYTES) {
    return invalidPayload();
  }

  const parsed = bridgePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return invalidPayload();
  }

  const records: RendererOtelBridgeRecord[] = [];
  for (const record of parsed.data.records) {
    const sanitizedRecord = isExceptionRecord(record)
      ? sanitizeExceptionRecord(record)
      : sanitizeRecord(record);
    if (!sanitizedRecord) {
      return invalidPayload();
    }
    records.push(sanitizedRecord);
  }

  return { ok: true, payload: { records } };
}

function sanitizeRecord(
  record: z.infer<typeof bridgeRecordSchema>
): RendererOtelBridgeRecord | null {
  const name = sanitizeIdentifier(record.name);
  const timestampUnixNano = sanitizeIdentifier(record.timestampUnixNano);
  const instrumentationScope = sanitizeInstrumentationScope(
    record.instrumentationScope
  );
  const attributes = sanitizeAttributes(record.attributes);
  const status = sanitizeSpanStatus(record.status);
  const value = sanitizeAttributeValue(record.value);
  if (
    !isValidSanitizedRecord(record, {
      attributes,
      instrumentationScope,
      name,
      status,
      timestampUnixNano,
      value,
    })
  ) {
    return null;
  }
  const sanitizedValue = value === null ? undefined : value;

  return {
    signal: record.signal,
    ...(instrumentationScope ? { instrumentationScope } : {}),
    ...(timestampUnixNano ? { timestampUnixNano } : {}),
    ...traceIdentityFields(record, status),
    ...(name ? { name } : {}),
    ...(sanitizedValue === undefined ? {} : { value: sanitizedValue }),
    ...(attributes ? { attributes } : {}),
    ...(record.droppedAttributesCount === undefined
      ? {}
      : { droppedAttributesCount: record.droppedAttributesCount }),
    ...(record.droppedEventsCount === undefined
      ? {}
      : { droppedEventsCount: record.droppedEventsCount }),
    ...(record.droppedLinksCount === undefined
      ? {}
      : { droppedLinksCount: record.droppedLinksCount }),
  };
}

function isValidSanitizedRecord(
  record: z.infer<typeof bridgeRecordSchema>,
  sanitized: {
    attributes: RendererOtelGenericAttributes | null | undefined;
    instrumentationScope:
      | RendererOtelBridgeRecord["instrumentationScope"]
      | null
      | undefined;
    name: string | undefined;
    status: RendererOtelGenericBridgeRecord["status"] | null | undefined;
    timestampUnixNano: string | undefined;
    value: AttributeValue | null | undefined;
  }
): boolean {
  if (
    record.signal !== DesktopOtelSignal.Trace &&
    hasTraceIdentityFields(record)
  ) {
    return false;
  }
  if (
    record.signal === DesktopOtelSignal.Trace &&
    hasPartialSpanIdentity(record)
  ) {
    return false;
  }
  if (record.name !== undefined && !sanitized.name) {
    return false;
  }
  if (record.timestampUnixNano !== undefined && !sanitized.timestampUnixNano) {
    return false;
  }
  if (
    record.instrumentationScope !== undefined &&
    !sanitized.instrumentationScope
  ) {
    return false;
  }
  if (record.status !== undefined && !sanitized.status) {
    return false;
  }
  if (record.attributes !== undefined && !sanitized.attributes) {
    return false;
  }
  return !(record.value !== undefined && sanitized.value === null);
}

function traceIdentityFields(
  record: z.infer<typeof bridgeRecordSchema>,
  status: RendererOtelGenericBridgeRecord["status"] | null | undefined
) {
  return {
    ...(record.traceId === undefined ? {} : { traceId: record.traceId }),
    ...(record.spanId === undefined ? {} : { spanId: record.spanId }),
    ...(record.parentSpanId === undefined
      ? {}
      : { parentSpanId: record.parentSpanId }),
    ...(record.kind === undefined ? {} : { kind: record.kind }),
    ...(status === undefined || status === null ? {} : { status }),
  };
}

function sanitizeExceptionRecord(
  record: z.infer<typeof bridgeRecordSchema>
): RendererOtelBridgeRecord | null {
  if (
    !isSupportedExceptionSignal(record) ||
    record.name !== "exception" ||
    record.value !== undefined ||
    !isValidExceptionTraceShape(record)
  ) {
    return null;
  }

  const attributes = sanitizeExceptionAttributes(record.attributes);
  const timestampUnixNano = sanitizeIdentifier(record.timestampUnixNano);
  const instrumentationScope = sanitizeInstrumentationScope(
    record.instrumentationScope
  );
  if (!attributes) {
    return null;
  }
  if (record.timestampUnixNano !== undefined && !timestampUnixNano) {
    return null;
  }
  if (record.instrumentationScope !== undefined && !instrumentationScope) {
    return null;
  }
  const status = sanitizeSpanStatus(record.status);
  if (record.status !== undefined && !status) {
    return null;
  }
  const signal =
    record.signal === DesktopOtelSignal.Trace
      ? DesktopOtelSignal.Trace
      : DesktopOtelSignal.Log;

  return {
    signal,
    name: "exception",
    attributes,
    ...traceIdentityFields(record, status),
    ...(instrumentationScope ? { instrumentationScope } : {}),
    ...(timestampUnixNano ? { timestampUnixNano } : {}),
    ...(record.droppedAttributesCount === undefined
      ? {}
      : { droppedAttributesCount: record.droppedAttributesCount }),
    ...(record.droppedEventsCount === undefined
      ? {}
      : { droppedEventsCount: record.droppedEventsCount }),
    ...(record.droppedLinksCount === undefined
      ? {}
      : { droppedLinksCount: record.droppedLinksCount }),
  };
}

function sanitizeInstrumentationScope(
  scope: z.infer<typeof instrumentationScopeSchema> | undefined
): RendererOtelBridgeRecord["instrumentationScope"] | null | undefined {
  if (!scope) {
    return undefined;
  }
  const name = sanitizeIdentifier(scope.name);
  const version = sanitizeIdentifier(scope.version);
  if (!name || (scope.version !== undefined && !version)) {
    return null;
  }
  return {
    name,
    ...(version ? { version } : {}),
  };
}

function sanitizeAttributes(
  attributes: Record<string, AttributeValue> | undefined
): RendererOtelGenericAttributes | null | undefined {
  if (!attributes) {
    return undefined;
  }
  const entries = Object.entries(attributes);
  if (entries.length > RENDERER_OTEL_MAX_ATTRIBUTES_PER_RECORD) {
    return null;
  }

  const sanitized: RendererOtelGenericAttributes = {};
  for (const [key, value] of entries) {
    if (!(isAllowedAttributeKey(key) && isAllowedAttributeValue(value))) {
      return null;
    }
    sanitized[key] = value;
  }
  return sanitized;
}

function sanitizeExceptionAttributes(
  attributes: Record<string, AttributeValue> | undefined
): RendererOtelExceptionAttributes | null {
  if (!attributes) {
    return null;
  }
  const entries = Object.entries(attributes);
  if (
    entries.length === 0 ||
    entries.length > Object.keys(RendererOtelExceptionAttributeKey).length
  ) {
    return null;
  }
  for (const [key, value] of entries) {
    if (
      !(ALLOWED_EXCEPTION_ATTRIBUTE_KEYS.has(key) && typeof value === "string")
    ) {
      return null;
    }
  }
  if (
    attributes[TelemetryAttribute.AppExceptionOrigin] !==
    AppExceptionOrigin.Renderer
  ) {
    return null;
  }
  const exceptionType = attributes[TelemetryAttribute.ExceptionType];
  if (typeof exceptionType !== "string") {
    return null;
  }

  const sanitized = sanitizeDesktopExceptionAttributes({
    type: exceptionType,
    origin: AppExceptionOrigin.Renderer,
    message: readOptionalString(
      attributes[TelemetryAttribute.ExceptionMessage]
    ),
    stacktrace: readOptionalString(
      attributes[TelemetryAttribute.ExceptionStacktrace]
    ),
  });

  return {
    [TelemetryAttribute.ExceptionType]:
      sanitized[TelemetryAttribute.ExceptionType],
    [TelemetryAttribute.AppExceptionOrigin]: AppExceptionOrigin.Renderer,
    ...(sanitized[TelemetryAttribute.ExceptionMessage]
      ? {
          [TelemetryAttribute.ExceptionMessage]:
            sanitized[TelemetryAttribute.ExceptionMessage],
        }
      : {}),
    ...(sanitized[TelemetryAttribute.ExceptionStacktrace]
      ? {
          [TelemetryAttribute.ExceptionStacktrace]:
            sanitized[TelemetryAttribute.ExceptionStacktrace],
        }
      : {}),
  };
}

function sanitizeAttributeValue(
  value: AttributeValue | undefined
): AttributeValue | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  return isAllowedAttributeValue(value) ? value : null;
}

function sanitizeSpanStatus(
  status: z.infer<typeof bridgeRecordSchema>["status"]
): RendererOtelGenericBridgeRecord["status"] | null | undefined {
  if (!status) {
    return undefined;
  }
  if (!status.message) {
    return status;
  }
  return isAllowedAttributeValue(status.message)
    ? status
    : { code: status.code };
}

function isAllowedAttributeKey(
  key: string
): key is RendererOtelAllowedAttributeKey {
  return ALLOWED_ATTRIBUTE_KEYS.has(key);
}

function isAllowedAttributeValue(value: AttributeValue): boolean {
  if (typeof value === "string") {
    return isSafeString(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return true;
  }
  return value.every((item) => {
    if (typeof item === "string") {
      return isSafeString(item);
    }
    return typeof item === "number" || typeof item === "boolean";
  });
}

// Identifier fields (span/scope names, scope versions, timestamps) are
// developer-controlled OTel identifiers, not user-supplied values. They are NOT
// run through SENSITIVE_KEY_PATTERN or the canonical path check: doing so
// silently dropped legitimate names like "renderer.session.created",
// "renderer.error.boundary", or HTTP-style span names such as "GET /settings"
// (and, because one rejected field nulls the whole record, the entire batch).
// The path patterns are intentionally excluded here despite the small
// path-leakage risk they would otherwise catch: any genuinely user-supplied
// data belongs in attribute VALUES, which still flow through isSafeString() with
// the full path/secret/URL filter set. A filesystem path embedded directly in a
// span/scope name would be developer-authored, so the residual exposure is
// bounded. Identifiers are still capped in length and rejected when they carry
// control characters, URLs, or secret-shaped tokens.
function sanitizeIdentifier(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return isSafeIdentifier(value) ? value : undefined;
}

function isSafeIdentifier(value: string): boolean {
  return (
    Buffer.byteLength(value) <= RENDERER_OTEL_MAX_STRING_BYTES &&
    !containsControlCharacter(value) &&
    !containsSensitiveUrlValue(value) &&
    !containsSensitiveSecretValue(value)
  );
}

function isSafeString(value: string): boolean {
  return (
    Buffer.byteLength(value) <= RENDERER_OTEL_MAX_STRING_BYTES &&
    !SENSITIVE_KEY_PATTERN.test(value) &&
    !containsSensitivePathOrUrlValue(value) &&
    !containsSensitiveSecretValue(value)
  );
}

function serializedPayloadBytes(payload: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(payload) ?? "");
  } catch {
    return RENDERER_OTEL_MAX_BATCH_BYTES + 1;
  }
}

function isExceptionRecord(
  record: z.infer<typeof bridgeRecordSchema>
): boolean {
  return (
    (record.signal === DesktopOtelSignal.Log ||
      record.signal === DesktopOtelSignal.Trace) &&
    record.name === "exception"
  );
}

function isSupportedExceptionSignal(
  record: z.infer<typeof bridgeRecordSchema>
): boolean {
  return (
    record.signal === DesktopOtelSignal.Log ||
    record.signal === DesktopOtelSignal.Trace
  );
}

function isValidExceptionTraceShape(
  record: z.infer<typeof bridgeRecordSchema>
): boolean {
  if (record.signal === DesktopOtelSignal.Log) {
    return (
      !hasTraceIdentityFields(record) &&
      record.droppedEventsCount === undefined &&
      record.droppedLinksCount === undefined
    );
  }
  return (
    record.traceId !== undefined &&
    record.spanId !== undefined &&
    !hasPartialSpanIdentity(record) &&
    record.status?.code === SpanStatusCode.Error
  );
}

function hasTraceIdentityFields(
  record: z.infer<typeof bridgeRecordSchema>
): boolean {
  return (
    record.traceId !== undefined ||
    record.spanId !== undefined ||
    record.parentSpanId !== undefined ||
    record.kind !== undefined ||
    record.status !== undefined
  );
}

function hasPartialSpanIdentity(
  record: z.infer<typeof bridgeRecordSchema>
): boolean {
  const hasTraceId = record.traceId !== undefined;
  const hasSpanId = record.spanId !== undefined;
  return (
    hasTraceId !== hasSpanId ||
    (record.parentSpanId !== undefined && !hasSpanId)
  );
}

function readOptionalString(
  value: AttributeValue | undefined
): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function invalidPayload(): RendererOtelBridgeParseResult {
  return {
    ok: false,
    result: {
      ok: false,
      reason: RendererOtelExportFailureReason.InvalidPayload,
    },
  };
}
