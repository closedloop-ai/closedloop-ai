/**
 * ISS-7352 capture list D, the BETA half: the `claude_code.llm_request` span,
 * the only carrier of `ttft_ms`, `stop_reason`,
 * `gen_ai.response.finish_reasons` and `response.has_tool_call`. Spans only
 * arrive when the user has set `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`; nothing
 * in this lane sets it, so these tests supply the spans a producer with the
 * beta on would send.
 *
 * Every case that asserts on a ROW drives the WIRED receiver, proving receiver
 * → normalizer → db facade → persister. The original ISS-7352 defect was a
 * persister with no caller, so a test calling the writer directly would
 * reproduce that bug rather than catch it. The cases that assert on `unusable`
 * call the normalizer directly, because a refusal is by definition the absence
 * of a row and that count is its only observable.
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import { ClaudeCodeOtelAttributeKey } from "../src/main/otel/claude-code-otel-attributes.js";
import { normalizeClaudeCodeOtelExport } from "../src/main/otel/claude-code-otel-normalizer.js";
import {
  ClaudeCodeOtelSignalType,
  ClaudeCodeOtelTableName,
} from "../src/main/otel/claude-code-otel-signal-contract.js";
import { ClaudeCodeOtelSpanName } from "../src/main/otel/claude-code-otel-trace-signals.js";
import {
  CONTENT_SENTINEL,
  claudeTraceExportOf,
  encodeAttributes,
  encodeSpans,
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

const SPAN_AT = "2026-06-18T19:00:51.000Z";
/**
 * Pinned as literals rather than derived from the code under test, so a rename
 * cannot silently rewrite the expectation along with the implementation.
 */
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_ID = "00f067aa0ba902b7";
const PARENT_SPAN_ID = "0102030405060708";
const OTHER_SPAN_ID = "a1b2c3d4e5f60718";
const TTFT_MS = 412;
const STOP_REASON = "tool_use";
const FINISH_REASONS = ["tool_use", "end_turn"];
/** A sibling span this lane does not claim. */
const TOOL_SPAN_NAME = "claude_code.tool";
/** OTel's `STATUS_CODE_ERROR`. */
const STATUS_CODE_ERROR = 2;

test("ISS-7352 item D: an llm_request span persists ttft_ms, stop_reason and finish reasons", async () => {
  // These four attributes exist nowhere else in the published telemetry, so
  // this row is the only place the beta tier's measurements can be read.
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    const { receiver, port, settled } = await startWiredReceiver(db);
    try {
      const response = await postOtlp(
        port,
        "/v1/traces",
        encodeSpans([llmRequestSpan({})])
      );
      assert.equal(response.status, 200);
      await settled(1);
    } finally {
      await receiver.stop();
    }

    const rows = await selectRows(db, ClaudeCodeOtelTableName.LlmRequest);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.session_id, SESSION_ID);
    assert.equal(row.trace_id, TRACE_ID);
    assert.equal(row.span_id, SPAN_ID);
    assert.equal(row.parent_span_id, PARENT_SPAN_ID);
    assert.equal(row.started_at, SPAN_AT);
    assert.equal(Number(row.ttft_ms), TTFT_MS);
    assert.equal(row.stop_reason, STOP_REASON);
    assert.equal(row.finish_reasons, FINISH_REASONS.join(","));
    assert.equal(Number(row.response_has_tool_call), 1);
    assert.equal(Number(row.attempt), 2);
    assert.equal(Number(row.status_code), 200);
    assert.equal(Number(row.input_tokens), 1200);
    assert.equal(Number(row.output_tokens), 340);
    assert.equal(row.model, MODEL);
    assert.equal(row.request_id, "req_01ABC");
    assert.equal(row.workflow_run_id, "wf_01JAAA");
  } finally {
    await cleanup();
  }
});

