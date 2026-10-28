/**
 * ISS-7352 (whitlockk + tamsinb review) — the values the OTel lane writes must be
 * TRUE, not merely present.
 *
 * Its sibling `claude-code-otel-receiver-persistence.test.ts` asks whether an
 * export reaches the right table. These ask whether what lands there is the
 * data Claude Code actually reported: not a co-batched neighbour's request,
 * not a rounded-off corruption, not one of two colliding cost points, not a
 * request a key collision overwrote, and not a transcript-owned total written
 * through the wrong door. Several also pin the REPORTED counts, because a loss
 * a caller is told did not happen is the same defect one level up.
 */

import assert from "node:assert/strict";
import { MAX_AUTHORITATIVE_COST_USD } from "@repo/api/src/constants";
import { test } from "vitest";
import { ClaudeCodeOtelAttributeKey } from "../src/main/otel/claude-code-otel-attributes.js";
import {
  ClaudeCodeOtelEventName,
  ClaudeCodeToolDecision,
} from "../src/main/otel/claude-code-otel-log-signals.js";
import {
  ClaudeCodeOtelMetricName,
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
import {
  type NormalizedOtlpExport,
  OtlpHarness,
} from "../src/main/telemetry/otlp-http-receiver.js";
import {
  API_REQUEST_AT,
  API_REQUEST_STARTED_AT,
  apiRequestAttributesFor,
  COST_OBSERVED_AT,
  claudeLogExportOf,
  countRows,
  decodePayload,
  encodeAttributes,
  encodeLogRecords,
  encodePayload,
  MODEL,
  type OtlpAttributeValue,
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

const FOREIGN_SERVICE_NAME = "some-other-cli";
const FOREIGN_MODEL = "not-a-claude-model";
const FIRST_COLLIDING_INPUT_TOKENS = 11;
const FIRST_COLLIDING_OUTPUT_TOKENS = 22;
const SECOND_COLLIDING_INPUT_TOKENS = 3300;
const SECOND_COLLIDING_OUTPUT_TOKENS = 4400;
const REPEATED_INPUT_TOKENS = 7;
const ZONELESS_STAMP_MODEL = "zoneless-stamp-model";
const OFFSET_STAMP_MODEL = "offset-stamp-model";
/** `API_REQUEST_AT`'s wall-clock with the `Z` dropped — the ambiguous form. */
const ZONELESS_EVENT_TIMESTAMP = "2026-06-18T19:00:05.000";
/** The SAME instant as `API_REQUEST_AT`, written with an explicit offset. */
const OFFSET_EVENT_TIMESTAMP = "2026-06-18T14:00:05.000-05:00";
/**
 * The record's own clock, deliberately NOT the stamped wall-clock: the two
 * sources must disagree or neither assertion can tell which one was used.
 */
const AMBIGUOUS_RECORD_AT = "2026-06-18T20:30:00.000Z";
/** {@link AMBIGUOUS_RECORD_AT} less `API_REQUEST_DURATION_MS`. */
const FALLBACK_STARTED_AT = "2026-06-18T20:29:57.500Z";

test("ISS-7352: a co-batched non-Claude resource is not persisted as Claude data", async () => {
  // The receiver classifies a whole export, so ONE resource saying claude-code
  // makes the request Claude's. If the normalizer then walks every resource
  // container, a sibling tool's api_request lands in Claude's table under
  // Claude's session id. Resource identity has to survive into the normalizer.
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    const { receiver, port, settled } = await startWiredReceiver(db);
    try {
      const response = await postOtlp(
        port,
        "/v1/logs",
        encodeCoBatchedForeignAndClaudeLogs()
      );
      assert.equal(response.status, 200);
      await settled(1);
    } finally {
      await receiver.stop();
    }

    const apiRows = await selectRows(db, ClaudeCodeOtelTableName.ApiRequest);
    // Claude's own record is kept — this is a filter, not a shutdown.
    assert.equal(apiRows.length, 1);
    assert.equal(apiRows[0]?.model, MODEL);
    assert.notEqual(apiRows[0]?.model, FOREIGN_MODEL);
  } finally {
    await cleanup();
  }
});

test("ISS-7352: colliding cost data points are summed, not overwritten", async () => {
  // Two data points in one delta interval share timeUnixNano and differ only on
  // `terminal.type`, a dimension this normalizer does not read, so both reduce
  // to the same (session, model, observed_at, attribution_key) upsert key. The
  // upsert REPLACES cost, so without pre-aggregation the second silently erases
  // the first.
  //
  // The differing attribute used to be `query_source`. ISS-7352 item E made
  // that attribute IDENTITY-BEARING, so it no longer belongs in a fixture whose
  // point is two points that are the same series — see the sibling test below,
  // which asserts the opposite outcome for a genuinely attributed pair.
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    const { receiver, port, settled } = await startWiredReceiver(db);
    try {
      const response = await postOtlp(
        port,
        "/v1/metrics",
        encodeCollidingCostDataPoints()
      );
      assert.equal(response.status, 200);
      await settled(1);
    } finally {
      await receiver.stop();
    }

    const rows = await selectRows(db, ClaudeCodeOtelTableName.CostEvent);
    assert.equal(rows.length, 1);
    // 0.25 + 0.75, not whichever point happened to be written last.
    assert.equal(Number(rows[0]?.cost_usd), 1);
  } finally {
    await cleanup();
  }
});

