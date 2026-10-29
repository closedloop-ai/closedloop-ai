import { canStoreAuthoritativeCostUsd } from "@repo/api/src/constants";
import {
  asOtlpRecordArray,
  decodeOtlpAttributes,
  groupOtlpLogRecordsByResource,
  groupOtlpMetricsByResource,
  groupOtlpSpansByResource,
  numberFromOtlpValue,
  type OtlpResourceGroup,
} from "../otlp/decode-utilities.js";
import {
  identifiesClaude,
  otlpIdentityValues,
} from "../otlp/harness-identity.js";
import { OtlpExportKind } from "../otlp/proto-descriptor.js";
import type { NormalizedOtlpExport } from "../telemetry/otlp-http-receiver.js";
import { asRecord } from "../util/api-response-utils.js";
import {
  ClaudeCodeOtelAttributeKey,
  eventTimeMsFrom,
  isoFromEpochMs,
  isoFromUnixNano,
  nonNegativeMeasurement,
  readString,
  trimmedString,
  withoutUndefinedValues,
} from "./claude-code-otel-attributes.js";
import {
  ClaudeCodeAttributionAttributeKey,
  type ClaudeCodeComponentAttribution,
} from "./claude-code-otel-attribution.js";
import {
  activeTimeSignalFrom,
  linesOfCodeSignalFrom,
  sessionStartSignalFrom,
} from "./claude-code-otel-counter-signals.js";
import { sessionIdentitySignalFrom } from "./claude-code-otel-identity.js";
import {
  isRecognizedEventName,
  logSignalFor,
} from "./claude-code-otel-log-signals.js";
import {
  type ClaudeCodeOtelSideTableSignal,
  ClaudeCodeOtelSignalType,
} from "./claude-code-otel-signal-contract.js";
import {
  aggregateCounterSignals,
  mergeSessionIdentitySignals,
  refuseLogSignalCollisions,
} from "./claude-code-otel-signal-reduction.js";
import {
  isRecognizedSpanName,
  spanSignalFor,
} from "./claude-code-otel-trace-signals.js";

/**
 * Claude Code metric names this normalizer recognizes.
 *
 * `claude_code.token.usage` is deliberately absent: its only existing home is
 * the `token_usage` table, which the transcript parser also writes and whose
 * unique key is `(session_id, model)`. Routing OTel into it would silently
 * decide which source wins — ISS-7352 open question #2 — so per-request token
 * counts are captured through `claude_code.api_request` instead, into the
 * OTel-owned `claude_code_api_request` table.
 */
export const ClaudeCodeOtelMetricName = {
  CostUsage: "claude_code.cost.usage",
  /** ISS-7352 item G. */
  LinesOfCode: "claude_code.lines_of_code.count",
  SessionCount: "claude_code.session.count",
  /** ISS-7352 item D — GA, despite the rest of item D riding the beta spans. */
  ActiveTime: "claude_code.active_time.total",
} as const;
export type ClaudeCodeOtelMetricName =
  (typeof ClaudeCodeOtelMetricName)[keyof typeof ClaudeCodeOtelMetricName];

/** `opentelemetry.proto.metrics.v1.AggregationTemporality`. */
export const OtlpAggregationTemporality = {
  Unspecified: 0,
  Delta: 1,
  Cumulative: 2,
} as const;
export type OtlpAggregationTemporality =
  (typeof OtlpAggregationTemporality)[keyof typeof OtlpAggregationTemporality];

/**
 * `token_usage` is excluded at the TYPE level, not merely never constructed, so
 * a later edit that reaches for it fails typecheck instead of quietly taking
 * ownership of a table the transcript parser also writes (see
 * {@link ClaudeCodeOtelMetricName}).
 *
 * The exclusion itself is owned by `claude-code-otel-signal-contract.ts`, which
 * is also where the db-host boundary's runtime check reads its discriminant —
 * one definition, so the producer and the boundary cannot disagree about what
 * the OTel lane may write.
 */
