/**
 * @file Builders that turn one decoded Claude Code OTLP LogRecord into a
 * normalized signal.
 *
 * Split out of `claude-code-otel-normalizer.ts` when ISS-7352 added capture
 * list A and B: that file owns which exports are Claude's, how signals
 * aggregate, and which collisions are refused; this one owns the per-event
 * shaping. The log BODY is never read by anything here — on some event types it
 * carries prompt or response text, and the event name lives in an attribute.
 */

import {
  ClaudeCodeOtelAttributeKey,
  eventTimeMsFrom,
  isoFromEpochMs,
  readBoolean,
  readHttpStatusCode,
  readNonNegativeInteger,
  readNonNegativeNumber,
  readOptionalCount,
  readString,
  readTokenCount,
  withoutUndefinedValues,
} from "./claude-code-otel-attributes.js";
import { toolResultSignalFrom } from "./claude-code-otel-counter-signals.js";
import { eventCorrelationFrom } from "./claude-code-otel-event-correlation.js";
import {
  authEventSignalFrom,
  mcpServerConnectionSignalFrom,
  pluginEventSignalFrom,
} from "./claude-code-otel-lifecycle-signals.js";
import {
  ClaudeCodeErrorKind,
  type ClaudeCodeOtelSideTableSignal,
  ClaudeCodeOtelSignalType,
  ClaudeCodePermissionDecision,
  ClaudeCodePermissionSource,
  ClaudeCodePluginLifecycle,
} from "./claude-code-otel-signal-contract.js";

/**
 * Values are the BARE `event.name` attribute Claude Code stamps, not the
 * qualified `claude_code.api_request` its docs headline. `readEventName` in the
 * normalizer accepts either spelling.
 */
export const ClaudeCodeOtelEventName = {
  ApiRequest: "api_request",
  ToolDecision: "tool_decision",
  /** ISS-7352 item A. */
  ApiError: "api_error",
  ApiRefusal: "api_refusal",
  InternalError: "internal_error",
  /** ISS-7352 item B. */
  PermissionModeChanged: "permission_mode_changed",
  /** ISS-7352 item C. */
  McpServerConnection: "mcp_server_connection",
  Auth: "auth",
  PluginInstalled: "plugin_installed",
  PluginLoaded: "plugin_loaded",
  /** ISS-7352 item G. */
  ToolResult: "tool_result",
} as const;
export type ClaudeCodeOtelEventName =
  (typeof ClaudeCodeOtelEventName)[keyof typeof ClaudeCodeOtelEventName];

/** `claude_code.tool_decision`'s `decision` attribute (published closed set). */
export const ClaudeCodeToolDecision = {
  Accept: "accept",
  Reject: "reject",
} as const;
export type ClaudeCodeToolDecision =
  (typeof ClaudeCodeToolDecision)[keyof typeof ClaudeCodeToolDecision];

const TOOL_DECISION_TO_PERMISSION_DECISION: Record<
  ClaudeCodeToolDecision,
  ClaudeCodePermissionDecision
> = {
  [ClaudeCodeToolDecision.Accept]: ClaudeCodePermissionDecision.Allow,
  [ClaudeCodeToolDecision.Reject]: ClaudeCodePermissionDecision.Deny,
};

const PERMISSION_SOURCES = new Set<string>(
  Object.values(ClaudeCodePermissionSource)
);

/**
 * Maps a recognized log event name to the error kind it records, if any.
 *
 * A Map rather than an object literal: the lookup key is an event name read
 * straight off an external export, and `{}["constructor"]` is not `undefined`.
 */
const EVENT_NAME_TO_ERROR_KIND = new Map<string, ClaudeCodeErrorKind>([
  [ClaudeCodeOtelEventName.ApiError, ClaudeCodeErrorKind.ApiError],
  [ClaudeCodeOtelEventName.ApiRefusal, ClaudeCodeErrorKind.ApiRefusal],
  [ClaudeCodeOtelEventName.InternalError, ClaudeCodeErrorKind.InternalError],
]);

/** ISS-7352 item C — which plugin lifecycle moment each event name records. */
const EVENT_NAME_TO_PLUGIN_LIFECYCLE = new Map<
  string,
  ClaudeCodePluginLifecycle
