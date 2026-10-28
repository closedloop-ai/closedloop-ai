/**
 * ISS-10717 — the Claude Code telemetry lane's failure taxonomy.
 *
 * The split between a LANE-WIDE failure and a SESSION-attributable one is the
 * whole contract: a desktop ahead of the API answers 501, and if that burned the
 * session's budget a staged rollout would walk the machine's whole corpus into
 * a terminal state (the ISS-4976 / ISS-7795 shape). The cases below drive the
 * real service against in-memory doubles.
 */

import assert from "node:assert/strict";
import {
  CLAUDE_CODE_TELEMETRY_TEXT_MAX,
  DESKTOP_CLAUDE_CODE_TELEMETRY_SYNC_REQUEST_MAX_BYTES,
  type DesktopClaudeCodeDropCounterInput,
  type DesktopClaudeCodeSessionTelemetryInput,
} from "@repo/api/src/types/desktop-claude-code-telemetry-sync";
import { test } from "vitest";
import {
  buildClaudeCodeTelemetrySyncSourceKey,
  ClaudeCodeTelemetrySyncService,
  type ClaudeCodeTelemetrySyncStore,
  resolveClaudeCodeTelemetrySyncStore,
} from "../src/main/agent-sync/claude-code-telemetry-sync-service.js";
import {
  createDesktopClaudeCodeTelemetryClient,
  type DesktopClaudeCodeTelemetryClientResult,
} from "../src/main/dashboard/desktop-claude-code-telemetry-client.js";
import { createClaudeCodeTelemetrySyncDelegates } from "../src/main/database/claude-code-telemetry-sync-store.js";
import { boundClaudeCodeTelemetryPayload } from "../src/main/otel/claude-code-telemetry-payload-bound.js";

const TARGET_ID = "target-1";
const SESSION_ID = "session-1";
const OBSERVED_TO = "2026-09-21T00:00:00.000Z";
const SOURCE_KEY = buildClaudeCodeTelemetrySyncSourceKey(TARGET_ID);

function sessionPayload(): DesktopClaudeCodeSessionTelemetryInput {
  return {
    externalSessionId: SESSION_ID,
    harness: "claude",
    costEventCount: 3,
    components: [],
  };
}

const DROP_COUNTER: DesktopClaudeCodeDropCounterInput = {
  harness: "claude",
  reason: "receiver_backpressure",
  droppedCount: "7",
  firstObservedAt: OBSERVED_TO,
  lastObservedAt: OBSERVED_TO,
};

type Recorded = {
  delivered: { sessionId: string; observedTo: string }[];
  rejections: string[];
  abandoned: { sessionId: string; reason: string }[];
  countersDelivered: string[][];
};

function fakeStore(): { store: ClaudeCodeTelemetrySyncStore; log: Recorded } {
  const log: Recorded = {
    delivered: [],
    rejections: [],
    abandoned: [],
    countersDelivered: [],
  };
  const attempts = new Map<string, number>();
  const deferrals = new Map<string, number>();
  return {
    log,
    store: {
      loadPendingSessions: () =>
        Promise.resolve([
          {
            sessionId: SESSION_ID,
            session: sessionPayload(),
            observedTo: OBSERVED_TO,
          },
        ]),
      loadDropCounters: () =>
        Promise.resolve({ counters: [], undelivered: false }),
      markDropCountersDelivered: (counters) => {
        log.countersDelivered.push(counters.map((c) => c.droppedCount));
        return Promise.resolve();
      },
      recordDelivered: (_sourceKey, sessionId, observedTo) => {
        log.delivered.push({ sessionId, observedTo });
        return Promise.resolve();
      },
      recordRejection: (_sourceKey, sessionId) => {
        const next = (attempts.get(sessionId) ?? 0) + 1;
        attempts.set(sessionId, next);
        log.rejections.push(sessionId);
        return Promise.resolve(next);
      },
      recordSessionAbsent: (_sourceKey, sessionId) => {
        const next = (deferrals.get(sessionId) ?? 0) + 1;
        deferrals.set(sessionId, next);
        return Promise.resolve(next);
      },
      recordAbandoned: (_sourceKey, sessionId, _observedTo, reason) => {
        log.abandoned.push({ sessionId, reason });
        return Promise.resolve();
      },
    },
  };
}