test("ISS-7352: a corrupt cost data point is refused, not netted against a valid one", () => {
  // Aggregation runs BEFORE the persister's Zod boundary, so a point admitted
  // here is summed first and validated second. A negative point nets a valid
  // $1.00 down to $0.60 — a number `finite().nonnegative()` happily admits —
  // and a NaN point destroys the valid measurement outright. Both have to be
  // refused at the point they are read, like every other numeric in the module.
  const { signals, unusable } = normalizeClaudeCodeOtelExport(
    claudeMetricExportOf(encodeCorruptCostDataPoints())
  );

  const costs = signals.filter(
    (signal) => signal.type === ClaudeCodeOtelSignalType.CostUsage
  );
  assert.equal(costs.length, 1);
  // The valid point, UNDIMINISHED: not 0.6 (netted) and not NaN (destroyed).
  assert.equal(costs[0]?.costUsd, 1);
  assert.equal(unusable, 2, "both corrupt points are reported, not absorbed");
});

test("ISS-7229: an unstorable cost point is refused, not summed into the session total", () => {
  // Same hazard as the corrupt point above, one dimension over. `1e100` is
  // finite and non-negative, so every guard that existed admitted it — and it
  // was then summed into `sessions.authoritative_cost_usd` and synced at a
  // magnitude the cloud's `Decimal(14,6)` column cannot hold. The desktop stored
  // a number the cloud reads back as absent (whitlockk, #6385 review).
  //
  // Refused at READ time for the reason this suite already establishes:
  // aggregation runs before the persister's Zod boundary, so an unstorable point
  // netted against valid ones would arrive there innocuous and take them down
  // with it. The bound is the cloud column's width, shared as
  // `MAX_AUTHORITATIVE_COST_USD` rather than restated here.
  const { signals, unusable } = normalizeClaudeCodeOtelExport(
    claudeMetricExportOf(encodeUnstorableCostDataPoints())
  );

  const costs = signals.filter(
    (signal) => signal.type === ClaudeCodeOtelSignalType.CostUsage
  );
  assert.equal(costs.length, 1);
  // The valid point survives at its own value, and the just-under-the-ceiling
  // point is NOT what came through — so the guard cannot be passing by
  // rejecting everything.
  assert.equal(costs[0]?.costUsd, 1);
  assert.equal(unusable, 1, "the unstorable point is reported, not absorbed");
});

