/**
 * ISS-5088: a CLIENT-side request abort on the agent-session sync lane is a
 * lane-wide transport stall, not a verdict on the batch that happened to be in
 * flight.
 *
 * Production evidence (default profile, 2026-08-03 19:07 → 2026-08-04 08:42):
 * dozens of `[cloud-socket] Disconnected: ping timeout` windows in which the
 * session lane's HTTP request timed out, the COMPONENT lane's POST to a
 * different endpoint aborted, and the relay socket's ping timed out — all
 * together. One session's payload cannot cause that, so charging the aborting
 * session's dead-letter budget for it violates `main/sync/AGENTS.md` invariant 4
 * ("never let a lane-wide failure burn a row's retry budget"). The component
 * lane already gets this right (`desktop-components-client.ts` classifies a
 * transport/timeout/abort as `LaneFailure` and never charges its poison budget);
 * these tests pin the session lane to the same rule.
 *
 * The budget is bounded, not free: a row that keeps aborting on a lane that
 * never drops still exhausts `MAX_CONSECUTIVE_TRANSPORT_TIMEOUTS` and reaches a
 * terminal path (invariant 5). What changes is that connectivity loss both
 * REFUNDS the charges taken before the lane noticed and SUPPRESSES the ones that
 * land after — the abort and the loss race each other, so neither half alone is
 * enough.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_CONSECUTIVE_TIMEOUTS,
  MAX_CONSECUTIVE_TRANSPORT_TIMEOUTS,
  TRANSPORT_TIMEOUT_BACKOFF_MS,
} from "../src/main/agent-sync/agent-session-sync-backoff-policy.js";
import { AgentSessionSyncService } from "../src/main/agent-sync/agent-session-sync-service.js";
import { DesktopAgentSessionsAckReason } from "../src/main/cloud/cloud-protocol.js";
import {
  type DesktopSyncBatchEventInput,
  DesktopSyncBatchOutcome,
} from "../src/main/telemetry/app-otel-runtime.js";
import {
  flushAgentSessionSync,
  runWithMockedNow,
} from "./agent-session-sync-service-fixtures.js";
import { type Deferred, deferred } from "./deferred.js";
import { FakeSyncSource, makeSyncedSession } from "./fake-sync-source.js";

const SESSION_UPDATED_AT = "2026-06-08T12:00:00.000Z";

/**
 * One attempt short of the dead-letter threshold — the state a lane reaches
 * after a single outage window, where the very next abort would set the session
 * aside if nothing refunded the budget.
 */
const ATTEMPTS_BEFORE_THRESHOLD = MAX_CONSECUTIVE_TRANSPORT_TIMEOUTS - 1;

/** A send held open so the test can act while the request is still in flight. */
type SendGate = {
  /** Resolves once the lane has actually entered `sendBatch`. */
  entered: Promise<void>;
  /** Let the held send resolve its ack. */
  release: () => void;
};

type Harness = {
  service: AgentSessionSyncService;
  sync: DesktopSyncBatchEventInput[];
  setReason: (reason: DesktopAgentSessionsAckReason) => void;
  setHttpReady: (ready: boolean) => void;
  /** Make the NEXT `sendBatch` throw instead of resolving an ack. */
  throwOnNextSend: (error: unknown) => void;
  /** Hold the NEXT `sendBatch` open until the returned gate is released. */
  armSendGate: () => SendGate;
};

/**
 * A single-session lane whose ack reason and HTTP readiness are both live-
 * settable, so one test can walk the lane through "aborting", "connection lost",
 * and "aborting again" the way the production windows do.
 */
function makeHarness(sessionId: string): Harness {
  const source = new FakeSyncSource([
    makeSyncedSession(sessionId, SESSION_UPDATED_AT),
  ]);
  const sync: DesktopSyncBatchEventInput[] = [];
  let reason: DesktopAgentSessionsAckReason =
    DesktopAgentSessionsAckReason.TransportTimeout;
  let httpReady = true;
  let heldSend: { entered: Deferred<void>; released: Deferred<void> } | null =
    null;
  let throwNext: unknown = null;
  const service = new AgentSessionSyncService({
    isHttpReady: () => httpReady,
    getSource: () => source,
    sendBatch: async () => {
      const held = heldSend;
      if (held) {
        heldSend = null;
        held.entered.resolve();
        await held.released.promise;
      }
      if (throwNext) {
        const toThrow = throwNext;
        throwNext = null;
        throw toThrow;
      }
      return { accepted: false, reason };
    },
    onSyncBatchTelemetry: (event) => {
      sync.push(event);
    },
  });
  return {
    service,
    sync,
    setReason: (next) => {
      reason = next;
    },
    setHttpReady: (ready) => {
      httpReady = ready;
    },
    throwOnNextSend: (error) => {
      throwNext = error;
    },
    armSendGate: () => {
      const entered = deferred();
      const released = deferred();
      heldSend = { entered, released };
      return { entered: entered.promise, release: () => released.resolve() };
    },
  };
}