function serviceWith(
  store: ClaudeCodeTelemetrySyncStore,
  results: DesktopClaudeCodeTelemetryClientResult[]
): { service: ClaudeCodeTelemetrySyncService; sent: number[] } {
  const sent: number[] = [];
  let index = 0;
  const service = new ClaudeCodeTelemetrySyncService({
    store: () => store,
    isReady: () => true,
    getComputeTargetId: () => TARGET_ID,
    sendSession: () => {
      sent.push(index);
      const result = results[Math.min(index, results.length - 1)];
      index += 1;
      return Promise.resolve(result);
    },
    log: () => {
      // Diagnostics are not the contract under test.
    },
  });
  return { service, sent };
}

test("ISS-10717: an accepted ack is the only thing that advances the watermark", async () => {
  const { store, log } = fakeStore();
  const { service } = serviceWith(store, [
    {
      kind: "ack",
      ack: {
        accepted: true,
        protocolVersion: 1,
        externalSessionId: SESSION_ID,
      },
    },
  ]);

  await service.syncOnce();

  assert.deepEqual(log.delivered, [
    { sessionId: SESSION_ID, observedTo: OBSERVED_TO },
  ]);
  assert.deepEqual(log.rejections, []);
});

test("ISS-10717: an older API's 501 defers without touching the session's budget", async () => {
  const { store, log } = fakeStore();
  // Three ticks against an API that does not serve this protocol. If the skew
  // charged the budget, the third would abandon the session and the corpus
  // would be permanently stranded once the API caught up.
  const { service } = serviceWith(store, [
    { kind: "unavailable", status: 501 },
  ]);

  await service.syncOnce();
  await service.syncOnce();
  await service.syncOnce();

  assert.deepEqual(log.rejections, []);
  assert.deepEqual(log.abandoned, []);
  assert.deepEqual(log.delivered, []);
});

test("ISS-10717: a transport failure defers without touching the budget either", async () => {
  const { store, log } = fakeStore();
  const { service } = serviceWith(store, [
    { kind: "retry", error: "socket hang up" },
  ]);

  await service.syncOnce();
  await service.syncOnce();
  await service.syncOnce();

  assert.deepEqual(log.rejections, []);
  assert.deepEqual(log.abandoned, []);
});

test("ISS-10717: a repeated payload rejection is charged and finally passed", async () => {
  const { store, log } = fakeStore();
  const { service } = serviceWith(store, [{ kind: "rejected", status: 400 }]);

  await service.syncOnce();
  await service.syncOnce();
  // `length`, not `deepEqual(..., [])`: the latter narrows the array to
  // `never[]` for the rest of the case, and the assertions below read it.
  assert.equal(log.abandoned.length, 0);

  await service.syncOnce();

  assert.equal(log.rejections.length, 3);
  assert.equal(log.abandoned.length, 1);
  assert.equal(log.abandoned[0]?.reason, "payload_rejected");
  // The pass is RECORDED on the durable row, never a silent disappearance.
  assert.deepEqual(log.delivered, []);
});

test("ISS-10717: a not-yet-synced session defers without spending budget", async () => {
  const { store, log } = fakeStore();
  // The cloud has no row for this session because the SESSION lane creates it
  // and runs independently. That race is ordinary; charging it would abandon
  // the telemetry of a healthy session in three ticks.
  const { service } = serviceWith(store, [
    {
      kind: "ack",
      ack: {
        accepted: false,
        protocolVersion: 1,
        externalSessionId: SESSION_ID,
        reason: "session_not_found",
      },
    },
  ]);

  await service.syncOnce();
  await service.syncOnce();
  await service.syncOnce();

  assert.equal(log.rejections.length, 0);
  assert.equal(log.abandoned.length, 0);
  // And the watermark must not move either: nothing was stored.
  assert.equal(log.delivered.length, 0);
});

