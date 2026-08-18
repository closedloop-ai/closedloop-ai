/**
 * @file symphony-completed-event-contract.test.ts
 * @description ISS-5154 — `waitForCompletedEvent` must hold the integration
 * suites to the CLOUD ingest contract, not a looser local re-declaration.
 *
 * `apps/api/app/loops/validators.ts` validates the POST against
 * `LoopEventCompletedSchema`, which requires `result`, `tokensUsed` and
 * `timestamp`. While the helper carried its own schema with those optional or
 * absent, a desktop payload missing any of them let an integration suite go
 * green on an event cloud ingestion would answer with a 400. `postLoopEvent`
 * injects `timestamp` before the request is recorded, so parsing the recorded
 * body with the real schema is both correct and what the suites should assert.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { LoopEventType } from "@closedloop-ai/loops-api/events";
import {
  type RecordedRequest,
  waitForCompletedEvent,
} from "./symphony-test-utils.js";

const LOOP_ID = "00000000-0000-0000-0000-0000000050154";
const EVENTS_URL = `http://127.0.0.1:1/loops/${LOOP_ID}/events`;

function recordEvent(body: Record<string, unknown>): RecordedRequest[] {
  return [{ method: "POST", url: EVENTS_URL, body: JSON.stringify(body) }];
}

/** The shape the desktop gateway actually posts, timestamp included. */
function validCompletedEvent(): Record<string, unknown> {
  return {
    type: LoopEventType.Completed,
    timestamp: new Date().toISOString(),
    result: { exitCode: 0, executeFinalizationStatus: "llm_commit" },
    tokensUsed: { input: 10, output: 20 },
  };
}

test("ISS-5154: a cloud-valid completed event resolves with its passthrough keys intact", async () => {
  const parsed = await waitForCompletedEvent(
    recordEvent(validCompletedEvent()),
    LOOP_ID,
    500
  );
  assert.equal(parsed.type, LoopEventType.Completed);
  assert.equal(parsed.tokensUsed.input, 10);
  assert.equal(
    parsed.result.executeFinalizationStatus,
    "llm_commit",
    "command-specific result keys must survive the loose parse"
  );
});

test("ISS-5154: a completed event missing a cloud-required field is rejected, not accepted", async () => {
  // Each of these would have been accepted by the old local schema and would be
  // answered with a 400 by cloud ingestion.
  const omissions = ["result", "tokensUsed", "timestamp"] as const;
  for (const omitted of omissions) {
    const body = validCompletedEvent();
    delete body[omitted];
    await assert.rejects(
      () => waitForCompletedEvent(recordEvent(body), LOOP_ID, 500),
      (err: Error) =>
        err.message.includes("did not match the expected shape") &&
        err.message.includes(omitted),
      `a completed event without '${omitted}' must not satisfy the helper`
    );
  }
});
