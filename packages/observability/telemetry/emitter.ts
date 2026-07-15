import { log } from "../log";
import { redactTraceGatewaySessionId } from "../redact-correlation";
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

// Home-rooted absolute paths carry the OS username. Desktop clients relativize
// these before emitting (FEA-2702), but Desktop/API deployments are version-
// skewed: an older, already-installed Desktop build emits
// diagnostics.decisionTableVerification with absolute telemetryFilePath /
// workdir / decisionTablePath / readError values that never went through the
// producer-side relativization. This server-side fallback collapses the
// home-directory prefix to `~/` so the username never egresses regardless of
// client version. Matches POSIX `/Users/<name>/…`, `/home/<name>/…`,
// `/root/…`, and Windows `C:\Users\<name>\…` (both slash styles).
const HOME_ROOTED_PATH_RE =
  /(?:\/(?:Users|home)\/[^/\s"']+|\/root|[A-Za-z]:[\\/]Users[\\/][^\\/\s"']+)([\\/][^\s"']*)?/g;

function redactHomeRootedPaths(value: string): string {
  return value.replace(
    HOME_ROOTED_PATH_RE,
    (_match, tail: string | undefined) => (tail ? `~${tail}` : "~")
  );
}

function sanitizeTextTail(value: string): string {
  // Bound the regex input before running CREDENTIAL_RE. The schema accepts
  // logTail/stderrTail as unbounded strings, and CREDENTIAL_RE contains nested
  // quantifiers (e.g. `(?:[a-z0-9]+[_-])*token`) that can backtrack for seconds
  // on a long, credential-free line built from repeated word/hyphen segments —
  // a skewed/malformed desktop client could tie up the API telemetry handler.
  // The output is truncated to LOG_TAIL_MAX_BYTES anyway, so pre-truncating the
  // whole value (plus capping each line) leaves observable output unchanged for
  // well-formed inputs while making the scan cost linear in ~4 KiB.
  const bounded = truncateUtf8(value, LOG_TAIL_MAX_BYTES);
  const stripped = bounded.replaceAll(ANSI_RE, "");
  const lines = stripped.split("\n");
  const filtered = lines.filter((line: string) => {
    // Cap the per-line window fed to the regex so a single pathological line
    // (no newlines, all within the 4 KiB budget) still can't backtrack for long.
    const scanned =
      line.length > LOG_TAIL_MAX_BYTES
        ? line.slice(0, LOG_TAIL_MAX_BYTES)
        : line;
    const lower = scanned.toLowerCase();
    const matchesSubstring = CREDENTIAL_PATTERNS.some((pattern) =>
      lower.includes(pattern.toLowerCase())
    );
    // Share the stronger regex used by sanitizeLoopPerfText so both scrubbers
    // catch the same credentials (e.g. `password:`, `ghp_*`, `xox*-*`,
    // space-separated `token abc`) instead of only the weak substring list.
    return !(matchesSubstring || CREDENTIAL_RE.test(scanned));
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
 * Server-side fallback for the decisionTableVerification diagnostics union.
 * The Desktop producer relativizes these path fields before emitting
 * (FEA-2702), but a version-skewed older Desktop client can still send absolute
 * home-rooted telemetryFilePath / workdir / decisionTablePath / readError
 * values. Collapse any home-directory prefix so the OS username never egresses,
 * independent of client version.
 */
function sanitizeDecisionTableVerificationDiagnostics(
  verification: NonNullable<TelemetryDiagnostics["decisionTableVerification"]>
): NonNullable<TelemetryDiagnostics["decisionTableVerification"]> {
  const sanitized = { ...verification };

  if (typeof sanitized.telemetryFilePath === "string") {
    sanitized.telemetryFilePath = redactHomeRootedPaths(
      sanitized.telemetryFilePath
    );
  }
  if (
    sanitized.telemetryStatus === "reported" &&
    typeof sanitized.workdir === "string"
  ) {
    sanitized.workdir = redactHomeRootedPaths(sanitized.workdir);
    sanitized.decisionTablePath = redactHomeRootedPaths(
      sanitized.decisionTablePath
    );
  }
  if (
    sanitized.telemetryStatus === "missing" &&
    typeof sanitized.readError === "string"
  ) {
    sanitized.readError = redactHomeRootedPaths(sanitized.readError);
  }

  return sanitized;
}

/**
 * Sanitize diagnostics from a desktop-originated event:
 * - Truncate logTail/stderrTail to at most LOG_TAIL_MAX_BYTES bytes
 * - Truncate diagnostics.pluginUpdate.stderrTail with the same credential scrubber
 * - Strip lines containing credential patterns
 * - Allowlist spawnMeta.envSnapshot to only safe env var keys
 * - Keep only descriptor fields for outbound-network diagnostics
 * - Collapse home-rooted absolute paths in decisionTableVerification (server-
 *   side fallback for version-skewed older Desktop clients — FEA-2702)
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

  if (sanitized.decisionTableVerification) {
    sanitized.decisionTableVerification =
      sanitizeDecisionTableVerificationDiagnostics(
        sanitized.decisionTableVerification
      );
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
  // Redact gatewaySessionId before validating/emitting: the validated trace is
  // logged as-is, so the raw session token must never reach the sink. The schema
  // accepts the redaction hash (see gatewaySessionIdSchema).
  const traceResult = telemetryTraceContextSchema.safeParse(
    redactTraceGatewaySessionId(trace)
  );
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
    // gatewaySessionId must never be logged raw; this payload is emitted directly.
    trace: redactTraceGatewaySessionId(event.trace),
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