test("ISS-10717: a session the cloud never grows a row for is eventually passed", async () => {
  const { store, log } = fakeStore();
  const { service } = serviceWith(store, [
    {
      kind: "ack",
      ack: {
        accepted: false,
        protocolVersion: 1,
        externalSessionId: SESSION_ID,
        reason: "session_not_found",
      },
    },
  ]);

  // The candidate query is oldest-owed-first, so a session whose cloud row will
  // never exist would otherwise hold a page slot for the life of the install
  // and starve every session that CAN be delivered.
  for (let tick = 0; tick < 20; tick += 1) {
    await service.syncOnce();
  }

  assert.equal(log.rejections.length, 0);
  assert.equal(log.abandoned.length, 1);
  assert.equal(log.abandoned[0]?.reason, "session_absent");
});

test("ISS-10717: the cursor is scoped to the compute target", () => {
  assert.equal(SOURCE_KEY, "claude_code_telemetry:target-1");
  assert.notEqual(
    SOURCE_KEY,
    buildClaudeCodeTelemetrySyncSourceKey("other-target")
  );
});

test("ISS-10717: a session that keeps 5xx-ing does not hold the head of the page forever", async () => {
  // The wedge this closes: a 500 becomes a LANE-WIDE `retry`, the budget is
  // correctly untouched, and the candidate query is oldest-owed-first — so
  // before the step-over the same session returned to the head every tick and
  // the whole corpus queued behind it.
  const delivered: string[] = [];
  const store: ClaudeCodeTelemetrySyncStore = {
    loadPendingSessions: () =>
      Promise.resolve([
        {
          sessionId: "wedged",
          session: { ...sessionPayload(), externalSessionId: "wedged" },
          observedTo: OBSERVED_TO,
        },
        {
          sessionId: "healthy",
          session: { ...sessionPayload(), externalSessionId: "healthy" },
          observedTo: OBSERVED_TO,
        },
      ]),
    loadDropCounters: () =>
      Promise.resolve({ counters: [], undelivered: false }),
    markDropCountersDelivered: () => Promise.resolve(),
    recordDelivered: (_sourceKey, sessionId) => {
      delivered.push(sessionId);
      return Promise.resolve();
    },
    recordRejection: () => Promise.resolve(1),
    recordSessionAbsent: () => Promise.resolve(1),
    recordAbandoned: () => Promise.resolve(),
  };

  const service = new ClaudeCodeTelemetrySyncService({
    store: () => store,
    isReady: () => true,
    getComputeTargetId: () => TARGET_ID,
    sendSession: ({ session }) =>
      Promise.resolve(
        session?.externalSessionId === "wedged"
          ? { kind: "retry", status: 500, error: "boom" }
          : {
              kind: "ack",
              ack: {
                accepted: true,
                protocolVersion: 1,
                externalSessionId: "healthy",
              },
            }
      ),
    log: () => {
      // Diagnostics are not the contract under test.
    },
  });

  // The first two ticks stop at the wedged head, which is the correct
  // conservative reading of a lane-wide result.
  await service.syncOnce();
  await service.syncOnce();
  assert.deepEqual(delivered, []);

  // The third steps over it, and the session BEHIND it drains. Nothing was
  // charged and nothing was abandoned: the wedged session is still owed.
  await service.syncOnce();
  assert.deepEqual(delivered, ["healthy"]);
});

