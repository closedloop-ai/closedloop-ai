import { log } from "../log";
import { truncateUtf8 } from "../truncate-utf8";
import type {
  DesktopTelemetryEvent,
  TelemetryDiagnostics,
  TelemetryTraceContext,
} from "./schema";
import {
  desktopTelemetryEventSchema,
  TelemetryCategory,
  TelemetrySeverity,
  telemetryDiagnosticsSchema,
  telemetryTraceContextSchema,
} from "./schema";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOG_TAIL_MAX_BYTES = 4096; // 4 KiB

const CREDENTIAL_PATTERNS = ["sk_", "token=", "password=", "authorization:"];

const SAFE_CATEGORY_RE = /^[a-zA-Z0-9._]{1,64}$/;

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

/**
 * Sanitize diagnostics from a desktop-originated event:
 * - Truncate logTail to at most LOG_TAIL_MAX_BYTES bytes
 * - Strip lines containing credential patterns
 */
export function sanitizeDesktopTelemetryDiagnostics(
  diagnostics: TelemetryDiagnostics | undefined
): TelemetryDiagnostics | undefined {
  if (diagnostics === undefined) {
    return undefined;
  }

  const sanitized: TelemetryDiagnostics = { ...diagnostics };

  if (typeof sanitized.logTail === "string") {
    const lines = sanitized.logTail.split("\n");
    const filtered = lines.filter((line: string) => {
      const lower = line.toLowerCase();
      return !CREDENTIAL_PATTERNS.some((pattern) =>
        lower.includes(pattern.toLowerCase())
      );
    });
    const joined = filtered.join("\n");

    sanitized.logTail = truncateUtf8(joined, LOG_TAIL_MAX_BYTES);
  }

  return sanitized;
}

// ---------------------------------------------------------------------------
// Internal emit helper
// ---------------------------------------------------------------------------

type TelemetryEventPayload = {
  schemaVersion: string;
  category: string;
  severity: string;
  timestamp: string;
  trace: TelemetryTraceContext;
  diagnostics?: TelemetryDiagnostics;
  message?: string;
  errorClass?: string;
};

function logAtSeverity(severity: string, json: string): void {
  if (severity === TelemetrySeverity.Error) {
    log.error(json);
  } else if (severity === TelemetrySeverity.Warn) {
    log.warn(json);
  } else {
    log.info(json);
  }
}

function emitEvent(payload: TelemetryEventPayload): void {
  logAtSeverity(payload.severity, JSON.stringify(payload));
}

// ---------------------------------------------------------------------------
// Validation-failed emitter — never includes message or received values
// ---------------------------------------------------------------------------

type SafeZodIssue = {
  path: PropertyKey[];
  code: string;
  expected?: unknown;
};

export function buildValidationFailedPayload(
  rawCategory: unknown,
  issues: SafeZodIssue[]
): Record<string, unknown> {
  const safeIssues = issues.map((issue) => ({
    path: issue.path,
    code: issue.code,
    expected:
      "expected" in issue
        ? (issue as { expected: unknown }).expected
        : undefined,
  }));

  const categoryStr =
    typeof rawCategory === "string" && SAFE_CATEGORY_RE.test(rawCategory)
      ? rawCategory
      : undefined;

  const payload: Record<string, unknown> = {
    schemaVersion: "1",
    category: TelemetryCategory.TelemetryValidationFailed,
    severity: TelemetrySeverity.Warn,
    timestamp: new Date().toISOString(),
    issues: safeIssues,
  };

  if (categoryStr !== undefined) {
    payload.failedCategory = categoryStr;
  }

  return payload;
}

function emitValidationFailed(
  rawCategory: unknown,
  issues: SafeZodIssue[]
): void {
  log.warn(JSON.stringify(buildValidationFailedPayload(rawCategory, issues)));
}

// ---------------------------------------------------------------------------
// Shared validation + emit for server-originated events
// ---------------------------------------------------------------------------

type ServerEventOptions = {
  severity?: string;
  diagnostics?: TelemetryDiagnostics;
  message?: string;
  errorClass?: string;
};

/**
 * Validate trace and diagnostics, then emit a server-originated telemetry event.
 * On validation failure, emits telemetry.validation_failed instead.
 */
function emitValidatedServerEvent(
  category: string,
  trace: Partial<TelemetryTraceContext>,
  defaultSeverity: string,
  options?: ServerEventOptions
): void {
  const traceResult = telemetryTraceContextSchema.safeParse(trace);
  if (!traceResult.success) {
    emitValidationFailed(category, traceResult.error.issues);
    return;
  }

  let diagnostics = options?.diagnostics;
  if (diagnostics !== undefined) {
    const diagResult = telemetryDiagnosticsSchema.safeParse(diagnostics);
    if (!diagResult.success) {
      emitValidationFailed(category, diagResult.error.issues);
      return;
    }
    diagnostics = diagResult.data;
  }

  emitEvent({
    schemaVersion: traceResult.data.schemaVersion,
    category,
    severity: options?.severity ?? defaultSeverity,
    timestamp: new Date().toISOString(),
    trace: traceResult.data,
    ...(diagnostics !== undefined && { diagnostics }),
    ...(options?.message !== undefined && { message: options.message }),
    ...(options?.errorClass !== undefined && {
      errorClass: options.errorClass,
    }),
  });
}

