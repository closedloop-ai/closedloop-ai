/**
 * ISS-7352 capture list D, the GA half: `claude_code.active_time.total` (a
 * metric) and `cost_usd_micros` (an `api_request` attribute). The rest of item
 * D rides the `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA` span tier, which open
 * question #3 has not decided.
 *
 * Every case that asserts on a ROW drives the WIRED receiver, proving receiver
 * → normalizer → db facade → persister. The original ISS-7352 defect was a
 * persister with no caller, so a test calling the writer directly would
 * reproduce that bug rather than catch it. The three cases that assert on
 * `unusable` call the normalizer directly, because a refusal is by definition
 * the absence of a row and that count is its only observable.
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
import { ClaudeCodeOtelTableName } from "../src/main/otel/claude-code-otel-signal-contract.js";
import {
  API_REQUEST_AT,
  API_REQUEST_DURATION_MS,
  API_REQUEST_STARTED_AT,
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

const ACTIVE_AT = "2026-06-18T19:00:41.000Z";
/** A second request instant, so the two records differ on their natural key. */
const SECOND_REQUEST_AT = "2026-06-18T19:00:09.000Z";
const SECOND_REQUEST_STARTED_AT = "2026-06-18T19:00:06.500Z";

/**
 * Pinned as literals rather than derived from the attribute const under test.
 * The point of the fixture is to state independently what the wire actually
 * carries, so a rename of the const cannot silently rewrite the expectation
 * along with the code.
 */
const ACTIVITY_TYPE_KEY = "type";
const USER_ACTIVITY = "user";
const CLI_ACTIVITY = "cli";
const COST_USD_MICROS_KEY = "cost_usd_micros";
/** Outside the published `user` / `cli` pair — a typo or a newer producer. */
const UNPUBLISHED_ACTIVITY = "background";

test("ISS-7352 item D: the user's active time and the CLI's stay two rows", async () => {
  // The split IS the measurement. Keyed without `activity_type` the two points
  // land on one row and the upsert REPLACES, so 12s of human time silently
  // becomes 30s of CLI time.
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    const { receiver, port, settled } = await startWiredReceiver(db);
    try {
      const response = await postOtlp(
        port,
        "/v1/metrics",
        encodeCounterPoints(
          ClaudeCodeOtelMetricName.ActiveTime,
          [activePoint(12, USER_ACTIVITY), activePoint(30, CLI_ACTIVITY)],
          OtlpAggregationTemporality.Delta
        )
      );
      assert.equal(response.status, 200);
      await settled(1);
    } finally {
      await receiver.stop();
    }

    const rows = await selectRows(db, ClaudeCodeOtelTableName.ActiveTime);
    assert.equal(rows.length, 2);
    const byType = new Map(
      rows.map((row) => [row.activity_type as string, row])
    );
    assert.equal(Number(byType.get(USER_ACTIVITY)?.seconds), 12);
    assert.equal(Number(byType.get(CLI_ACTIVITY)?.seconds), 30);
    for (const row of rows) {
      assert.equal(row.session_id, SESSION_ID);
      assert.equal(row.observed_at, ACTIVE_AT);
    }
  } finally {
    await cleanup();
  }
});

test("ISS-7352 item D: two active-time points on ONE key are summed, not overwritten", async () => {
  // Delta points are additive, and two can share a key by differing on a
  // dimension we do not read. The upsert REPLACES, so without summing first the
  // second erases the first and the session under-reports. Expected 20, not 8.
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    const { receiver, port, settled } = await startWiredReceiver(db);
    try {
      const response = await postOtlp(
        port,
        "/v1/metrics",
        encodeCounterPoints(
          ClaudeCodeOtelMetricName.ActiveTime,
          [activePoint(12, CLI_ACTIVITY), activePoint(8, CLI_ACTIVITY)],
          OtlpAggregationTemporality.Delta
        )
      );
      assert.equal(response.status, 200);
      await settled(1);
    } finally {
      await receiver.stop();
    }

    const rows = await selectRows(db, ClaudeCodeOtelTableName.ActiveTime);
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0]?.seconds), 20);
  } finally {
    await cleanup();
  }
});

test("ISS-7352 item D: a sub-second active-time interval keeps its fraction", async () => {
  // The unit is SECONDS, so 0.25s is an ordinary measurement. The sibling
  // count-shaped counters refuse a fraction on purpose, and reusing that reader
  // here would drop every burst of activity shorter than a second.
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    const { receiver, port, settled } = await startWiredReceiver(db);
    try {
      const response = await postOtlp(
        port,
        "/v1/metrics",
        encodeCounterPoints(
          ClaudeCodeOtelMetricName.ActiveTime,
          [activePoint(0.25, USER_ACTIVITY)],
          OtlpAggregationTemporality.Delta
        )
      );
      assert.equal(response.status, 200);
      await settled(1);
    } finally {
      await receiver.stop();
    }

    const rows = await selectRows(db, ClaudeCodeOtelTableName.ActiveTime);
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0]?.seconds), 0.25);
  } finally {
    await cleanup();
  }
});

