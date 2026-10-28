/**
 * @file How a batch of normalized Claude Code signals is reduced before it
 * reaches the persister: delta counter points that share a natural key are
 * SUMMED, and log records that would collide on one are REFUSED.
 *
 * Split from `claude-code-otel-normalizer.ts` when ISS-7352 added capture list
 * C and G — that file owns which exports are Claude's and which signals each
 * record produces, this one owns what happens when two of them land on one row.
 *
 * The distinction between the two reductions is the point of the module. A
 * delta Sum's data points are additive by definition, so summing two yields
 * exactly what one point would have reported. A log record is the record of ONE
 * event — `duration_ms` has no honest merge, two 500 ms connections are not one
 * 1000 ms connection — so a differing collision is refused and counted instead.
 */

import { withoutUndefinedValues } from "./claude-code-otel-attributes.js";
import {
  agreedAttributionDimensions,
  attributionKeyOf,
} from "./claude-code-otel-attribution.js";
import { sameEventCorrelation } from "./claude-code-otel-event-correlation.js";
import {
  isSessionIdentitySignal,
  mergeSessionIdentity,
} from "./claude-code-otel-identity.js";
import {
  authOccurrenceKeyOf,
  type ClaudeCodeActiveTimeSignal,
  type ClaudeCodeApiRequestSignal,
  type ClaudeCodeAuthEventSignal,
  type ClaudeCodeCostUsageSignal,
  type ClaudeCodeErrorEventSignal,
  type ClaudeCodeLinesOfCodeSignal,
  type ClaudeCodeLlmRequestSignal,
  type ClaudeCodeMcpServerConnectionSignal,
  type ClaudeCodeOtelSideTableSignal,
  ClaudeCodeOtelSignalType,
  type ClaudeCodePermissionDecisionSignal,
  type ClaudeCodePermissionModeChangeSignal,
  type ClaudeCodePluginEventSignal,
  type ClaudeCodeSessionStartSignal,
  type ClaudeCodeToolResultSignal,
  errorOccurrenceKeyOf,
  mcpConnectionKeyOf,
  pluginKeyOf,
  toolResultKeyOf,
} from "./claude-code-otel-signal-contract.js";

/**
 * Joins the parts of a signal's IN-MEMORY collision key. NUL because it cannot
 * occur in a session id, model, or ISO timestamp, so two different key tuples
 * can never flatten to the same string — a printable separator could. Unlike
 * the stored `attribution_key` / `occurrence_key`, this value never reaches a
 * column, so an embedded NUL costs nothing here.
 */
const SIGNAL_KEY_SEPARATOR = "\u0000";

/**
 * Sums the delta counter points in a batch that share their table's natural key.
 *
 * Colliding points are SUMMED, never allowed to reach the persister as separate
 * rows (tamsinb, ISS-7352 review). An OTel Sum's data points are distinct time
 * series keyed by their FULL attribute set, so two points in one delta interval
 * that differ on a dimension we do not read land on one key, and the persister's
 * upsert REPLACES the value rather than adding to it — the second would silently
 * erase the first and understate the total.
 *
 * Order is preserved and non-counter signals pass through untouched.
 */
export function aggregateCounterSignals(
  signals: ClaudeCodeOtelSideTableSignal[]
): ClaudeCodeOtelSideTableSignal[] {
  const costMerged = aggregateDeltaSignals(
    signals,
    isCostSignal,
    costKeyOf,
    mergedCostSignal
  );
  const linesMerged = aggregateDeltaSignals(
    costMerged,
    isLinesOfCodeSignal,
    linesOfCodeKeyOf,
    (existing, incoming) => ({
      ...existing,
      lineCount: existing.lineCount + incoming.lineCount,
    })
  );
  const startsMerged = aggregateDeltaSignals(
    linesMerged,
    isSessionStartSignal,
    sessionStartKeyOf,
    (existing, incoming) => ({
      ...existing,
      sessionCount: existing.sessionCount + incoming.sessionCount,
    })
  );
  return aggregateDeltaSignals(
    startsMerged,
    isActiveTimeSignal,
    activeTimeKeyOf,
    (existing, incoming) => ({
      ...existing,
      seconds: existing.seconds + incoming.seconds,
    })
  );
}

