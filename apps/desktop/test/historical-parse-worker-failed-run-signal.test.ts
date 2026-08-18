import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createHistoricalParseWorkerParsedResponse,
  HistoricalParseWorkerResponseType,
} from "../src/main/collectors/engine/historical-parse-worker-protocol.js";
import { makeSession } from "./normalized-session-test-utils.js";

const ASSISTANT_TS = "2026-07-01T12:00:00.000Z";
const ERROR_TS = "2026-07-01T12:05:00.000Z";

// FEA-4187: the worker stamps the failed-run signal from the FULL parsed
// session (before the response array clamp) so the import path can classify a
// run that ended on an unrecovered API error as ERROR, not COMPLETED.
test("worker stamps endedOnUnrecoveredError=true for a run whose last error trails its last assistant message", () => {
  const response = createHistoricalParseWorkerParsedResponse("req-1", [
    makeSession({
      sessionId: "failed-run",
      messages: [
        { role: "assistant", timestamp: ASSISTANT_TS, text: "before" },
      ],
      apiErrors: [
        { type: "overloaded_error", message: "boom", timestamp: ERROR_TS },
      ],
    }),
  ]);

  assert.equal(response.type, HistoricalParseWorkerResponseType.Parsed);
  if (response.type !== HistoricalParseWorkerResponseType.Parsed) {
    assert.fail("expected a parsed response");
  }
  assert.equal(response.sessions[0]?.endedOnUnrecoveredError, true);
});

test("worker stamps endedOnUnrecoveredError=false for a genuinely successful run", () => {
  const response = createHistoricalParseWorkerParsedResponse("req-2", [
    makeSession({
      sessionId: "ok-run",
      messages: [{ role: "assistant", timestamp: ASSISTANT_TS, text: "done" }],
      apiErrors: [],
    }),
  ]);

  assert.equal(response.type, HistoricalParseWorkerResponseType.Parsed);
  if (response.type !== HistoricalParseWorkerResponseType.Parsed) {
    assert.fail("expected a parsed response");
  }
  assert.equal(response.sessions[0]?.endedOnUnrecoveredError, false);
});

test("worker never downgrades a parser-set endedOnUnrecoveredError=true flag", () => {
  // The arrays reaching the response builder may already be truncated (no
  // trailing error), but a parser that positively flagged the failure must win.
  const response = createHistoricalParseWorkerParsedResponse("req-3", [
    makeSession({
      sessionId: "flagged-run",
      endedOnUnrecoveredError: true,
      messages: [
        { role: "assistant", timestamp: ASSISTANT_TS, text: "before" },
      ],
      apiErrors: [],
    }),
  ]);

  assert.equal(response.type, HistoricalParseWorkerResponseType.Parsed);
  if (response.type !== HistoricalParseWorkerResponseType.Parsed) {
    assert.fail("expected a parsed response");
  }
  assert.equal(response.sessions[0]?.endedOnUnrecoveredError, true);
});