test("ISS-7352 item D: two spans under one span id with different ttft are refused, not overwritten", () => {
  // `(trace_id, span_id)` is the row's whole key, so without the collision
  // guard the second span's upsert REPLACES the first and one of two
  // contradictory measurements is silently reported as the request's ttft.
  const result = normalizeClaudeCodeOtelExport(
    claudeTraceExportOf(
      encodeSpans([llmRequestSpan({}), llmRequestSpan({ ttftMs: 999 })])
    )
  );

  assert.equal(result.signals.length, 1);
  assert.equal(result.unusable, 1);
  const signal = result.signals[0];
  assert.equal(signal.type, ClaudeCodeOtelSignalType.LlmRequest);
  assert.equal(
    signal.type === ClaudeCodeOtelSignalType.LlmRequest
      ? signal.ttftMs
      : undefined,
    TTFT_MS
  );
});

test("ISS-7352 item D: two spans with different span ids are two rows", async () => {
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    const { receiver, port, settled } = await startWiredReceiver(db);
    try {
      const response = await postOtlp(
        port,
        "/v1/traces",
        encodeSpans([
          llmRequestSpan({}),
          llmRequestSpan({ spanId: OTHER_SPAN_ID, ttftMs: 999 }),
        ])
      );
      assert.equal(response.status, 200);
      await settled(1);
    } finally {
      await receiver.stop();
    }

    const rows = await selectRows(db, ClaudeCodeOtelTableName.LlmRequest);
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((each) => Number(each.ttft_ms)).sort((a, b) => a - b),
      [TTFT_MS, 999]
    );
  } finally {
    await cleanup();
  }
});

test("ISS-7352 item D: a corrupt ttft_ms fails the whole span rather than storing the rest", () => {
  // Valid-or-absent: a negative latency is impossible, and storing the span
  // without it would report a real-looking request whose headline measurement
  // silently went missing.
  const result = normalizeClaudeCodeOtelExport(
    claudeTraceExportOf(encodeSpans([llmRequestSpan({ ttftMs: -1 })]))
  );

  assert.equal(result.signals.length, 0);
  assert.equal(result.unusable, 1);
});

test("ISS-7352 item D: a malformed stop_reason fails the whole span rather than storing the rest", () => {
  // Valid-or-absent for the strings too: `stop_reason` is a closed field, and
  // a number under it is not "the producer did not say". Read as absent, the
  // span would persist as a normal request with a NULL stop reason beside a
  // real ttft — indistinguishable from one the producer genuinely left out.
  const result = normalizeClaudeCodeOtelExport(
    claudeTraceExportOf(encodeSpans([llmRequestSpan({ stopReason: 7 })]))
  );

  assert.equal(result.signals.length, 0);
  assert.equal(result.unusable, 1);
});

test("ISS-7352 item D: a blank optional string is absent, not malformed", () => {
  // The GA `api_request` reader omits a blank `request_id`; the beta span reads
  // a blank the same way, so the two tiers cannot disagree about what "" means.
  // A failed request that stamps `stop_reason: ""` keeps its row, minus the
  // column.
  const result = normalizeClaudeCodeOtelExport(
    claudeTraceExportOf(encodeSpans([llmRequestSpan({ stopReason: "" })]))
  );

  assert.equal(result.unusable, 0);
  assert.equal(result.signals.length, 1);
  const signal = result.signals[0];
  assert.equal(signal.type, ClaudeCodeOtelSignalType.LlmRequest);
  assert.equal("stopReason" in signal, false);
});

test("ISS-7352 item D: an empty finish_reasons list is absent, not malformed", () => {
  // A request that failed before the model answered is a realistic producer of
  // `finish_reasons: []`; refusing it would drop every such request from the
  // table while `success` and `status_code` already carry the failure.
  const result = normalizeClaudeCodeOtelExport(
    claudeTraceExportOf(encodeSpans([llmRequestSpan({ finishReasons: [] })]))
  );

  assert.equal(result.unusable, 0);
  assert.equal(result.signals.length, 1);
  const signal = result.signals[0];
  assert.equal(signal.type, ClaudeCodeOtelSignalType.LlmRequest);
  assert.equal("finishReasons" in signal, false);
});

test("ISS-7352 item D: a blank finish_reasons member fails the whole span", () => {
  // The seam between empty and malformed: a list with a blank member is not a
  // shorter list. Storing `tool_use` alone would read as a genuine one-reason
  // response.
  const result = normalizeClaudeCodeOtelExport(
    claudeTraceExportOf(
      encodeSpans([llmRequestSpan({ finishReasons: ["tool_use", ""] })])
    )
  );

  assert.equal(result.signals.length, 0);
  assert.equal(result.unusable, 1);
});