/**
 * Refuses the log-sourced signals in a batch that would collide on their table's
 * natural key, and REPORTS how many were refused.
 *
 * These keys are DERIVED over a few of the many attributes Claude Code stamps,
 * so two genuinely distinct records can reduce to one. The persister's upsert
 * REPLACES, so without this the second silently erased the first while the
 * summary reported both accepted.
 */
export function refuseLogSignalCollisions(
  signals: ClaudeCodeOtelSideTableSignal[]
): { signals: ClaudeCodeOtelSideTableSignal[]; refused: number } {
  let kept = signals;
  let refused = 0;
  for (const guard of Object.values(COLLISION_GUARDS)) {
    const result = guard(kept);
    kept = result.signals;
    refused += result.refused;
  }
  return { signals: kept, refused };
}

/**
 * The signal types whose collisions are REFUSED: every side-table signal except
 * the ones another reduction already merges. Log records are most of them; the
 * beta `llm_request` SPAN is here too, for the same reason — it records one
 * request, and two contradictory readings of one request have no honest merge.
 *
 * The four delta counters are subtracted because {@link aggregateCounterSignals}
 * SUMS them, and `session_identity` because
 * {@link mergeSessionIdentitySignals} UNIONS it — a second reading of one
 * session is more of the same fact, not a competing record, so refusing it
 * would discard an identifier the producer genuinely resolved.
 *
 * All five are subtracted by name because nothing in the schema marks a signal
 * as merge-sourced; this list and the `aggregateDeltaSignals` calls are the
 * same fact stated twice, so a new merged signal fails HERE (demanding a
 * collision guard it does not want) rather than passing silently.
 */
type ClaudeCodeOtelLogSignalType = Exclude<
  ClaudeCodeOtelSideTableSignal["type"],
  | typeof ClaudeCodeOtelSignalType.CostUsage
  | typeof ClaudeCodeOtelSignalType.LinesOfCode
  | typeof ClaudeCodeOtelSignalType.SessionStart
  | typeof ClaudeCodeOtelSignalType.ActiveTime
  | typeof ClaudeCodeOtelSignalType.SessionIdentity
>;

type ClaudeCodeOtelCollisionGuard = (
  signals: ClaudeCodeOtelSideTableSignal[]
) => { signals: ClaudeCodeOtelSideTableSignal[]; refused: number };

/**
 * One guard per table a non-counter signal can write, applied in sequence.
 *
 * TOTAL over {@link ClaudeCodeOtelLogSignalType} rather than a list, because a
 * list can only be *claimed* exhaustive: `permission_decision` was missing from
 * it while this module was the one place claiming to guard every log-backed
 * table, so two `tool_decision` records in one millisecond both reached the
 * persister and the later one's `decision`/`source` silently overwrote the
 * earlier through the upsert's update clause (whitlockk, ISS-7352 review). Keyed by
 * signal type, the NEXT omission fails typecheck instead of production.
 *
 * The key is the signal type each guard filters on; order of application does
 * not matter, since every guard passes non-matching signals through untouched.
 */
const COLLISION_GUARDS: Record<
  ClaudeCodeOtelLogSignalType,
  ClaudeCodeOtelCollisionGuard