/** Step the lane one attempt forward, past whatever backoff the last ack set. */
async function attemptAgain(
  service: AgentSessionSyncService,
  advance: (ms: number) => void
): Promise<void> {
  advance(TRANSPORT_TIMEOUT_BACKOFF_MS + 1);
  service.refresh();
  await flushAgentSessionSync();
}

function deadLetterCount(events: DesktopSyncBatchEventInput[]): number {
  return events.filter(
    (event) => event.outcome === DesktopSyncBatchOutcome.DeadLetter
  ).length;
}

test("ISS-5088: client-side aborts do not dead-letter at the server-408 budget", async () => {
  // Pre-ISS-5088 a client abort resolved `AckTimeout`, so the third consecutive
  // one (MAX_CONSECUTIVE_TIMEOUTS) dead-lettered a perfectly healthy session
  // whose only sin was being queued while the machine's network stalled.
  const { service, sync } = makeHarness("aborting-session");

  await runWithMockedNow(async ({ advance }) => {
    service.start();
    await flushAgentSessionSync();
    for (let i = 1; i < MAX_CONSECUTIVE_TIMEOUTS; i += 1) {
      await attemptAgain(service, advance);
    }
  });
  service.stop();

  assert.equal(sync.length, MAX_CONSECUTIVE_TIMEOUTS);
  assert.equal(
    deadLetterCount(sync),
    0,
    "a run of client aborts at the ack_timeout threshold must not dead-letter"
  );
  for (const event of sync) {
    assert.equal(event.outcome, DesktopSyncBatchOutcome.Failure);
    assert.equal(
      event.reason,
      DesktopAgentSessionsAckReason.TransportTimeout,
      "the transport-health event names the lane-wide cause, not ack_timeout"
    );
  }
});

test("ISS-5088: transport_timeout still reaches a terminal path on a lane that never drops", async () => {
  // Invariant 5 guard: the refundable budget is BOUNDED. With no connectivity
  // loss to refund it, a row that keeps aborting is eventually set aside so it
  // cannot head-of-line-block the queue forever.
  const { service, sync } = makeHarness("persistently-aborting-session");

  await runWithMockedNow(async ({ advance }) => {
    service.start();
    await flushAgentSessionSync();
    for (let i = 1; i < MAX_CONSECUTIVE_TRANSPORT_TIMEOUTS; i += 1) {
      await attemptAgain(service, advance);
    }
  });
  service.stop();

  assert.equal(sync.length, MAX_CONSECUTIVE_TRANSPORT_TIMEOUTS);
  assert.deepEqual(
    sync.map((event) => event.outcome),
    [
      ...Array.from(
        { length: MAX_CONSECUTIVE_TRANSPORT_TIMEOUTS - 1 },
        () => DesktopSyncBatchOutcome.Failure
      ),
      DesktopSyncBatchOutcome.DeadLetter,
    ]
  );
});

test("ISS-5088: a transport_unavailable ack refunds the accumulated abort budget", async () => {
  // The production shape: aborts accumulate, THEN the relay socket ping-times-out
  // and the lane discovers it has no live compute target. That discovery proves
  // every earlier abort was taken inside a lane-wide outage window, so the
  // charges are handed back and the session survives the next outage window too.
  const { service, sync, setReason } = makeHarness("refunded-session");

  await runWithMockedNow(async ({ advance }) => {
    service.start();
    await flushAgentSessionSync();
    // Burn the budget to one attempt short of the dead-letter threshold.
    for (let i = 1; i < ATTEMPTS_BEFORE_THRESHOLD; i += 1) {
      await attemptAgain(service, advance);
    }
    assert.equal(
      deadLetterCount(sync),
      0,
      "precondition: the budget is spent but not yet exhausted"
    );

    // The socket drops: no live compute target, so the lane synthesizes
    // `transport_unavailable`. This is the unambiguous lane-wide signal.
    setReason(DesktopAgentSessionsAckReason.TransportUnavailable);
    await attemptAgain(service, advance);

    // Back to aborting. Without the refund the very next abort would be the
    // threshold attempt and would dead-letter this session.
    setReason(DesktopAgentSessionsAckReason.TransportTimeout);
    for (let i = 0; i < ATTEMPTS_BEFORE_THRESHOLD; i += 1) {
      await attemptAgain(service, advance);
    }
  });
  service.stop();

  assert.equal(
    deadLetterCount(sync),
    0,
    "connectivity loss refunds the abort budget, so no session is dead-lettered"
  );
});

