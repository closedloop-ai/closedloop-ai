/**
 * ISS-7352 — the OTLP receiver, wired to persistence, writes the Claude Code
 * signals it used to decode, ACK, and drop.
 *
 * Whether the value it writes is TRUTHFUL (right resource, right arithmetic,
 * corrupt input refused) is the sibling suite,
 * `claude-code-otel-normalization-integrity.test.ts`.
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import { ClaudeCodeOtelAttributeKey } from "../src/main/otel/claude-code-otel-attributes.js";
import {
  ClaudeCodeOtelEventName,
  ClaudeCodeToolDecision,
} from "../src/main/otel/claude-code-otel-log-signals.js";
import {
  ClaudeCodeOtelMetricName,
  type NormalizedClaudeCodeOtelSignal,
  normalizeClaudeCodeOtelExport,
  OtlpAggregationTemporality,
} from "../src/main/otel/claude-code-otel-normalizer.js";
import {
  ClaudeCodeOtelSignalType,
  ClaudeCodeOtelTableName,
  ClaudeCodePermissionDecision,
  ClaudeCodePermissionSource,
} from "../src/main/otel/claude-code-otel-signal-contract.js";
import { OtlpExportKind } from "../src/main/otlp/proto-descriptor.js";
import { OtlpHarness } from "../src/main/telemetry/otlp-http-receiver.js";
import {
  API_REQUEST_AT,
  API_REQUEST_DURATION_MS,
  API_REQUEST_STARTED_AT,
  CONTENT_SENTINEL,
  COST_OBSERVED_AT,
  countRows,
  decodePayload,
  encodeAttributes,
  encodeLogRecords,
  encodePayload,
  MODEL,
  openTestDatabase,
  postOtlp,
  resourceAttributes,
  SESSION_ID,
  seedSession,
  selectRows,
  startWiredReceiver,
  TOOL_DECISION_AT,
  TOOL_NAME,
  unixNano,
} from "./helpers/claude-code-otel-fixtures.js";

const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Every key a normalized signal is allowed to carry, as a compile-time
 * keys-covered guard: adding a field to any variant of
 * {@link NormalizedClaudeCodeOtelSignal} fails typecheck here until it is
 * classified, so a newly-forwarded attribute cannot reach persistence without
 * someone deciding it is an id, a closed enum, or a measure.
 */
const COST_USAGE_KEYS: Record<
  keyof Extract<
    NormalizedClaudeCodeOtelSignal,
    { type: typeof ClaudeCodeOtelSignalType.CostUsage }
  >,
  true
> = {
  type: true,
  sessionId: true,
  model: true,
  observedAt: true,
  costUsd: true,
  // ISS-7352 item E — harness-stamped component attribution.
  agentName: true,
  skillName: true,
  pluginName: true,
  marketplaceName: true,
  mcpServerName: true,
  mcpToolName: true,
  querySource: true,
  speed: true,
  effort: true,
};

const PERMISSION_KEYS: Record<
  keyof Extract<
    NormalizedClaudeCodeOtelSignal,
    { type: typeof ClaudeCodeOtelSignalType.PermissionDecision }
  >,
  true
> = {
  type: true,
  sessionId: true,
  toolName: true,
  observedAt: true,
  decision: true,
  source: true,
  // ISS-7481 — the join to this call's tool_result row, and what proves two
  // parallel auto-approved calls distinct.
  toolUseId: true,
  // ISS-7352 item F — the per-event join keys.
  promptId: true,
  messageUuid: true,
  workflowRunId: true,
  workflowName: true,
};

const API_REQUEST_KEYS: Record<
  keyof Extract<
    NormalizedClaudeCodeOtelSignal,
    { type: typeof ClaudeCodeOtelSignalType.ApiRequest }
  >,
  true
> = {
  type: true,
  sessionId: true,
  model: true,
  startedAt: true,
  durationMs: true,
  costUsd: true,
  // ISS-7352 item D — the exact-integer cost beside the float one.
  costUsdMicros: true,
  inputTokens: true,
  outputTokens: true,
  cacheReadTokens: true,
  cacheCreationTokens: true,
  // ISS-7352 item F — the join keys back to Anthropic's own records.
  requestId: true,
  clientRequestId: true,
  promptId: true,
  messageUuid: true,
  workflowRunId: true,
  workflowName: true,
};

const ERROR_EVENT_KEYS: Record<
  keyof Extract<
    NormalizedClaudeCodeOtelSignal,
    { type: typeof ClaudeCodeOtelSignalType.ErrorEvent }
  >,
  true
