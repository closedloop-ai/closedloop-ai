/**
 * ISS-10717 — the dropped-signal counter, driven through the WIRED receiver.
 *
 * Before this table, all three drop sites logged the loss and discarded it, so
 * a session that produced no permission events was indistinguishable from one
 * whose export was thrown away. The completeness signal ISS-10717 ships is
 * computed from these rows, so the cases below are the ones that decide whether
 * that signal can exist at all.
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import { ClaudeCodeOtelAttributeKey } from "../src/main/otel/claude-code-otel-attributes.js";
import { ClaudeCodeOtelEventName } from "../src/main/otel/claude-code-otel-log-signals.js";
import {
  ClaudeCodeOtelMetricName,
  OtlpAggregationTemporality,
} from "../src/main/otel/claude-code-otel-normalizer.js";
import {
  ClaudeCodeSignalDropReason,
  createClaudeCodeSignalDropRecorder,
  isRecordableDropCount,
} from "../src/main/otel/claude-code-signal-drop.js";
import {
  COST_OBSERVED_AT,
  type CounterPoint,
  encodeAttributes,
  encodeCounterPoints,
  encodeLogRecords,
  MODEL,
  openTestDatabase,
  postOtlp,
  SESSION_ID,
  seedSession,
  startWiredReceiver,
  TOOL_DECISION_AT,
} from "./helpers/claude-code-otel-fixtures.js";

const HARNESS = "claude";

function costPoint(value: number): CounterPoint {
  return {
    value,
    observedAt: COST_OBSERVED_AT,
    attributes: {
      [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
      [ClaudeCodeOtelAttributeKey.Model]: MODEL,
    },
  };
}

async function readDropRows(
  db: Awaited<ReturnType<typeof openTestDatabase>>["db"]
): Promise<Record<string, unknown>[]> {
  return await db.prisma.client.$queryRawUnsafe<Record<string, unknown>[]>(
    "SELECT * FROM claude_code_signal_drop ORDER BY id ASC"
  );
}

test("ISS-10717: a normalizer-unusable export is counted instead of only logged", async () => {
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    const { receiver, port, dropsRecorded } = await startWiredReceiver(db);
    try {
      // A CUMULATIVE cost counter: the normalizer refuses it because no table
      // records which temporality a row came from, so both data points are
      // unusable. That is exactly the loss that used to vanish into a log line.
      const response = await postOtlp(
        port,
        "/v1/metrics",
        encodeCounterPoints(
          ClaudeCodeOtelMetricName.CostUsage,
          [costPoint(0.5), costPoint(0.25)],
          OtlpAggregationTemporality.Cumulative
        )
      );
      assert.equal(response.status, 200);
      await dropsRecorded(1);
    } finally {
      await receiver.stop();
    }

    const rows = await readDropRows(db);
    assert.equal(rows.length, 1);
    assert.equal(
      rows[0]?.reason,
      ClaudeCodeSignalDropReason.NormalizerUnusable
    );
    assert.equal(rows[0]?.harness, HARNESS);
    // Two data points were refused, so the counter must say two. A count of one
    // would read as a single lost signal and understate the shortfall.
    assert.equal(Number(rows[0]?.dropped_count), 2);
  } finally {
    await cleanup();
  }
});

test("ISS-10717: repeated drops accumulate on one row rather than replacing it", async () => {
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    const { receiver, port, dropsRecorded } = await startWiredReceiver(db);
    try {
      for (const _ of [0, 1]) {
        const response = await postOtlp(
          port,
          "/v1/metrics",
          encodeCounterPoints(
            ClaudeCodeOtelMetricName.CostUsage,
            [costPoint(0.5)],
            OtlpAggregationTemporality.Cumulative
          )
        );
        assert.equal(response.status, 200);
      }
      await dropsRecorded(2);
    } finally {
      await receiver.stop();
    }

    const rows = await readDropRows(db);
    assert.equal(rows.length, 1);
    // A replacing write would report 1 and the machine would look an order of
    // magnitude more complete than it is.
    assert.equal(Number(rows[0]?.dropped_count), 2);
  } finally {
    await cleanup();
  }
});

test("ISS-10717: an impossible drop count is refused, not written", async () => {
  // The whole impossible set, not just the two that get remembered: each of
  // these would render downstream as a confident real measurement.
  for (const impossible of [
    -1,
    0,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 2,
  ]) {
    assert.equal(
      isRecordableDropCount(impossible),
      false,
      `${impossible} must not be recordable`
    );
  }
  assert.equal(isRecordableDropCount(1), true);

  const { db, cleanup } = await openTestDatabase();
  try {
    const warnings: string[] = [];
    const recorder = createClaudeCodeSignalDropRecorder({
      prisma: db.prisma,
      warn: (message) => warnings.push(message),
    });

    await recorder.record({
      harness: HARNESS,
      reason: ClaudeCodeSignalDropReason.PersistenceRejected,
      count: 1.5,
    });

    assert.deepEqual(await readDropRows(db), []);
    assert.equal(warnings.length, 1);
  } finally {
    await cleanup();
  }
});

function toolDecisionRecord(toolUseId: string) {
  return {
    timeUnixNano: (
      BigInt(Date.parse(TOOL_DECISION_AT)) * 1_000_000n
    ).toString(),
    attributes: encodeAttributes({
      [ClaudeCodeOtelAttributeKey.EventName]:
        ClaudeCodeOtelEventName.ToolDecision,
      [ClaudeCodeOtelAttributeKey.EventTimestamp]: TOOL_DECISION_AT,
      [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
      [ClaudeCodeOtelAttributeKey.ToolName]: "Read",
      [ClaudeCodeOtelAttributeKey.Decision]: "accept",
      [ClaudeCodeOtelAttributeKey.Source]: "config",
      [ClaudeCodeOtelAttributeKey.ToolUseId]: toolUseId,
    }),
  };
}

test("ISS-10722 (ISS-7481): a natural-key collision is counted under its OWN reason", async () => {
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    const { receiver, port, dropsRecorded } = await startWiredReceiver(db);
    try {
      // Two DIFFERENT tool decisions reduce to one `claude_code_permission_event`
      // row — the ISS-7481 overwrite path. The table is then a LOWER BOUND on
      // real decisions, which is a different disclosure from a record that could
      // not be read, so it must not be folded into `normalizer_unusable`.
      const response = await postOtlp(
        port,
        "/v1/logs",
        encodeLogRecords([
          toolDecisionRecord("toolu_01AAA"),
          toolDecisionRecord("toolu_01BBB"),
        ])
      );
      assert.equal(response.status, 200);
      await dropsRecorded(1);
    } finally {
      await receiver.stop();
    }

    const rows = await readDropRows(db);
    const byReason = new Map(rows.map((row) => [row.reason as string, row]));
    assert.equal(
      Number(
        byReason.get(ClaudeCodeSignalDropReason.NaturalKeyCollision)
          ?.dropped_count
      ),
      1
    );
    // And it must NOT be double-counted as an unreadable record.
    assert.equal(
      byReason.has(ClaudeCodeSignalDropReason.NormalizerUnusable),
      false
    );
  } finally {
    await cleanup();
  }
});