> = {
  [ClaudeCodeOtelSignalType.ApiRequest]: (signals) =>
    refuseCollidingSignals(
      signals,
      isApiRequestSignal,
      apiRequestKeyOf,
      sameApiRequestObservation
    ),
  [ClaudeCodeOtelSignalType.PermissionDecision]: (signals) =>
    refuseCollidingSignals(
      signals,
      isPermissionDecisionSignal,
      permissionDecisionKeyOf,
      samePermissionDecisionOutcome
    ),
  [ClaudeCodeOtelSignalType.ErrorEvent]: (signals) =>
    refuseCollidingSignals(
      signals,
      isErrorEventSignal,
      errorEventKeyOf,
      sameErrorEventTaxonomy
    ),
  [ClaudeCodeOtelSignalType.PermissionModeChange]: (signals) =>
    refuseCollidingSignals(
      signals,
      isPermissionModeChangeSignal,
      permissionModeChangeKeyOf,
      samePermissionModeChangeTrigger
    ),
  [ClaudeCodeOtelSignalType.McpServerConnection]: (signals) =>
    refuseCollidingSignals(
      signals,
      isMcpServerConnectionSignal,
      mcpServerConnectionKeyOf,
      neverProvablyOneRecord
    ),
  [ClaudeCodeOtelSignalType.AuthEvent]: (signals) =>
    refuseCollidingSignals(
      signals,
      isAuthEventSignal,
      authEventKeyOf,
      // Every attribute the auth event ITSELF carries is already in its key, so
      // two signals reaching here agree on all of those by construction. The
      // ISS-7352 correlation keys are not in it, and they are the one thing
      // left that can still tell two records apart.
      sameEventCorrelation
    ),
  [ClaudeCodeOtelSignalType.PluginEvent]: (signals) =>
    refuseCollidingSignals(
      signals,
      isPluginEventSignal,
      pluginEventKeyOf,
      neverProvablyOneRecord
    ),
  [ClaudeCodeOtelSignalType.ToolResult]: (signals) =>
    refuseCollidingSignals(
      signals,
      isToolResultSignal,
      toolResultSignalKeyOf,
      sameToolResultDetail
    ),
  [ClaudeCodeOtelSignalType.LlmRequest]: (signals) =>
    refuseCollidingSignals(
      signals,
      isLlmRequestSignal,
      llmRequestKeyOf,
      sameLlmRequestMeasurements
    ),
};

/**
 * Merges the target signals that share a key, leaving everything else untouched.
 *
 * The merge is applied in place at the FIRST occurrence's position, so a batch's
 * order survives aggregation and a reader of the resulting array sees the points
 * in the order the exporter sent them.
 */
function aggregateDeltaSignals<T extends ClaudeCodeOtelSideTableSignal>(
  signals: ClaudeCodeOtelSideTableSignal[],
  isTarget: (signal: ClaudeCodeOtelSideTableSignal) => signal is T,
  keyOf: (signal: T) => string,
  merge: (existing: T, incoming: T) => T
): ClaudeCodeOtelSideTableSignal[] {
  const aggregated: ClaudeCodeOtelSideTableSignal[] = [];
  const indexByKey = new Map<string, number>();
  for (const signal of signals) {
    if (!isTarget(signal)) {
      aggregated.push(signal);
      continue;
    }
    const key = keyOf(signal);
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      indexByKey.set(key, aggregated.length);
      aggregated.push(signal);
      continue;
    }
    const existing = aggregated[existingIndex];
    if (existing !== undefined && isTarget(existing)) {
      aggregated[existingIndex] = merge(existing, signal);
    }
  }
  return aggregated;
}

/**
 * Keeps the first record for a key and REFUSES a differing later one.
 *
 * An identical repeat is collapsed WITHOUT being counted: it is one observation
 * reported twice, its upsert is idempotent, and calling it unusable would report
 * a data problem that did not occur.
 */
function refuseCollidingSignals<T extends ClaudeCodeOtelSideTableSignal>(
  signals: ClaudeCodeOtelSideTableSignal[],
  isTarget: (signal: ClaudeCodeOtelSideTableSignal) => signal is T,
  keyOf: (signal: T) => string,
  isSame: (first: T, second: T) => boolean
): { signals: ClaudeCodeOtelSideTableSignal[]; refused: number } {
  const kept: ClaudeCodeOtelSideTableSignal[] = [];
  const seenByKey = new Map<string, T>();
  let refused = 0;
  for (const signal of signals) {
    if (!isTarget(signal)) {
      kept.push(signal);
      continue;
    }
    const key = keyOf(signal);
    const existing = seenByKey.get(key);
    if (existing === undefined) {
      seenByKey.set(key, signal);
      kept.push(signal);
      continue;
    }
    if (!isSame(existing, signal)) {
      refused += 1;
    }
  }
  return { signals: kept, refused };
}