> = {
  type: true,
  sessionId: true,
  errorKind: true,
  observedAt: true,
  model: true,
  statusCode: true,
  attempt: true,
  errorCategory: true,
  durationMs: true,
  requestId: true,
  clientRequestId: true,
  refusalCategory: true,
  serverFallbackHop: true,
  hasCategory: true,
  hasExplanation: true,
  errorName: true,
  errorCode: true,
  // ISS-7352 item F — the per-event join keys.
  promptId: true,
  messageUuid: true,
  workflowRunId: true,
  workflowName: true,
};

const PERMISSION_MODE_CHANGE_KEYS: Record<
  keyof Extract<
    NormalizedClaudeCodeOtelSignal,
    { type: typeof ClaudeCodeOtelSignalType.PermissionModeChange }
  >,
  true
> = {
  type: true,
  sessionId: true,
  observedAt: true,
  fromMode: true,
  toMode: true,
  trigger: true,
  // ISS-7352 item F — the per-event join keys.
  promptId: true,
  messageUuid: true,
  workflowRunId: true,
  workflowName: true,
};

const ALLOWED_SIGNAL_KEYS = new Set<string>([
  ...Object.keys(COST_USAGE_KEYS),
  ...Object.keys(PERMISSION_KEYS),
  ...Object.keys(API_REQUEST_KEYS),
  ...Object.keys(ERROR_EVENT_KEYS),
  ...Object.keys(PERMISSION_MODE_CHANGE_KEYS),
]);

const ALLOWED_SIGNAL_STRINGS = new Set<string>([
  ...Object.values(ClaudeCodeOtelSignalType),
  ...Object.values(ClaudeCodePermissionDecision),
  ...Object.values(ClaudeCodePermissionSource),
  SESSION_ID,
  MODEL,
  TOOL_NAME,
]);

test("wired OTLP receiver PERSISTS a decoded Claude Code cost metric", async () => {
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    const { receiver, port, settled } = await startWiredReceiver(db);
    try {
      const response = await postOtlp(
        port,
        "/v1/metrics",
        encodeCostUsageMetric()
      );
      assert.equal(response.status, 200);
      await settled(1);
    } finally {
      await receiver.stop();
    }

    const rows = await selectRows(db, ClaudeCodeOtelTableName.CostEvent);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.session_id, SESSION_ID);
    assert.equal(rows[0]?.model, MODEL);
    assert.equal(Number(rows[0]?.cost_usd), 0.4275);
    assert.equal(rows[0]?.observed_at, COST_OBSERVED_AT);
  } finally {
    await cleanup();
  }
});

test("wired OTLP receiver PERSISTS api_request and tool_decision events", async () => {
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    const { receiver, port, settled } = await startWiredReceiver(db);
    try {
      const response = await postOtlp(port, "/v1/logs", encodeEventLogs());
      assert.equal(response.status, 200);
      await settled(1);
    } finally {
      await receiver.stop();
    }

    const apiRows = await selectRows(db, ClaudeCodeOtelTableName.ApiRequest);
    assert.equal(apiRows.length, 1);
    assert.equal(apiRows[0]?.session_id, SESSION_ID);
    assert.equal(apiRows[0]?.model, MODEL);
    // started_at is the completion stamp less the reported duration.
    assert.equal(apiRows[0]?.started_at, API_REQUEST_STARTED_AT);
    assert.equal(Number(apiRows[0]?.duration_ms), API_REQUEST_DURATION_MS);
    assert.equal(Number(apiRows[0]?.cost_usd), 1.75);
    assert.equal(Number(apiRows[0]?.tokens_input), 100);
    assert.equal(Number(apiRows[0]?.tokens_output), 30);
    assert.equal(Number(apiRows[0]?.tokens_cache_read), 5);
    assert.equal(Number(apiRows[0]?.tokens_cache_creation), 2);

    const permissionRows = await selectRows(
      db,
      ClaudeCodeOtelTableName.PermissionEvent
    );
    assert.equal(permissionRows.length, 1);
    assert.equal(permissionRows[0]?.tool_name, TOOL_NAME);
    assert.equal(
      permissionRows[0]?.decision,
      ClaudeCodePermissionDecision.Deny
    );
    assert.equal(
      permissionRows[0]?.source,
      ClaudeCodePermissionSource.UserAbort
    );
    assert.equal(permissionRows[0]?.observed_at, TOOL_DECISION_AT);
  } finally {
    await cleanup();
  }
});

