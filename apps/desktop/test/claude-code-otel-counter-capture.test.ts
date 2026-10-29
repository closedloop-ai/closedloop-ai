/**
 * ISS-7352 capture list G — the counters we approximate but do not carry
 * natively: `claude_code.lines_of_code.count`, `claude_code.session.count`, and
 * the result side of a tool invocation.
 *
 * The DB-level cases drive the WIRED receiver, so each one proves the
 * production path — receiver, normalizer, db facade, persister — and not just
 * the unit under it.
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import { ClaudeCodeOtelAttributeKey } from "../src/main/otel/claude-code-otel-attributes.js";
import { ClaudeCodeOtelEventName } from "../src/main/otel/claude-code-otel-log-signals.js";
import {
  ClaudeCodeOtelMetricName,
  normalizeClaudeCodeOtelExport,
  OtlpAggregationTemporality,
} from "../src/main/otel/claude-code-otel-normalizer.js";
import {
  ClaudeCodeOtelSignalType,
  ClaudeCodeOtelTableName,
} from "../src/main/otel/claude-code-otel-signal-contract.js";
import {
  CONTENT_SENTINEL,
  type CounterPoint,
  claudeLogExportOf,
  claudeMetricExportOf,
  encodeAttributes,
  encodeCounterPoints,
  encodeLogRecords,
  MODEL,
  type OtlpAttributeValue,
  openTestDatabase,
  postOtlp,
  SESSION_ID,
  seedSession,
  selectRows,
  startWiredReceiver,
  unixNano,
} from "./helpers/claude-code-otel-fixtures.js";

const LOC_AT = "2026-06-18T19:00:31.000Z";
const SESSION_START_AT = "2026-06-18T19:00:33.000Z";
const TOOL_RESULT_AT = "2026-06-18T19:00:35.000Z";
const OTHER_MODEL = "claude-haiku-4-5";
const TOOL_USE_ID = "toolu_01AAA";
const OTHER_TOOL_USE_ID = "toolu_01BBB";

test("ISS-7352 item G: lines added and removed by one model are two rows, not one total", async () => {
  // The whole reason to carry this counter over our session-level `diffStats`
  // is that it splits churn by DIRECTION and by MODEL. Keyed without
  // `change_type` the two points land on one row and the persister's upsert
  // REPLACES — 120 added silently becomes 40 removed, and no reader could tell
  // an addition from a deletion again. Expected: two rows, 120 and 40.
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    const { receiver, port, settled } = await startWiredReceiver(db);
    try {
      const response = await postOtlp(
        port,
        "/v1/metrics",
        encodeCounterPoints(
          ClaudeCodeOtelMetricName.LinesOfCode,
          [
            locPoint(120, { model: MODEL, changeType: "added" }),
            locPoint(40, { model: MODEL, changeType: "removed" }),
          ],
          OtlpAggregationTemporality.Delta
        )
      );
      assert.equal(response.status, 200);
      await settled(1);
    } finally {
      await receiver.stop();
    }

    const rows = await selectRows(db, ClaudeCodeOtelTableName.LinesOfCode);
    assert.equal(rows.length, 2);
    const byType = new Map(rows.map((row) => [row.change_type as string, row]));
    assert.equal(Number(byType.get("added")?.line_count), 120);
    assert.equal(Number(byType.get("removed")?.line_count), 40);
    for (const row of rows) {
      assert.equal(row.model, MODEL);
      assert.equal(row.observed_at, LOC_AT);
    }
  } finally {
    await cleanup();
  }
});

test("ISS-7352 item G: the same model's churn attributed to two models stays split", async () => {
  // `model` is the second half of what makes this counter worth carrying. Two
  // points that agree on direction and instant and differ only in which model
  // made the change are two facts; collapsing them would attribute all the
  // churn to whichever model happened to arrive first.
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    const { receiver, port, settled } = await startWiredReceiver(db);
    try {
      const response = await postOtlp(
        port,
        "/v1/metrics",
        encodeCounterPoints(
          ClaudeCodeOtelMetricName.LinesOfCode,
          [
            locPoint(120, { model: MODEL, changeType: "added" }),
            locPoint(7, { model: OTHER_MODEL, changeType: "added" }),
          ],
          OtlpAggregationTemporality.Delta
        )
      );
      assert.equal(response.status, 200);
      await settled(1);
    } finally {
      await receiver.stop();
    }

    const rows = await selectRows(db, ClaudeCodeOtelTableName.LinesOfCode);
    assert.equal(rows.length, 2);
    const byModel = new Map(rows.map((row) => [row.model as string, row]));
    assert.equal(Number(byModel.get(MODEL)?.line_count), 120);
    assert.equal(Number(byModel.get(OTHER_MODEL)?.line_count), 7);
  } finally {
    await cleanup();
  }
});

test("ISS-7352 item G: two lines-of-code points on ONE key are summed, not overwritten", async () => {
  // A delta Sum's data points are additive by definition, and two points can
  // land on one key by differing on a dimension we do not read. The persister's
  // upsert REPLACES, so without summing here the second point silently erases
  // the first and the session under-reports its churn. Expected: 160, not 40.
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    const { receiver, port, settled } = await startWiredReceiver(db);
    try {
      const response = await postOtlp(
        port,
        "/v1/metrics",
        encodeCounterPoints(
          ClaudeCodeOtelMetricName.LinesOfCode,
          [
            locPoint(120, { model: MODEL, changeType: "added" }),
            locPoint(40, { model: MODEL, changeType: "added" }),
          ],
          OtlpAggregationTemporality.Delta
        )
      );
      assert.equal(response.status, 200);
      await settled(1);
    } finally {
      await receiver.stop();
    }

    const rows = await selectRows(db, ClaudeCodeOtelTableName.LinesOfCode);
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0]?.line_count), 160);
  } finally {
    await cleanup();
  }
});

test("ISS-7352 item G: a CUMULATIVE lines-of-code export writes nothing and is counted unusable", () => {
  // A cumulative point carries a running total, and the table has no column
  // recording which temporality a row came from. Persisting both shapes into
  // one table would make any sum over it wrong in a way no reader could detect,
  // so the points are refused and REPORTED rather than silently dropped.
  const result = normalizeClaudeCodeOtelExport(
    claudeMetricExportOf(
      encodeCounterPoints(
        ClaudeCodeOtelMetricName.LinesOfCode,
        [
          locPoint(120, { model: MODEL, changeType: "added" }),
          locPoint(40, { model: MODEL, changeType: "removed" }),
        ],
        OtlpAggregationTemporality.Cumulative
      )
    )
  );
  assert.equal(result.signals.length, 0);
  assert.equal(result.unusable, 2);
});

test("ISS-7352 item G: a lines-of-code point with no change_type is refused, not defaulted", () => {
  // The direction is half the measurement. Storing such a point under an
  // invented "added" would be a plausible-but-wrong number a reader could not
  // tell from a real one; the positive sibling above proves a well-formed point
  // on the same derivation IS captured.
  const result = normalizeClaudeCodeOtelExport(
    claudeMetricExportOf(
      encodeCounterPoints(
        ClaudeCodeOtelMetricName.LinesOfCode,
        [
          {
            value: 120,
            observedAt: LOC_AT,
            attributes: {
              [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
              [ClaudeCodeOtelAttributeKey.Model]: MODEL,
            },
          },
        ],
        OtlpAggregationTemporality.Delta
      )
    )
  );
  assert.equal(result.signals.length, 0);
  assert.equal(result.unusable, 1);
});

test("ISS-7352 item G: a session.count point records the start_type that produced it", async () => {
  // Nothing else we collect distinguishes a resumed session from a fresh one —
  // the session row records that the session exists, never how it began.
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    const { receiver, port, settled } = await startWiredReceiver(db);
    try {
      const response = await postOtlp(
        port,
        "/v1/metrics",
        encodeCounterPoints(
          ClaudeCodeOtelMetricName.SessionCount,
          [
            {
              value: 1,
              observedAt: SESSION_START_AT,
              attributes: {
                [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
                [ClaudeCodeOtelAttributeKey.StartType]: "resume",
              },
            },
          ],
          OtlpAggregationTemporality.Delta
        )
      );
      assert.equal(response.status, 200);
      await settled(1);
    } finally {
      await receiver.stop();
    }

    const rows = await selectRows(db, ClaudeCodeOtelTableName.SessionStart);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.start_type, "resume");
    assert.equal(Number(rows[0]?.session_count), 1);
    assert.equal(rows[0]?.observed_at, SESSION_START_AT);
  } finally {
    await cleanup();
  }
});

test("ISS-7352 item G: a failed tool_result carries its sizes, scope and error category", async () => {
  // `claude_code_permission_event` records only whether a call was ALLOWED.
  // Nothing recorded what the call cost in payload, which MCP scope served it,
  // or how it failed. `success` is stored beside `error_type` because a NULL
  // error_type alone cannot tell a success from an uncategorized failure.
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    const { receiver, port, settled } = await startWiredReceiver(db);
    try {
      const response = await postOtlp(
        port,
        "/v1/logs",
        encodeLogRecords([
          toolResultRecord({
            [ClaudeCodeOtelAttributeKey.ToolName]: "Bash",
            [ClaudeCodeOtelAttributeKey.ToolUseId]: TOOL_USE_ID,
            [ClaudeCodeOtelAttributeKey.Success]: "false",
            [ClaudeCodeOtelAttributeKey.ErrorType]: "Error:ENOENT",
            [ClaudeCodeOtelAttributeKey.ToolInputSizeBytes]: 512,
            [ClaudeCodeOtelAttributeKey.ToolResultSizeBytes]: 4096,
            [ClaudeCodeOtelAttributeKey.McpServerScope]: "project",
          }),
        ])
      );
      assert.equal(response.status, 200);
      await settled(1);
    } finally {
      await receiver.stop();
    }

    const rows = await selectRows(db, ClaudeCodeOtelTableName.ToolResult);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row?.tool_name, "Bash");
    assert.equal(row?.tool_use_id, TOOL_USE_ID);
    // Guarded against NULL before the numeric compare: `Number(null)` is 0, and
    // a NULL `success` beside a NULL `error_type` is exactly the state this
    // column exists to rule out.
    assert.notEqual(row?.success, null);
    assert.equal(Number(row?.success), 0);
    assert.equal(row?.error_type, "Error:ENOENT");
    assert.equal(Number(row?.tool_input_size_bytes), 512);
    assert.equal(Number(row?.tool_result_size_bytes), 4096);
    assert.equal(row?.mcp_server_scope, "project");
  } finally {
    await cleanup();
  }
});

test("ISS-7352 item G: two tool results in one millisecond stay separate rows per tool_use_id", async () => {
  // Parallel tool calls complete inside one millisecond routinely. Keyed on
  // (session, tool_name, observed_at) alone the second REPLACES the first, and
  // a table meant to measure payload sizes would under-count every burst.
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    const { receiver, port, settled } = await startWiredReceiver(db);
    try {
      const response = await postOtlp(
        port,
        "/v1/logs",
        encodeLogRecords([
          toolResultRecord({
            [ClaudeCodeOtelAttributeKey.ToolName]: "Bash",
            [ClaudeCodeOtelAttributeKey.ToolUseId]: TOOL_USE_ID,
            [ClaudeCodeOtelAttributeKey.ToolResultSizeBytes]: 4096,
          }),
          toolResultRecord({
            [ClaudeCodeOtelAttributeKey.ToolName]: "Bash",
            [ClaudeCodeOtelAttributeKey.ToolUseId]: OTHER_TOOL_USE_ID,
            [ClaudeCodeOtelAttributeKey.ToolResultSizeBytes]: 128,
          }),
        ])
      );
      assert.equal(response.status, 200);
      await settled(1);
    } finally {
      await receiver.stop();
    }

    const rows = await selectRows(db, ClaudeCodeOtelTableName.ToolResult);
    assert.equal(rows.length, 2);
    const byUseId = new Map(
      rows.map((row) => [row.tool_use_id as string, row])
    );
    assert.equal(
      Number(byUseId.get(TOOL_USE_ID)?.tool_result_size_bytes),
      4096
    );
    assert.equal(
      Number(byUseId.get(OTHER_TOOL_USE_ID)?.tool_result_size_bytes),
      128
    );
  } finally {
    await cleanup();
  }
});

test("ISS-7352 item G: two tool results on ONE key with different sizes refuse the second", () => {
  // `sameToolResultDetail` is the guard here. Both records carry the same
  // `tool_use_id`, so they claim to be the SAME invocation while reporting
  // different payload sizes — one of them is wrong, and the upsert would
  // silently keep whichever arrived last. A tool result is the record of one
  // invocation and has no honest merge, so the differing second is refused.
  const result = normalizeClaudeCodeOtelExport(
    claudeLogExportOf(
      encodeLogRecords([
        toolResultRecord({
          [ClaudeCodeOtelAttributeKey.ToolName]: "Bash",
          [ClaudeCodeOtelAttributeKey.ToolUseId]: TOOL_USE_ID,
          [ClaudeCodeOtelAttributeKey.ToolResultSizeBytes]: 4096,
        }),
        toolResultRecord({
          [ClaudeCodeOtelAttributeKey.ToolName]: "Bash",
          [ClaudeCodeOtelAttributeKey.ToolUseId]: TOOL_USE_ID,
          [ClaudeCodeOtelAttributeKey.ToolResultSizeBytes]: 128,
        }),
      ])
    )
  );
  assert.equal(result.signals.length, 1);
  assert.equal(result.unusable, 1);
  const [signal] = result.signals;
  assert.equal(
    signal?.type === ClaudeCodeOtelSignalType.ToolResult
      ? signal.toolResultSizeBytes
      : undefined,
    4096
  );
});

test("ISS-7352 item G: an identical repeated tool result collapses WITHOUT being counted unusable", () => {
  // The positive sibling of the tool-result refusal above, on the same
  // derivation. An OTLP exporter retries a batch it did not see ACKed, so the
  // same invocation arrives twice; its upsert is idempotent.
  const record = toolResultRecord({
    [ClaudeCodeOtelAttributeKey.ToolName]: "Bash",
    [ClaudeCodeOtelAttributeKey.ToolUseId]: TOOL_USE_ID,
    [ClaudeCodeOtelAttributeKey.ToolResultSizeBytes]: 4096,
  });
  const result = normalizeClaudeCodeOtelExport(
    claudeLogExportOf(encodeLogRecords([record, record]))
  );
  assert.equal(result.signals.length, 1);
  assert.equal(result.unusable, 0);
});

test("ISS-7352 item G: two session.count points on ONE key are summed, not overwritten", async () => {
  // The session counter gets the SAME delta treatment as lines-of-code, and
  // that is not free: `aggregateCounterSignals` runs a separate pass per
  // counter, so a pass that was never wired would leave this table silently
  // taking the last point instead of the total. Expected: 3, not 1.
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    const { receiver, port, settled } = await startWiredReceiver(db);
    try {
      const response = await postOtlp(
        port,
        "/v1/metrics",
        encodeCounterPoints(
          ClaudeCodeOtelMetricName.SessionCount,
          [startPoint(1, "resume"), startPoint(2, "resume")],
          OtlpAggregationTemporality.Delta
        )
      );
      assert.equal(response.status, 200);
      await settled(1);
    } finally {
      await receiver.stop();
    }

    const rows = await selectRows(db, ClaudeCodeOtelTableName.SessionStart);
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0]?.session_count), 3);
  } finally {
    await cleanup();
  }
});

test("ISS-7352 item G: session.count points with different start_types stay split", async () => {
  // `start_type` is the reason to carry this counter at all, and it is in the
  // natural key for that reason: a resume and a fresh start reported at one
  // instant are two facts, and merging them would lose the only signal that
  // distinguishes them.
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    const { receiver, port, settled } = await startWiredReceiver(db);
    try {
      const response = await postOtlp(
        port,
        "/v1/metrics",
        encodeCounterPoints(
          ClaudeCodeOtelMetricName.SessionCount,
          [startPoint(1, "resume"), startPoint(1, "fresh")],
          OtlpAggregationTemporality.Delta
        )
      );
      assert.equal(response.status, 200);
      await settled(1);
    } finally {
      await receiver.stop();
    }

    const rows = await selectRows(db, ClaudeCodeOtelTableName.SessionStart);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.start_type).sort(), [
      "fresh",
      "resume",
    ]);
  } finally {
    await cleanup();
  }
});

test("ISS-7352 item G: a CUMULATIVE session.count export writes nothing and is counted unusable", () => {
  // The temporality guard is applied per METRIC, not once for the export, so
  // the lines-of-code case cannot vouch for this one. A cumulative point is a
  // running total and this table has no column recording which it is.
  const result = normalizeClaudeCodeOtelExport(
    claudeMetricExportOf(
      encodeCounterPoints(
        ClaudeCodeOtelMetricName.SessionCount,
        [startPoint(1, "resume")],
        OtlpAggregationTemporality.Cumulative
      )
    )
  );
  assert.equal(result.signals.length, 0);
  assert.equal(result.unusable, 1);
});

test("ISS-7352 item G: a session.count point with no start_type is refused, not defaulted", () => {
  // Storing such a point under an invented "fresh" would be a
  // plausible-but-wrong value a reader could not tell from a real one — and
  // "fresh" is the value a reader would most likely trust.
  const result = normalizeClaudeCodeOtelExport(
    claudeMetricExportOf(
      encodeCounterPoints(
        ClaudeCodeOtelMetricName.SessionCount,
        [
          {
            value: 1,
            observedAt: SESSION_START_AT,
            attributes: {
              [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
            },
          },
        ],
        OtlpAggregationTemporality.Delta
      )
    )
  );
  assert.equal(result.signals.length, 0);
  assert.equal(result.unusable, 1);
});

test("ISS-7352 item G: a metric point whose counter value is not a whole count is refused", () => {
  // `counterValueOf` guards the proto ONEOF, which no attribute reader covers.
  // Lines of code are whole units; rounding a fractional value would turn
  // malformed external data into a plausible measurement, and the positive
  // sibling cases above prove a well-formed point on the same derivation is
  // captured.
  const result = normalizeClaudeCodeOtelExport(
    claudeMetricExportOf(
      encodeCounterPoints(
        ClaudeCodeOtelMetricName.LinesOfCode,
        [{ ...locPoint(0, { model: MODEL, changeType: "added" }), value: 1.5 }],
        OtlpAggregationTemporality.Delta
      )
    )
  );
  assert.equal(result.signals.length, 0);
  assert.equal(result.unusable, 1);
});

test("ISS-7352 item G: a fractional tool payload size fails the WHOLE record", () => {
  // A byte count that is not a non-negative integer is not a count we observed.
  // Rounding it would turn malformed external data into a plausible measurement;
  // storing the row without it would leave a real-looking result whose size is
  // silently missing. A row is valid-or-absent.
  const result = normalizeClaudeCodeOtelExport(
    claudeLogExportOf(
      encodeLogRecords([
        toolResultRecord({
          [ClaudeCodeOtelAttributeKey.ToolName]: "Bash",
          [ClaudeCodeOtelAttributeKey.ToolInputSizeBytes]: 1.5,
        }),
      ])
    )
  );
  assert.equal(result.signals.length, 0);
  assert.equal(result.unusable, 1);
});

test("ISS-7352 item G: a tool_result with a whole-number payload size IS captured", () => {
  // The positive sibling of the refusal above, on the same derivation.
  const result = normalizeClaudeCodeOtelExport(
    claudeLogExportOf(
      encodeLogRecords([
        toolResultRecord({
          [ClaudeCodeOtelAttributeKey.ToolName]: "Bash",
          [ClaudeCodeOtelAttributeKey.ToolInputSizeBytes]: 2,
        }),
      ])
    )
  );
  assert.equal(result.signals.length, 1);
  assert.equal(result.unusable, 0);
  assert.equal(result.signals[0]?.type, ClaudeCodeOtelSignalType.ToolResult);
});

test("ISS-7352 item G: no tool payload content reaches a tool_result signal", () => {
  // `tool_input`, `tool_parameters` and `error` are stamped under
  // `OTEL_LOG_TOOL_DETAILS=1` and are all content; open question #4 leaves the
  // content decision unanswered with the redaction gates closed. The two SIZE
  // attributes carry the shape of that payload without the payload.
  const result = normalizeClaudeCodeOtelExport(
    claudeLogExportOf(
      encodeLogRecords([
        toolResultRecord({
          [ClaudeCodeOtelAttributeKey.ToolName]: "Bash",
          [ClaudeCodeOtelAttributeKey.ToolInputSizeBytes]: 512,
          tool_input: CONTENT_SENTINEL,
          tool_parameters: CONTENT_SENTINEL,
          error: CONTENT_SENTINEL,
        }),
      ])
    )
  );
  assert.equal(result.signals.length, 1);
  const serialized = JSON.stringify(result.signals);
  assert.ok(
    !serialized.includes(CONTENT_SENTINEL),
    `a content-bearing attribute reached a normalized signal: ${serialized}`
  );
  // The positive half: the size that describes that same payload IS captured.
  assert.ok(serialized.includes("512"));
});

function locPoint(
  value: number,
  dimensions: { model: string; changeType: string }
): CounterPoint {
  return {
    value,
    observedAt: LOC_AT,
    attributes: {
      [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
      [ClaudeCodeOtelAttributeKey.Model]: dimensions.model,
      [ClaudeCodeOtelAttributeKey.MeasurementType]: dimensions.changeType,
    },
  };
}

function startPoint(value: number, startType: string): CounterPoint {
  return {
    value,
    observedAt: SESSION_START_AT,
    attributes: {
      [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
      [ClaudeCodeOtelAttributeKey.StartType]: startType,
    },
  };
}

function toolResultRecord(
  attributes: Record<string, OtlpAttributeValue>
): object {
  return {
    timeUnixNano: unixNano(TOOL_RESULT_AT),
    attributes: encodeAttributes({
      [ClaudeCodeOtelAttributeKey.EventName]:
        ClaudeCodeOtelEventName.ToolResult,
      [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
      ...attributes,
    }),
  };
}