/**
 * Two cost points on one natural key, as a single measurement.
 *
 * The costs are summed (a delta Sum's points are additive) but the non-identity
 * dimensions are only carried over where the two points AGREED — see
 * {@link agreedAttributionDimensions}. Keeping the first point's value would
 * store a summed cost beside an effort or speed that no single measurement
 * reported, which is a fabricated pairing rather than a lossy one.
 */
function mergedCostSignal(
  existing: ClaudeCodeCostUsageSignal,
  incoming: ClaudeCodeCostUsageSignal
): ClaudeCodeCostUsageSignal {
  return withoutUndefinedValues({
    ...existing,
    costUsd: existing.costUsd + incoming.costUsd,
    ...agreedAttributionDimensions(existing, incoming),
  });
}

function isCostSignal(
  signal: ClaudeCodeOtelSideTableSignal
): signal is ClaudeCodeCostUsageSignal {
  return signal.type === ClaudeCodeOtelSignalType.CostUsage;
}

function isLinesOfCodeSignal(
  signal: ClaudeCodeOtelSideTableSignal
): signal is ClaudeCodeLinesOfCodeSignal {
  return signal.type === ClaudeCodeOtelSignalType.LinesOfCode;
}

function isSessionStartSignal(
  signal: ClaudeCodeOtelSideTableSignal
): signal is ClaudeCodeSessionStartSignal {
  return signal.type === ClaudeCodeOtelSignalType.SessionStart;
}

function isActiveTimeSignal(
  signal: ClaudeCodeOtelSideTableSignal
): signal is ClaudeCodeActiveTimeSignal {
  return signal.type === ClaudeCodeOtelSignalType.ActiveTime;
}

function isApiRequestSignal(
  signal: ClaudeCodeOtelSideTableSignal
): signal is ClaudeCodeApiRequestSignal {
  return signal.type === ClaudeCodeOtelSignalType.ApiRequest;
}

function isPermissionDecisionSignal(
  signal: ClaudeCodeOtelSideTableSignal
): signal is ClaudeCodePermissionDecisionSignal {
  return signal.type === ClaudeCodeOtelSignalType.PermissionDecision;
}

function isErrorEventSignal(
  signal: ClaudeCodeOtelSideTableSignal
): signal is ClaudeCodeErrorEventSignal {
  return signal.type === ClaudeCodeOtelSignalType.ErrorEvent;
}

function isPermissionModeChangeSignal(
  signal: ClaudeCodeOtelSideTableSignal
): signal is ClaudeCodePermissionModeChangeSignal {
  return signal.type === ClaudeCodeOtelSignalType.PermissionModeChange;
}

function isMcpServerConnectionSignal(
  signal: ClaudeCodeOtelSideTableSignal
): signal is ClaudeCodeMcpServerConnectionSignal {
  return signal.type === ClaudeCodeOtelSignalType.McpServerConnection;
}

function isAuthEventSignal(
  signal: ClaudeCodeOtelSideTableSignal
): signal is ClaudeCodeAuthEventSignal {
  return signal.type === ClaudeCodeOtelSignalType.AuthEvent;
}

function isPluginEventSignal(
  signal: ClaudeCodeOtelSideTableSignal
): signal is ClaudeCodePluginEventSignal {
  return signal.type === ClaudeCodeOtelSignalType.PluginEvent;
}

function isToolResultSignal(
  signal: ClaudeCodeOtelSideTableSignal
): signal is ClaudeCodeToolResultSignal {
  return signal.type === ClaudeCodeOtelSignalType.ToolResult;
}

