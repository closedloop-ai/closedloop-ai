/**
 * ISS-7352 steps 2 and 3 — the capture-list extension.
 *
 * Covers item A (error / refusal taxonomy), item B (permission mode
 * transitions) and item E (harness-stamped component attribution on the cost
 * counter, plus step 3's record of which source produced it).
 *
 * The DB-level cases drive the WIRED receiver, so each one proves the
 * production path — receiver, normalizer, db facade, persister — and not just
 * the unit under it.
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import { ClaudeCodeOtelAttributeKey } from "../src/main/otel/claude-code-otel-attributes.js";
import {
  ClaudeCodeAttributionAttributeKey,
  ClaudeCodeAttributionSource,
} from "../src/main/otel/claude-code-otel-attribution.js";
import { ClaudeCodeOtelEventName } from "../src/main/otel/claude-code-otel-log-signals.js";
import {
  ClaudeCodeOtelMetricName,
  normalizeClaudeCodeOtelExport,
  OtlpAggregationTemporality,
} from "../src/main/otel/claude-code-otel-normalizer.js";
import {
  ClaudeCodeErrorKind,
  ClaudeCodeOtelSignalType,
  ClaudeCodeOtelTableName,
} from "../src/main/otel/claude-code-otel-signal-contract.js";
import { OtlpExportKind } from "../src/main/otlp/proto-descriptor.js";
import { OtlpHarness } from "../src/main/telemetry/otlp-http-receiver.js";
import {
  COST_OBSERVED_AT,
  claudeLogExportOf,
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
  unixNano,
} from "./helpers/claude-code-otel-fixtures.js";

const ERROR_AT = "2026-06-18T19:00:11.000Z";
const MODE_CHANGE_AT = "2026-06-18T19:00:13.000Z";
const AGENT_NAME = "design-critic";
const OTHER_AGENT_NAME = "test-engineer";
const REQUEST_ID = "req_01HZY";
const CLIENT_REQUEST_ID = "cli_01HZY";
/**
 * The character the pre-fix key encoding used as its part separator. Planted
 * INSIDE attribute values on purpose — nothing in the read path rejects it, and
 * that is the whole finding.
 */
const UNIT_SEPARATOR = "\u001f";

test("ISS-7352 item E: cost points differing only in agent.name stay SEPARATE attributed rows", async () => {
  // The counterfactual for widening the aggregation and natural keys by
  // `attribution_key`. Two points share (session, model, observed_at) and
  // differ only in which agent spent the money. Without the attribution key
  // they are one series: `aggregateCostSignals` SUMS them into a single 1.00
  // row carrying whichever agent arrived first, which is the exact
  // per-component attribution item E exists to capture being destroyed on the
  // way in. Expected from the requirement: two rows, 0.25 and 0.75, each
  // naming its own agent.
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    const { receiver, port, settled } = await startWiredReceiver(db);
    try {
      const response = await postOtlp(
        port,
        "/v1/metrics",
        encodeCostPoints([
          {
            costUsd: 0.25,
            attributes: {
              [ClaudeCodeAttributionAttributeKey.AgentName]: AGENT_NAME,
            },
          },
          {
            costUsd: 0.75,
            attributes: {
              [ClaudeCodeAttributionAttributeKey.AgentName]: OTHER_AGENT_NAME,
            },
          },
        ])
      );
      assert.equal(response.status, 200);
      await settled(1);
    } finally {
      await receiver.stop();
    }

    const rows = await selectRows(db, ClaudeCodeOtelTableName.CostEvent);
    assert.equal(rows.length, 2);
    const byAgent = new Map(rows.map((row) => [row.agent_name as string, row]));
    assert.equal(Number(byAgent.get(AGENT_NAME)?.cost_usd), 0.25);
    assert.equal(Number(byAgent.get(OTHER_AGENT_NAME)?.cost_usd), 0.75);
    // Step 3: each row records that the HARNESS attributed it.
    for (const row of rows) {
      assert.equal(
        row.attribution_source,
        ClaudeCodeAttributionSource.HarnessOtel
      );
      assert.notEqual(row.attribution_key, "");
    }
    // Two attributed rows must not collapse onto one primary key either.
    assert.notEqual(rows[0]?.id, rows[1]?.id);
  } finally {
    await cleanup();
  }
});