test("ISS-7352 item D: a later export under the same span id preserves the stored row", async () => {
  // The in-batch guard only sees spans that arrive together. A second POST
  // carrying the same trace and span ids with a different ttft reaches the
  // write alone, so the write itself must refuse to rewrite the observation —
  // and an exact retry, the case the upsert exists for, must still land.
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db);
    const { receiver, port, settled, summaries } = await startWiredReceiver(db);
    try {
      const first = await postOtlp(
        port,
        "/v1/traces",
        encodeSpans([llmRequestSpan({})])
      );
      assert.equal(first.status, 200);
      await settled(1);

      const conflicting = await postOtlp(
        port,
        "/v1/traces",
        encodeSpans([llmRequestSpan({ ttftMs: 999 })])
      );
      assert.equal(conflicting.status, 200);
      await settled(2);

      const retry = await postOtlp(
        port,
        "/v1/traces",
        encodeSpans([llmRequestSpan({})])
      );
      assert.equal(retry.status, 200);
      await settled(3);
    } finally {
      await receiver.stop();
    }

    const rows = await selectRows(db, ClaudeCodeOtelTableName.LlmRequest);
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].ttft_ms), TTFT_MS);
    assert.equal(rows[0].stop_reason, STOP_REASON);
    assert.deepEqual(summaries(), [
      { accepted: 1, rejected: 0 },
      { accepted: 0, rejected: 1 },
      { accepted: 1, rejected: 0 },
    ]);
  } finally {
    await cleanup();
  }
});

test("ISS-7352 item D: span content and unclaimed sibling spans never reach a signal", () => {
  // The operator's 2026-09-11 ruling: the error message attribute is not
  // captured — only that there WAS an error message — so no substring, first
  // line, truncation, hash or "sanitized" rendering of `status.message` is
  // taken and no classification is derived by reading it. Span EVENTS stay
  // unread for the same reason: a `tool.output` event carries request and
  // response bodies under `OTEL_LOG_TOOL_CONTENT=1`.
  const result = normalizeClaudeCodeOtelExport(
    claudeTraceExportOf(
      encodeSpans([
        {
          name: TOOL_SPAN_NAME,
          traceId: Buffer.from(TRACE_ID, "hex"),
          spanId: Buffer.from(OTHER_SPAN_ID, "hex"),
          startTimeUnixNano: unixNano(SPAN_AT),
          attributes: encodeAttributes({
            "session.id": SESSION_ID,
            full_command: CONTENT_SENTINEL,
            file_path: CONTENT_SENTINEL,
          }),
        },
        {
          ...llmRequestSpan({}),
          status: { code: STATUS_CODE_ERROR, message: CONTENT_SENTINEL },
        },
      ])
    )
  );

  assert.equal(result.signals.length, 1);
  assert.equal(
    JSON.stringify(result.signals).includes(CONTENT_SENTINEL),
    false
  );
  // The tool span is out of scope, not corrupt, so it is skipped rather than
  // counted — a count here would report a data problem that did not occur.
  assert.equal(result.unusable, 0);
});

test("ISS-7352 item D: colliding spans disagreeing on finish_reasons are counted", () => {
  // A collision keeps the FIRST record and drops the later one. Dropping it
  // uncounted is only honest when the two report the same request, so the
  // guard must compare every non-key field rather than a hand-written subset:
  // `gen_ai.response.finish_reasons` is one of the four attributes this span
  // exists to carry, and a disagreement there is a real conflict.
  const result = normalizeClaudeCodeOtelExport(
    claudeTraceExportOf(
      encodeSpans([
        llmRequestSpan({}),
        llmRequestSpan({ finishReasons: ["max_tokens"] }),
      ])
    )
  );

  assert.equal(result.signals.length, 1);
  assert.equal(result.unusable, 1);
});

test("ISS-7352 item D: an identical repeat of one span is collapsed uncounted", () => {
  // The other half of that branch, so neither side can drift: a retried OTLP
  // batch reports one observation twice and its upsert is idempotent, so
  // counting it would report a data problem that did not occur.
  const result = normalizeClaudeCodeOtelExport(
    claudeTraceExportOf(encodeSpans([llmRequestSpan({}), llmRequestSpan({})]))
  );

  assert.equal(result.signals.length, 1);
  assert.equal(result.unusable, 0);
});

