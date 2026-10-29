import assert from "node:assert/strict";
import { test } from "vitest";
import { z } from "zod";
import { summarizeHistoricalWorkerResponseIssues } from "../src/main/collectors/engine/historical-parse-worker-diagnostics.js";
import { HistoricalParseWorkerLimits } from "../src/main/collectors/engine/historical-parse-worker-limits-and-clamping.js";
import {
  createHistoricalParseWorkerFailedResponse,
  createHistoricalParseWorkerParsedResponse,
  HistoricalParseWorkerResponseType,
  historicalParseWorkerResponseSchema,
} from "../src/main/collectors/engine/historical-parse-worker-protocol.js";
import { clampSessionsForWorkerResponse } from "../src/main/collectors/engine/historical-parse-worker-response-budget.js";
import type { NormalizedSession } from "../src/main/collectors/types.js";
import {
  CAPPED_UNION_DIAGNOSTIC_PATTERN,
  INVALID_WORKER_RESPONSE_REQUEST_PATTERN,
  makeSession,
  OFFENDING_FIELD_DIAGNOSTIC_PATTERN,
  ROOT_INVALID_UNION_PATTERN,
  UNCAPPED_UNION_LEAF_PATTERN,
} from "./historical-parse-worker-response-support.js";

test("historical parse worker response rejects oversized aggregate arrays", () => {
  const result = historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "historical-parse-1",
    sessions: [makeAggregateHeavySession("aggregate-heavy")],
  });

  assert.equal(result.success, false);
});

test("historical parse worker response rejects oversized aggregate text", () => {
  const text = "x".repeat(HistoricalParseWorkerLimits.maxLongTextLength);
  const result = historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "historical-parse-1",
    sessions: [
      {
        ...makeSession("aggregate-text"),
        messages: Array.from({ length: 33 }, () => ({
          role: "assistant",
          timestamp: "2026-06-07T12:00:00.000Z",
          text,
        })),
      },
    ],
  });

  assert.equal(result.success, false);
});

test("historical parse worker converts malformed parsed output into a small nonfatal failure", () => {
  const response = createHistoricalParseWorkerParsedResponse(
    "historical-parse-1",
    [{ sessionId: "missing-required-fields" } as NormalizedSession]
  );

  assert.equal(response.type, HistoricalParseWorkerResponseType.Failed);
  if (response.type !== HistoricalParseWorkerResponseType.Failed) {
    assert.fail("expected malformed parsed output to become a failed response");
  }
  assert.equal(response.fatal, undefined);
  assert.match(response.message, INVALID_WORKER_RESPONSE_REQUEST_PATTERN);
  assert.ok(response.diagnostic);
  assert.equal(response.diagnostic.includes("sessions.0.sessionId"), false);
});

test("historical parse worker names the offending field in the nonfatal diagnostic", () => {
  // A well-formed session that clamps cleanly but violates a per-field bound —
  // the case that produced a bare `<root>:invalid_union` before the diagnostic
  // was sharpened.
  //
  // The fixture is an oversized `cwd` (a SHORT-capped field), not the oversized
  // `name` it used to be: ISS-5797 taught the producer to truncate every
  // long-text field, so an oversized `name` is now clamped and the response
  // legitimately succeeds. Short-capped fields are identifiers and paths rather
  // than transcript payloads, are deliberately left unclamped, and so remain the
  // honest way to exercise the diagnostic path.
  const response = createHistoricalParseWorkerParsedResponse(
    "historical-parse-1",
    [
      {
        ...makeSession("oversized-cwd"),
        cwd: "x".repeat(HistoricalParseWorkerLimits.maxShortTextLength + 1),
      },
    ]
  );

  assert.equal(response.type, HistoricalParseWorkerResponseType.Failed);
  if (response.type !== HistoricalParseWorkerResponseType.Failed) {
    assert.fail(
      "expected an out-of-bounds session to become a failed response"
    );
  }
  assert.ok(response.diagnostic);
  assert.match(response.diagnostic, OFFENDING_FIELD_DIAGNOSTIC_PATTERN);
  assert.doesNotMatch(response.diagnostic, ROOT_INVALID_UNION_PATTERN);
});

test("historical parse worker caps nested invalid union diagnostic flattening", () => {
  const error = new z.ZodError([makeNestedInvalidUnionIssue(12)]);
  const diagnostic = summarizeHistoricalWorkerResponseIssues(error);

  assert.match(diagnostic, CAPPED_UNION_DIAGNOSTIC_PATTERN);
  assert.doesNotMatch(diagnostic, UNCAPPED_UNION_LEAF_PATTERN);
  assert.equal(diagnostic.split("; ").length, 6);
});