>([
  [
    ClaudeCodeOtelEventName.PluginInstalled,
    ClaudeCodePluginLifecycle.Installed,
  ],
  [ClaudeCodeOtelEventName.PluginLoaded, ClaudeCodePluginLifecycle.Loaded],
]);

/** Every log event name this lane claims. Anything else is out of scope. */
const RECOGNIZED_EVENT_NAMES = new Set<string>(
  Object.values(ClaudeCodeOtelEventName)
);

export function isRecognizedEventName(value: string | undefined): boolean {
  return value !== undefined && RECOGNIZED_EVENT_NAMES.has(value);
}

/**
 * The signal a log record carries, or `null` when this lane does not claim the
 * event or the record could not be turned into a row.
 */
export function logSignalFor(
  eventName: string | undefined,
  attributes: Record<string, unknown>,
  record: Record<string, unknown>
): ClaudeCodeOtelSideTableSignal | null {
  if (eventName === ClaudeCodeOtelEventName.ApiRequest) {
    return apiRequestSignalFrom(attributes, record);
  }
  if (eventName === ClaudeCodeOtelEventName.ToolDecision) {
    return toolDecisionSignalFrom(attributes, record);
  }
  if (eventName === ClaudeCodeOtelEventName.PermissionModeChanged) {
    return permissionModeChangeSignalFrom(attributes, record);
  }
  if (eventName === ClaudeCodeOtelEventName.McpServerConnection) {
    return mcpServerConnectionSignalFrom(attributes, record);
  }
  if (eventName === ClaudeCodeOtelEventName.Auth) {
    return authEventSignalFrom(attributes, record);
  }
  if (eventName === ClaudeCodeOtelEventName.ToolResult) {
    return toolResultSignalFrom(attributes, record);
  }
  if (eventName === undefined) {
    return null;
  }
  const lifecycle = EVENT_NAME_TO_PLUGIN_LIFECYCLE.get(eventName);
  if (lifecycle !== undefined) {
    return pluginEventSignalFrom(lifecycle, attributes, record);
  }
  const errorKind = EVENT_NAME_TO_ERROR_KIND.get(eventName);
  if (errorKind !== undefined) {
    return errorEventSignalFrom(errorKind, attributes, record);
  }
  return null;
}

function apiRequestSignalFrom(
  attributes: Record<string, unknown>,
  record: Record<string, unknown>
): ClaudeCodeOtelSideTableSignal | null {
  const sessionId = readString(
    attributes,
    ClaudeCodeOtelAttributeKey.SessionId
  );
  const model = readString(attributes, ClaudeCodeOtelAttributeKey.Model);
  const observedAtMs = eventTimeMsFrom(attributes, record);
  const durationMs = readNonNegativeInteger(
    attributes,
    ClaudeCodeOtelAttributeKey.DurationMs
  );
  const costUsd = readNonNegativeNumber(
    attributes,
    ClaudeCodeOtelAttributeKey.CostUsd
  );
  if (
    !(sessionId && model) ||
    observedAtMs === undefined ||
    durationMs === undefined ||
    costUsd === undefined
  ) {
    return null;
  }
  // `claude_code.api_request` is emitted once the request has completed and
  // carries its duration, so the start it belongs under is the completion
  // stamp less that duration. `started_at` is half the row's natural key, so
  // it has to be the request's own instant and not the export's.
  const startedAt = isoFromEpochMs(observedAtMs - durationMs);
  if (!startedAt) {
    return null;
  }
  const inputTokens = readTokenCount(
    attributes,
    ClaudeCodeOtelAttributeKey.InputTokens
  );
  const outputTokens = readTokenCount(
    attributes,
    ClaudeCodeOtelAttributeKey.OutputTokens
  );
  const cacheReadTokens = readTokenCount(
    attributes,
    ClaudeCodeOtelAttributeKey.CacheReadTokens
  );
  const cacheCreationTokens = readTokenCount(
    attributes,
    ClaudeCodeOtelAttributeKey.CacheCreationTokens
  );
  // ISS-7352 item D, GA half: the exact integer cost beside the float one.
  // `readOptionalCount` distinguishes ABSENT (an older Claude Code that never
  // stamps it — omitted, and the row still stands) from PRESENT-BUT-CORRUPT,
  // which fails the record like a corrupt token count below.
  const costUsdMicros = readOptionalCount(
    attributes,
    ClaudeCodeOtelAttributeKey.CostUsdMicros
  );
  // A present-but-corrupt count fails the whole record: a row is valid-or-
  // absent, never partially-corrupt, and a silent 0 here would understate usage
  // in a way no reader could detect.
  if (
    inputTokens === null ||
    outputTokens === null ||
    cacheReadTokens === null ||
    cacheCreationTokens === null ||
    costUsdMicros === null
  ) {
    return null;
  }
  return withoutUndefinedValues({
    type: ClaudeCodeOtelSignalType.ApiRequest,
    sessionId,
    model,
    startedAt,
    durationMs,
    costUsd,
    costUsdMicros,
    // ISS-7352 item F — the join back to Anthropic's own record of this
    // request. `started_at` is DERIVED (completion less duration, at ms
    // resolution), so the natural key is approximate in a way these ids are
    // not; they are what lets the collision guard tell a re-sent export from a
    // second request that happened to land on the same derived instant.
    requestId: readString(attributes, ClaudeCodeOtelAttributeKey.RequestId),
    clientRequestId: readString(
      attributes,
      ClaudeCodeOtelAttributeKey.ClientRequestId
    ),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    ...eventCorrelationFrom(attributes),
  });
}

