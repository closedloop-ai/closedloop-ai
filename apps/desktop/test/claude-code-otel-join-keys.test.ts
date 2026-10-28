/**
 * ISS-7352 item F (JOIN-KEY half) and ISS-7481 — the per-event keys that join a
 * Claude Code OTel row back to Anthropic's own records, and the collisions they
 * make countable.
 *
 * The collision cases are the point of the file. Every one of these tables keys
 * on a tuple that includes a MILLISECOND instant, so two records the producer
 * genuinely distinguished can land on one key; the persister's upsert REPLACES,
 * so before these keys existed the second silently erased the first while the
 * batch summary reported both accepted. A test with one record per millisecond
 * passes identically with and without the fix and proves nothing — so each case
 * here asserts on a PAIR that collides, and on the `unusable` count that has to
 * announce the truncation.
 *
 * Item F's identity half (`organization.id`, `user.account_uuid`, …) is a
 * different grain — per-SESSION, one row in `claude_code_session_identity` — so
 * it is covered by `claude-code-otel-identity-capture.test.ts` rather than here.
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import { ClaudeCodeOtelAttributeKey } from "../src/main/otel/claude-code-otel-attributes.js";
import { ClaudeCodeOtelEventName } from "../src/main/otel/claude-code-otel-log-signals.js";
import { normalizeClaudeCodeOtelExport } from "../src/main/otel/claude-code-otel-normalizer.js";
import { ClaudeCodeOtelTableName } from "../src/main/otel/claude-code-otel-signal-contract.js";
import {
  claudeLogExportOf,
  encodeAttributes,
  encodeLogRecords,
  MODEL,
  openTestDatabase,
  postOtlp,
  SESSION_ID,
  seedSession,
  selectRows,
  startWiredReceiver,
  unixNano,
} from "./helpers/claude-code-otel-fixtures.js";

const DECISION_AT = "2026-06-18T19:00:07.000Z";
const ERROR_AT = "2026-06-18T19:00:11.000Z";
const REQUEST_AT = "2026-06-18T19:00:17.000Z";
const REQUEST_DURATION_MS = 1000;
const MODE_CHANGE_AT = "2026-06-18T19:00:21.000Z";
const MCP_AT = "2026-06-18T19:00:23.000Z";
const AUTH_AT = "2026-06-18T19:00:25.000Z";
const PLUGIN_AT = "2026-06-18T19:00:27.000Z";
const TOOL_RESULT_AT = "2026-06-18T19:00:29.000Z";
const PROMPT_ID = "cc7f1b2a-0000-4000-8000-00000000000a";
const OTHER_PROMPT_ID = "cc7f1b2a-0000-4000-8000-00000000000b";
const MESSAGE_UUID = "7a1c9f00-0000-4000-8000-00000000000c";
const WORKFLOW_RUN_ID = "run_01HZY";
const WORKFLOW_NAME = "nightly-review";

test("ISS-7481: two decisions proved distinct by tool_use_id are COUNTED, not silently merged", () => {
  // The reviewer's named case on PR #5526: several parallel `Read` calls
  // auto-allowed from config. They agree on session, tool, millisecond,
  // `decision` AND `source`, so every field the pre-fix comparison looked at
  // says "one observation reported twice" — and `claude_code_permission_event`
  // keys on `(session, tool_name, observed_at)`, so only one row can survive.
  // `tool_use_id` is the harness's own identifier for the invocation, so a
  // differing one PROVES two calls; it is the only thing that can make the
  // truncation announce itself.
  const differing = normalizeClaudeCodeOtelExport(
    claudeLogExportOf(
      encodeLogRecords([
        toolDecisionRecord({ toolUseId: "toolu_01AAA" }),
        toolDecisionRecord({ toolUseId: "toolu_01BBB" }),
      ])
    )
  );
  assert.equal(differing.unusable, 1);
  assert.equal(differing.signals.length, 1);

  // The sibling on the same derivation: a byte-identical repeat is a
  // re-delivered export, not a data problem, and must still collapse WITHOUT
  // being counted. Asserting only the differing case would leave a guard that
  // reports every retried batch as corrupt.
  const repeated = normalizeClaudeCodeOtelExport(
    claudeLogExportOf(
      encodeLogRecords([
        toolDecisionRecord({ toolUseId: "toolu_01AAA" }),
        toolDecisionRecord({ toolUseId: "toolu_01AAA" }),
      ])
    )
  );
  assert.equal(repeated.unusable, 0);
  assert.equal(repeated.signals.length, 1);
});

test("ISS-7352 item F: two failures from different prompts at one instant are COUNTED, not swallowed", () => {
  // `claude_code_error_event`'s `occurrence_key` is built from the attempt and
  // request identifiers, so two `api_error` records carrying NEITHER reduce to
  // one key. `prompt.id` is then the only thing left saying they are two
  // failures from two prompts.
  const differing = normalizeClaudeCodeOtelExport(
    claudeLogExportOf(
      encodeLogRecords([
        apiErrorRecord(PROMPT_ID),
        apiErrorRecord(OTHER_PROMPT_ID),
      ])
    )
  );
  assert.equal(differing.unusable, 1);
  assert.equal(differing.signals.length, 1);

  const repeated = normalizeClaudeCodeOtelExport(
    claudeLogExportOf(
      encodeLogRecords([apiErrorRecord(PROMPT_ID), apiErrorRecord(PROMPT_ID)])
    )
  );
  assert.equal(repeated.unusable, 0);
  assert.equal(repeated.signals.length, 1);
});

test("ISS-7352 item F: two api_requests proved distinct by request_id are COUNTED, not swallowed", () => {
  // This table's natural key is `(session, started_at, model)` and `started_at`
  // is DERIVED — the completion stamp less the duration, at millisecond
  // resolution — so two real requests can easily land on one key. Anthropic
  // issues one `request_id` per request, which makes a differing one proof the
  // collision is two requests rather than one re-sent export.
  const differing = normalizeClaudeCodeOtelExport(
    claudeLogExportOf(
      encodeLogRecords([
        apiRequestRecord("req_01AAA"),
        apiRequestRecord("req_01BBB"),
      ])
    )
  );
  assert.equal(differing.unusable, 1);
  assert.equal(differing.signals.length, 1);

  const repeated = normalizeClaudeCodeOtelExport(
    claudeLogExportOf(
      encodeLogRecords([
        apiRequestRecord("req_01AAA"),
        apiRequestRecord("req_01AAA"),
      ])
    )
  );
  assert.equal(repeated.unusable, 0);
  assert.equal(repeated.signals.length, 1);
});

test("ISS-7352 item F: an event's join keys reach its persisted row", async () => {
  // Drives the WIRED receiver, so this proves the production path — receiver,
  // normalizer, db facade, persister, column — and not just the reader under
  // it. A unit assertion on the signal would stay green if the persister never
  // learned the new columns.
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    const { receiver, port, settled } = await startWiredReceiver(db);
    try {
      const response = await postOtlp(
        port,
        "/v1/logs",
        encodeLogRecords([
          toolDecisionRecord({
            toolUseId: "toolu_01AAA",
            correlated: true,
          }),
        ])
      );
      assert.equal(response.status, 200);
      await settled(1);
    } finally {
      await receiver.stop();
    }

    const rows = await selectRows(db, ClaudeCodeOtelTableName.PermissionEvent);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row?.tool_use_id, "toolu_01AAA");
    assert.equal(row?.prompt_id, PROMPT_ID);
    assert.equal(row?.message_uuid, MESSAGE_UUID);
    assert.equal(row?.workflow_run_id, WORKFLOW_RUN_ID);
    assert.equal(row?.workflow_name, WORKFLOW_NAME);
  } finally {
    await cleanup();
  }
});

test("ISS-7352 item F: an absent join key is stored NULL, never an invented value", async () => {
  // The counterfactual for the column defaults. These four are nullable on
  // purpose — `workflow.*` exists only for a workflow-launched session — and a
  // "" or a placeholder here would read as a real observation of an empty
  // workflow name. NULL is what a reader has to see to know nothing was
  // stamped.
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    const { receiver, port, settled } = await startWiredReceiver(db);
    try {
      const response = await postOtlp(
        port,
        "/v1/logs",
        encodeLogRecords([toolDecisionRecord({ toolUseId: "toolu_01AAA" })])
      );
      assert.equal(response.status, 200);
      await settled(1);
    } finally {
      await receiver.stop();
    }

    const rows = await selectRows(db, ClaudeCodeOtelTableName.PermissionEvent);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row?.tool_use_id, "toolu_01AAA");
    assert.equal(row?.prompt_id, null);
    assert.equal(row?.message_uuid, null);
    assert.equal(row?.workflow_run_id, null);
    assert.equal(row?.workflow_name, null);
  } finally {
    await cleanup();
  }
});

/**
 * The collision guard sees ONE export, and that boundary is now pinned.
 *
 * @whitlockk on this PR: two decisions arriving in SEPARATE requests each clear the
 * reducer, so neither batch observes a collision, `unusable` stays zero, and the
 * second upsert replaces the first row. That is real, and it is the documented
 * behaviour rather than a defect this PR introduces — the natural key
 * `(session, tool_name, observed_at)` has always been last-write-wins across
 * exports (ISS-7481), and ISS-7352 item F scopes this change to join keys.
 *
 * Moving the comparison to the persistence boundary would need a read-before-
 * write or a database-level guard on every side table, which is a different
 * change with a different risk. So this covers and narrows instead: the limit is
 * asserted here, so a future reader learns it from a failing test rather than
 * from a comment that might drift.
 */