test("ISS-7229: a large but storable cost point is kept", () => {
  // The other side of the bound. Without this, a guard that rejected every
  // large figure would pass the case above.
  const { signals, unusable } = normalizeClaudeCodeOtelExport(
    claudeMetricExportOf(encodeLargeStorableCostDataPoint())
  );

  const costs = signals.filter(
    (signal) => signal.type === ClaudeCodeOtelSignalType.CostUsage
  );
  assert.equal(costs.length, 1);
  assert.equal(costs[0]?.costUsd, MAX_AUTHORITATIVE_COST_USD - 1);
  assert.equal(unusable, 0);
});

test("ISS-7352: colliding api_request records do not overwrite each other", async () => {
  // `(session, started_at, model)` is DERIVED from `event.timestamp` less
  // `duration_ms`, so two distinct requests reduce to one upsert key. The
  // upsert REPLACES, so without a collision guard the second silently erases
  // the first while the persister reports both accepted.
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    const { receiver, port, settled } = await startWiredReceiver(db);
    try {
      const response = await postOtlp(
        port,
        "/v1/logs",
        encodeCollidingApiRequests()
      );
      assert.equal(response.status, 200);
      await settled(1);
    } finally {
      await receiver.stop();
    }

    const rows = await selectRows(db, ClaudeCodeOtelTableName.ApiRequest);
    assert.equal(rows.length, 1);
    // The FIRST record, kept whole. Not the second's counts (an overwrite) and
    // not their sum (a request that never happened — `duration_ms` has no
    // honest merge, and it is half of what derived the key).
    assert.equal(Number(rows[0]?.tokens_input), FIRST_COLLIDING_INPUT_TOKENS);
    assert.equal(Number(rows[0]?.tokens_output), FIRST_COLLIDING_OUTPUT_TOKENS);
  } finally {
    await cleanup();
  }
});

test("ISS-7352: a key collision is reported unusable, an identical repeat is not", () => {
  // The counts must stop lying in BOTH directions. A differing record that
  // cannot be kept is a data problem and is reported; an identical repeat is
  // one observation exported twice, its upsert is idempotent, and calling it
  // unusable would report a problem that did not occur.
  const differing = normalizeClaudeCodeOtelExport(
    claudeLogExportOf(encodeCollidingApiRequests())
  );
  assert.equal(
    differing.signals.filter(
      (signal) => signal.type === ClaudeCodeOtelSignalType.ApiRequest
    ).length,
    1
  );
  assert.equal(differing.unusable, 1, "the refused record is reported");

  const identical = normalizeClaudeCodeOtelExport(
    claudeLogExportOf(encodeRepeatedApiRequest())
  );
  assert.equal(
    identical.signals.filter(
      (signal) => signal.type === ClaudeCodeOtelSignalType.ApiRequest
    ).length,
    1
  );
  assert.equal(
    identical.unusable,
    0,
    "a harmless repeat is not a data problem"
  );
});

test("ISS-7352: colliding tool_decision records do not overwrite each other", async () => {
  // `claude_code_permission_event` keys on (session, tool_name, observed_at)
  // and its upsert's update clause rewrites `decision` and `source` — so an
  // accept and a reject of the same tool in one millisecond were BOTH accepted
  // and the later silently won (whitlockk, ISS-7352 review). The guard list is the
  // one place claiming to cover every log-backed table and this table was
  // missing from it. Expected: the FIRST decision, kept whole.
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    const { receiver, port, settled } = await startWiredReceiver(db);
    try {
      const response = await postOtlp(
        port,
        "/v1/logs",
        encodeCollidingToolDecisions()
      );
      assert.equal(response.status, 200);
      await settled(1);
    } finally {
      await receiver.stop();
    }

    const rows = await selectRows(db, ClaudeCodeOtelTableName.PermissionEvent);
    assert.equal(rows.length, 1);
    // `allow` is the first record. `deny` here means the second overwrote it.
    assert.equal(rows[0]?.decision, ClaudeCodePermissionDecision.Allow);
    assert.equal(rows[0]?.source, ClaudeCodePermissionSource.Config);
  } finally {
    await cleanup();
  }
});

