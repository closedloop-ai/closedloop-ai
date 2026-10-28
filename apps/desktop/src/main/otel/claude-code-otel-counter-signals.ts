/**
 * @file ISS-7352 capture list G — the counters we approximate but do not carry
 * natively.
 *
 * `claude_code.lines_of_code.count` splits code churn by added-vs-removed AND by
 * the model that made the change; our own `diffStats` is session-level only.
 * `claude_code.session.count` carries `start_type`, the only thing that tells a
 * resumed session from a fresh one. `tool_result` carries the input/result sizes
 * and the failure category for an invocation we otherwise only see the request
 * side of.
 *
 * Also ISS-7352 item D's GA half: `claude_code.active_time.total` splits the
 * time a session actually spent working into the human's share and the CLI's,
 * which no timestamp we already store can separate.
 *
 * The metrics here are DELTA sums, so their builders take a data point rather
 * than a LogRecord; the normalizer sums points that share a natural key before
 * they reach the persister.
 */

import { numberFromOtlpValue } from "../otlp/decode-utilities.js";
import {
  ClaudeCodeOtelAttributeKey,
  eventTimeMsFrom,
  isoFromEpochMs,
  isoFromUnixNano,
  nonNegativeMeasurement,
  readBoolean,
  readOptionalCount,
  readString,
  withoutUndefinedValues,
} from "./claude-code-otel-attributes.js";
import { eventCorrelationFrom } from "./claude-code-otel-event-correlation.js";
import {
  ClaudeCodeActivityType,
  type ClaudeCodeOtelSideTableSignal,
  ClaudeCodeOtelSignalType,
} from "./claude-code-otel-signal-contract.js";

/**
 * ISS-7352 item G — one `claude_code.lines_of_code.count` delta point.
 *
 * `model` and `type` are BOTH required and both key the row. The whole reason to
 * carry this counter over our session-level `diffStats` is that it attributes
 * churn to a direction and a model, so a point that names neither is not the
 * measurement this table exists for and is counted unusable rather than stored
 * under an invented default.
 */
export function linesOfCodeSignalFrom(
  attributes: Record<string, unknown>,
  dataPoint: Record<string, unknown>
): ClaudeCodeOtelSideTableSignal | null {
  const sessionId = readString(
    attributes,
    ClaudeCodeOtelAttributeKey.SessionId
  );
  const model = readString(attributes, ClaudeCodeOtelAttributeKey.Model);
  const changeType = readString(
    attributes,
    ClaudeCodeOtelAttributeKey.MeasurementType
  );
  const observedAt = isoFromUnixNano(dataPoint.timeUnixNano);
  const lineCount = counterValueOf(dataPoint);
  if (!(sessionId && model && changeType && observedAt)) {
    return null;
  }
  if (lineCount === null) {
    return null;
  }
  return {
    type: ClaudeCodeOtelSignalType.LinesOfCode,
    sessionId,
    model,
    observedAt,
    changeType,
    lineCount,
  };
}

/** ISS-7352 item G — one `claude_code.session.count` delta point. */
export function sessionStartSignalFrom(
  attributes: Record<string, unknown>,
  dataPoint: Record<string, unknown>
): ClaudeCodeOtelSideTableSignal | null {
  const sessionId = readString(
    attributes,
    ClaudeCodeOtelAttributeKey.SessionId
  );
  const startType = readString(
    attributes,
    ClaudeCodeOtelAttributeKey.StartType
  );
  const observedAt = isoFromUnixNano(dataPoint.timeUnixNano);
  const sessionCount = counterValueOf(dataPoint);
  if (!(sessionId && startType && observedAt)) {
    return null;
  }
  if (sessionCount === null) {
    return null;
  }
  return {
    type: ClaudeCodeOtelSignalType.SessionStart,
    sessionId,
    observedAt,
    startType,
    sessionCount,
  };
}

/**
 * ISS-7352 item G — one `tool_result`.
 *
 * `success` is read alongside `error_type` on purpose. The producer only stamps
 * `error_type` on a FAILED call, so a NULL there cannot on its own tell a
 * successful invocation from one that failed without a category — the row could
 * not answer whether the tool worked.
 *
 * `tool_use_id` is the harness's identifier for the invocation and is what keys
 * the row; it is optional because a producer that omits it should still leave a
 * record, and the normalizer refuses a genuinely-differing collision instead.
 */
export function toolResultSignalFrom(
  attributes: Record<string, unknown>,
  record: Record<string, unknown>
): ClaudeCodeOtelSideTableSignal | null {
  const sessionId = readString(
    attributes,
    ClaudeCodeOtelAttributeKey.SessionId
  );
  const toolName = readString(attributes, ClaudeCodeOtelAttributeKey.ToolName);
  const observedAt = isoFromEpochMs(eventTimeMsFrom(attributes, record));
  if (!(sessionId && toolName && observedAt)) {
    return null;
  }
  const success = readBoolean(attributes, ClaudeCodeOtelAttributeKey.Success);
  const toolInputSizeBytes = readOptionalCount(
    attributes,
    ClaudeCodeOtelAttributeKey.ToolInputSizeBytes
  );
  const toolResultSizeBytes = readOptionalCount(
    attributes,
    ClaudeCodeOtelAttributeKey.ToolResultSizeBytes
  );
  if (
    success === null ||
    toolInputSizeBytes === null ||
    toolResultSizeBytes === null
  ) {
    return null;
  }
  return withoutUndefinedValues({
    type: ClaudeCodeOtelSignalType.ToolResult,
    sessionId,
    toolName,
    observedAt,
    toolUseId: readString(attributes, ClaudeCodeOtelAttributeKey.ToolUseId),
    success,
    errorType: readString(attributes, ClaudeCodeOtelAttributeKey.ErrorType),
    toolInputSizeBytes,
    toolResultSizeBytes,
    mcpServerScope: readString(
      attributes,
      ClaudeCodeOtelAttributeKey.McpServerScope
    ),
    ...eventCorrelationFrom(attributes),
  });
}