test("ISS-7481: the collision guard is per-export, and says so", () => {
  const first = normalizeClaudeCodeOtelExport(
    claudeLogExportOf(
      encodeLogRecords([toolDecisionRecord({ toolUseId: "toolu_01AAA" })])
    )
  );
  const second = normalizeClaudeCodeOtelExport(
    claudeLogExportOf(
      encodeLogRecords([toolDecisionRecord({ toolUseId: "toolu_01BBB" })])
    )
  );

  // Same session, tool and millisecond, differing `tool_use_id` — the exact pair
  // that IS counted when it shares one export (the first test in this file).
  // Split across two, neither batch can see the other, so nothing is counted.
  assert.equal(first.unusable, 0);
  assert.equal(second.unusable, 0);
  assert.equal(first.signals.length, 1);
  assert.equal(second.signals.length, 1);

  // The narrowing, stated as an assertion rather than prose: what the guard
  // proves is within-export distinctness, so the two signals are indistinguishable
  // to the persister and the later write wins on the shared natural key.
  const firstDecision = first.signals[0];
  const secondDecision = second.signals[0];
  if (!(firstDecision && "observedAt" in firstDecision)) {
    assert.fail("the first export did not yield a timestamped decision");
  }
  if (!(secondDecision && "observedAt" in secondDecision)) {
    assert.fail("the second export did not yield a timestamped decision");
  }
  assert.equal(firstDecision.observedAt, secondDecision.observedAt);
});