/**
 * `claude_code_cost_event`'s natural key.
 *
 * Includes the attribution key (ISS-7352 item E), which is exactly what stops
 * the merge from destroying the attribution it was added to capture: two points
 * differing only in `agent.name` are two components' spend, not one series
 * reported twice, and summing them would attribute both to whichever name
 * happened to arrive first. It is derived from the persistence contract's own
 * function so the key aggregated on and the key stored cannot drift.
 */
function costKeyOf(signal: ClaudeCodeCostUsageSignal): string {
  return joinSignalKey([
    signal.sessionId,
    signal.model,
    signal.observedAt,
    attributionKeyOf(signal),
  ]);
}

function linesOfCodeKeyOf(signal: ClaudeCodeLinesOfCodeSignal): string {
  return joinSignalKey([
    signal.sessionId,
    signal.model,
    signal.observedAt,
    signal.changeType,
  ]);
}

function sessionStartKeyOf(signal: ClaudeCodeSessionStartSignal): string {
  return joinSignalKey([signal.sessionId, signal.observedAt, signal.startType]);
}

function activeTimeKeyOf(signal: ClaudeCodeActiveTimeSignal): string {
  return joinSignalKey([
    signal.sessionId,
    signal.observedAt,
    signal.activityType,
  ]);
}

function apiRequestKeyOf(signal: ClaudeCodeApiRequestSignal): string {
  return joinSignalKey([signal.sessionId, signal.startedAt, signal.model]);
}

/**
 * `claude_code_permission_event`'s natural key, exactly as the upsert spells it.
 *
 * `decision` and `source` are deliberately NOT in it — they are the columns the
 * update clause rewrites, so folding them in would make every disagreeing pair
 * a separate row and defeat the guard rather than arm it. They are compared by
 * {@link samePermissionDecisionOutcome} instead.
 */
function permissionDecisionKeyOf(
  signal: ClaudeCodePermissionDecisionSignal
): string {
  return joinSignalKey([signal.sessionId, signal.toolName, signal.observedAt]);
}

function errorEventKeyOf(signal: ClaudeCodeErrorEventSignal): string {
  return joinSignalKey([
    signal.sessionId,
    signal.errorKind,
    signal.observedAt,
    errorOccurrenceKeyOf(signal),
  ]);
}

/**
 * `claude_code_permission_mode_change`'s natural key — WITHOUT `trigger`.
 *
 * `trigger` is nullable, and a nullable column in a SQLite UNIQUE index makes
 * every row carrying a NULL distinct from itself, which turns the upsert into a
 * duplicate insert on every export. It stays out of the key and is checked here
 * instead: two transitions reported in the same millisecond by DIFFERENT
 * triggers are two facts, and without this the later one silently overwrote the
 * earlier through the upsert's update clause (whitlockk, ISS-7352 review).
 */
function permissionModeChangeKeyOf(
  signal: ClaudeCodePermissionModeChangeSignal
): string {
  return joinSignalKey([
    signal.sessionId,
    signal.observedAt,
    signal.fromMode,
    signal.toMode,
  ]);
}

function mcpServerConnectionKeyOf(
  signal: ClaudeCodeMcpServerConnectionSignal
): string {
  return joinSignalKey([
    signal.sessionId,
    signal.observedAt,
    signal.status,
    mcpConnectionKeyOf(signal),
  ]);
}

function authEventKeyOf(signal: ClaudeCodeAuthEventSignal): string {
  return joinSignalKey([
    signal.sessionId,
    signal.observedAt,
    signal.action,
    authOccurrenceKeyOf(signal),
  ]);
}

function pluginEventKeyOf(signal: ClaudeCodePluginEventSignal): string {
  return joinSignalKey([
    signal.sessionId,
    signal.lifecycle,
    signal.observedAt,
    pluginKeyOf(signal),
  ]);
}

function toolResultSignalKeyOf(signal: ClaudeCodeToolResultSignal): string {
  return joinSignalKey([
    signal.sessionId,
    signal.toolName,
    signal.observedAt,
    toolResultKeyOf(signal),
  ]);
}