test("ISS-10717: an oversized rollup is shed to the route's cap, not sent to a 413", () => {
  // A schema-valid payload can far exceed the byte cap: 200 components each
  // carrying eleven CLAUDE_CODE_TELEMETRY_TEXT_MAX strings is several times it.
  const wide = "w".repeat(CLAUDE_CODE_TELEMETRY_TEXT_MAX);
  const session: DesktopClaudeCodeSessionTelemetryInput = {
    ...sessionPayload(),
    components: Array.from({ length: 200 }, (_component, index) => ({
      attributionKey: `${wide}-${index}`.slice(
        0,
        CLAUDE_CODE_TELEMETRY_TEXT_MAX
      ),
      attributionSource: wide,
      agentName: wide,
      skillName: wide,
      pluginName: wide,
      mcpServerName: wide,
      mcpToolName: wide,
      querySource: wide,
      speed: wide,
      effort: wide,
      costEventCount: 1,
      costUsd: "1.000000",
    })),
  };

  const before = Buffer.byteLength(JSON.stringify(session), "utf8");
  assert.ok(
    before > DESKTOP_CLAUDE_CODE_TELEMETRY_SYNC_REQUEST_MAX_BYTES,
    "fixture must actually exceed the cap"
  );

  const bounded = boundClaudeCodeTelemetryPayload({
    session,
    dropCounters: [],
  });

  assert.ok(
    Buffer.byteLength(JSON.stringify(bounded), "utf8") <=
      DESKTOP_CLAUDE_CODE_TELEMETRY_SYNC_REQUEST_MAX_BYTES
  );
  assert.ok((bounded.components ?? []).length < 200);
  // The shortfall is PUBLISHED, so the cloud keeps the tail it already holds
  // instead of reading a shed page as the whole set and deleting the rest.
  assert.equal(bounded.componentsTruncated, true);
});

test("ISS-10717: a payload already under the cap is passed through untouched", () => {
  const session = sessionPayload();

  const bounded = boundClaudeCodeTelemetryPayload({
    session,
    dropCounters: [],
  });

  assert.equal(bounded, session);
  assert.equal(bounded.componentsTruncated, undefined);
});

/**
 * A store whose page is EMPTY and whose drop counters are owed — the exact state
 * a loss recorded before any signal row existed leaves behind.
 */
function idleStoreWithOwedCounters(undelivered = true): {
  store: ClaudeCodeTelemetrySyncStore;
  marked: string[][];
} {
  const marked: string[][] = [];
  return {
    marked,
    store: {
      loadPendingSessions: () => Promise.resolve([]),
      loadDropCounters: () =>
        Promise.resolve({ counters: [DROP_COUNTER], undelivered }),
      markDropCountersDelivered: (counters) => {
        marked.push(counters.map((counter) => counter.droppedCount));
        return Promise.resolve();
      },
      recordDelivered: () => Promise.resolve(),
      recordRejection: () => Promise.resolve(1),
      recordSessionAbsent: () => Promise.resolve(1),
      recordAbandoned: () => Promise.resolve(),
    },
  };
}

test("ISS-10717: a drop counter is delivered with no session, so a loss that dirties nothing still leaves the machine", async () => {
  // The defect this closes: a receiver-backpressure eviction or an all-rejected
  // batch persists no signal row, so no session becomes dirty, and a
  // counters-as-passenger-only lane never sends the counter at all — cloud then
  // reads that machine as COMPLETE.
  const { store, marked } = idleStoreWithOwedCounters();
  const sentSessions: (DesktopClaudeCodeSessionTelemetryInput | undefined)[] =
    [];
  const sentCounters: string[][] = [];
  const service = new ClaudeCodeTelemetrySyncService({
    store: () => store,
    isReady: () => true,
    getComputeTargetId: () => TARGET_ID,
    sendSession: ({ session, dropCounters }) => {
      sentSessions.push(session);
      sentCounters.push(dropCounters.map((counter) => counter.droppedCount));
      return Promise.resolve({
        kind: "ack",
        ack: { accepted: true, protocolVersion: 1, dropCountersRecorded: 1 },
      });
    },
    log: () => {
      // Diagnostics are not the contract under test.
    },
  });

  await service.syncOnce();

  assert.equal(sentSessions.length, 1);
  // Omitted, not null: the receiving schema declares `session` optional, and a
  // `null` there is a validation failure rather than a counters-only delivery.
  assert.equal(sentSessions[0], undefined);
  assert.deepEqual(sentCounters, [["7"]]);
  // Invariant 1: the watermark moved because the server acknowledged it, and it
  // moved to the total that was SENT.
  assert.deepEqual(marked, [["7"]]);
});