test("normalized signals carry no prompt, response, tool, or identity content", () => {
  const signals = [
    ...normalizeClaudeCodeOtelExport({
      kind: OtlpExportKind.Metrics,
      harness: OtlpHarness.Claude,
      resourceAttributes: [],
      metricNames: [],
      logSummaries: [],
      spanSummaries: [],
      decodedPayload: decodePayload(
        OtlpExportKind.Metrics,
        encodeCostUsageMetric()
      ),
    }).signals,
    ...normalizeClaudeCodeOtelExport({
      kind: OtlpExportKind.Logs,
      harness: OtlpHarness.Claude,
      resourceAttributes: [],
      metricNames: [],
      logSummaries: [],
      spanSummaries: [],
      decodedPayload: decodePayload(OtlpExportKind.Logs, encodeEventLogs()),
    }).signals,
  ];

  // Positive control: a normalizer that returned nothing would satisfy every
  // assertion below vacuously.
  assert.equal(signals.length, 3);
  assert.equal(
    JSON.stringify(signals).includes(CONTENT_SENTINEL),
    false,
    "a content-bearing attribute reached a normalized signal"
  );

  for (const signal of signals) {
    for (const [key, value] of Object.entries(signal)) {
      assert.equal(
        ALLOWED_SIGNAL_KEYS.has(key),
        true,
        `unexpected signal key: ${key}`
      );
      if (typeof value === "string") {
        assert.equal(
          ALLOWED_SIGNAL_STRINGS.has(value) || ISO_TIMESTAMP_RE.test(value),
          true,
          `signal string is neither a supplied id, a closed-enum member, nor a timestamp: ${key}=${value}`
        );
        continue;
      }
      assert.equal(typeof value, "number", `signal value ${key} is not scalar`);
    }
  }
});

test("an unknown or malformed Claude Code signal never sinks its batch", async () => {
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    const { receiver, port, settled } = await startWiredReceiver(db);
    try {
      const metrics = await postOtlp(
        port,
        "/v1/metrics",
        encodeCumulativeAndUnknownMetrics()
      );
      const logs = await postOtlp(port, "/v1/logs", encodeDegradedEventLogs());
      assert.equal(metrics.status, 200);
      assert.equal(logs.status, 200);
      await settled(1);
    } finally {
      await receiver.stop();
    }

    // A cumulative cost counter and an unrecognized metric wrote nothing —
    // persisting a running total into a delta-shaped table would corrupt it.
    assert.equal(await countRows(db, ClaudeCodeOtelTableName.CostEvent), 0);
    // The api_request missing `cost_usd` wrote nothing, and the unknown event
    // name was ignored — but the well-formed tool_decision beside them landed.
    assert.equal(await countRows(db, ClaudeCodeOtelTableName.ApiRequest), 0);
    const permissionRows = await selectRows(
      db,
      ClaudeCodeOtelTableName.PermissionEvent
    );
    assert.equal(permissionRows.length, 1);
    assert.equal(
      permissionRows[0]?.decision,
      ClaudeCodePermissionDecision.Allow
    );
  } finally {
    await cleanup();
  }
});

test("a qualified event.name, and the OTLP event_name field, are both recognized", async () => {
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    const { receiver, port, settled } = await startWiredReceiver(db);
    try {
      const response = await postOtlp(
        port,
        "/v1/logs",
        encodeAlternateEventNameSpellings()
      );
      assert.equal(response.status, 200);
      await settled(1);
    } finally {
      await receiver.stop();
    }

    // Claude Code's docs headline `claude_code.tool_decision` while the
    // attribute it stamps today is the bare `tool_decision`; a version-skewed
    // producer that switches spelling, or moves the name to the LogRecord's own
    // `event_name` field, must not silently stop being captured.
    const rows = await selectRows(db, ClaudeCodeOtelTableName.PermissionEvent);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.tool_name).sort(), ["Edit", "Read"]);
  } finally {
    await cleanup();
  }
});