/**
 * The mixed export's records are well-formed — provable without a receiver.
 *
 * The table assertions below run through the wired receiver, which CI executes
 * and a dev box may not. This case is the part that CAN fail locally: a record
 * whose required attributes are wrong normalizes to nothing, and the eight-row
 * assertion would then be reporting a fixture bug as a persistence bug.
 */
test("ISS-7352 item F: every record in the mixed export normalizes", () => {
  const normalized = normalizeClaudeCodeOtelExport(
    claudeLogExportOf(encodeLogRecords(mixedCorrelatedExport()))
  );

  assert.equal(normalized.unusable, 0);
  assert.equal(normalized.signals.length, 8);
  // Each carries the join keys, so a row later missing them is the persister's
  // doing and not the reader's.
  for (const signal of normalized.signals) {
    // The union has members that carry no correlation at all (cost usage,
    // lines of code, session start, active time), so this narrows rather than
    // casts — and a record that normalized to one of those fails HERE, naming
    // the type, instead of reading `undefined` as a mismatch further down.
    if (!("promptId" in signal)) {
      assert.fail(`${signal.type} carries no event correlation`);
    }
    assert.equal(signal.promptId, PROMPT_ID);
    assert.equal(signal.messageUuid, MESSAGE_UUID);
    assert.equal(signal.workflowRunId, WORKFLOW_RUN_ID);
    assert.equal(signal.workflowName, WORKFLOW_NAME);
  }
});

/** One record per table the migration widened, every one correlated. */
function mixedCorrelatedExport() {
  return [
    toolDecisionRecord({ toolUseId: "toolu_01MIX", correlated: true }),
    correlatedApiRequestRecord(),
    correlatedApiErrorRecord(),
    permissionModeChangeRecord(),
    mcpServerConnectionRecord(),
    authEventRecord(),
    pluginEventRecord(),
    toolResultRecord(),
  ];
}