test("ISS-7352: a colliding tool_decision is reported unusable, an identical repeat is not", () => {
  // The count half of the case above, which the DB cannot show: a decision that
  // could not be kept is a data problem and must be reported, while the same
  // decision exported twice is one observation and must not be.
  const differing = normalizeClaudeCodeOtelExport(
    claudeLogExportOf(encodeCollidingToolDecisions())
  );
  assert.equal(
    differing.signals.filter(
      (signal) => signal.type === ClaudeCodeOtelSignalType.PermissionDecision
    ).length,
    1
  );
  assert.equal(differing.unusable, 1, "the refused decision is reported");

  const repeated = toolDecisionRecord(ClaudeCodeToolDecision.Accept);
  const identical = normalizeClaudeCodeOtelExport(
    claudeLogExportOf(encodeLogRecords([repeated, repeated]))
  );
  assert.equal(
    identical.signals.filter(
      (signal) => signal.type === ClaudeCodeOtelSignalType.PermissionDecision
    ).length,
    1
  );
  assert.equal(
    identical.unusable,
    0,
    "a harmless repeat is not a data problem"
  );
});

test("ISS-7352: a present-but-invalid token count drops its row instead of reading 0", () => {
  // Math.round turned corrupt input into plausible measurements. A row is
  // valid-or-absent: a fractional or negative count is not a count we observed,
  // and persisting it as 0 would understate usage undetectably.
  const { signals, unusable } = normalizeClaudeCodeOtelExport(
    claudeLogExportOf(encodeInvalidTokenCountEvents())
  );

  const apiRequests = signals.filter(
    (signal) => signal.type === ClaudeCodeOtelSignalType.ApiRequest
  );
  // Only the record whose counts are all absent survives; absence still means
  // 0, which is the column default and cannot overstate usage.
  assert.equal(apiRequests.length, 1);
  assert.equal(apiRequests[0]?.model, MODEL);
  assert.equal(apiRequests[0]?.inputTokens, 0);
  assert.equal(apiRequests[0]?.outputTokens, 0);
  // Three corrupt records are REPORTED, not silently discarded: fractional,
  // negative, and PRESENT-BUT-UNDECODABLE. The last is the one that reads as
  // absent — and silently becomes 0 — if presence is tested by value rather
  // than by key.
  assert.equal(unusable, 3);
});

test("ISS-7352: an unrecognized permission source degrades instead of dropping the decision", () => {
  // Claude Code is version-skewed and adds sources (this PR had to add two it
  // was already emitting). The allow/deny decision is the row's point and we
  // understand it fully; losing it over one unknown attribute is the worse
  // failure.
  const { signals } = normalizeClaudeCodeOtelExport(
    claudeLogExportOf(encodeFutureSourceToolDecision())
  );

  const decisions = signals.filter(
    (signal) => signal.type === ClaudeCodeOtelSignalType.PermissionDecision
  );
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]?.decision, ClaudeCodePermissionDecision.Deny);
  assert.equal(decisions[0]?.source, ClaudeCodePermissionSource.Unknown);
});