/**
 * ISS-7352 item D — one `claude_code.active_time.total` delta point.
 *
 * `type` (user / cli) is required and keys the row: a total that cannot say
 * whose time it was is not this measurement, so a point without it — or with a
 * value outside that published pair — is counted unusable rather than stored
 * under an invented default or an invented third bucket.
 *
 * Takes {@link durationValueOf}, not {@link counterValueOf}: this counter's
 * unit is SECONDS, so a fraction is an ordinary interval here where a
 * fractional line count is corruption.
 */
export function activeTimeSignalFrom(
  attributes: Record<string, unknown>,
  dataPoint: Record<string, unknown>
): ClaudeCodeOtelSideTableSignal | null {
  const sessionId = readString(
    attributes,
    ClaudeCodeOtelAttributeKey.SessionId
  );
  const activityType = readActivityType(attributes);
  const observedAt = isoFromUnixNano(dataPoint.timeUnixNano);
  const seconds = durationValueOf(dataPoint);
  if (!(sessionId && activityType && observedAt)) {
    return null;
  }
  if (seconds === null) {
    return null;
  }
  return {
    type: ClaudeCodeOtelSignalType.ActiveTime,
    sessionId,
    observedAt,
    activityType,
    seconds,
  };
}

/**
 * A duration counter's value in its own unit, or `null` when the point carried
 * no measurement or one that is not a duration.
 *
 * Deliberately does NOT require an integer, unlike {@link counterValueOf}: a
 * negative or non-finite duration is still refused, but 0.5s is a real interval
 * and rounding it away would understate every short burst of activity.
 *
 * Bounded at BOTH ends even so. Past `Number.MAX_SAFE_INTEGER` seconds — some
 * 285 million years — the value is not an interval this session spent, and
 * admitting one had a second consequence: two such points sharing a natural key
 * SUM to `Infinity` in the delta reduction, which the persistence-boundary
 * schema then refuses as a validation failure AFTER the normalizer has already
 * counted both points usable, so the batch's `unusable` tally missed the input
 * that caused it. Refusing at the read keeps the refusal where the tally is,
 * and makes the overflow unreachable: no batch holds the ~1e292 points a finite
 * sum of bounded values would need to reach it.
 */
function durationValueOf(dataPoint: Record<string, unknown>): number | null {
  const value = nonNegativeMeasurement(
    numberFromOtlpValue(dataPoint.asDouble) ??
      numberFromOtlpValue(dataPoint.asInt)
  );
  if (value === undefined || value > Number.MAX_SAFE_INTEGER) {
    return null;
  }
  return value;
}

/**
 * The point's `type`, or `undefined` when it is absent or outside the published
 * `user` / `cli` set.
 *
 * Refusing an unrecognized value rather than degrading it — the opposite of
 * what `readPermissionSource` does with a source it does not know — is the
 * difference between an ANNOTATION and a KEY. A permission decision still
 * carries its allow/deny when the source is unknown; an active-time total whose
 * `type` we cannot name is a third bucket that a user-plus-cli sum silently
 * misses, so the point is counted unusable instead.
 */
function readActivityType(
  attributes: Record<string, unknown>
): ClaudeCodeActivityType | undefined {
  const value = readString(
    attributes,
    ClaudeCodeOtelAttributeKey.MeasurementType
  );
  if (
    value === ClaudeCodeActivityType.User ||
    value === ClaudeCodeActivityType.Cli
  ) {
    return value;
  }
  return undefined;
}

/**
 * A counter data point's value, or `null` when it carried none or carried
 * something that is not a count.
 *
 * `as_double`/`as_int` are proto3 oneof members, which the wire always carries,
 * so a genuine 0 arrives as 0 and an ABSENT value means the point reported no
 * measurement at all rather than a zero-line interval. Both counters here are
 * whole-unit counts, so a fractional or out-of-range value is refused rather
 * than rounded into a plausible-looking number — the same rule
 * `readNonNegativeInteger` applies to an attribute, applied here to the oneof
 * that `nonNegativeMeasurement` exists to guard.
 */
function counterValueOf(dataPoint: Record<string, unknown>): number | null {
  const value = nonNegativeMeasurement(
    numberFromOtlpValue(dataPoint.asInt) ??
      numberFromOtlpValue(dataPoint.asDouble)
  );
  if (value === undefined || !Number.isSafeInteger(value)) {
    return null;
  }
  return value;
}