function correlatedApiRequestRecord() {
  return {
    timeUnixNano: unixNano(REQUEST_AT),
    attributes: encodeAttributes({
      [ClaudeCodeOtelAttributeKey.EventName]:
        ClaudeCodeOtelEventName.ApiRequest,
      [ClaudeCodeOtelAttributeKey.EventTimestamp]: REQUEST_AT,
      [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
      [ClaudeCodeOtelAttributeKey.Model]: MODEL,
      [ClaudeCodeOtelAttributeKey.CostUsd]: 1.25,
      [ClaudeCodeOtelAttributeKey.DurationMs]: REQUEST_DURATION_MS,
      [ClaudeCodeOtelAttributeKey.RequestId]: "req_01MIX",
      ...correlationAttributes(),
    }),
  };
}

/**
 * ISS-7352 item F — the same join keys, on EVERY table the migration widened.
 *
 * The case above drives one table. Migration 0086 adds the four correlation
 * columns to EIGHT, and each writes through its own `create*Operation`, so a
 * single-table assertion leaves seven upserts free to drop the columns while it
 * stays green — the gap @whitlockk named. One mixed export exercises all eight in
 * the order a real exporter batches them, and every row is read back.
 */
test("ISS-7352 item F: every event table persists the join keys", async () => {
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    const { receiver, port, settled } = await startWiredReceiver(db);
    try {
      const response = await postOtlp(
        port,
        "/v1/logs",
        encodeLogRecords(mixedCorrelatedExport())
      );
      assert.equal(response.status, 200);
      // ONE batch, not eight: `settled` counts export batches reaching
      // persistence, and this is a single mixed export.
      await settled(1);
    } finally {
      await receiver.stop();
    }

    // Every table the migration widened, read back from the real store.
    for (const table of [
      ClaudeCodeOtelTableName.PermissionEvent,
      ClaudeCodeOtelTableName.ApiRequest,
      ClaudeCodeOtelTableName.ErrorEvent,
      ClaudeCodeOtelTableName.PermissionModeChange,
      ClaudeCodeOtelTableName.McpServerConnection,
      ClaudeCodeOtelTableName.AuthEvent,
      ClaudeCodeOtelTableName.PluginEvent,
      ClaudeCodeOtelTableName.ToolResult,
    ]) {
      const rows = await selectRows(db, table);
      assert.equal(rows.length, 1, `${table}: expected exactly one row`);
      const row = rows[0];
      assert.equal(row?.prompt_id, PROMPT_ID, `${table}: prompt_id`);
      assert.equal(row?.message_uuid, MESSAGE_UUID, `${table}: message_uuid`);
      assert.equal(
        row?.workflow_run_id,
        WORKFLOW_RUN_ID,
        `${table}: workflow_run_id`
      );
      assert.equal(
        row?.workflow_name,
        WORKFLOW_NAME,
        `${table}: workflow_name`
      );
    }
  } finally {
    await cleanup();
  }
});

/** The four join keys, on every record the mixed export sends. */
function correlationAttributes() {
  return {
    [ClaudeCodeOtelAttributeKey.PromptId]: PROMPT_ID,
    [ClaudeCodeOtelAttributeKey.MessageUuid]: MESSAGE_UUID,
    [ClaudeCodeOtelAttributeKey.WorkflowRunId]: WORKFLOW_RUN_ID,
    [ClaudeCodeOtelAttributeKey.WorkflowName]: WORKFLOW_NAME,
  };
}

