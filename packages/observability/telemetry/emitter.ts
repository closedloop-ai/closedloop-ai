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
const LOOP_PERF_COMMAND_MAX_BYTES = 64;
const LOOP_PERF_PARSE_FAILURE_RAW_BYTES_MAX_BYTES = 1024;

const CREDENTIAL_PATTERNS = [
  "sk_",
  "sk-",
  "token=",
  "password=",
  "authorization:",
  "bearer ",
  "api_key=",
  "secret=",
];

const SAFE_CATEGORY_RE = /^[a-zA-Z0-9._]{1,64}$/;

// biome-ignore lint/complexity/useRegexLiterals: Control characters (\u001b, \u009b) required for ANSI stripping
const ANSI_RE = new RegExp(
  String.raw`[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]`,
  "g"
);
// biome-ignore lint/complexity/useRegexLiterals: Control character ranges are built from escapes for loopPerf control stripping
const CONTROL_CHARS_RE = new RegExp(
  String.raw`[\u0000-\u001f\u007f-\u009f]`,
  "g"
);
const CREDENTIAL_RE =
  /(?:["']?\b(?:authorization|password|(?:[a-z0-9]+[_-])*token|(?:[a-z0-9]+[_-])*api[_-]?key|(?:[a-z0-9]+[_-])*secret)\b["']?\s*(?::|=|\s+)\s*["']?\S+|\bbearer\s+\S+|\bsk[-_][a-z0-9]+|\bgh[pousr]_[a-z0-9_]+|\bxox[abprs]-[a-z0-9-]+)/i;

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

const SAFE_ENV_KEYS = new Set(["NODE_ENV"]);
const SAFE_ENV_PREFIXES = ["CLAUDE_CODE_USE_"];

function sanitizeTextTail(value: string): string {
  const stripped = value.replaceAll(ANSI_RE, "");
  const lines = stripped.split("\n");
  const filtered = lines.filter((line: string) => {
    const lower = line.toLowerCase();
    return !CREDENTIAL_PATTERNS.some((pattern) =>
      lower.includes(pattern.toLowerCase())
    );
  });
  const joined = filtered.join("\n");
  return truncateUtf8(joined, LOG_TAIL_MAX_BYTES);
}

function sanitizeLoopPerfText(value: string, maxBytes: number): string {
  const stripped = value
    .replaceAll(ANSI_RE, "")
    .replaceAll(CONTROL_CHARS_RE, "");
  const sanitized = CREDENTIAL_RE.test(stripped) ? "[redacted]" : stripped;
  return truncateUtf8(sanitized, maxBytes);
}

function sanitizeLoopPerfDiagnostics(
  loopPerf: NonNullable<TelemetryDiagnostics["loopPerf"]>
): NonNullable<TelemetryDiagnostics["loopPerf"]> {
  const sanitizedLoopPerf = { ...loopPerf };

  if (typeof sanitizedLoopPerf.command === "string") {
    sanitizedLoopPerf.command = sanitizeLoopPerfText(
      sanitizedLoopPerf.command,
      LOOP_PERF_COMMAND_MAX_BYTES
    );
  }

  if (typeof sanitizedLoopPerf.rawBytes === "string") {
    sanitizedLoopPerf.rawBytes = sanitizeLoopPerfText(
      sanitizedLoopPerf.rawBytes,
      LOOP_PERF_PARSE_FAILURE_RAW_BYTES_MAX_BYTES
    );
  }

  return sanitizedLoopPerf;
}

/**
 * Sanitize diagnostics from a desktop-originated event:
 * - Truncate logTail/stderrTail to at most LOG_TAIL_MAX_BYTES bytes
 * - Truncate diagnostics.pluginUpdate.stderrTail with the same credential scrubber
 * - Strip lines containing credential patterns
 * - Allowlist spawnMeta.envSnapshot to only safe env var keys
 * - Keep only descriptor fields for outbound-network diagnostics
 */
export function sanitizeDesktopTelemetryDiagnostics(
  diagnostics: TelemetryDiagnostics | undefined
): TelemetryDiagnostics | undefined {
  if (diagnostics === undefined) {
    return undefined;
  }

  const sanitized: TelemetryDiagnostics = { ...diagnostics };

  if (typeof sanitized.logTail === "string") {
    sanitized.logTail = sanitizeTextTail(sanitized.logTail);
  }

  if (typeof sanitized.stderrTail === "string") {
    sanitized.stderrTail = sanitizeTextTail(sanitized.stderrTail);
  }

  if (typeof sanitized.pluginUpdate?.stderrTail === "string") {
    sanitized.pluginUpdate = {
      ...sanitized.pluginUpdate,
      stderrTail: sanitizeTextTail(sanitized.pluginUpdate.stderrTail),
    };
  }

  if (sanitized.spawnMeta?.envSnapshot) {
    const filtered: Record<string, string> = {};
    for (const [key, value] of Object.entries(
      sanitized.spawnMeta.envSnapshot
    )) {
      if (
        SAFE_ENV_KEYS.has(key) ||
        SAFE_ENV_PREFIXES.some((p) => key.startsWith(p))
      ) {
        filtered[key] = value;
      }
    }
    sanitized.spawnMeta = { ...sanitized.spawnMeta, envSnapshot: filtered };
  }

  if (sanitized.outboundNetwork) {
    const outboundNetwork = sanitized.outboundNetwork;
    sanitized.outboundNetwork = {
      surface: outboundNetwork.surface,
      decision: outboundNetwork.decision,
      reason: outboundNetwork.reason,
      destinationClass: outboundNetwork.destinationClass,
      ...(outboundNetwork.protocol !== undefined && {
        protocol: outboundNetwork.protocol,
      }),
      ...(outboundNetwork.hostname !== undefined && {
        hostname: outboundNetwork.hostname,
      }),
      ...(outboundNetwork.port !== undefined && { port: outboundNetwork.port }),
      ...(outboundNetwork.statusCode !== undefined && {
        statusCode: outboundNetwork.statusCode,
      }),
    };
  }

  if (sanitized.loopPerf) {
    sanitized.loopPerf = sanitizeLoopPerfDiagnostics(sanitized.loopPerf);
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