// ---------------------------------------------------------------------------
// Public emitter functions
// ---------------------------------------------------------------------------

/**
 * Emit a command lifecycle telemetry event (server-originated).
 * Validates the trace context before emitting. On failure, emits
 * telemetry.validation_failed with sanitized ZodIssue fields only.
 */
export function emitCommandLifecycleEvent(
  category: string,
  trace: Partial<TelemetryTraceContext>,
  options?: {
    severity?: string;
    diagnostics?: TelemetryDiagnostics;
    message?: string;
    errorClass?: string;
  }
): void {
  emitValidatedServerEvent(category, trace, TelemetrySeverity.Info, options);
}

/**
 * Emit a connection state telemetry event (server-originated).
 * Validates the trace context before emitting. On failure, emits
 * telemetry.validation_failed with sanitized ZodIssue fields only.
 */
export function emitConnectionStateEvent(
  category: string,
  trace: Partial<TelemetryTraceContext>,
  options?: {
    severity?: string;
    message?: string;
  }
): void {
  emitValidatedServerEvent(category, trace, TelemetrySeverity.Info, options);
}

/**
 * Emit an error telemetry event (server-originated).
 * Validates the trace context before emitting. On failure, emits
 * telemetry.validation_failed with sanitized ZodIssue fields only.
 */
export function emitErrorEvent(
  category: string,
  trace: Partial<TelemetryTraceContext>,
  options?: {
    severity?: string;
    diagnostics?: TelemetryDiagnostics;
    message?: string;
    errorClass?: string;
  }
): void {
  emitValidatedServerEvent(category, trace, TelemetrySeverity.Error, options);
}

/**
 * Emit a metric telemetry event (server-originated).
 * Validates the trace context before emitting. On failure, emits
 * telemetry.validation_failed with sanitized ZodIssue fields only.
 */
export function emitMetricEvent(
  category: string,
  trace: Partial<TelemetryTraceContext>,
  options?: {
    severity?: string;
    diagnostics?: TelemetryDiagnostics;
    message?: string;
  }
): void {
  emitValidatedServerEvent(category, trace, TelemetrySeverity.Info, options);
}

/**
 * Emit a desktop-originated telemetry event. Validates the incoming wire
 * format using desktopTelemetryEventSchema, applies
 * sanitizeDesktopTelemetryDiagnostics to scrub credentials and truncate
 * logTail, then emits the event. Omits loopCommand body fields.
 *
 * On validation failure, emits telemetry.validation_failed with sanitized
 * ZodIssue fields only (no message/received values).
 */
export function buildDesktopTelemetryPayload(
  rawEvent: unknown
): Record<string, unknown> {
  const parseResult = desktopTelemetryEventSchema.safeParse(rawEvent);
  if (!parseResult.success) {
    const rawCategory =
      rawEvent !== null &&
      typeof rawEvent === "object" &&
      "category" in rawEvent
        ? (rawEvent as { category: unknown }).category
        : undefined;
    return buildValidationFailedPayload(rawCategory, parseResult.error.issues);
  }

  const event: DesktopTelemetryEvent = parseResult.data;
  const sanitizedDiagnostics = sanitizeDesktopTelemetryDiagnostics(
    event.diagnostics
  );

  return {
    schemaVersion: event.schemaVersion,
    category: event.category,
    severity: event.severity,
    timestamp: event.timestamp,
    trace: event.trace,
    ...(sanitizedDiagnostics !== undefined && {
      diagnostics: sanitizedDiagnostics,
    }),
    ...(event.message !== undefined && { message: event.message }),
    ...(event.errorClass !== undefined && { errorClass: event.errorClass }),
  };
}

/**
 * Must NOT be called from apps/api or apps/relay for desktop-forwarded events. Desktop events MUST
 * flow through handleTelemetryEvent() so origin is enriched to Origin.Desktop; this Path B
 * stringified-message emitter would leave origin at the server's ORIGIN value.
 */
export function emitDesktopTelemetryEvent(rawEvent: unknown): void {
  const payload = buildDesktopTelemetryPayload(rawEvent);
  const severity =
    typeof payload.severity === "string"
      ? payload.severity
      : TelemetrySeverity.Info;
  logAtSeverity(severity, JSON.stringify(payload));
}
