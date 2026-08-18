/**
 * @file agent-session-sync-event-pump.test.ts
 * @description Goal stage 3 — the event-driven sync pump (ISS-5993).
 *
 * The 5s poll used to be the only thing that made the session lane look for
 * work, and on a real machine (ISS-5993) the observed inter-pass gap was 5-8
 * MINUTES against a ~9s pass — a 60-100x starvation whose gate the pass trace
 * now instruments. These tests pin the pump's contract:
 *
 *  1. Work arrival while IDLE schedules a pass immediately — the new session
 *     uploads after pumped event-loop turns alone, with no `refresh()` call and
 *     no poll tick (the test never waits wall-clock time, per the
 *     no-timing-assertions gate: it counts calls after deterministic pumping).
 *  2. N triggers while a pass is RUNNING coalesce into exactly ONE follow-up
 *     pass (counted by the source's cursor reads — each admitted pass performs
 *     exactly one incremental cursor read once the watermark exists).
 *  3. The pass-lifecycle trace lands on gatewayLog with the trigger attributed
 *     (the ISS-5993 instrument's production wiring).
 *
 * Passes stay strictly serialized — the pump IS the single-flight guard — and
 * the 5s timer remains only as the fallback sweep (its docstring says so).
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import {
  flushAgentSessionSync,
  makeServiceWithIdentity,
  pumpSyncDrainTurn,
  settleSelfContinuedDrain,
} from "./agent-session-sync-service-fixtures.js";
import { deferred } from "./deferred.js";
import { FakeSyncSource, makeSyncedSession } from "./fake-sync-source.js";

afterEach(() => {
  gatewayLog.clear();
  gatewayLog.setVerbose(false);
});

test("goal stage 3: work arrival while idle schedules a pass — the new session uploads without refresh() or a poll tick", async () => {
  const source = new FakeSyncSource([
    makeSyncedSession("existing", "2026-06-08T12:00:00.000Z"),
  ]);
  const sent: string[][] = [];
  const service = makeServiceWithIdentity(
    source,
    (batch) => {
      sent.push(batch.sessions.map((s) => s.externalSessionId));
      return Promise.resolve({ accepted: true as const });
    },
    "target-pump"
  );

  service.start();
  await settleSelfContinuedDrain(service);
  assert.deepEqual(sent, [["existing"]], "the initial backfill drained");

  // New local work lands while the lane is idle. The pump — not refresh(),
  // not the 5s poll (which never fires inside pumped turns) — must run a pass.
  source.upsert(makeSyncedSession("arrival", "2026-06-08T12:05:00.000Z"));
  service.notifyLocalSessionActivity();
  await pumpSyncDrainTurn();
  await pumpSyncDrainTurn();
  service.stop();

  assert.deepEqual(
    sent,
    [["existing"], ["arrival"]],
    "the arrival triggered its own pass and uploaded within pumped turns"
  );
});

test("goal stage 3: N triggers during a running pass coalesce into exactly one follow-up pass", async () => {
  const source = new FakeSyncSource([
    makeSyncedSession("s1", "2026-06-08T12:00:00.000Z"),
  ]);
  const ackGate = deferred<void>();
  const sent: string[][] = [];
  const service = makeServiceWithIdentity(
    source,
    async (batch) => {
      sent.push(batch.sessions.map((s) => s.externalSessionId));
      // Hold the FIRST pass open at the send await so triggers land mid-pass.
      await ackGate.promise;
      return { accepted: true };
    },
    "target-coalesce"
  );

  service.start();
  // Let the first pass reach the held send.
  await flushAgentSessionSync();
  assert.equal(sent.length, 1, "the first pass is in flight at the send");
  const cursorReadsBeforeTriggers = source.listUpdatedCursorCalls.length;

  // Five rapid triggers while the pass runs.
  for (let i = 0; i < 5; i += 1) {
    service.notifyLocalSessionActivity();
  }

  // Release the ack; the pass completes and must schedule EXACTLY ONE
  // coalesced follow-up pass.
  ackGate.resolve();
  await settleSelfContinuedDrain(service);
  // Extra pumped turns: if a second (spurious) follow-up were queued, these
  // are the turns in which it would run and take its cursor read.
  await pumpSyncDrainTurn();
  await pumpSyncDrainTurn();
  service.stop();

  const followUpCursorReads =
    source.listUpdatedCursorCalls.length - cursorReadsBeforeTriggers;
  assert.equal(
    followUpCursorReads,
    1,
    "five mid-pass triggers must fold into exactly one follow-up pass (one incremental cursor read)"
  );
  assert.deepEqual(sent, [["s1"]], "no duplicate upload was produced");
});

test("goal stage 3: the pass-lifecycle trace lands on gatewayLog attributed to its trigger", async () => {
  gatewayLog.setVerbose(true);
  const source = new FakeSyncSource([
    makeSyncedSession("traced", "2026-06-08T12:00:00.000Z"),
  ]);
  const service = makeServiceWithIdentity(
    source,
    () => Promise.resolve({ accepted: true as const }),
    "target-trace"
  );

  service.start();
  await settleSelfContinuedDrain(service);
  service.notifyLocalSessionActivity();
  await pumpSyncDrainTurn();
  service.stop();

  const traceLines = gatewayLog
    .getEntries()
    .filter((entry) => entry.message.startsWith("pass trace:"))
    .map((entry) => entry.message);
  assert.ok(
    traceLines.some((line) => line.includes("outcome=sent")),
    `a productive pass emits a trace line; saw ${JSON.stringify(traceLines)}`
  );
  assert.ok(
    traceLines.some((line) => line.includes("trigger=work-arrival")),
    `the work-arrival trigger is attributed; saw ${JSON.stringify(traceLines)}`
  );
  for (const line of traceLines) {
    assert.match(
      line,
      TRACE_LINE_SHAPE,
      "every trace line carries the fired→admitted→started→completed path"
    );
  }
});

const TRACE_LINE_SHAPE =
  /^pass trace: trigger=[a-z-]+ fired→admitted=\d+ms admitted→started=(\d+ms|n\/a) started→completed=\d+ms outcome=[a-z]+$/;