test("historical parse worker failed response factory bounds and sanitizes diagnostics", () => {
  const response = createHistoricalParseWorkerFailedResponse(
    "historical-parse-1",
    `failed at /Users/alice/private/transcript.jsonl OPENAI_API_KEY=secret-value ${"x".repeat(HistoricalParseWorkerLimits.maxLongTextLength)}`,
    {
      diagnostic:
        "Bearer ghp_123456789012345678901234567890 at file:///Users/alice/transcript.jsonl",
    }
  );

  assert.equal(response.type, HistoricalParseWorkerResponseType.Failed);
  assert.equal(response.fatal, undefined);
  assert.equal(
    response.message.length <= HistoricalParseWorkerLimits.maxLongTextLength,
    true
  );
  assert.equal(response.message.includes("/Users/alice"), false);
  assert.equal(response.message.includes("secret-value"), false);
  assert.ok(response.diagnostic);
  assert.equal(response.diagnostic.includes("ghp_"), false);
  assert.equal(response.diagnostic.includes("file:///Users/alice"), false);
});

function makeNestedInvalidUnionIssue(depth: number): z.ZodIssue {
  if (depth === 0) {
    return {
      code: "invalid_type",
      expected: "string",
      path: ["leaf"],
      message: "Invalid input: expected string, received number",
    } as z.ZodIssue;
  }

  return {
    code: "invalid_union",
    path: [`union-${depth}`],
    message: "Invalid input",
    errors: [
      [makeNestedInvalidUnionIssue(depth - 1)],
      [makeNestedInvalidUnionIssue(depth - 1)],
    ],
  } as z.ZodIssue;
}

test("clampSessionsForWorkerResponse leaves a normal session untouched", () => {
  const session = makeSession("normal");
  const [clamped] = clampSessionsForWorkerResponse([session]).sessions;

  assert.deepEqual(clamped, session);
});

test("clampSessionsForWorkerResponse trims an oversized session to a valid response", () => {
  // Raw, the over-budget session is rejected by the response schema.
  assert.equal(
    historicalParseWorkerResponseSchema.safeParse({
      type: HistoricalParseWorkerResponseType.Parsed,
      requestId: "historical-parse-1",
      sessions: [makeAggregateHeavySession("aggregate-heavy")],
    }).success,
    false
  );

  // Clamped, the same session yields a response that validates.
  const clamped = clampSessionsForWorkerResponse([
    makeAggregateHeavySession("aggregate-heavy"),
  ]).sessions;
  const result = historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "historical-parse-1",
    sessions: clamped,
  });

  assert.equal(result.success, true);
  // The session is preserved (only its detail arrays are truncated).
  assert.equal(clamped.length, 1);
  assert.equal(clamped[0]?.sessionId, "aggregate-heavy");
  assert.ok(clamped[0] !== undefined && clamped[0].messages.length < 5000);
});

function makeAggregateHeavySession(sessionId: string): NormalizedSession {
  const session = makeSession(sessionId);
  session.messages = Array.from({ length: 5000 }, () => ({
    role: "assistant",
    timestamp: "2026-06-07T12:00:00.000Z",
    text: "ok",
  }));
  session.tokenSeries = Array.from({ length: 5000 }, () => ({
    timestamp: "2026-06-07T12:00:00.000Z",
    model: "gpt-5",
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
  }));
  session.toolUses = Array.from({ length: 5000 }, () => ({
    name: "Read",
    timestamp: "2026-06-07T12:00:00.000Z",
  }));
  session.messageTimestamps = Array.from(
    { length: 5000 },
    () => "2026-06-07T12:00:00.000Z"
  );
  session.turnDurations = Array.from({ length: 5000 }, () => ({
    durationMs: 1,
    timestamp: "2026-06-07T12:00:00.000Z",
  }));
  session.slashCommands = Array.from({ length: 5000 }, () => ({
    name: "test",
    timestamp: "2026-06-07T12:00:00.000Z",
  }));
  session.teams = Array.from({ length: 5000 }, () => "team");
  session.compactions = Array.from({ length: 5000 }, () => ({
    timestamp: "2026-06-07T12:00:00.000Z",
  }));
  session.apiErrors = Array.from({ length: 5000 }, () => ({
    timestamp: "2026-06-07T12:00:00.000Z",
  }));
  session.toolResultErrors = Array.from({ length: 5000 }, () => ({
    timestamp: "2026-06-07T12:00:00.000Z",
  }));
  session.usageExtras = {
    service_tiers: Array.from({ length: 5000 }, () => "default"),
    speeds: Array.from({ length: 5000 }, () => "normal"),
    inference_geos: Array.from({ length: 5000 }, () => "us"),
    reasoning_output_tokens: 0,
    web_search_requests: 0,
  };
  return session;
}