/**
 * How to read each field two key-colliding `api_request`s must AGREE on for the
 * pair to be one observation reported twice; `null` marks a field that is
 * already in the natural key, so two signals reaching here share it by
 * construction.
 *
 * TOTAL over the signal's keys rather than a list, for the reason
 * {@link COLLISION_GUARDS} gives: a list can only be *claimed* exhaustive. When
 * `costUsdMicros` was added to the signal and not to the hand-written
 * comparison this replaces, two records disagreeing on only that field read as
 * an identical repeat and the second was dropped UNCOUNTED — the precise
 * collapse this module exists to prevent, and the one the exact-integer cost
 * exists to expose. Keyed this way, the next field fails typecheck instead.
 *
 * That totality is why this table carries the ISS-7352 join keys itself rather
 * than deferring to {@link sameEventCorrelation} the way its sibling
 * comparators do: a correlation key added to the contract has to fail typecheck
 * HERE too, and a separate call would let this one comparison silently keep
 * comparing four of five.
 */
const API_REQUEST_COMPARED_FIELDS: Record<
  keyof ClaudeCodeApiRequestSignal,
  ((signal: ClaudeCodeApiRequestSignal) => number | string | undefined) | null
> = {
  type: null,
  sessionId: null,
  model: null,
  startedAt: null,
  durationMs: (signal) => signal.durationMs,
  costUsd: (signal) => signal.costUsd,
  costUsdMicros: (signal) => signal.costUsdMicros,
  inputTokens: (signal) => signal.inputTokens,
  outputTokens: (signal) => signal.outputTokens,
  cacheReadTokens: (signal) => signal.cacheReadTokens,
  cacheCreationTokens: (signal) => signal.cacheCreationTokens,
  // ISS-7352 item F. `started_at` is DERIVED — the completion stamp less the
  // duration, at millisecond resolution — so the natural key is approximate in
  // a way these are not: Anthropic issues one `request_id` per request, which
  // makes a differing one the strongest evidence this table has that a
  // collision is two requests rather than one re-sent export. Leaving them out
  // let a provably-distinct pair collapse with `unusable` at zero.
  requestId: (signal) => signal.requestId,
  clientRequestId: (signal) => signal.clientRequestId,
  promptId: (signal) => signal.promptId,
  messageUuid: (signal) => signal.messageUuid,
  workflowRunId: (signal) => signal.workflowRunId,
  workflowName: (signal) => signal.workflowName,
};

/**
 * Whether two key-colliding api_requests report the same observation — every
 * measured value AND every identifier not already in the natural key.
 */
function sameApiRequestObservation(
  first: ClaudeCodeApiRequestSignal,
  second: ClaudeCodeApiRequestSignal
): boolean {
  return Object.values(API_REQUEST_COMPARED_FIELDS).every(
    (read) => read === null || read(first) === read(second)
  );
}

/**
 * Whether two key-colliding permission decisions report the same outcome.
 *
 * `tool_name` is in the key and the producer never redacts it, so a collision
 * that AGREES here is one decision exported twice and collapses silently — the
 * same posture as `api_request` and `error_event`. One that disagrees is two
 * decisions about the same tool in one millisecond, and only one row can hold
 * them.
 */
function samePermissionDecisionOutcome(
  first: ClaudeCodePermissionDecisionSignal,
  second: ClaudeCodePermissionDecisionSignal
): boolean {
  return (
    first.decision === second.decision &&
    first.source === second.source &&
    // ISS-7481. `tool_use_id` is the harness's own identifier for the
    // invocation, so a differing one PROVES two calls. It stays OUT of the
    // natural key — it is nullable, and a nullable column in a SQLite UNIQUE
    // index makes every row carrying a NULL distinct from itself — which means
    // only this comparison can announce the truncation. Without it, several
    // parallel auto-approved `Read`s (the reviewer's named case on PR #5526)
    // agree on `decision` and `source`, read as one observation reported twice,
    // and persist as ONE row while `claude_code_tool_result` keeps all of them
    // and `unusable` reports no problem at all.
    first.toolUseId === second.toolUseId &&
    sameEventCorrelation(first, second)
  );
}

