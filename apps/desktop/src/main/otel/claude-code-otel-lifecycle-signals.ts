/**
 * @file ISS-7352 capture list C — the MCP, auth and plugin lifecycle events, for
 * which nothing equivalent existed.
 *
 * These are the expensive-to-reconstruct facts the harness reports and no
 * transcript contains: which MCP servers connected and over what transport, when
 * a user authenticated, and which plugins are installed and loaded. Each builder
 * turns one decoded LogRecord into a normalized signal, or `null` when the
 * record cannot become a row.
 *
 * Split from `claude-code-otel-log-signals.ts` (which owns list A and B and the
 * per-event dispatch) so neither file carries two capture-list items.
 */

import {
  ClaudeCodeOtelAttributeKey,
  eventTimeMsFrom,
  isoFromEpochMs,
  readBoolean,
  readHttpStatusCode,
  readOptionalCount,
  readString,
  withoutUndefinedValues,
} from "./claude-code-otel-attributes.js";
import { ClaudeCodeAttributionAttributeKey } from "./claude-code-otel-attribution.js";
import { eventCorrelationFrom } from "./claude-code-otel-event-correlation.js";
import {
  type ClaudeCodeOtelSideTableSignal,
  ClaudeCodeOtelSignalType,
  type ClaudeCodePluginLifecycle,
} from "./claude-code-otel-signal-contract.js";

/**
 * ISS-7352 item C — one MCP server connection attempt.
 *
 * `status` is required and `session.id` is required; everything else describes
 * the attempt and is left NULL when absent, the same posture the error taxonomy
 * takes. A PRESENT-BUT-INVALID `duration_ms` or `is_plugin` fails the whole
 * record: a row is valid-or-absent, never partially-corrupt.
 */
export function mcpServerConnectionSignalFrom(
  attributes: Record<string, unknown>,
  record: Record<string, unknown>
): ClaudeCodeOtelSideTableSignal | null {
  const sessionId = readString(
    attributes,
    ClaudeCodeOtelAttributeKey.SessionId
  );
  const observedAt = isoFromEpochMs(eventTimeMsFrom(attributes, record));
  const status = readString(attributes, ClaudeCodeOtelAttributeKey.Status);
  if (!(sessionId && observedAt && status)) {
    return null;
  }
  const durationMs = readOptionalCount(
    attributes,
    ClaudeCodeOtelAttributeKey.DurationMs
  );
  const isPlugin = readBoolean(attributes, ClaudeCodeOtelAttributeKey.IsPlugin);
  if (durationMs === null || isPlugin === null) {
    return null;
  }
  return withoutUndefinedValues({
    type: ClaudeCodeOtelSignalType.McpServerConnection,
    sessionId,
    observedAt,
    status,
    transportType: readString(
      attributes,
      ClaudeCodeOtelAttributeKey.TransportType
    ),
    serverScope: readString(attributes, ClaudeCodeOtelAttributeKey.ServerScope),
    durationMs,
    errorCode: readString(attributes, ClaudeCodeOtelAttributeKey.ErrorCode),
    isPlugin,
    pluginIdHash: readString(
      attributes,
      ClaudeCodeOtelAttributeKey.PluginIdHash
    ),
    ...eventCorrelationFrom(attributes),
  });
}

/**
 * ISS-7352 item C — one `login` or `logout`.
 *
 * `action` is required: a row that cannot say WHICH action occurred says nothing
 * an operator can act on. `success` is documented as the strings
 * `"true"`/`"false"`, which {@link readBoolean} resolves; a spelling it has no
 * reading for fails the record rather than being stored as "the producer said
 * nothing", which would make a failed login indistinguishable from an
 * unreported one.
 *
 * The free-text error message is not available on this event by construction —
 * the producer documents that `error_category` is categorical and the raw
 * message is never included — so nothing here reads content the operator's
 * 2026-09-11 ruling keeps out of a signal.
 */
export function authEventSignalFrom(
  attributes: Record<string, unknown>,
  record: Record<string, unknown>
): ClaudeCodeOtelSideTableSignal | null {
  const sessionId = readString(
    attributes,
    ClaudeCodeOtelAttributeKey.SessionId
  );
  const observedAt = isoFromEpochMs(eventTimeMsFrom(attributes, record));
  const action = readString(attributes, ClaudeCodeOtelAttributeKey.Action);
  if (!(sessionId && observedAt && action)) {
    return null;
  }
  const success = readBoolean(attributes, ClaudeCodeOtelAttributeKey.Success);
  const statusCode = readHttpStatusCode(
    attributes,
    ClaudeCodeOtelAttributeKey.StatusCode
  );
  if (success === null || statusCode === null) {
    return null;
  }
  return withoutUndefinedValues({
    type: ClaudeCodeOtelSignalType.AuthEvent,
    sessionId,
    observedAt,
    action,
    success,
    authMethod: readString(attributes, ClaudeCodeOtelAttributeKey.AuthMethod),
    errorCategory: readString(
      attributes,
      ClaudeCodeOtelAttributeKey.ErrorCategory
    ),
    statusCode,
    ...eventCorrelationFrom(attributes),
  });
}

/**
 * ISS-7352 item C — one `plugin_installed` or `plugin_loaded`.
 *
 * The lifecycle discriminant comes from the caller (it is decided by the event
 * NAME) rather than from an attribute, so the two events cannot be conflated by
 * a producer that stops stamping a field.
 *
 * `plugin.name` is NOT required. Claude Code substitutes the literal
 * `"third-party"` for it, or omits it entirely, on third-party marketplaces
 * unless `OTEL_LOG_TOOL_DETAILS=1`. Refusing those records would leave a plugin
 * inventory that silently describes only first-party plugins while looking
 * complete — worse than a row that records an install it cannot name.
 */
export function pluginEventSignalFrom(
  lifecycle: ClaudeCodePluginLifecycle,
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
  const marketplaceIsOfficial = readBoolean(
    attributes,
    ClaudeCodeOtelAttributeKey.MarketplaceIsOfficial
  );
  if (marketplaceIsOfficial === null) {
    return null;
  }
  return withoutUndefinedValues({
    type: ClaudeCodeOtelSignalType.PluginEvent,
    sessionId,
    observedAt,
    lifecycle,
    pluginName: readString(
      attributes,
      ClaudeCodeAttributionAttributeKey.PluginName
    ),
    pluginVersion: readString(
      attributes,
      ClaudeCodeOtelAttributeKey.PluginVersion
    ),
    marketplaceName: readString(
      attributes,
      ClaudeCodeAttributionAttributeKey.MarketplaceName
    ),
    marketplaceIsOfficial,
    installTrigger: readString(
      attributes,
      ClaudeCodeOtelAttributeKey.InstallTrigger
    ),
    ...eventCorrelationFrom(attributes),
  });
}