export type NormalizedClaudeCodeOtelSignal = ClaudeCodeOtelSideTableSignal;

export type ClaudeCodeOtelNormalizationResult = {
  signals: NormalizedClaudeCodeOtelSignal[];
  /**
   * Signals this normalizer RECOGNIZED but could not turn into a row — a
   * counter reported with non-delta temporality, a record missing an
   * identifying attribute, or one of two differing records that reduce to
   * the same natural key (see `refuseLogSignalCollisions`, which is why
   * this can exceed the count of records that failed to parse). A metric or
   * event whose name we do not handle is NOT counted: Claude Code exports 8
   * metrics and 15 events and we claim a subset, so counting the rest would
   * make this number describe our scope rather than a data problem.
   */
  unusable: number;
  /**
   * ISS-10722 (ISS-7481): the subset of {@link unusable} that is a NATURAL-KEY
   * COLLISION — two differing records reducing to one stored row, which is the
   * `tool_decision` overwrite path. Reported separately because the counter is
   * "by kind": a collision means the table is a LOWER BOUND on decisions, which
   * is a different disclosure from a record the normalizer could not read.
   */
  keyCollisions: number;
};

/** Stripped from a qualified `event.name` before matching — see `readEventName`. */
const CLAUDE_CODE_EVENT_NAME_PREFIX = "claude_code.";

/**
 * Turns one decoded Claude Code OTLP export into the signals
 * `persistClaudeCodeOtelSignals` accepts. Callers hand the result straight to
 * that persister, which re-validates: this function narrows and shapes, the
 * Zod contract there is what admits a row.
 */
export function normalizeClaudeCodeOtelExport(
  payload: NormalizedOtlpExport
): ClaudeCodeOtelNormalizationResult {
  if (payload.kind === OtlpExportKind.Metrics) {
    return normalizeMetricExport(payload.decodedPayload);
  }
  if (payload.kind === OtlpExportKind.Logs) {
    return normalizeLogExport(payload.decodedPayload);
  }
  // Traces carry the CLAUDE_CODE_ENHANCED_TELEMETRY_BETA span tier — the BETA
  // half of ISS-7352 capture list item D, and the only carrier of `ttft_ms`,
  // `stop_reason`, `gen_ai.response.finish_reasons` and
  // `response.has_tool_call`. Nothing here sets that variable, so on an install
  // without it no span arrives and this branch returns an empty result.
  // Item D's GA half — `active_time.total` and `cost_usd_micros` — does not
  // come through here and is captured above.
  return normalizeTraceExport(payload.decodedPayload);
}

/**
 * The builder for each counter this lane claims.
 *
 * A Map rather than an object literal because `metric.name` comes straight off
 * an external export, and `{}["constructor"]` is not `undefined`.
 */
const METRIC_POINT_BUILDERS = new Map<
  string,
  (
    attributes: Record<string, unknown>,
    dataPoint: Record<string, unknown>
  ) => NormalizedClaudeCodeOtelSignal | null
>([
  [ClaudeCodeOtelMetricName.CostUsage, costUsageSignalFrom],
  [ClaudeCodeOtelMetricName.LinesOfCode, linesOfCodeSignalFrom],
  [ClaudeCodeOtelMetricName.SessionCount, sessionStartSignalFrom],
  [ClaudeCodeOtelMetricName.ActiveTime, activeTimeSignalFrom],
]);