test("ISS-7352 step 3: an unattributed cost point records source 'none', not a populated-looking row", async () => {
  // A NULL agent_name alone cannot distinguish "the harness said nothing" from
  // "this build never read the attribute". The recorded source is what makes
  // that distinction, so it is asserted as a value rather than inferred.
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    const { receiver, port, settled } = await startWiredReceiver(db);
    try {
      const response = await postOtlp(
        port,
        "/v1/metrics",
        encodeCostPoints([{ costUsd: 0.5, attributes: {} }])
      );
      assert.equal(response.status, 200);
      await settled(1);
    } finally {
      await receiver.stop();
    }

    const rows = await selectRows(db, ClaudeCodeOtelTableName.CostEvent);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.attribution_source, ClaudeCodeAttributionSource.None);
    // "" is the same value the migration gives every pre-item-E row, so an old
    // row and a genuinely unattributed new one share one natural key.
    assert.equal(rows[0]?.attribution_key, "");
    assert.equal(rows[0]?.agent_name, null);
  } finally {
    await cleanup();
  }
});

test("ISS-7352 item E: speed and effort fill columns WITHOUT splitting a series", () => {
  // `speed`/`effort` describe how a request ran, not which component ran it.
  // Including them in the attribution key would split one component's spend
  // across rows on a dimension no reader attributes cost by, so two points
  // differing only in `effort` must still aggregate to one 1.00 measurement.
  const { signals } = normalizeClaudeCodeOtelExport({
    kind: OtlpExportKind.Metrics,
    harness: OtlpHarness.Claude,
    resourceAttributes: [],
    metricNames: [],
    logSummaries: [],
    spanSummaries: [],
    decodedPayload: decodedCostPayload([
      {
        costUsd: 0.4,
        attributes: {
          [ClaudeCodeAttributionAttributeKey.AgentName]: AGENT_NAME,
          [ClaudeCodeAttributionAttributeKey.Effort]: "low",
        },
      },
      {
        costUsd: 0.6,
        attributes: {
          [ClaudeCodeAttributionAttributeKey.AgentName]: AGENT_NAME,
          [ClaudeCodeAttributionAttributeKey.Effort]: "high",
        },
      },
    ]),
  });

  assert.equal(signals.length, 1);
  const [signal] = signals;
  assert.equal(signal?.type, ClaudeCodeOtelSignalType.CostUsage);
  if (signal?.type !== ClaudeCodeOtelSignalType.CostUsage) {
    return;
  }
  assert.equal(signal.costUsd, 1);
  assert.equal(signal.agentName, AGENT_NAME);
});

test("ISS-7352 item A: an api_error is PERSISTED with its taxonomy", async () => {
  // Nothing equivalent existed before this change: an api_error was decoded,
  // ACKed and dropped. Expected from the capture list: one row carrying the
  // status, attempt, category and both join keys back to Anthropic's records.
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    const { receiver, port, settled } = await startWiredReceiver(db);
    try {
      const response = await postOtlp(
        port,
        "/v1/logs",
        encodeLogRecords([
          {
            timeUnixNano: unixNano(ERROR_AT),
            attributes: encodeAttributes({
              [ClaudeCodeOtelAttributeKey.EventName]:
                ClaudeCodeOtelEventName.ApiError,
              [ClaudeCodeOtelAttributeKey.EventTimestamp]: ERROR_AT,
              [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
              [ClaudeCodeOtelAttributeKey.Model]: MODEL,
              [ClaudeCodeOtelAttributeKey.StatusCode]: 529,
              [ClaudeCodeOtelAttributeKey.Attempt]: 2,
              [ClaudeCodeOtelAttributeKey.ErrorCategory]: "overloaded",
              [ClaudeCodeOtelAttributeKey.DurationMs]: 1200,
              [ClaudeCodeOtelAttributeKey.RequestId]: REQUEST_ID,
              [ClaudeCodeOtelAttributeKey.ClientRequestId]: CLIENT_REQUEST_ID,
            }),
          },
        ])
      );
      assert.equal(response.status, 200);
      await settled(1);
    } finally {
      await receiver.stop();
    }

    const rows = await selectRows(db, ClaudeCodeOtelTableName.ErrorEvent);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.error_kind, ClaudeCodeErrorKind.ApiError);
    assert.equal(rows[0]?.session_id, SESSION_ID);
    assert.equal(rows[0]?.observed_at, ERROR_AT);
    assert.equal(Number(rows[0]?.status_code), 529);
    assert.equal(Number(rows[0]?.attempt), 2);
    assert.equal(rows[0]?.error_category, "overloaded");
    assert.equal(Number(rows[0]?.duration_ms), 1200);
    assert.equal(rows[0]?.request_id, REQUEST_ID);
    assert.equal(rows[0]?.client_request_id, CLIENT_REQUEST_ID);
  } finally {
    await cleanup();
  }
});

