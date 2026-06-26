import { AppExceptionOrigin } from "@closedloop-ai/telemetry-contract/app-exception-origin";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import type { AttributeValue } from "@opentelemetry/api";
import { z } from "zod";
import { sanitizeDesktopExceptionAttributes } from "./exception-sanitizer.js";
import {
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
} from "./renderer-otel-bridge-constants.js";
import { containsControlCharacter } from "./renderer-otel-bridge-utils.js";

export type RendererOtelBridgeParseResult =
  | { ok: true; payload: RendererOtelBridgePayload }
  | { ok: false; result: RendererOtelExportResult };

const SENSITIVE_KEY_PATTERN =
  /(api[_-]?key|authorization|body|cwd|device\.id|endpoint|error|file|home|host|installation|org|path|prompt|resource|session|stack|token|url|user)/i;
const FILE_PATH_VALUE_PATTERN =
  /(?:^|[\s"'])((?:\/(?!\/)[^\s"']+|\\+[^\s"']*|[A-Za-z]:[\\/][^\s"']*|~\/[^\s"']*))/;
const RELATIVE_PATH_VALUE_PATTERN =
  /(?:^|[\s"'])((?:\.{1,2}[\\/]|[A-Za-z0-9._-]+[\\/])[^\s"']*)/;
const URL_VALUE_PATTERN = /\b(?:https?:\/\/|localhost\b|127\.0\.0\.1\b)/i;
const SECRET_VALUE_PATTERN =
  /\b(?:bearer\s+[A-Za-z0-9._~+/-]{12,}=*|github_pat_[A-Za-z0-9_]{20,}|gh[opsu]_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{20,}|re_[A-Za-z0-9]{10,}|sk-(?:proj-)?[A-Za-z0-9_-]{6,}|sk_(?:live|test)_[A-Za-z0-9]{6,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/i;
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

const instrumentationScopeSchema = z
  .object({
    name: z.string(),
    version: z.string().optional(),
  })
  .strict();

const bridgeRecordSchema = z
  .object({
    signal: z.enum([
      DesktopOtelSignal.Trace,
      DesktopOtelSignal.Metric,
      DesktopOtelSignal.Log,
    ]),
    instrumentationScope: instrumentationScopeSchema.optional(),
    timestampUnixNano: z.string().optional(),
    name: z.string().optional(),
    value: attributeValueSchema.optional(),
    attributes: z.record(z.string(), attributeValueSchema).optional(),
    droppedAttributesCount: z.number().int().nonnegative().optional(),
    droppedEventsCount: z.number().int().nonnegative().optional(),
    droppedLinksCount: z.number().int().nonnegative().optional(),
  })
  .strict();

const bridgePayloadSchema = z
  .object({
    records: z
      .array(bridgeRecordSchema)
      .min(1)
      .max(RENDERER_OTEL_MAX_RECORDS_PER_BATCH),
  })
  .strict();

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
  const value = sanitizeAttributeValue(record.value);
  if (record.name !== undefined && !name) {
    return null;
  }
  if (record.timestampUnixNano !== undefined && !timestampUnixNano) {
    return null;
  }
  if (record.instrumentationScope !== undefined && !instrumentationScope) {
    return null;
  }
  if (record.attributes !== undefined && !attributes) {
    return null;
  }
  if (record.value !== undefined && value === null) {
    return null;
  }
  const sanitizedValue = value === null ? undefined : value;

  return {
    signal: record.signal,
    ...(instrumentationScope ? { instrumentationScope } : {}),
    ...(timestampUnixNano ? { timestampUnixNano } : {}),
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

function sanitizeExceptionRecord(
  record: z.infer<typeof bridgeRecordSchema>
): RendererOtelBridgeRecord | null {
  if (
    record.signal !== DesktopOtelSignal.Log ||
    record.name !== "exception" ||
    record.value !== undefined ||
    record.droppedEventsCount !== undefined ||
    record.droppedLinksCount !== undefined
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

  return {
    signal: DesktopOtelSignal.Log,
    name: "exception",
    attributes,
    ...(instrumentationScope ? { instrumentationScope } : {}),
    ...(timestampUnixNano ? { timestampUnixNano } : {}),
    ...(record.droppedAttributesCount === undefined
      ? {}
      : { droppedAttributesCount: record.droppedAttributesCount }),
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
// run through SENSITIVE_KEY_PATTERN or the FILE/RELATIVE path patterns: doing so
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
    !URL_VALUE_PATTERN.test(value) &&
    !SECRET_VALUE_PATTERN.test(value)
  );
}

function isSafeString(value: string): boolean {
  return (
    Buffer.byteLength(value) <= RENDERER_OTEL_MAX_STRING_BYTES &&
    !SENSITIVE_KEY_PATTERN.test(value) &&
    !FILE_PATH_VALUE_PATTERN.test(value) &&
    !RELATIVE_PATH_VALUE_PATTERN.test(value) &&
    !URL_VALUE_PATTERN.test(value) &&
    !SECRET_VALUE_PATTERN.test(value)
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
  return record.signal === DesktopOtelSignal.Log && record.name === "exception";
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