function normalizeMetricExport(
  decodedPayload: Record<string, unknown>
): ClaudeCodeOtelNormalizationResult {
  const signals: NormalizedClaudeCodeOtelSignal[] = [];
  let unusable = 0;

  for (const metric of claudeLeavesOf(
    groupOtlpMetricsByResource(
      asOtlpRecordArray(decodedPayload.resourceMetrics)
    )
  )) {
    const build =
      typeof metric.name === "string"
        ? METRIC_POINT_BUILDERS.get(metric.name)
        : undefined;
    if (build === undefined) {
      continue;
    }
    const sum = asRecord(metric.sum);
    const dataPoints = asOtlpRecordArray(sum.dataPoints);
    // Claude Code defaults to delta temporality. A cumulative point carries a
    // running total, and none of these tables has a column that records which
    // it is — persisting both shapes into one table would make any sum over it
    // wrong in a way no reader could detect.
    if (
      numberFromOtlpValue(sum.aggregationTemporality) !==
      OtlpAggregationTemporality.Delta
    ) {
      unusable += dataPoints.length;
      continue;
    }
    for (const dataPoint of dataPoints) {
      const attributes = decodeOtlpAttributes(
        asOtlpRecordArray(dataPoint.attributes)
      );
      pushSessionIdentity(
        signals,
        attributes,
        isoFromUnixNano(dataPoint.timeUnixNano)
      );
      const signal = build(attributes, dataPoint);
      if (signal) {
        signals.push(signal);
      } else {
        unusable += 1;
      }
    }
  }

  return {
    signals: mergeSessionIdentitySignals(aggregateCounterSignals(signals)),
    unusable,
    keyCollisions: 0,
  };
}

function normalizeLogExport(
  decodedPayload: Record<string, unknown>
): ClaudeCodeOtelNormalizationResult {
  const signals: NormalizedClaudeCodeOtelSignal[] = [];
  let unusable = 0;

  for (const record of claudeLeavesOf(
    groupOtlpLogRecordsByResource(
      asOtlpRecordArray(decodedPayload.resourceLogs)
    )
  )) {
    // The log BODY is never read. On some event types it carries prompt or
    // response text; the event name lives in an attribute.
    const attributes = decodeOtlpAttributes(
      asOtlpRecordArray(record.attributes)
    );
    const eventName = readEventName(attributes, record);
    const recognized = isRecognizedEventName(eventName);
    const signal = logSignalFor(eventName, attributes, record);
    // Harvested from every record whose signal this lane CLAIMS, including one
    // that then fails to become a row. NOT from an unclaimed record: that would
    // write an identity row for a session no other table mentions.
    if (recognized || signal) {
      pushSessionIdentity(
        signals,
        attributes,
        isoFromEpochMs(eventTimeMsFrom(attributes, record))
      );
    }
    if (signal) {
      signals.push(signal);
      continue;
    }
    if (recognized) {
      unusable += 1;
    }
  }

  const deduped = refuseLogSignalCollisions(signals);
  return {
    signals: mergeSessionIdentitySignals(deduped.signals),
    unusable: unusable + deduped.refused,
    keyCollisions: deduped.refused,
  };
}

/**
 * The event's identity, as the two places Claude Code can put it.
 *
 * The published reference spells the event `claude_code.api_request` but sets
 * the `event.name` attribute to the BARE `api_request` — which is why
 * `ClaudeCodeOtelEventName` holds bare values while
 * {@link ClaudeCodeOtelMetricName} holds fully-qualified ones: each constant
 * carries what that signal actually puts on the wire, and the two conventions
 * differ because the producer's do.
 *
 * Both spellings are accepted anyway. This is a version-skewed external
 * producer, the qualified form is what its own docs headline, and a CLI that
 * starts emitting it would otherwise silently stop being captured. The OTLP
 * LogRecord `event_name` field is read as a last resort for the same reason.
 */
function readEventName(
  attributes: Record<string, unknown>,
  record: Record<string, unknown>
): string | undefined {
  const stamped =
    readString(attributes, ClaudeCodeOtelAttributeKey.EventName) ??
    trimmedString(record.eventName);
  if (stamped === undefined) {
    return undefined;
  }
  return stamped.startsWith(CLAUDE_CODE_EVENT_NAME_PREFIX)
    ? stamped.slice(CLAUDE_CODE_EVENT_NAME_PREFIX.length)
    : stamped;
}