test("ISS-7352: a zone-less event.timestamp is refused, an offset one is trusted", () => {
  // `event.timestamp` is the one external STRING this module does arithmetic
  // on. A date-time with no zone designator parses as LOCAL time, and the shift
  // is invisible downstream — it is re-emitted as a well-formed UTC ISO that
  // the persister's regex accepts, and `started_at` is half the row's key.
  //
  // Deliberately NOT pinned with a fake timezone. The stamped wall-clock and
  // the record's `timeUnixNano` name DIFFERENT instants, so trusting the
  // ambiguous string yields the wrong `started_at` under EVERY offset,
  // including a UTC box where a local-vs-UTC assertion would pass vacuously.
  const { signals } = normalizeClaudeCodeOtelExport(
    claudeLogExportOf(encodeAmbiguouslyStampedApiRequests())
  );

  const startedAtByModel = new Map(
    signals
      .filter((signal) => signal.type === ClaudeCodeOtelSignalType.ApiRequest)
      .map((signal) => [signal.model, signal.startedAt])
  );

  // Refused: the export's own epoch-nanos clock is UTC by construction, so the
  // fallback is a better instant than either reading of the ambiguous string.
  assert.equal(
    startedAtByModel.get(ZONELESS_STAMP_MODEL),
    FALLBACK_STARTED_AT,
    "a zone-less stamp falls back to timeUnixNano instead of being guessed"
  );
  // The other direction, so a guard that simply distrusted every stamp — and
  // silently discarded the producer's own more precise instant — cannot pass:
  // an OFFSET form names an unambiguous instant and is still used.
  assert.equal(
    startedAtByModel.get(OFFSET_STAMP_MODEL),
    API_REQUEST_STARTED_AT,
    "an explicit offset is unambiguous and is still trusted over timeUnixNano"
  );
});

test("ISS-7352: the db-host facade refuses a token_usage signal", async () => {
  // token_usage is keyed (session_id, model) and owned by the transcript
  // parser; an OTel write would REPLACE those totals rather than add to them.
  // The parameter type excludes it, but this facade is a process boundary and a
  // type constrains nothing that arrives over IPC.
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    const before = await countRows(db, ClaudeCodeOtelTableName.CostEvent);
    const summary = await db.claudeCodeOtel.persistSignals([
      {
        type: ClaudeCodeOtelSignalType.TokenUsage,
        sessionId: SESSION_ID,
        model: MODEL,
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        // The type excludes token_usage precisely so this cannot be written by
        // accident; the cast is the IPC skew the runtime guard exists for.
      } as unknown as Parameters<
        typeof db.claudeCodeOtel.persistSignals
      >[0][number],
    ]);

    assert.deepEqual(summary, { accepted: 0, rejected: 1 });
    assert.equal(
      await countRows(db, ClaudeCodeOtelTableName.CostEvent),
      before
    );
    const tokenRows = await db.tokenUsage.getBySession(SESSION_ID);
    assert.equal(tokenRows.length, 0, "transcript-owned totals are untouched");
  } finally {
    await cleanup();
  }
});

/**
 * Two resource containers in ONE request: a foreign CLI's api_request and
 * Claude's. The receiver classifies the whole export as Claude because a
 * sibling resource says so, which is exactly the condition under test.
 */
function encodeCoBatchedForeignAndClaudeLogs(): Buffer {
  return encodePayload(OtlpExportKind.Logs, {
    resourceLogs: [
      {
        resource: {
          attributes: encodeAttributes({
            "service.name": FOREIGN_SERVICE_NAME,
          }),
        },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: unixNano(API_REQUEST_AT),
                attributes: encodeAttributes(
                  apiRequestAttributesFor(FOREIGN_MODEL)
                ),
              },
            ],
          },
        ],
      },
      {
        resource: { attributes: encodeAttributes(resourceAttributes()) },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: unixNano(API_REQUEST_AT),
                attributes: encodeAttributes(apiRequestAttributesFor(MODEL)),
              },
            ],
          },
        ],
      },
    ],
  });
}

/**
 * Two delta data points sharing a timestamp, session, and model, differing only
 * on an attribution dimension the normalizer does not read.
 */