function correlatedApiErrorRecord() {
  return {
    timeUnixNano: unixNano(ERROR_AT),
    attributes: encodeAttributes({
      [ClaudeCodeOtelAttributeKey.EventName]: ClaudeCodeOtelEventName.ApiError,
      [ClaudeCodeOtelAttributeKey.EventTimestamp]: ERROR_AT,
      [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
      [ClaudeCodeOtelAttributeKey.ErrorCategory]: "overloaded",
      ...correlationAttributes(),
    }),
  };
}

function permissionModeChangeRecord() {
  return {
    timeUnixNano: unixNano(MODE_CHANGE_AT),
    attributes: encodeAttributes({
      [ClaudeCodeOtelAttributeKey.EventName]:
        ClaudeCodeOtelEventName.PermissionModeChanged,
      [ClaudeCodeOtelAttributeKey.EventTimestamp]: MODE_CHANGE_AT,
      [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
      [ClaudeCodeOtelAttributeKey.FromMode]: "default",
      [ClaudeCodeOtelAttributeKey.ToMode]: "acceptEdits",
      ...correlationAttributes(),
    }),
  };
}

function mcpServerConnectionRecord() {
  return {
    timeUnixNano: unixNano(MCP_AT),
    attributes: encodeAttributes({
      [ClaudeCodeOtelAttributeKey.EventName]:
        ClaudeCodeOtelEventName.McpServerConnection,
      [ClaudeCodeOtelAttributeKey.EventTimestamp]: MCP_AT,
      [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
      [ClaudeCodeOtelAttributeKey.Status]: "connected",
      ...correlationAttributes(),
    }),
  };
}

function authEventRecord() {
  return {
    timeUnixNano: unixNano(AUTH_AT),
    attributes: encodeAttributes({
      [ClaudeCodeOtelAttributeKey.EventName]: ClaudeCodeOtelEventName.Auth,
      [ClaudeCodeOtelAttributeKey.EventTimestamp]: AUTH_AT,
      [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
      [ClaudeCodeOtelAttributeKey.Action]: "login",
      ...correlationAttributes(),
    }),
  };
}

function pluginEventRecord() {
  return {
    timeUnixNano: unixNano(PLUGIN_AT),
    attributes: encodeAttributes({
      [ClaudeCodeOtelAttributeKey.EventName]:
        ClaudeCodeOtelEventName.PluginLoaded,
      [ClaudeCodeOtelAttributeKey.EventTimestamp]: PLUGIN_AT,
      [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
      ...correlationAttributes(),
    }),
  };
}

function toolResultRecord() {
  return {
    timeUnixNano: unixNano(TOOL_RESULT_AT),
    attributes: encodeAttributes({
      [ClaudeCodeOtelAttributeKey.EventName]:
        ClaudeCodeOtelEventName.ToolResult,
      [ClaudeCodeOtelAttributeKey.EventTimestamp]: TOOL_RESULT_AT,
      [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
      [ClaudeCodeOtelAttributeKey.ToolName]: "Read",
      [ClaudeCodeOtelAttributeKey.Success]: true,
      [ClaudeCodeOtelAttributeKey.ToolInputSizeBytes]: 128,
      [ClaudeCodeOtelAttributeKey.ToolResultSizeBytes]: 512,
      ...correlationAttributes(),
    }),
  };
}

function toolDecisionRecord(options: {
  toolUseId: string;
  correlated?: boolean;
}) {
  return {
    timeUnixNano: unixNano(DECISION_AT),
    attributes: encodeAttributes({
      [ClaudeCodeOtelAttributeKey.EventName]:
        ClaudeCodeOtelEventName.ToolDecision,
      [ClaudeCodeOtelAttributeKey.EventTimestamp]: DECISION_AT,
      [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
      [ClaudeCodeOtelAttributeKey.ToolName]: "Read",
      [ClaudeCodeOtelAttributeKey.Decision]: "accept",
      [ClaudeCodeOtelAttributeKey.Source]: "config",
      [ClaudeCodeOtelAttributeKey.ToolUseId]: options.toolUseId,
      ...(options.correlated
        ? {
            [ClaudeCodeOtelAttributeKey.PromptId]: PROMPT_ID,
            [ClaudeCodeOtelAttributeKey.MessageUuid]: MESSAGE_UUID,
            [ClaudeCodeOtelAttributeKey.WorkflowRunId]: WORKFLOW_RUN_ID,
            [ClaudeCodeOtelAttributeKey.WorkflowName]: WORKFLOW_NAME,
          }
        : {}),
    }),
  };
}

function apiErrorRecord(promptId: string) {
  return {
    timeUnixNano: unixNano(ERROR_AT),
    attributes: encodeAttributes({
      [ClaudeCodeOtelAttributeKey.EventName]: ClaudeCodeOtelEventName.ApiError,
      [ClaudeCodeOtelAttributeKey.EventTimestamp]: ERROR_AT,
      [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
      [ClaudeCodeOtelAttributeKey.ErrorCategory]: "overloaded",
      [ClaudeCodeOtelAttributeKey.PromptId]: promptId,
    }),
  };
}

function apiRequestRecord(requestId: string) {
  return {
    timeUnixNano: unixNano(REQUEST_AT),
    attributes: encodeAttributes({
      [ClaudeCodeOtelAttributeKey.EventName]:
        ClaudeCodeOtelEventName.ApiRequest,
      [ClaudeCodeOtelAttributeKey.EventTimestamp]: REQUEST_AT,
      [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
      [ClaudeCodeOtelAttributeKey.Model]: MODEL,
      [ClaudeCodeOtelAttributeKey.CostUsd]: 1.25,
      [ClaudeCodeOtelAttributeKey.DurationMs]: REQUEST_DURATION_MS,
      [ClaudeCodeOtelAttributeKey.RequestId]: requestId,
    }),
  };
}