function toolDecisionSignalFrom(
  attributes: Record<string, unknown>,
  record: Record<string, unknown>
): ClaudeCodeOtelSideTableSignal | null {
  const sessionId = readString(
    attributes,
    ClaudeCodeOtelAttributeKey.SessionId
  );
  const toolName = readString(attributes, ClaudeCodeOtelAttributeKey.ToolName);
  const observedAt = isoFromEpochMs(eventTimeMsFrom(attributes, record));
  const decision = readToolDecision(attributes);
  const source = readPermissionSource(attributes);
  if (!(sessionId && toolName && observedAt && decision && source)) {
    return null;
  }
  return withoutUndefinedValues({
    type: ClaudeCodeOtelSignalType.PermissionDecision,
    sessionId,
    toolName,
    observedAt,
    decision: TOOL_DECISION_TO_PERMISSION_DECISION[decision],
    source,
    // ISS-7352 item F / ISS-7481. `claude_code_permission_event` keys on
    // `(session, tool_name, observed_at)` at MILLISECOND resolution, so several
    // parallel auto-approved `Read`s land on one key and only one row can
    // survive. `tool_use_id` is the harness's own identifier for the
    // invocation, so a differing one PROVES two calls — it is what lets the
    // collision guard count the truncation instead of collapsing the pair as
    // one observation reported twice.
    toolUseId: readString(attributes, ClaudeCodeOtelAttributeKey.ToolUseId),
    ...eventCorrelationFrom(attributes),
  });
}

/**
 * ISS-7352 item B — a `permission_mode_changed` transition.
 *
 * Both ends are required. The session row already stores the mode a session
 * ended in, so a record naming only `to_mode` adds nothing; the transition IS
 * the pair. A record missing either end is refused rather than completed with
 * an invented "unknown" origin.
 */
function permissionModeChangeSignalFrom(
  attributes: Record<string, unknown>,
  record: Record<string, unknown>
): ClaudeCodeOtelSideTableSignal | null {
  const sessionId = readString(
    attributes,
    ClaudeCodeOtelAttributeKey.SessionId
  );
  const observedAt = isoFromEpochMs(eventTimeMsFrom(attributes, record));
  const fromMode = readString(attributes, ClaudeCodeOtelAttributeKey.FromMode);
  const toMode = readString(attributes, ClaudeCodeOtelAttributeKey.ToMode);
  if (!(sessionId && observedAt && fromMode && toMode)) {
    return null;
  }
  return withoutUndefinedValues({
    type: ClaudeCodeOtelSignalType.PermissionModeChange,
    sessionId,
    observedAt,
    fromMode,
    toMode,
    trigger: readString(attributes, ClaudeCodeOtelAttributeKey.Trigger),
    ...eventCorrelationFrom(attributes),
  });
}