/**
 * Whether two key-colliding error events report the same taxonomy.
 *
 * Only the fields NOT already in the key are compared: everything
 * `errorOccurrenceKeyOf` is built from — the attempt/request identifiers and
 * the refusal taxonomy — is part of the key, so two signals reaching here
 * already agree on all of it.
 */
function sameErrorEventTaxonomy(
  first: ClaudeCodeErrorEventSignal,
  second: ClaudeCodeErrorEventSignal
): boolean {
  return (
    first.model === second.model &&
    first.statusCode === second.statusCode &&
    first.errorCategory === second.errorCategory &&
    first.durationMs === second.durationMs &&
    // ISS-7352 item F. `errorOccurrenceKeyOf` is built from the attempt and
    // request identifiers, so two `api_error` records carrying neither reduce
    // to one key and `prompt.id` is then the only thing left saying they are
    // two failures from two prompts.
    sameEventCorrelation(first, second)
  );
}

/** Whether two key-colliding transitions report the same trigger and prompt. */
function samePermissionModeChangeTrigger(
  first: ClaudeCodePermissionModeChangeSignal,
  second: ClaudeCodePermissionModeChangeSignal
): boolean {
  return (
    first.trigger === second.trigger && sameEventCorrelation(first, second)
  );
}

/**
 * For the two tables whose only real discriminator the producer can REDACT: a
 * key collision is never provable evidence of one record reported twice.
 *
 * `plugin.name` is replaced with the literal `"third-party"` (or omitted) on
 * third-party marketplaces unless `OTEL_LOG_TOOL_DETAILS=1`, and
 * `createClaudeCodeShellEnvProvider` never sets it — so redaction is the
 * DEFAULT for every session this lane instruments, and two different plugins
 * loading at one instant produce byte-identical records. `server_name` on
 * `mcp_server_connection` is stamped under the same flag and the capture list
 * does not claim it, so two different MCP servers collide the same way.
 *
 * The sibling guards may treat an identical repeat as one observation reported
 * twice because their keys carry an identifier the producer does not redact.
 * These two cannot, and the cost of the two readings is asymmetric: counting a
 * genuine duplicate reports a data problem that did not occur, while NOT
 * counting a redacted pair reports "one plugin loaded, zero problems" for a
 * fleet of ten. The truncation has to announce itself.
 *
 * A retried export is unaffected either way — it re-enters the normalizer as a
 * separate batch with a fresh map, and the persister's upsert is what makes the
 * re-delivery idempotent.
 */
function neverProvablyOneRecord(): boolean {
  return false;
}

/** Whether two key-colliding tool results report the same outcome and sizes. */
function sameToolResultDetail(
  first: ClaudeCodeToolResultSignal,
  second: ClaudeCodeToolResultSignal
): boolean {
  return (
    first.success === second.success &&
    first.errorType === second.errorType &&
    first.toolInputSizeBytes === second.toolInputSizeBytes &&
    first.toolResultSizeBytes === second.toolResultSizeBytes &&
    first.mcpServerScope === second.mcpServerScope &&
    sameEventCorrelation(first, second)
  );
}

function isLlmRequestSignal(
  signal: ClaudeCodeOtelSideTableSignal
): signal is ClaudeCodeLlmRequestSignal {
  return signal.type === ClaudeCodeOtelSignalType.LlmRequest;
}

/**
 * `claude_code_llm_request`'s natural key — the producer's own span identity.
 *
 * Unlike the log-record guards, this key needs no timestamp or occurrence
 * counter: a span id is unique within its trace by the OTel spec, so two
 * signals reaching here describe one request and a difference between them is a
 * real conflict rather than two events landing in the same millisecond.
 */
function llmRequestKeyOf(signal: ClaudeCodeLlmRequestSignal): string {
  return joinSignalKey([signal.traceId, signal.spanId]);
}

