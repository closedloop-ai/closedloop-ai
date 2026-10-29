/**
 * @file ISS-7352 capture list D — the beta `claude_code.llm_request` span, the
 * only carrier of `ttft_ms`, `stop_reason`, `gen_ai.response.finish_reasons` and
 * `response.has_tool_call`.
 *
 * This module is the CAPTURE side of the beta tier and nothing more. Spans only
 * exist when the user has set `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`; nothing
 * in this lane sets it or writes a user's Claude settings, so with the beta off
 * no span arrives and the table stays empty. Turning it on is a separate scope.
 *
 * Only `claude_code.llm_request` is claimed. Its sibling spans (`interaction`,
 * `tool`, `tool.execution`, `blocked_on_user`, `hook`) carry none of item D's
 * attributes, and this lane already claims a subset of the published signals
 * rather than all of them.
 *
 * A span's `status.message` and its span EVENTS are never read. `status.message`
 * is free-text error content and a `tool.output` span event carries request and
 * response bodies under `OTEL_LOG_TOOL_CONTENT=1`. The operator's 2026-09-11
 * ruling is that the error message attribute is not captured — only that there
 * WAS an error message — so no substring, first line, truncation, hash or
 * "sanitized" rendering of it is taken, and no classification is derived by
 * reading it. The string never enters a signal, and the table this lane adds
 * carries no column built from it.
 */

import { decodeOtlpBytesToHex } from "../otlp/decode-utilities.js";
import {
  ClaudeCodeOtelAttributeKey,
  isoFromUnixNano,
  readBoolean,
  readHttpStatusCode,
  readOptionalCount,
  readOptionalString,
  readString,
  readStringList,
  readTokenCount,
  withoutUndefinedValues,
} from "./claude-code-otel-attributes.js";
import { ClaudeCodeAttributionAttributeKey } from "./claude-code-otel-attribution.js";
import {
  type ClaudeCodeOtelSideTableSignal,
  ClaudeCodeOtelSignalType,
} from "./claude-code-otel-signal-contract.js";

/**
 * The span names this lane claims. Fully qualified, like the metric names and
 * unlike the bare `event.name` values: a span carries its producer in its own
 * name, which is also what identifies a traces container as Claude's.
 */
export const ClaudeCodeOtelSpanName = {
  LlmRequest: "claude_code.llm_request",
} as const;
export type ClaudeCodeOtelSpanName =
  (typeof ClaudeCodeOtelSpanName)[keyof typeof ClaudeCodeOtelSpanName];

/** Whether a span name is one this lane claims. Anything else is out of scope. */
export function isRecognizedSpanName(value: unknown): boolean {
  return value === ClaudeCodeOtelSpanName.LlmRequest;
}

/**
 * The signal one decoded span carries, or `null` when it could not be turned
 * into a row. The caller has already claimed the span by name
 * ({@link isRecognizedSpanName}); this does not re-check it.
 *
 * Only the session, the trace/span identity and the start instant are required.
 * Everything the span MEASURES is optional and left NULL when absent, because
 * the tier is explicitly beta: an attribute it stops stamping must cost that
 * column, not the whole request. A PRESENT-BUT-INVALID value still fails the
 * record — the same valid-or-absent rule the GA readers apply — so a `ttft_ms`
 * of `-1` is refused rather than stored as a real observation. An EMPTY value
 * (a blank string, a `finish_reasons` with no members) is absent, not invalid,
 * matching what the GA readers make of a blank.
 */
export function spanSignalFor(
  span: Record<string, unknown>,
  attributes: Record<string, unknown>
): ClaudeCodeOtelSideTableSignal | null {
  const sessionId = readString(
    attributes,
    ClaudeCodeOtelAttributeKey.SessionId
  );
  const traceId = decodeOtlpBytesToHex(span.traceId, { bytes: "buffer" });
  const spanId = decodeOtlpBytesToHex(span.spanId, { bytes: "buffer" });
  const startedAt = isoFromUnixNano(span.startTimeUnixNano);
  if (!(sessionId && traceId && spanId && startedAt)) {
    return null;
  }
  const strings = spanStringsOf(attributes);
  const measurements = spanMeasurementsOf(attributes);
  const tokens = spanTokenCountsOf(attributes);
  if (strings === null || measurements === null || tokens === null) {
    return null;
  }
  return withoutUndefinedValues({
    type: ClaudeCodeOtelSignalType.LlmRequest,
    sessionId,
    traceId,
    spanId,
    parentSpanId: spanIdOrUndefined(span.parentSpanId),
    startedAt,
    ...strings,
    ...measurements,
    ...tokens,
  });
}

type SpanMeasurements = {
  durationMs?: number;
  ttftMs?: number;
  attempt?: number;
  statusCode?: number;
  success?: boolean;
  responseHasToolCall?: boolean;
  finishReasons?: string;
};

type SpanTokenCounts = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
};

/**
 * The span's numeric, boolean and list measurements, or `null` when one was
 * present and unreadable.
 *
 * Gathered in one place because they share a failure mode: every reader here
 * distinguishes ABSENT from PRESENT-BUT-INVALID, and a single `null` must fail
 * the whole span rather than leaving a real-looking row with one field silently
 * dropped.
 */