/**
 * ISS-7352 item A — an `api_error`, `api_refusal` or `internal_error`.
 *
 * Only the session and the instant are required. The taxonomy attributes are
 * what varies by kind, and refusing a record because one was absent would lose
 * the fact that a failure happened at all — which is the signal this table
 * exists for. ABSENT therefore leaves a column NULL.
 *
 * PRESENT-BUT-INVALID is the opposite case and fails the whole record, the same
 * posture `api_request` takes with a corrupt token count: a row is
 * valid-or-absent, never partially-corrupt. Storing the rest of an event whose
 * `status_code` read `99999` would put a real-looking failure row in the table
 * with one field silently dropped, and no reader could tell.
 */
function errorEventSignalFrom(
  errorKind: ClaudeCodeErrorKind,
  attributes: Record<string, unknown>,
  record: Record<string, unknown>
): ClaudeCodeOtelSideTableSignal | null {
  const sessionId = readString(
    attributes,
    ClaudeCodeOtelAttributeKey.SessionId
  );
  const observedAt = isoFromEpochMs(eventTimeMsFrom(attributes, record));
  if (!(sessionId && observedAt)) {
    return null;
  }
  const statusCode = readHttpStatusCode(
    attributes,
    ClaudeCodeOtelAttributeKey.StatusCode
  );
  const attempt = readOptionalCount(
    attributes,
    ClaudeCodeOtelAttributeKey.Attempt
  );
  const durationMs = readOptionalCount(
    attributes,
    ClaudeCodeOtelAttributeKey.DurationMs
  );
  const serverFallbackHop = readOptionalCount(
    attributes,
    ClaudeCodeOtelAttributeKey.ServerFallbackHop
  );
  const hasCategory = readBoolean(
    attributes,
    ClaudeCodeOtelAttributeKey.HasCategory
  );
  const hasExplanation = readBoolean(
    attributes,
    ClaudeCodeOtelAttributeKey.HasExplanation
  );
  if (
    statusCode === null ||
    attempt === null ||
    durationMs === null ||
    serverFallbackHop === null ||
    hasCategory === null ||
    hasExplanation === null
  ) {
    return null;
  }
  return withoutUndefinedValues({
    type: ClaudeCodeOtelSignalType.ErrorEvent,
    errorKind,
    sessionId,
    observedAt,
    model: readString(attributes, ClaudeCodeOtelAttributeKey.Model),
    statusCode,
    attempt,
    errorCategory: readString(
      attributes,
      ClaudeCodeOtelAttributeKey.ErrorCategory
    ),
    durationMs,
    requestId: readString(attributes, ClaudeCodeOtelAttributeKey.RequestId),
    clientRequestId: readString(
      attributes,
      ClaudeCodeOtelAttributeKey.ClientRequestId
    ),
    refusalCategory: readString(
      attributes,
      ClaudeCodeOtelAttributeKey.RefusalCategory
    ),
    serverFallbackHop,
    hasCategory,
    hasExplanation,
    errorName: readString(attributes, ClaudeCodeOtelAttributeKey.ErrorName),
    errorCode: readString(attributes, ClaudeCodeOtelAttributeKey.ErrorCode),
    ...eventCorrelationFrom(attributes),
  });
}

function readToolDecision(
  attributes: Record<string, unknown>
): ClaudeCodeToolDecision | undefined {
  const value = readString(attributes, ClaudeCodeOtelAttributeKey.Decision);
  if (
    value === ClaudeCodeToolDecision.Accept ||
    value === ClaudeCodeToolDecision.Reject
  ) {
    return value;
  }
  return undefined;
}

/**
 * The decision's `source`, degrading an unrecognized one to
 * `ClaudeCodePermissionSource.Unknown` rather than dropping the record.
 *
 * Claude Code is a version-skewed external producer that can add a source at
 * any time. The allow/deny decision is the row's point and we understand it
 * fully; losing it over one attribute we do not recognize is the worse failure.
 * An ABSENT source still fails the record — that is a malformed event, not a
 * new one.
 */
function readPermissionSource(
  attributes: Record<string, unknown>
): ClaudeCodePermissionSource | undefined {
  const value = readString(attributes, ClaudeCodeOtelAttributeKey.Source);
  if (value === undefined) {
    return undefined;
  }
  return isPermissionSource(value) ? value : ClaudeCodePermissionSource.Unknown;
}

function isPermissionSource(
  value: string
): value is ClaudeCodePermissionSource {
  return PERMISSION_SOURCES.has(value);
}