test("ISS-7352 item D: an active-time point naming no activity type is refused", () => {
  // Malformed input at the parse boundary must not be repaired into a plausible
  // row: an invented default would report CLI time the producer never
  // attributed. The sibling point still lands -- one bad point costs its own
  // row, never the batch.
  const withoutType = normalizeClaudeCodeOtelExport(
    claudeMetricExportOf(
      encodeCounterPoints(
        ClaudeCodeOtelMetricName.ActiveTime,
        [
          { value: 9, observedAt: ACTIVE_AT, attributes: sessionOnly() },
          activePoint(4, USER_ACTIVITY),
        ],
        OtlpAggregationTemporality.Delta
      )
    )
  );

  assert.equal(withoutType.signals.length, 1);
  assert.equal(withoutType.unusable, 1);
  assert.equal(
    JSON.stringify(withoutType.signals).includes(CLI_ACTIVITY),
    false,
    "a point with no activity type was stored under an invented default"
  );
});

test("ISS-7352 item D: an active-time point naming an unpublished activity type is refused", () => {
  // `type` is the published `user`/`cli` pair AND half the row's natural key,
  // so an unrecognized value cannot degrade the way an unknown permission
  // source does: it would land as a third activity bucket, and every
  // user-plus-cli total over this table would then silently miss that time.
  // The sibling point still lands -- one bad point costs its own row.
  const unpublished = normalizeClaudeCodeOtelExport(
    claudeMetricExportOf(
      encodeCounterPoints(
        ClaudeCodeOtelMetricName.ActiveTime,
        [activePoint(9, UNPUBLISHED_ACTIVITY), activePoint(4, USER_ACTIVITY)],
        OtlpAggregationTemporality.Delta
      )
    )
  );

  assert.equal(unpublished.signals.length, 1);
  assert.equal(unpublished.unusable, 1);
  assert.equal(
    JSON.stringify(unpublished.signals).includes(UNPUBLISHED_ACTIVITY),
    false,
    "an unrecognized activity type was stored as a third bucket"
  );
});

test("ISS-7352 item D: an active-time duration past the safe-integer range is refused where the tally is", () => {
  // Two FINITE points sharing a natural key are SUMMED, and near the top of the
  // double range that sum is Infinity. The persistence boundary does refuse an
  // Infinity `seconds` -- but as a validation failure, AFTER the normalizer
  // counted both points usable, so the batch's `unusable` missed the input that
  // caused it. Bounding the read refuses them here instead: 2 unusable, no
  // signal, and no overflow left downstream to explain.
  const overflowed = normalizeClaudeCodeOtelExport(
    claudeMetricExportOf(
      encodeCounterPoints(
        ClaudeCodeOtelMetricName.ActiveTime,
        [hugePoint(), hugePoint()],
        OtlpAggregationTemporality.Delta
      )
    )
  );

  assert.equal(overflowed.signals.length, 0);
  assert.equal(overflowed.unusable, 2);
});

test("ISS-7352 item D: an api_request carries the exact integer cost beside the float", async () => {
  // Both spellings of the SAME cost are stored, so a later reader can tell
  // which one it is summing instead of inheriting the float's drift.
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    const { receiver, port, settled } = await startWiredReceiver(db);
    try {
      const response = await postOtlp(
        port,
        "/v1/logs",
        encodeLogRecords([
          apiRequestRecord({ [COST_USD_MICROS_KEY]: 1_750_000 }),
        ])
      );
      assert.equal(response.status, 200);
      await settled(1);
    } finally {
      await receiver.stop();
    }

    const rows = await selectRows(db, ClaudeCodeOtelTableName.ApiRequest);
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0]?.cost_usd_micros), 1_750_000);
    assert.equal(Number(rows[0]?.cost_usd), 1.75);
    assert.equal(rows[0]?.started_at, API_REQUEST_STARTED_AT);
  } finally {
    await cleanup();
  }
});

test("ISS-7352 item D: an api_request from a Claude Code that stamps no micros still lands", async () => {
  // Version skew: requiring the attribute would trade every pre-upgrade request
  // for a precision gain. The row persists with the column NULL -- unknown --
  // rather than 0, which would read as a free request.
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    const { receiver, port, settled } = await startWiredReceiver(db);
    try {
      const response = await postOtlp(
        port,
        "/v1/logs",
        encodeLogRecords([apiRequestRecord({})])
      );
      assert.equal(response.status, 200);
      await settled(1);
    } finally {
      await receiver.stop();
    }

    const rows = await selectRows(db, ClaudeCodeOtelTableName.ApiRequest);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.cost_usd_micros, null);
    assert.equal(Number(rows[0]?.cost_usd), 1.75);
  } finally {
    await cleanup();
  }
});