test("ISS-10717: an idle lane whose counters the cloud already holds sends nothing", async () => {
  const { store, marked } = idleStoreWithOwedCounters(false);
  let sends = 0;
  const service = new ClaudeCodeTelemetrySyncService({
    store: () => store,
    isReady: () => true,
    getComputeTargetId: () => TARGET_ID,
    sendSession: () => {
      sends += 1;
      return Promise.resolve({
        kind: "ack",
        ack: { accepted: true, protocolVersion: 1 },
      });
    },
    log: () => {
      // Diagnostics are not the contract under test.
    },
  });

  await service.syncOnce();

  assert.equal(sends, 0);
  assert.deepEqual(marked, []);
});

test("ISS-10717: a refused counters-only delivery marks nothing and is not re-posted every tick", async () => {
  // The skew this bounds: an API old enough to still require `session` answers a
  // counters-only body with a 400. The counter must stay owed (invariant 3 —
  // nothing is abandoned) without the lane re-asking every 15s.
  const { store, marked } = idleStoreWithOwedCounters();
  let sends = 0;
  let clock = 1_000_000;
  const service = new ClaudeCodeTelemetrySyncService({
    store: () => store,
    isReady: () => true,
    getComputeTargetId: () => TARGET_ID,
    now: () => clock,
    sendSession: () => {
      sends += 1;
      return Promise.resolve({ kind: "rejected", status: 400 });
    },
    log: () => {
      // Diagnostics are not the contract under test.
    },
  });

  await service.syncOnce();
  assert.equal(sends, 1);
  assert.deepEqual(marked, [], "a refusal must not advance the watermark");

  // Still inside the cooldown: the tick does not re-post.
  clock += 60_000;
  await service.syncOnce();
  assert.equal(sends, 1);

  // Past it: the counter is still owed, so it is attempted again.
  clock += 5 * 60 * 1000;
  await service.syncOnce();
  assert.equal(sends, 2);
});

test("ISS-10717: the counters that rode along with an accepted session are marked delivered by that same ack", async () => {
  // Without this the ride-along path would never advance the counter watermark,
  // and every idle tick afterwards would re-post counters the cloud already
  // holds — the mirror-image defect of never posting them at all.
  const marked: string[][] = [];
  const store: ClaudeCodeTelemetrySyncStore = {
    loadPendingSessions: () =>
      Promise.resolve([
        {
          sessionId: SESSION_ID,
          session: sessionPayload(),
          observedTo: OBSERVED_TO,
        },
      ]),
    loadDropCounters: () =>
      Promise.resolve({ counters: [DROP_COUNTER], undelivered: true }),
    markDropCountersDelivered: (counters) => {
      marked.push(counters.map((counter) => counter.droppedCount));
      return Promise.resolve();
    },
    recordDelivered: () => Promise.resolve(),
    recordRejection: () => Promise.resolve(1),
    recordSessionAbsent: () => Promise.resolve(1),
    recordAbandoned: () => Promise.resolve(),
  };
  const sentCounters: string[][] = [];
  const service = new ClaudeCodeTelemetrySyncService({
    store: () => store,
    isReady: () => true,
    getComputeTargetId: () => TARGET_ID,
    sendSession: ({ session, dropCounters }) => {
      assert.equal(session?.externalSessionId, SESSION_ID);
      sentCounters.push(dropCounters.map((counter) => counter.droppedCount));
      return Promise.resolve({
        kind: "ack",
        ack: {
          accepted: true,
          protocolVersion: 1,
          externalSessionId: SESSION_ID,
        },
      });
    },
    log: () => {
      // Diagnostics are not the contract under test.
    },
  });

  await service.syncOnce();

  assert.deepEqual(sentCounters, [["7"]], "the counters ride with the session");
  assert.deepEqual(marked, [["7"]]);
});