test("ISS-5088: losing HTTP readiness refunds the accumulated abort budget", async () => {
  // The same refund, reached the other way: the lane is torn down by
  // `refresh()` seeing `isHttpReady()` go false (sign-out, cloud offline, the
  // socket recycling after a ping timeout) rather than by an in-flight ack.
  const { service, sync, setHttpReady } = makeHarness("readiness-loss-session");

  await runWithMockedNow(async ({ advance }) => {
    service.start();
    await flushAgentSessionSync();
    for (let i = 1; i < ATTEMPTS_BEFORE_THRESHOLD; i += 1) {
      await attemptAgain(service, advance);
    }
    assert.equal(deadLetterCount(sync), 0, "precondition: not yet exhausted");

    setHttpReady(false);
    service.refresh();
    await flushAgentSessionSync();

    setHttpReady(true);
    for (let i = 0; i < ATTEMPTS_BEFORE_THRESHOLD; i += 1) {
      await attemptAgain(service, advance);
    }
  });
  service.stop();

  assert.equal(
    deadLetterCount(sync),
    0,
    "readiness loss refunds the abort budget, so no session is dead-lettered"
  );
});

test("ISS-5088: aborts that land AFTER the loss is observed still do not dead-letter", async () => {
  // The ordering a retroactive refund alone cannot cover. socket.io detects a
  // ping timeout on its own schedule while the HTTP abort fires a fixed 30s after
  // ITS send, so a charge can land on either side of the loss. Here the send is
  // already in flight when readiness drops, so the refund runs first and finds
  // nothing, and the abort's charge lands after it.
  //
  // The socket then recovers while the HTTP path stays stalled — the shape the
  // ISS-5088 logs show, where hello re-completes but component and session
  // requests keep timing out. Nothing drops readiness again, so no further refund
  // ever runs and those later aborts accumulate on top of the survivor: without
  // the level-triggered guard the budget reaches its threshold and dead-letters a
  // session whose only problem is a connection the lane already knows is bad.
  const { service, sync, setHttpReady, armSendGate } =
    makeHarness("late-abort-session");

  await runWithMockedNow(async ({ advance }) => {
    service.start();
    await flushAgentSessionSync();

    // One outage window whose abort resolves after the loss was observed.
    const gate = armSendGate();
    advance(TRANSPORT_TIMEOUT_BACKOFF_MS + 1);
    service.refresh();
    await gate.entered;
    setHttpReady(false);
    service.refresh();
    await flushAgentSessionSync();
    setHttpReady(true);
    gate.release();
    await flushAgentSessionSync();

    // The socket is back but the HTTP path is still stalled, and no second loss
    // edge arrives to refund anything.
    for (let i = 0; i < ATTEMPTS_BEFORE_THRESHOLD; i += 1) {
      await attemptAgain(service, advance);
    }
  });
  service.stop();

  assert.equal(
    deadLetterCount(sync),
    0,
    "an abort resolved after the loss was observed must not spend the budget"
  );
});

test("ISS-5088: a thrown transport error also suppresses the abort budget", async () => {
  // In a real blackout a THROWN send (ECONNRESET / ENOTFOUND) usually arrives
  // before any 30s abort does — it is the earliest and most common proof the
  // connection is gone. If it did not record the loss, the aborts that follow it
  // would keep charging a healthy session all the way to a dead-letter while the
  // lane already had the evidence in hand.
  const { service, sync, throwOnNextSend } = makeHarness(
    "thrown-then-aborting"
  );

  await runWithMockedNow(async ({ advance }) => {
    service.start();
    await flushAgentSessionSync();

    throwOnNextSend(new TypeError("fetch failed"));
    await attemptAgain(service, advance);

    for (let i = 0; i < MAX_CONSECUTIVE_TRANSPORT_TIMEOUTS; i += 1) {
      await attemptAgain(service, advance);
    }
  });
  service.stop();

  assert.equal(
    deadLetterCount(sync),
    0,
    "a thrown send records the connectivity loss, so the aborts after it defer with budgets intact"
  );
});