/**
 * Wider than the `api_request` reader's `number | undefined` because this span
 * reports strings and booleans beside its counts; every member compares by
 * `===`, so nothing here may be an object.
 */
type LlmRequestFieldValue = string | number | boolean | undefined;

/**
 * How to read each field an `llm_request` span reports; `null` marks a field
 * that identifies the span rather than describing the request it made.
 *
 * TOTAL over the signal's keys for the reason {@link API_REQUEST_MEASUREMENTS}
 * gives, and this signal is where that reason bites hardest: it carries the
 * beta tier's whole attribute set, so a hand-written list omitting one reads
 * two spans that disagree on only that field as an identical repeat and drops
 * the second UNCOUNTED. `finishReasons` and `responseHasToolCall` are two of
 * the four attributes this span exists to carry, and a list is the shape that
 * loses them silently. Keyed this way, the next field fails typecheck instead.
 *
 * Only the discriminant and the natural key are identity here. `sessionId` and
 * `startedAt` are NOT: a span id is unique within its trace, so two signals
 * disagreeing on which session or instant produced it is a real conflict and
 * belongs in `unusable` rather than being absorbed as a repeat.
 */
const LLM_REQUEST_MEASUREMENTS: Record<
  keyof ClaudeCodeLlmRequestSignal,
  ((signal: ClaudeCodeLlmRequestSignal) => LlmRequestFieldValue) | null
> = {
  type: null,
  traceId: null,
  spanId: null,
  sessionId: (signal) => signal.sessionId,
  parentSpanId: (signal) => signal.parentSpanId,
  startedAt: (signal) => signal.startedAt,
  model: (signal) => signal.model,
  querySource: (signal) => signal.querySource,
  speed: (signal) => signal.speed,
  requestContext: (signal) => signal.requestContext,
  durationMs: (signal) => signal.durationMs,
  ttftMs: (signal) => signal.ttftMs,
  stopReason: (signal) => signal.stopReason,
  finishReasons: (signal) => signal.finishReasons,
  responseHasToolCall: (signal) => signal.responseHasToolCall,
  attempt: (signal) => signal.attempt,
  success: (signal) => signal.success,
  statusCode: (signal) => signal.statusCode,
  requestId: (signal) => signal.requestId,
  clientRequestId: (signal) => signal.clientRequestId,
  responseId: (signal) => signal.responseId,
  agentId: (signal) => signal.agentId,
  parentAgentId: (signal) => signal.parentAgentId,
  workflowRunId: (signal) => signal.workflowRunId,
  workflowName: (signal) => signal.workflowName,
  inputTokens: (signal) => signal.inputTokens,
  outputTokens: (signal) => signal.outputTokens,
  cacheReadTokens: (signal) => signal.cacheReadTokens,
  cacheCreationTokens: (signal) => signal.cacheCreationTokens,
};

/** Whether two key-colliding llm_request spans report the same request. */
function sameLlmRequestMeasurements(
  first: ClaudeCodeLlmRequestSignal,
  second: ClaudeCodeLlmRequestSignal
): boolean {
  return Object.values(LLM_REQUEST_MEASUREMENTS).every(
    (read) => read === null || read(first) === read(second)
  );
}

function joinSignalKey(parts: readonly string[]): string {
  return parts.join(SIGNAL_KEY_SEPARATOR);
}

/**
 * Collapses a batch's identity readings of one session into a single signal.
 *
 * Reuses the delta-counter machinery for its keep-first-position behaviour, not
 * because identity is additive: the merge itself is a field-wise UNION, since
 * the producer stamps `organization.id` only after a session authenticates and
 * a batch spanning that moment carries one record without it and a later one
 * with it. Summing is what the counters do; taking the later reading whole is
 * what this must NOT do.
 */
export function mergeSessionIdentitySignals(
  signals: ClaudeCodeOtelSideTableSignal[]
): ClaudeCodeOtelSideTableSignal[] {
  return aggregateDeltaSignals(
    signals,
    isSessionIdentitySignal,
    (signal) => signal.sessionId,
    mergeSessionIdentity
  );
}