test("ISS-7352 item D: a corrupt micros value fails its row without sinking the batch", async () => {
  // A row is valid-or-absent, never partially-corrupt -- the posture
  // `api_request` already takes with a corrupt token count. The healthy sibling
  // is the positive control: it proves the corrupt record cost ITS OWN row, not
  // the batch, and stops this passing against a normalizer that refused both.
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    const { receiver, port, settled } = await startWiredReceiver(db);
    try {
      const response = await postOtlp(
        port,
        "/v1/logs",
        encodeLogRecords([
          apiRequestRecord({ [COST_USD_MICROS_KEY]: -5 }),
          apiRequestRecord(
            { [COST_USD_MICROS_KEY]: 90_000 },
            SECOND_REQUEST_AT
          ),
        ])
      );
      assert.equal(response.status, 200);
      await settled(1);
    } finally {
      await receiver.stop();
    }

    const rows = await selectRows(db, ClaudeCodeOtelTableName.ApiRequest);
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0]?.cost_usd_micros), 90_000);
    assert.equal(rows[0]?.started_at, SECOND_REQUEST_STARTED_AT);
  } finally {
    await cleanup();
  }
});

test("ISS-7352 item D: two api_requests differing ONLY in micros are not one repeat", () => {
  // The collision guard decides whether a key collision is one record exported
  // twice (collapsed, uncounted) or two records only one row can hold (refused,
  // counted). A guard blind to `cost_usd_micros` reads a real disagreement as a
  // repeat and drops the second silently -- and micros is the field most able
  // to expose a difference the float cost rounds away. Expected: refused.
  const collided = normalizeClaudeCodeOtelExport(
    claudeLogExportOf(
      encodeLogRecords([
        apiRequestRecord({ [COST_USD_MICROS_KEY]: 1_750_000 }),
        apiRequestRecord({ [COST_USD_MICROS_KEY]: 1_750_001 }),
      ])
    )
  );

  assert.equal(collided.signals.length, 1);
  assert.equal(collided.unusable, 1);
});

test("ISS-7352 item D: a genuinely identical api_request repeat is still collapsed uncounted", () => {
  // The positive sibling of the case above, and what stops that guard from
  // being "refuse every collision": an OTLP exporter retries a batch it did not
  // see ACKed, so the same record arriving twice is ONE observation reported
  // twice and must not inflate `unusable`.
  const repeated = normalizeClaudeCodeOtelExport(
    claudeLogExportOf(
      encodeLogRecords([
        apiRequestRecord({ [COST_USD_MICROS_KEY]: 1_750_000 }),
        apiRequestRecord({ [COST_USD_MICROS_KEY]: 1_750_000 }),
      ])
    )
  );

  assert.equal(repeated.signals.length, 1);
  assert.equal(repeated.unusable, 0);
});

function activePoint(value: number, activityType: string): CounterPoint {
  return {
    value,
    observedAt: ACTIVE_AT,
    attributes: { ...sessionOnly(), [ACTIVITY_TYPE_KEY]: activityType },
  };
}

/** One point large enough that two of them sum past the double range. */
function hugePoint(): CounterPoint {
  return { ...activePoint(Number.MAX_VALUE, CLI_ACTIVITY), forceDouble: true };
}

function sessionOnly(): Record<string, OtlpAttributeValue> {
  return { [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID };
}

function apiRequestRecord(
  extra: Record<string, OtlpAttributeValue>,
  at: string = API_REQUEST_AT
) {
  return {
    timeUnixNano: unixNano(at),
    attributes: encodeAttributes({
      [ClaudeCodeOtelAttributeKey.EventName]:
        ClaudeCodeOtelEventName.ApiRequest,
      [ClaudeCodeOtelAttributeKey.EventTimestamp]: at,
      [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
      [ClaudeCodeOtelAttributeKey.Model]: MODEL,
      [ClaudeCodeOtelAttributeKey.CostUsd]: 1.75,
      [ClaudeCodeOtelAttributeKey.DurationMs]: API_REQUEST_DURATION_MS,
      [ClaudeCodeOtelAttributeKey.InputTokens]: 100,
      [ClaudeCodeOtelAttributeKey.OutputTokens]: 30,
      [ClaudeCodeOtelAttributeKey.CacheReadTokens]: 5,
      [ClaudeCodeOtelAttributeKey.CacheCreationTokens]: 2,
      ...extra,
    }),
  };
}