function llmRequestSpan(options: {
  ttftMs?: number;
  spanId?: string;
  finishReasons?: readonly string[];
  stopReason?: OtlpAttributeValue;
}): object {
  const attributes: Record<string, OtlpAttributeValue> = {
    [ClaudeCodeOtelAttributeKey.SessionId]: SESSION_ID,
    [ClaudeCodeOtelAttributeKey.Model]: MODEL,
    [ClaudeCodeOtelAttributeKey.TtftMs]: options.ttftMs ?? TTFT_MS,
    [ClaudeCodeOtelAttributeKey.DurationMs]: 2500,
    [ClaudeCodeOtelAttributeKey.StopReason]: options.stopReason ?? STOP_REASON,
    [ClaudeCodeOtelAttributeKey.ResponseHasToolCall]: true,
    [ClaudeCodeOtelAttributeKey.Attempt]: 2,
    [ClaudeCodeOtelAttributeKey.Success]: true,
    [ClaudeCodeOtelAttributeKey.StatusCode]: 200,
    [ClaudeCodeOtelAttributeKey.InputTokens]: 1200,
    [ClaudeCodeOtelAttributeKey.OutputTokens]: 340,
    [ClaudeCodeOtelAttributeKey.RequestId]: "req_01ABC",
    [ClaudeCodeOtelAttributeKey.WorkflowRunId]: "wf_01JAAA",
  };
  return {
    name: ClaudeCodeOtelSpanName.LlmRequest,
    traceId: Buffer.from(TRACE_ID, "hex"),
    spanId: Buffer.from(options.spanId ?? SPAN_ID, "hex"),
    parentSpanId: Buffer.from(PARENT_SPAN_ID, "hex"),
    startTimeUnixNano: unixNano(SPAN_AT),
    attributes: [
      ...encodeAttributes(attributes),
      // Hand-built: `gen_ai.response.finish_reasons` is a `string[]` in the
      // gen-AI semantic conventions, which arrives as an `arrayValue` AnyValue
      // and which `encodeAttributes` does not build.
      {
        key: ClaudeCodeOtelAttributeKey.FinishReasons,
        value: {
          arrayValue: {
            values: (options.finishReasons ?? FINISH_REASONS).map((reason) => ({
              stringValue: reason,
            })),
          },
        },
      },
    ],
  };
}

/**
 * The wire spellings the beta span actually stamps, repeated here as literals
 * ON PURPOSE. Everywhere else in this suite a fixture keys off
 * {@link ClaudeCodeOtelAttributeKey}, which is right for a fixture and useless
 * as a check: the const and the fixture then agree with each other no matter
 * what the producer sends, so a mistyped key reads NULL forever and every test
 * stays green. Four of these were mistyped on the way in and survived exactly
 * that way. A literal is the only thing on this side of the wire that can
 * disagree with the const, so this is the one place the repo's
 * import-the-constant rule is deliberately not followed.
 *
 * `WorkflowRunId` / `WorkflowName` are item F's members, pinned here too
 * because the beta span reads them and a second spelling is what collided.
 */
const BETA_SPAN_WIRE_KEYS = {
  TtftMs: "ttft_ms",
  StopReason: "stop_reason",
  FinishReasons: "gen_ai.response.finish_reasons",
  ResponseHasToolCall: "response.has_tool_call",
  RequestModel: "gen_ai.request.model",
  RequestContext: "llm_request.context",
  ResponseId: "gen_ai.response.id",
  AgentId: "agent_id",
  ParentAgentId: "parent_agent_id",
  WorkflowRunId: "workflow.run_id",
  WorkflowName: "workflow.name",
} as const;

test("ISS-7352 item D: the beta span's attribute keys match the wire", () => {
  for (const [member, wireKey] of Object.entries(BETA_SPAN_WIRE_KEYS)) {
    assert.equal(
      ClaudeCodeOtelAttributeKey[member as keyof typeof BETA_SPAN_WIRE_KEYS],
      wireKey
    );
  }
});