function encodeCollidingCostDataPoints(): Buffer {
  const dataPoint = (cost: number, terminalType: string) => ({
    timeUnixNano: unixNano(COST_OBSERVED_AT),
    asDouble: cost,
    attributes: encodeAttributes({
      [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
      [ClaudeCodeOtelAttributeKey.Model]: MODEL,
      "terminal.type": terminalType,
    }),
  });
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
                    dataPoint(0.25, "iTerm.app"),
                    dataPoint(0.75, "vscode"),
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

/**
 * Three api_request events: one with a fractional count, one with a negative
 * count, and one carrying no counts at all.
 */
function encodeInvalidTokenCountEvents(): Buffer {
  const event = (
    model: string,
    counts: Record<string, OtlpAttributeValue>
  ) => ({
    timeUnixNano: unixNano(API_REQUEST_AT),
    attributes: encodeAttributes({
      ...apiRequestAttributesFor(model),
      ...counts,
    }),
  });
  return encodeLogRecords([
    event("fractional-count-model", {
      [ClaudeCodeOtelAttributeKey.InputTokens]: 1.5,
    }),
    event("negative-count-model", {
      [ClaudeCodeOtelAttributeKey.OutputTokens]: -5,
    }),
    event(MODEL, {}),
    // A count attribute that IS present but whose AnyValue carries none of the
    // scalar members, so it decodes to `undefined`. Hand-built because
    // `encodeAttributes` cannot express an empty AnyValue.
    {
      timeUnixNano: unixNano(API_REQUEST_AT),
      attributes: [
        ...encodeAttributes(apiRequestAttributesFor("empty-anyvalue-model")),
        { key: ClaudeCodeOtelAttributeKey.InputTokens, value: {} },
      ],
    },
  ]);
}

/**
 * Three delta points on ONE key: a valid $1.00, a negative, and a NaN. The
 * corrupt two are what summation would launder into a valid-looking total.
 */
function encodeCorruptCostDataPoints(): Buffer {
  const dataPoint = (cost: number, querySource: string) => ({
    timeUnixNano: unixNano(COST_OBSERVED_AT),
    asDouble: cost,
    attributes: encodeAttributes({
      [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
      [ClaudeCodeOtelAttributeKey.Model]: MODEL,
      query_source: querySource,
    }),
  });
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
                    dataPoint(1, "user"),
                    dataPoint(-0.4, "subagent"),
                    dataPoint(Number.NaN, "main"),
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

/** One valid cost point and one past the storable ceiling. */
function encodeUnstorableCostDataPoints(): Buffer {
  return encodeCostDataPoints([
    [1, "user"],
    [1e100, "subagent"],
  ]);
}

/** A single point one dollar under the ceiling — storable, and large. */
function encodeLargeStorableCostDataPoint(): Buffer {
  return encodeCostDataPoints([[MAX_AUTHORITATIVE_COST_USD - 1, "user"]]);
}

function encodeCostDataPoints(points: [number, string][]): Buffer {
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
                  dataPoints: points.map(([cost, querySource]) => ({
                    timeUnixNano: unixNano(COST_OBSERVED_AT),
                    asDouble: cost,
                    attributes: encodeAttributes({
                      [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
                      [ClaudeCodeOtelAttributeKey.Model]: MODEL,
                      query_source: querySource,
                    }),
                  })),
                },
              },
            ],
          },
        ],
      },
    ],
  });
}

/**
 * Two api_request events reducing to ONE `(session, started_at, model)` key —
 * same session, model, `event.timestamp`, and `duration_ms` — reporting
 * different token counts, so they are two distinct requests and not a repeat.
 */
function encodeCollidingApiRequests(): Buffer {
  return encodeLogRecords([
    apiRequestRecord(
      FIRST_COLLIDING_INPUT_TOKENS,
      FIRST_COLLIDING_OUTPUT_TOKENS
    ),
    apiRequestRecord(
      SECOND_COLLIDING_INPUT_TOKENS,
      SECOND_COLLIDING_OUTPUT_TOKENS
    ),
  ]);
}

/** The SAME api_request twice: one observation exported twice, not two. */
function encodeRepeatedApiRequest(): Buffer {
  const record = apiRequestRecord(REPEATED_INPUT_TOKENS, REPEATED_INPUT_TOKENS);
  return encodeLogRecords([record, record]);
}