test("ISS-10717: a rejected session leaves the drop counters owed", async () => {
  const marked: string[][] = [];
  const store: ClaudeCodeTelemetrySyncStore = {
    loadPendingSessions: () =>
      Promise.resolve([
        {
          sessionId: SESSION_ID,
          session: sessionPayload(),
          observedTo: OBSERVED_TO,
        },
      ]),
    loadDropCounters: () =>
      Promise.resolve({ counters: [DROP_COUNTER], undelivered: true }),
    markDropCountersDelivered: (counters) => {
      marked.push(counters.map((counter) => counter.droppedCount));
      return Promise.resolve();
    },
    recordDelivered: () => Promise.resolve(),
    recordRejection: () => Promise.resolve(1),
    recordSessionAbsent: () => Promise.resolve(1),
    recordAbandoned: () => Promise.resolve(),
  };
  const { service } = serviceWith(store, [{ kind: "rejected", status: 400 }]);

  await service.syncOnce();

  assert.deepEqual(marked, []);
});

test("ISS-10717: a counters-only body OMITS session rather than sending null", async () => {
  // The receiving schema declares `session` optional, not nullable, so a `null`
  // is a validation failure — a 400 on every counters-only delivery, which the
  // lane reads as session-attributable and the counter then never lands.
  const bodies: string[] = [];
  const client = createDesktopClaudeCodeTelemetryClient({
    getAccessToken: () => Promise.resolve("token"),
    getApiOrigin: () => "https://api.example.test",
    getComputeTargetId: () => TARGET_ID,
    fetch: ((_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            accepted: true,
            protocolVersion: 1,
            dropCountersRecorded: 1,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    }) as unknown as typeof fetch,
  });

  const result = await client.syncSession({ dropCounters: [DROP_COUNTER] });

  assert.equal(result.kind, "ack");
  assert.equal(bodies.length, 1);
  const parsed = JSON.parse(bodies[0] ?? "{}") as Record<string, unknown>;
  assert.equal(
    "session" in parsed,
    false,
    "an absent session must be omitted, never serialized as null"
  );
  assert.equal(Array.isArray(parsed.dropCounters), true);

  // And the session shape still carries it, so the omission is conditional.
  await client.syncSession({
    session: sessionPayload(),
    dropCounters: [DROP_COUNTER],
  });
  const withSession = JSON.parse(bodies[1] ?? "{}") as Record<string, unknown>;
  assert.equal("session" in withSession, true);
});

test("ISS-10717: the real delegate set satisfies the store guard, so the lane is not silently dark", async () => {
  // `resolveClaudeCodeTelemetrySyncStore` answers null when ANY method is
  // missing, and the composition passes that null straight into the service —
  // so a delegate the factory forgot disables the whole lane with nothing red.
  // The guard grew a seventh method with the drop-counter watermark; this is
  // what proves the producer grew with it.
  const calls: string[] = [];
  const prismaDouble = {
    read: (fn: (client: unknown) => unknown) => Promise.resolve(fn({})),
    write: (fn: (client: unknown) => unknown) => Promise.resolve(fn({})),
  } as unknown as Parameters<typeof createClaudeCodeTelemetrySyncDelegates>[0];
  const delegates = createClaudeCodeTelemetrySyncDelegates(prismaDouble);

  const store = resolveClaudeCodeTelemetrySyncStore(delegates);

  assert.notEqual(store, null);
  // And the new method is genuinely routed, not merely present on the object.
  delegates.markClaudeCodeTelemetryDropCountersDelivered = (counters) => {
    calls.push(counters.map((counter) => counter.droppedCount).join(","));
    return Promise.resolve();
  };
  const rewired = resolveClaudeCodeTelemetrySyncStore(delegates);
  await rewired?.markDropCountersDelivered([DROP_COUNTER]);
  assert.deepEqual(calls, ["7"]);
});