function spanMeasurementsOf(
  attributes: Record<string, unknown>
): SpanMeasurements | null {
  const durationMs = readOptionalCount(
    attributes,
    ClaudeCodeOtelAttributeKey.DurationMs
  );
  const ttftMs = readOptionalCount(
    attributes,
    ClaudeCodeOtelAttributeKey.TtftMs
  );
  const attempt = readOptionalCount(
    attributes,
    ClaudeCodeOtelAttributeKey.Attempt
  );
  const statusCode = readHttpStatusCode(
    attributes,
    ClaudeCodeOtelAttributeKey.StatusCode
  );
  const success = readBoolean(attributes, ClaudeCodeOtelAttributeKey.Success);
  const responseHasToolCall = readBoolean(
    attributes,
    ClaudeCodeOtelAttributeKey.ResponseHasToolCall
  );
  const finishReasons = readStringList(
    attributes,
    ClaudeCodeOtelAttributeKey.FinishReasons
  );
  if (
    durationMs === null ||
    ttftMs === null ||
    attempt === null ||
    statusCode === null ||
    success === null ||
    responseHasToolCall === null ||
    finishReasons === null
  ) {
    return null;
  }
  return withoutUndefinedValues({
    durationMs,
    ttftMs,
    attempt,
    statusCode,
    success,
    responseHasToolCall,
    finishReasons,
  });
}

/**
 * The span's token counts, or `null` when one was present and corrupt.
 *
 * Absence defaults to 0, matching `api_request`: the column's own default is 0
 * and "none of this kind" cannot overstate usage. A corrupt value fails the
 * record instead of silently becoming 0.
 */
function spanTokenCountsOf(
  attributes: Record<string, unknown>
): SpanTokenCounts | null {
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
  if (
    inputTokens === null ||
    outputTokens === null ||
    cacheReadTokens === null ||
    cacheCreationTokens === null
  ) {
    return null;
  }
  return { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens };
}

/**
 * A span id, or `undefined` when the field held no bytes.
 *
 * A root span carries an EMPTY `parent_span_id` rather than omitting the field,
 * and `decodeOtlpBytesToHex` returns `""` for it. Storing that would put an
 * empty string in a column whose absence means "this span has no parent".
 */
function spanIdOrUndefined(value: unknown): string | undefined {
  const hex = decodeOtlpBytesToHex(value, { bytes: "buffer" });
  return hex === "" ? undefined : hex;
}

type SpanStrings = {
  model?: string;
  querySource?: string;
  speed?: string;
  requestContext?: string;
  stopReason?: string;
  requestId?: string;
  clientRequestId?: string;
  responseId?: string;
  agentId?: string;
  parentAgentId?: string;
  workflowRunId?: string;
  workflowName?: string;
};

/**
 * The span's optional string attributes, or `null` when one was present and
 * unreadable.
 *
 * Every one of these is left NULL when the producer omits it, so they are read
 * tri-state like the measurements: a `stop_reason` that arrived as a number
 * must fail the span, not be stored as "not stamped" beside a real `ttft_ms`.
 * `readString` cannot tell those apart, which is why it is not used here. A
 * blank is absent under both readers, so a blank `gen_ai.request.model` beside
 * a valid `model` still names the model.
 */
function spanStringsOf(
  attributes: Record<string, unknown>
): SpanStrings | null {
  const model = readOptionalString(
    attributes,
    ClaudeCodeOtelAttributeKey.Model
  );
  const requestModel = readOptionalString(
    attributes,
    ClaudeCodeOtelAttributeKey.RequestModel
  );
  const querySource = readOptionalString(
    attributes,
    ClaudeCodeAttributionAttributeKey.QuerySource
  );
  const speed = readOptionalString(
    attributes,
    ClaudeCodeAttributionAttributeKey.Speed
  );
  const requestContext = readOptionalString(
    attributes,
    ClaudeCodeOtelAttributeKey.RequestContext
  );
  const stopReason = readOptionalString(
    attributes,
    ClaudeCodeOtelAttributeKey.StopReason
  );
  const requestId = readOptionalString(
    attributes,
    ClaudeCodeOtelAttributeKey.RequestId
  );
  const clientRequestId = readOptionalString(
    attributes,
    ClaudeCodeOtelAttributeKey.ClientRequestId
  );
  const responseId = readOptionalString(
    attributes,
    ClaudeCodeOtelAttributeKey.ResponseId
  );
  const agentId = readOptionalString(
    attributes,
    ClaudeCodeOtelAttributeKey.AgentId
  );
  const parentAgentId = readOptionalString(
    attributes,
    ClaudeCodeOtelAttributeKey.ParentAgentId
  );
  const workflowRunId = readOptionalString(
    attributes,
    ClaudeCodeOtelAttributeKey.WorkflowRunId
  );
  const workflowName = readOptionalString(
    attributes,
    ClaudeCodeOtelAttributeKey.WorkflowName
  );
  if (
    model === null ||
    requestModel === null ||
    querySource === null ||
    speed === null ||
    requestContext === null ||
    stopReason === null ||
    requestId === null ||
    clientRequestId === null ||
    responseId === null ||
    agentId === null ||
    parentAgentId === null ||
    workflowRunId === null ||
    workflowName === null
  ) {
    return null;
  }
  return withoutUndefinedValues({
    // `gen_ai.request.model` is the semconv spelling and `model` the harness's
    // own; the span carries both today. Reading either means a producer that
    // drops one still names the model rather than storing a NULL beside a real
    // measurement of it.
    model: model ?? requestModel,
    querySource,
    speed,
    requestContext,
    stopReason,
    requestId,
    clientRequestId,
    responseId,
    agentId,
    parentAgentId,
    workflowRunId,
    workflowName,
  });
}