function costUsageSignalFrom(
  attributes: Record<string, unknown>,
  dataPoint: Record<string, unknown>
): NormalizedClaudeCodeOtelSignal | null {
  const sessionId = readString(
    attributes,
    ClaudeCodeOtelAttributeKey.SessionId
  );
  const model = readString(attributes, ClaudeCodeOtelAttributeKey.Model);
  const observedAt = isoFromUnixNano(dataPoint.timeUnixNano);
  // `as_double`/`as_int` are oneof members, which proto3 always puts on the
  // wire — a genuine 0 arrives as 0, so an absent value means the datapoint
  // carried no measurement at all rather than a zero-cost interval.
  const costUsd = storableCostUsd(
    nonNegativeMeasurement(
      numberFromOtlpValue(dataPoint.asDouble) ??
        numberFromOtlpValue(dataPoint.asInt)
    )
  );
  if (!(sessionId && model && observedAt) || costUsd === undefined) {
    return null;
  }
  return {
    type: ClaudeCodeOtelSignalType.CostUsage,
    sessionId,
    model,
    observedAt,
    costUsd,
    ...componentAttributionFrom(attributes),
  };
}

/**
 * ISS-7352 item E — the component attribution riding on a cost counter.
 *
 * Absent keys stay ABSENT rather than becoming `null`: the persister maps
 * `undefined` to a NULL column itself, and an explicitly-present `null` would
 * defeat the `key in attributes` distinction the readers rely on elsewhere.
 */
function componentAttributionFrom(
  attributes: Record<string, unknown>
): ClaudeCodeComponentAttribution {
  return withoutUndefinedValues({
    agentName: readString(
      attributes,
      ClaudeCodeAttributionAttributeKey.AgentName
    ),
    skillName: readString(
      attributes,
      ClaudeCodeAttributionAttributeKey.SkillName
    ),
    pluginName: readString(
      attributes,
      ClaudeCodeAttributionAttributeKey.PluginName
    ),
    marketplaceName: readString(
      attributes,
      ClaudeCodeAttributionAttributeKey.MarketplaceName
    ),
    mcpServerName: readString(
      attributes,
      ClaudeCodeAttributionAttributeKey.McpServerName
    ),
    mcpToolName: readString(
      attributes,
      ClaudeCodeAttributionAttributeKey.McpToolName
    ),
    querySource: readString(
      attributes,
      ClaudeCodeAttributionAttributeKey.QuerySource
    ),
    speed: readString(attributes, ClaudeCodeAttributionAttributeKey.Speed),
    effort: readString(attributes, ClaudeCodeAttributionAttributeKey.Effort),
  });
}

/**
 * The leaves of ONLY those resource containers that identify as Claude Code.
 *
 * The receiver's harness discrimination covers a whole export: one resource
 * saying `claude-code` makes the entire request Claude's. An OTLP request may
 * carry several resource containers, so a co-batched non-Claude `api_request`
 * would then be persisted as Claude data (ISS-7352 review). Re-deciding per
 * container preserves resource identity; it can only ever narrow what the
 * receiver already admitted, never widen it.
 */
function claudeLeavesOf(
  groups: OtlpResourceGroup[]
): Record<string, unknown>[] {
  return groups
    .filter((group) =>
      identifiesClaude(
        otlpIdentityValues({
          names: leafNamesOf(group.leaves),
          resourceAttributes: [group.resourceAttributes],
        })
      )
    )
    .flatMap((group) => group.leaves);
}

/**
 * The identity-bearing names inside a container's leaves.
 *
 * Metrics carry their producer in the metric name (`claude_code.cost.usage`),
 * which is the only identity a metrics container is guaranteed to have when the
 * resource is sparse. Log records carry none — their `event.name` is bare
 * (`api_request`) — so a logs container is identified by its resource alone,
 * which is what Claude Code stamps (`service.name`).
 */
function leafNamesOf(leaves: Record<string, unknown>[]): string[] {
  const names: string[] = [];
  for (const leaf of leaves) {
    if (typeof leaf.name === "string") {
      names.push(leaf.name);
    }
  }
  return names;
}