test("ISS-7352 item A: an api_refusal keeps its category and explanation flags", () => {
  const { signals } = normalizeClaudeCodeOtelExport(
    claudeLogExportOf(
      encodeLogRecords([
        {
          timeUnixNano: unixNano(ERROR_AT),
          attributes: encodeAttributes({
            [ClaudeCodeOtelAttributeKey.EventName]:
              ClaudeCodeOtelEventName.ApiRefusal,
            [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
            [ClaudeCodeOtelAttributeKey.RefusalCategory]: "cyber",
            [ClaudeCodeOtelAttributeKey.ServerFallbackHop]: 1,
            [ClaudeCodeOtelAttributeKey.HasCategory]: true,
            [ClaudeCodeOtelAttributeKey.HasExplanation]: false,
          }),
        },
      ])
    )
  );

  assert.equal(signals.length, 1);
  const [signal] = signals;
  if (signal?.type !== ClaudeCodeOtelSignalType.ErrorEvent) {
    assert.fail("expected an error_event signal");
    return;
  }
  assert.equal(signal.errorKind, ClaudeCodeErrorKind.ApiRefusal);
  assert.equal(signal.refusalCategory, "cyber");
  assert.equal(signal.serverFallbackHop, 1);
  // `false` must survive as false, not be conflated with an absent flag.
  assert.equal(signal.hasCategory, true);
  assert.equal(signal.hasExplanation, false);
});

test("ISS-7352 item A: an out-of-range status_code REFUSES the record rather than storing it", () => {
  // Bounded at BOTH ends: a non-negative check alone admits 99999. Clamping it
  // to 599 would be a plausible-but-wrong observation no reader could tell from
  // a real one, and storing the rest of the row with the field silently dropped
  // would be a partially-corrupt record. Expected from the rule: no signal, and
  // the record counted as unusable rather than silently vanishing.
  const { signals, unusable } = normalizeClaudeCodeOtelExport(
    claudeLogExportOf(
      encodeLogRecords([
        {
          timeUnixNano: unixNano(ERROR_AT),
          attributes: encodeAttributes({
            [ClaudeCodeOtelAttributeKey.EventName]:
              ClaudeCodeOtelEventName.ApiError,
            [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
            [ClaudeCodeOtelAttributeKey.StatusCode]: 99_999,
          }),
        },
      ])
    )
  );

  assert.equal(signals.length, 0);
  assert.equal(unusable, 1);
});

test("ISS-7352 item A: an ABSENT taxonomy attribute still yields a row", () => {
  // The mirror of the case above, so "refuse corrupt input" cannot quietly
  // become "refuse sparse input". An internal_error carries neither a status
  // nor a request id, and losing the fact that it happened would defeat the
  // table.
  const { signals, unusable } = normalizeClaudeCodeOtelExport(
    claudeLogExportOf(
      encodeLogRecords([
        {
          timeUnixNano: unixNano(ERROR_AT),
          attributes: encodeAttributes({
            [ClaudeCodeOtelAttributeKey.EventName]:
              ClaudeCodeOtelEventName.InternalError,
            [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
            [ClaudeCodeOtelAttributeKey.ErrorName]: "TypeError",
            [ClaudeCodeOtelAttributeKey.ErrorCode]: "ERR_INVALID_STATE",
          }),
        },
      ])
    )
  );

  assert.equal(unusable, 0);
  assert.equal(signals.length, 1);
  const [signal] = signals;
  if (signal?.type !== ClaudeCodeOtelSignalType.ErrorEvent) {
    assert.fail("expected an error_event signal");
    return;
  }
  assert.equal(signal.errorKind, ClaudeCodeErrorKind.InternalError);
  assert.equal(signal.errorName, "TypeError");
  assert.equal(signal.errorCode, "ERR_INVALID_STATE");
  assert.equal(signal.statusCode, undefined);
});

test("ISS-7352 item B: a permission_mode_changed transition is PERSISTED", async () => {
  // The session row stores only the mode a session ended in, so before this
  // change every transition that produced it was unrecoverable.
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    const { receiver, port, settled } = await startWiredReceiver(db);
    try {
      const response = await postOtlp(
        port,
        "/v1/logs",
        encodeLogRecords([
          {
            timeUnixNano: unixNano(MODE_CHANGE_AT),
            attributes: encodeAttributes({
              [ClaudeCodeOtelAttributeKey.EventName]:
                ClaudeCodeOtelEventName.PermissionModeChanged,
              [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
              [ClaudeCodeOtelAttributeKey.FromMode]: "default",
              [ClaudeCodeOtelAttributeKey.ToMode]: "acceptEdits",
              [ClaudeCodeOtelAttributeKey.Trigger]: "user",
            }),
          },
        ])
      );
      assert.equal(response.status, 200);
      await settled(1);
    } finally {
      await receiver.stop();
    }

    const rows = await selectRows(
      db,
      ClaudeCodeOtelTableName.PermissionModeChange
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.session_id, SESSION_ID);
    assert.equal(rows[0]?.observed_at, MODE_CHANGE_AT);
    assert.equal(rows[0]?.from_mode, "default");
    assert.equal(rows[0]?.to_mode, "acceptEdits");
    assert.equal(rows[0]?.trigger, "user");
  } finally {
    await cleanup();
  }
});

test("ISS-7352 item B: a transition missing from_mode is refused, not half-recorded", () => {
  // A row naming only where the session landed says no more than the session's
  // current mode already does, and inventing an "unknown" origin to fill the
  // column would make a transition that never happened look observed.
  const { signals, unusable } = normalizeClaudeCodeOtelExport(
    claudeLogExportOf(
      encodeLogRecords([
        {
          timeUnixNano: unixNano(MODE_CHANGE_AT),
          attributes: encodeAttributes({
            [ClaudeCodeOtelAttributeKey.EventName]:
              ClaudeCodeOtelEventName.PermissionModeChanged,
            [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
            [ClaudeCodeOtelAttributeKey.ToMode]: "acceptEdits",
          }),
        },
      ])
    )
  );

  assert.equal(signals.length, 0);
  assert.equal(unusable, 1);
});

test("ISS-7352 item A: two DIFFERING errors on one natural key refuse the second instead of overwriting", () => {
  // `claude_code_error_event`'s key is derived, and the persister's upsert
  // REPLACES. Two api_errors sharing session, kind, instant and occurrence key
  // but reporting different statuses would otherwise land as one row holding
  // the later status, while the summary reported both accepted.
  const { signals, unusable } = normalizeClaudeCodeOtelExport(
    claudeLogExportOf(
      encodeLogRecords([errorRecordWithStatus(500), errorRecordWithStatus(529)])
    )
  );

  assert.equal(signals.length, 1);
  assert.equal(unusable, 1);
  const [signal] = signals;
  if (signal?.type !== ClaudeCodeOtelSignalType.ErrorEvent) {
    assert.fail("expected an error_event signal");
    return;
  }
  // The FIRST record is kept unchanged; the differing later one is refused.
  assert.equal(signal.statusCode, 500);
});

test("ISS-7352 item A: an IDENTICAL repeat collapses without being called unusable", () => {
  // One observation reported twice is not a data problem: the upsert is
  // idempotent and counting it would report a corruption that did not occur.
  const { signals, unusable } = normalizeClaudeCodeOtelExport(
    claudeLogExportOf(
      encodeLogRecords([errorRecordWithStatus(529), errorRecordWithStatus(529)])
    )
  );

  assert.equal(signals.length, 1);
  assert.equal(unusable, 0);
});

test("ISS-7352 item A: a present-but-malformed boolean flag REFUSES the record", () => {
  // T1 (whitlockk). `readBoolean` used to collapse ABSENT and PRESENT-BUT-MALFORMED
  // to the same `undefined`, so `has_explanation: "maybe"` persisted a
  // real-looking refusal row with a NULL flag while the neighbouring count and
  // status readers refused the whole record for the same class of corruption.
  // The refusal taxonomy is exactly the set of fields that say WHAT was
  // refused, so a silently-dropped one is unreadable. Expected from
  // valid-or-absent: no signal, and the record counted as unusable.
  const { signals, unusable } = normalizeClaudeCodeOtelExport(
    claudeLogExportOf(
      encodeLogRecords([
        {
          timeUnixNano: unixNano(ERROR_AT),
          attributes: encodeAttributes({
            [ClaudeCodeOtelAttributeKey.EventName]:
              ClaudeCodeOtelEventName.ApiRefusal,
            [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
            [ClaudeCodeOtelAttributeKey.RefusalCategory]: "cyber",
            [ClaudeCodeOtelAttributeKey.HasExplanation]: "maybe",
          }),
        },
      ])
    )
  );

  assert.equal(signals.length, 0);
  assert.equal(unusable, 1);
});

test("ISS-7352 item A: an integer-spelled boolean flag reads as the boolean it spells", () => {
  // The mirror of the case above, so "refuse a malformed flag" cannot become
  // "drop every refusal a version-skewed producer int-encodes". `1`/`0` is the
  // protobuf-adjacent canonical spelling of a boolean and has no other reading
  // on a `has_*` predicate, so it is ACCEPTED; `"maybe"` above has no reading
  // at all and is refused. Expected: true and false, not two dropped rows.
  const { signals, unusable } = normalizeClaudeCodeOtelExport(
    claudeLogExportOf(
      encodeLogRecords([
        {
          timeUnixNano: unixNano(ERROR_AT),
          attributes: encodeAttributes({
            [ClaudeCodeOtelAttributeKey.EventName]:
              ClaudeCodeOtelEventName.ApiRefusal,
            [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
            [ClaudeCodeOtelAttributeKey.HasCategory]: 1,
            [ClaudeCodeOtelAttributeKey.HasExplanation]: 0,
          }),
        },
      ])
    )
  );

  assert.equal(unusable, 0);
  assert.equal(signals.length, 1);
  const [signal] = signals;
  if (signal?.type !== ClaudeCodeOtelSignalType.ErrorEvent) {
    assert.fail("expected an error_event signal");
    return;
  }
  assert.equal(signal.hasCategory, true);
  assert.equal(signal.hasExplanation, false);
});

test("ISS-7352 item E: two DIFFERENT attribution tuples cannot flatten to one key", () => {
  // T2 (whitlockk). The old key joined the identity fields with an ASCII unit
  // separator on the claim that no accepted attribute value can contain one —
  // a rule nothing enforced, since `readString` only trims and U+001F is not
  // whitespace. An agent name ENDING in the separator paired with skill "y",
  // and agent "x" paired with a skill name STARTING with the separator, are
  // two different components whose tuples flattened to a byte-identical key:
  // `aggregateCostSignals` SUMMED them and the upsert filed both components'
  // spend under whichever name arrived first. Expected: two signals, kept apart.
  const { signals } = normalizeClaudeCodeOtelExport({
    kind: OtlpExportKind.Metrics,
    harness: OtlpHarness.Claude,
    resourceAttributes: [],
    metricNames: [],
    logSummaries: [],
    spanSummaries: [],
    decodedPayload: decodedCostPayload([
      {
        costUsd: 0.25,
        attributes: {
          [ClaudeCodeAttributionAttributeKey.AgentName]: `x${UNIT_SEPARATOR}`,
          [ClaudeCodeAttributionAttributeKey.SkillName]: "y",
        },
      },
      {
        costUsd: 0.75,
        attributes: {
          [ClaudeCodeAttributionAttributeKey.AgentName]: "x",
          [ClaudeCodeAttributionAttributeKey.SkillName]: `${UNIT_SEPARATOR}y`,
        },
      },
    ]),
  });

  assert.equal(signals.length, 2);
  const costs = signals.map((signal) =>
    signal.type === ClaudeCodeOtelSignalType.CostUsage ? signal.costUsd : null
  );
  assert.deepEqual(costs, [0.25, 0.75]);
});

test("ISS-7352 item E: merged points that DISAGREE on effort drop it rather than invent one", () => {
  // T3 (whitlockk). `speed`/`effort` stay out of the attribution key on the
  // rationale that they describe how a request ran, not which component ran it
  // — so two points differing only in effort are one series and must merge.
  // But the merge kept the FIRST point's effort while summing both costs,
  // storing `cost=1.00, effort="low"`, a pairing no producer ever emitted. The
  // rationale and first-wins cannot both stand: keeping the rationale means the
  // aggregate DROPS a dimension the merged points disagree on. Expected: one
  // 1.00 signal, effort ABSENT, and the agreed `speed` still filled.
  const { signals } = normalizeClaudeCodeOtelExport({
    kind: OtlpExportKind.Metrics,
    harness: OtlpHarness.Claude,
    resourceAttributes: [],
    metricNames: [],
    logSummaries: [],
    spanSummaries: [],
    decodedPayload: decodedCostPayload([
      {
        costUsd: 0.4,
        attributes: {
          [ClaudeCodeAttributionAttributeKey.AgentName]: AGENT_NAME,
          [ClaudeCodeAttributionAttributeKey.Speed]: "fast",
          [ClaudeCodeAttributionAttributeKey.Effort]: "low",
        },
      },
      {
        costUsd: 0.6,
        attributes: {
          [ClaudeCodeAttributionAttributeKey.AgentName]: AGENT_NAME,
          [ClaudeCodeAttributionAttributeKey.Speed]: "fast",
          [ClaudeCodeAttributionAttributeKey.Effort]: "high",
        },
      },
    ]),
  });

  assert.equal(signals.length, 1);
  const [signal] = signals;
  if (signal?.type !== ClaudeCodeOtelSignalType.CostUsage) {
    assert.fail("expected a cost_usage signal");
    return;
  }
  assert.equal(signal.costUsd, 1);
  assert.equal(signal.effort, undefined);
  assert.ok(!("effort" in signal));
  // A dimension both points agreed on is not a merge artefact and survives.
  assert.equal(signal.speed, "fast");
});

test("ISS-7352 item B: two same-instant transitions with DIFFERENT triggers refuse the second", () => {
  // T4 (whitlockk). `trigger` is update data on an upsert whose key is
  // (session, observed_at, from_mode, to_mode), and nothing collision-checked
  // it — so two transitions reported in the same millisecond by different
  // triggers were both accepted and the later one silently overwrote the
  // earlier. Two different facts, one surviving row. Expected: the first kept
  // unchanged, the differing later one refused and counted.
  const { signals, unusable } = normalizeClaudeCodeOtelExport(
    claudeLogExportOf(
      encodeLogRecords([
        modeChangeRecordWithTrigger("user"),
        modeChangeRecordWithTrigger("hook"),
      ])
    )
  );

  assert.equal(signals.length, 1);
  assert.equal(unusable, 1);
  const [signal] = signals;
  if (signal?.type !== ClaudeCodeOtelSignalType.PermissionModeChange) {
    assert.fail("expected a permission_mode_change signal");
    return;
  }
  assert.equal(signal.trigger, "user");
});

test("ISS-7352 item B: an IDENTICAL repeated transition collapses without being called unusable", () => {
  // The mirror, so the new refusal cannot quietly become "count every repeat".
  const { signals, unusable } = normalizeClaudeCodeOtelExport(
    claudeLogExportOf(
      encodeLogRecords([
        modeChangeRecordWithTrigger("user"),
        modeChangeRecordWithTrigger("user"),
      ])
    )
  );

  assert.equal(signals.length, 1);
  assert.equal(unusable, 0);
});

test("ISS-7352 item A: two same-instant refusals with different categories are BOTH persisted", async () => {
  // T5 (tamsinb). `errorOccurrenceKeyOf` was built from attempt / request_id /
  // client_request_id / error_name / error_code — NONE of which an api_refusal
  // carries — so every refusal got occurrence_key "" and the natural key
  // collapsed to (session, "api_refusal", observed_at, ""). Two refusals in the
  // same millisecond then looked like one contradictory row and
  // `refuseCollidingSignals` DROPPED the second. Expected: two rows, distinct
  // occurrence keys, each keeping its own category.
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    const { receiver, port, settled } = await startWiredReceiver(db);
    try {
      const response = await postOtlp(
        port,
        "/v1/logs",
        encodeLogRecords([
          refusalRecordWithCategory("cyber"),
          refusalRecordWithCategory("bioweapon"),
        ])
      );
      assert.equal(response.status, 200);
      await settled(1);
    } finally {
      await receiver.stop();
    }

    const rows = await selectRows(db, ClaudeCodeOtelTableName.ErrorEvent);
    assert.equal(rows.length, 2);
    const categories = rows
      .map((row) => row.refusal_category as string)
      .sort((first, second) => first.localeCompare(second));
    assert.deepEqual(categories, ["bioweapon", "cyber"]);
    for (const row of rows) {
      assert.equal(row.error_kind, ClaudeCodeErrorKind.ApiRefusal);
      assert.equal(row.observed_at, ERROR_AT);
      assert.notEqual(row.occurrence_key, "");
    }
    assert.notEqual(rows[0]?.occurrence_key, rows[1]?.occurrence_key);
  } finally {
    await cleanup();
  }
});

function modeChangeRecordWithTrigger(trigger: string): object {
  return {
    timeUnixNano: unixNano(MODE_CHANGE_AT),
    attributes: encodeAttributes({
      [ClaudeCodeOtelAttributeKey.EventName]:
        ClaudeCodeOtelEventName.PermissionModeChanged,
      [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
      [ClaudeCodeOtelAttributeKey.FromMode]: "default",
      [ClaudeCodeOtelAttributeKey.ToMode]: "acceptEdits",
      [ClaudeCodeOtelAttributeKey.Trigger]: trigger,
    }),
  };
}

function refusalRecordWithCategory(category: string): object {
  return {
    timeUnixNano: unixNano(ERROR_AT),
    attributes: encodeAttributes({
      [ClaudeCodeOtelAttributeKey.EventName]:
        ClaudeCodeOtelEventName.ApiRefusal,
      [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
      [ClaudeCodeOtelAttributeKey.RefusalCategory]: category,
      [ClaudeCodeOtelAttributeKey.HasCategory]: true,
      [ClaudeCodeOtelAttributeKey.HasExplanation]: true,
    }),
  };
}

function errorRecordWithStatus(statusCode: number): object {
  return {
    timeUnixNano: unixNano(ERROR_AT),
    attributes: encodeAttributes({
      [ClaudeCodeOtelAttributeKey.EventName]: ClaudeCodeOtelEventName.ApiError,
      [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
      [ClaudeCodeOtelAttributeKey.Attempt]: 1,
      [ClaudeCodeOtelAttributeKey.StatusCode]: statusCode,
    }),
  };
}

type CostPoint = {
  costUsd: number;
  attributes: Record<string, OtlpAttributeValue>;
};

/**
 * A cost export as the RECEIVER hands it to the normalizer — encoded to
 * protobuf and decoded back, not hand-built. A hand-built object would skip the
 * field naming and long-encoding the real decode applies, so the test would
 * exercise a payload shape production never sees.
 */
function decodedCostPayload(points: CostPoint[]): Record<string, unknown> {
  return decodePayload(OtlpExportKind.Metrics, encodeCostPoints(points));
}

function costPayloadObject(points: CostPoint[]): object {
  return {
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
                  dataPoints: points.map((point) => ({
                    timeUnixNano: unixNano(COST_OBSERVED_AT),
                    asDouble: point.costUsd,
                    attributes: encodeAttributes({
                      [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
                      [ClaudeCodeOtelAttributeKey.Model]: MODEL,
                      ...point.attributes,
                    }),
                  })),
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

function encodeCostPoints(points: CostPoint[]): Buffer {
  return encodePayload(OtlpExportKind.Metrics, costPayloadObject(points));
}