function apiRequestRecord(inputTokens: number, outputTokens: number): object {
  return {
    timeUnixNano: unixNano(API_REQUEST_AT),
    attributes: encodeAttributes({
      ...apiRequestAttributesFor(MODEL),
      [ClaudeCodeOtelAttributeKey.InputTokens]: inputTokens,
      [ClaudeCodeOtelAttributeKey.OutputTokens]: outputTokens,
    }),
  };
}

/**
 * An accept and a reject of the SAME tool at the SAME instant.
 *
 * They agree on every part of `claude_code_permission_event`'s natural key and
 * disagree on exactly the columns the upsert's update clause rewrites, which is
 * the shape that made the later one win.
 */
function encodeCollidingToolDecisions(): Buffer {
  return encodeLogRecords([
    toolDecisionRecord(ClaudeCodeToolDecision.Accept),
    toolDecisionRecord(ClaudeCodeToolDecision.Reject),
  ]);
}

function toolDecisionRecord(decision: ClaudeCodeToolDecision): object {
  return {
    timeUnixNano: unixNano(TOOL_DECISION_AT),
    attributes: encodeAttributes({
      [ClaudeCodeOtelAttributeKey.EventName]:
        ClaudeCodeOtelEventName.ToolDecision,
      [ClaudeCodeOtelAttributeKey.EventTimestamp]: TOOL_DECISION_AT,
      [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
      [ClaudeCodeOtelAttributeKey.ToolName]: TOOL_NAME,
      [ClaudeCodeOtelAttributeKey.Decision]: decision,
      [ClaudeCodeOtelAttributeKey.Source]: ClaudeCodePermissionSource.Config,
    }),
  };
}

/** A decoded Claude metrics export, as the receiver hands one to the normalizer. */
function claudeMetricExportOf(body: Buffer): NormalizedOtlpExport {
  return {
    kind: OtlpExportKind.Metrics,
    harness: OtlpHarness.Claude,
    resourceAttributes: [],
    metricNames: [],
    logSummaries: [],
    spanSummaries: [],
    decodedPayload: decodePayload(OtlpExportKind.Metrics, body),
  };
}

/** A tool_decision whose `source` is a value no shipped build knows. */
function encodeFutureSourceToolDecision(): Buffer {
  return encodeLogRecords([
    {
      timeUnixNano: unixNano(TOOL_DECISION_AT),
      attributes: encodeAttributes({
        [ClaudeCodeOtelAttributeKey.EventName]:
          ClaudeCodeOtelEventName.ToolDecision,
        [ClaudeCodeOtelAttributeKey.EventTimestamp]: TOOL_DECISION_AT,
        [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
        [ClaudeCodeOtelAttributeKey.ToolName]: TOOL_NAME,
        [ClaudeCodeOtelAttributeKey.Decision]: ClaudeCodeToolDecision.Reject,
        [ClaudeCodeOtelAttributeKey.Source]: "sandbox_policy_from_the_future",
      }),
    },
  ]);
}

/**
 * Two api_request events whose stamped `event.timestamp` and whose record
 * `timeUnixNano` name DIFFERENT instants — one stamp zone-less, one carrying an
 * explicit offset. The disagreement is the whole point: whichever source the
 * normalizer trusted is then readable off `started_at`.
 */
function encodeAmbiguouslyStampedApiRequests(): Buffer {
  const event = (model: string, stamp: string) => ({
    timeUnixNano: unixNano(AMBIGUOUS_RECORD_AT),
    attributes: encodeAttributes({
      ...apiRequestAttributesFor(model),
      [ClaudeCodeOtelAttributeKey.EventTimestamp]: stamp,
    }),
  });
  return encodeLogRecords([
    event(ZONELESS_STAMP_MODEL, ZONELESS_EVENT_TIMESTAMP),
    event(OFFSET_STAMP_MODEL, OFFSET_EVENT_TIMESTAMP),
  ]);
}