/**
 * A cost data point the whole pipeline can actually store, or `undefined`.
 *
 * ISS-7229 (whitlockk, #6385 review): `nonNegativeMeasurement` admits any finite
 * non-negative number, so a `1e100` point was summed into
 * `sessions.authoritative_cost_usd` and then synced at a magnitude the cloud's
 * `Decimal(14,6)` column cannot hold. The cloud's own parse already rejects such
 * a figure, so the two ends disagreed: the desktop stored a number the cloud
 * read back as absent.
 *
 * REJECTED HERE, at the point the value is READ, for the same reason the
 * non-negative guard runs here rather than at the persister's Zod boundary —
 * colliding points are SUMMED before they reach it, so an unstorable point
 * netted against valid ones arrives as an innocuous total and takes them down
 * with it.
 *
 * Rejected rather than clamped: a clamped cost is a confident wrong measurement,
 * and absence is honest about a figure we cannot store. The test is the shared
 * {@link canStoreAuthoritativeCostUsd}, not a local inequality, because the value
 * that makes the two ends agree is the cloud column's width — and because that
 * predicate rounds to the column's six decimals first, which the inequality
 * written here did not, admitting the sliver that rounds up past the ceiling.
 */
function storableCostUsd(value: number | undefined): number | undefined {
  if (value === undefined || !canStoreAuthoritativeCostUsd(value)) {
    return undefined;
  }
  return value;
}

/**
 * Appends the identity a record carries, if it carries any — ISS-7352 item F.
 *
 * One signal per RECORD here, collapsed to one per session by
 * {@link mergeSessionIdentitySignals} before the result leaves the normalizer.
 * A record resolving no identifier appends nothing rather than an empty signal,
 * so a session nothing attributes stays unattributed instead of acquiring a row
 * of NULLs. An undecodable `timeUnixNano` is the same refusal for the same
 * reason: `observed_at` is NOT NULL, and a fabricated instant would be a
 * measurement nothing measured.
 */
function pushSessionIdentity(
  signals: NormalizedClaudeCodeOtelSignal[],
  attributes: Record<string, unknown>,
  observedAt: string | undefined
): void {
  if (!observedAt) {
    return;
  }
  const identity = sessionIdentitySignalFrom(attributes, observedAt);
  if (identity) {
    signals.push(identity);
  }
}

/**
 * The signals one traces export carries — ISS-7352 item D's beta half.
 *
 * Grouped per resource container and re-decided by {@link claudeLeavesOf} for
 * the same reason the metric and log paths are: one OTLP request may carry
 * several producers' containers, and a non-Claude one must not be persisted as
 * Claude's. A traces container is identified as Claude's by its SPAN NAMES,
 * which are fully qualified, so no extra identity rule is needed here.
 *
 * A span this lane does not claim is skipped and NOT counted unusable — it is
 * out of scope, not corrupt. A claimed span that could not be turned into a row
 * is counted, so a producer change shows up as a number rather than as silence.
 */
function normalizeTraceExport(
  decodedPayload: Record<string, unknown>
): ClaudeCodeOtelNormalizationResult {
  const signals: NormalizedClaudeCodeOtelSignal[] = [];
  let unusable = 0;
  for (const span of claudeLeavesOf(
    groupOtlpSpansByResource(asOtlpRecordArray(decodedPayload.resourceSpans))
  )) {
    if (!isRecognizedSpanName(span.name)) {
      continue;
    }
    const attributes = decodeOtlpAttributes(asOtlpRecordArray(span.attributes));
    const signal = spanSignalFor(span, attributes);
    if (signal) {
      signals.push(signal);
      continue;
    }
    unusable += 1;
  }
  const deduped = refuseLogSignalCollisions(signals);
  return {
    signals: deduped.signals,
    unusable: unusable + deduped.refused,
    keyCollisions: deduped.refused,
  };
}