test("capture stays closed by default: the flag OFF still ACKs and writes nothing", async () => {
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    const { receiver, port, persistCalls, gateReads } =
      await startWiredReceiver(db, false);
    try {
      const metrics = await postOtlp(
        port,
        "/v1/metrics",
        encodeCostUsageMetric()
      );
      const logs = await postOtlp(port, "/v1/logs", encodeEventLogs());
      // The receiver still speaks OTLP — a closed gate must not turn into an
      // export failure the harness retries forever.
      assert.equal(metrics.status, 200);
      assert.equal(logs.status, 200);
    } finally {
      await receiver.stop();
    }

    // The gate was actually consulted on both exports — without this the two
    // zero-row assertions below would also hold if the receiver had simply
    // never dispatched, which is a different bug wearing the same result.
    assert.equal(gateReads(), 2);
    assert.equal(persistCalls(), 0);
    assert.equal(await countRows(db, ClaudeCodeOtelTableName.CostEvent), 0);
    assert.equal(await countRows(db, ClaudeCodeOtelTableName.ApiRequest), 0);
    assert.equal(
      await countRows(db, ClaudeCodeOtelTableName.PermissionEvent),
      0
    );
  } finally {
    await cleanup();
  }
});

function encodeCostUsageMetric(): Buffer {
  return encodePayload(OtlpExportKind.Metrics, {
    resourceMetrics: [
      {
        resource: { attributes: encodeAttributes(resourceAttributes()) },
        scopeMetrics: [
          {
            metrics: [
              {
                name: ClaudeCodeOtelMetricName.CostUsage,
                sum: {
                  isMonotonic: true,
                  aggregationTemporality: OtlpAggregationTemporality.Delta,
                  dataPoints: [
                    {
                      timeUnixNano: unixNano(COST_OBSERVED_AT),
                      asDouble: 0.4275,
                      attributes: encodeAttributes({
                        [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
                        [ClaudeCodeOtelAttributeKey.Model]: MODEL,
                        "user.email": CONTENT_SENTINEL,
                        "user.groups": CONTENT_SENTINEL,
                      }),
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  });
}

function encodeCumulativeAndUnknownMetrics(): Buffer {
  return encodePayload(OtlpExportKind.Metrics, {
    resourceMetrics: [
      {
        resource: { attributes: encodeAttributes(resourceAttributes()) },
        scopeMetrics: [
          {
            metrics: [
              {
                name: ClaudeCodeOtelMetricName.CostUsage,
                sum: {
                  isMonotonic: true,
                  aggregationTemporality: OtlpAggregationTemporality.Cumulative,
                  dataPoints: [
                    {
                      timeUnixNano: unixNano(COST_OBSERVED_AT),
                      asDouble: 12.5,
                      attributes: encodeAttributes({
                        [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
                        [ClaudeCodeOtelAttributeKey.Model]: MODEL,
                      }),
                    },
                  ],
                },
              },
              // A metric Claude Code exports that this lane does not claim.
              {
                name: "claude_code.active_time.total",
                sum: {
                  aggregationTemporality: OtlpAggregationTemporality.Delta,
                  dataPoints: [
                    {
                      timeUnixNano: unixNano(COST_OBSERVED_AT),
                      asDouble: 42,
                      attributes: encodeAttributes({
                        [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
                      }),
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  });
}

function encodeEventLogs(): Buffer {
  return encodeLogRecords([
    {
      body: { stringValue: CONTENT_SENTINEL },
      timeUnixNano: unixNano(API_REQUEST_AT),
      attributes: encodeAttributes({
        [ClaudeCodeOtelAttributeKey.EventName]:
          ClaudeCodeOtelEventName.ApiRequest,
        [ClaudeCodeOtelAttributeKey.EventTimestamp]: API_REQUEST_AT,
        [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
        [ClaudeCodeOtelAttributeKey.Model]: MODEL,
        [ClaudeCodeOtelAttributeKey.CostUsd]: 1.75,
        [ClaudeCodeOtelAttributeKey.DurationMs]: API_REQUEST_DURATION_MS,
        [ClaudeCodeOtelAttributeKey.InputTokens]: 100,
        [ClaudeCodeOtelAttributeKey.OutputTokens]: 30,
        [ClaudeCodeOtelAttributeKey.CacheReadTokens]: 5,
        [ClaudeCodeOtelAttributeKey.CacheCreationTokens]: 2,
        prompt: CONTENT_SENTINEL,
        response: CONTENT_SENTINEL,
        "user.email": CONTENT_SENTINEL,
      }),
    },
    {
      body: { stringValue: CONTENT_SENTINEL },
      timeUnixNano: unixNano(TOOL_DECISION_AT),
      attributes: encodeAttributes({
        [ClaudeCodeOtelAttributeKey.EventName]:
          ClaudeCodeOtelEventName.ToolDecision,
        [ClaudeCodeOtelAttributeKey.EventTimestamp]: TOOL_DECISION_AT,
        [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
        [ClaudeCodeOtelAttributeKey.ToolName]: TOOL_NAME,
        [ClaudeCodeOtelAttributeKey.Decision]: ClaudeCodeToolDecision.Reject,
        [ClaudeCodeOtelAttributeKey.Source]:
          ClaudeCodePermissionSource.UserAbort,
        tool_parameters: CONTENT_SENTINEL,
        tool_input: CONTENT_SENTINEL,
        error: CONTENT_SENTINEL,
      }),
    },
    // A metrics-tier attribution attribute that must never become a signal.
    {
      body: { stringValue: CONTENT_SENTINEL },
      timeUnixNano: unixNano(TOOL_DECISION_AT),
      attributes: encodeAttributes({
        [ClaudeCodeOtelAttributeKey.EventName]: "user_prompt",
        [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
        prompt: CONTENT_SENTINEL,
      }),
    },
  ]);
}

function encodeAlternateEventNameSpellings(): Buffer {
  return encodeLogRecords([
    // The fully-qualified spelling Claude Code's own reference headlines.
    {
      timeUnixNano: unixNano(TOOL_DECISION_AT),
      attributes: encodeAttributes({
        [ClaudeCodeOtelAttributeKey.EventName]: `claude_code.${ClaudeCodeOtelEventName.ToolDecision}`,
        [ClaudeCodeOtelAttributeKey.EventTimestamp]: TOOL_DECISION_AT,
        [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
        [ClaudeCodeOtelAttributeKey.ToolName]: "Read",
        [ClaudeCodeOtelAttributeKey.Decision]: ClaudeCodeToolDecision.Accept,
        [ClaudeCodeOtelAttributeKey.Source]: ClaudeCodePermissionSource.Config,
      }),
    },
    // No `event.name` attribute at all — the name is on the LogRecord's own
    // `event_name` field (OTLP proto field 12).
    {
      timeUnixNano: unixNano(API_REQUEST_AT),
      eventName: ClaudeCodeOtelEventName.ToolDecision,
      attributes: encodeAttributes({
        [ClaudeCodeOtelAttributeKey.EventTimestamp]: API_REQUEST_AT,
        [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
        [ClaudeCodeOtelAttributeKey.ToolName]: "Edit",
        [ClaudeCodeOtelAttributeKey.Decision]: ClaudeCodeToolDecision.Reject,
        [ClaudeCodeOtelAttributeKey.Source]:
          ClaudeCodePermissionSource.UserReject,
      }),
    },
  ]);
}

function encodeDegradedEventLogs(): Buffer {
  return encodeLogRecords([
    // Recognized event, missing the `cost_usd` this lane refuses to invent.
    {
      timeUnixNano: unixNano(API_REQUEST_AT),
      attributes: encodeAttributes({
        [ClaudeCodeOtelAttributeKey.EventName]:
          ClaudeCodeOtelEventName.ApiRequest,
        [ClaudeCodeOtelAttributeKey.EventTimestamp]: API_REQUEST_AT,
        [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
        [ClaudeCodeOtelAttributeKey.Model]: MODEL,
        [ClaudeCodeOtelAttributeKey.DurationMs]: API_REQUEST_DURATION_MS,
      }),
    },
    // An event class Claude Code may add tomorrow.
    {
      timeUnixNano: unixNano(TOOL_DECISION_AT),
      attributes: encodeAttributes({
        [ClaudeCodeOtelAttributeKey.EventName]: "some_future_event",
        [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
        unexpected_field: "unexpected",
      }),
    },
    // Well-formed, and must survive both of the above.
    {
      timeUnixNano: unixNano(TOOL_DECISION_AT),
      attributes: encodeAttributes({
        [ClaudeCodeOtelAttributeKey.EventName]:
          ClaudeCodeOtelEventName.ToolDecision,
        [ClaudeCodeOtelAttributeKey.EventTimestamp]: TOOL_DECISION_AT,
        [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
        [ClaudeCodeOtelAttributeKey.ToolName]: TOOL_NAME,
        [ClaudeCodeOtelAttributeKey.Decision]: ClaudeCodeToolDecision.Accept,
        [ClaudeCodeOtelAttributeKey.Source]: ClaudeCodePermissionSource.Config,
      }),
    },
  ]);
}

/** A decoded Claude logs export, as the receiver hands one to the normalizer. */
