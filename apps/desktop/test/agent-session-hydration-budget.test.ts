import assert from "node:assert/strict";
import { test } from "node:test";
import { hydrateWithinByteBudget } from "../src/main/agent-sync/agent-session-hydration-budget.js";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import { SESSION_HYDRATION_SLICE_SIZE } from "../src/main/agent-sync/agent-session-sync-limits.js";
import { buildAgentSessionSyncSourceKey } from "../src/main/agent-sync/agent-session-sync-source.js";
import type { DesktopAgentSessionsAck } from "../src/main/cloud/cloud-protocol.js";
import {
  flushAgentSessionSync,
  makeService,
  makeServiceWithIdentity,
  ResettingSyncSource,
} from "./agent-session-sync-service-fixtures.js";
import { deferred } from "./deferred.js";
import { FakeSyncSource, makeSyncedSession } from "./fake-sync-source.js";

/**
 * ISS-5988: the hydration step is bounded by BYTES HELD, not candidate count.
 * These execute that decision against synthetic loads rather than asserting the
 * bound exists somewhere.
 */

function session(id: string, padBytes: number): SyncedAgentSession {
  return {
    externalSessionId: id,
    // A single wide field is enough to drive the raw-JSON measurement.
    summary: "x".repeat(padBytes),
  } as unknown as SyncedAgentSession;
}

function idsFor(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `s${index}`);
}

test("stops hydrating once the byte budget is reached, deferring the rest", async () => {
  const loadedSlices: string[][] = [];
  const result = await hydrateWithinByteBudget(
    idsFor(50),
    (sliceIds) => {
      loadedSlices.push(sliceIds);
      return sliceIds.map((id) => session(id, 10_000));
    },
    { byteBudget: 50_000, sliceSize: 2 }
  );

  // 2 sessions x ~10 KiB per slice against a 50 KiB budget -> ~3 slices.
  assert.ok(
    result.sessions.length < 50,
    "budget must stop short of the full admitted set"
  );
  assert.ok(
    result.hydratedBytes >= 50_000,
    "stops only once the budget is met"
  );
  assert.equal(
    result.attemptedIds.length,
    result.sessions.length,
    "attempted ids track what was actually loaded"
  );
  assert.equal(
    result.attemptedIds.length + result.deferredIds.length,
    50,
    "every admitted id is either attempted or deferred"
  );
  // Counterfactual guard: an unbounded hydrate would have loaded all 50.
  const loadedCount = loadedSlices.flat().length;
  assert.ok(
    loadedCount < 50,
    `budget must prevent loading every candidate (loaded ${loadedCount})`
  );
});

test("deferred ids are never reported as attempted (they must not dead-letter)", async () => {
  const result = await hydrateWithinByteBudget(
    idsFor(20),
    (sliceIds) => sliceIds.map((id) => session(id, 40_000)),
    { byteBudget: 50_000, sliceSize: 1 }
  );

  assert.ok(result.deferredIds.length > 0, "some ids must be deferred");
  for (const deferred of result.deferredIds) {
    assert.ok(
      !result.attemptedIds.includes(deferred),
      `deferred id ${deferred} must not appear in attemptedIds — the caller ` +
        "dead-letters unhydratable attempted ids"
    );
  }
});

test("always hydrates the first slice so one over-budget session still ships", async () => {
  // A single session larger than the ENTIRE budget must not wedge the queue.
  const result = await hydrateWithinByteBudget(
    idsFor(5),
    (sliceIds) => sliceIds.map((id) => session(id, 500_000)),
    { byteBudget: 1000, sliceSize: 1 }
  );

  assert.equal(result.sessions.length, 1, "the lone huge session is hydrated");
  assert.deepEqual(result.attemptedIds, ["s0"]);
  assert.ok(
    result.hydratedBytes > 1000,
    "progress is preserved even past the budget"
  );
});

test("the first-slice escape hatch is SLICE_SIZE sessions wide, not one", async () => {
  // The test above pins the hatch at `sliceSize: 1`, which is NOT the
  // production slice size — so it cannot see how much the real configuration
  // over-hydrates before the budget gets a vote. The budget is checked only
  // AFTER a whole slice loads, so the true worst-case first load is
  // SESSION_HYDRATION_SLICE_SIZE x the largest session. Pin that here at the
  // production value: this is the heap the byte budget can never claw back,
  // because it has already been spent.
  const perSessionBytes = 500_000;
  const result = await hydrateWithinByteBudget(
    idsFor(SESSION_HYDRATION_SLICE_SIZE * 3),
    (sliceIds) => sliceIds.map((id) => session(id, perSessionBytes)),
    { byteBudget: 1000, sliceSize: SESSION_HYDRATION_SLICE_SIZE }
  );

  assert.equal(
    result.sessions.length,
    SESSION_HYDRATION_SLICE_SIZE,
    "a whole slice is hydrated before the budget can stop it"
  );
  assert.ok(
    result.hydratedBytes >= perSessionBytes * SESSION_HYDRATION_SLICE_SIZE,
    `the unbudgeted first load is ~${SESSION_HYDRATION_SLICE_SIZE}x one session, ` +
      `not 1x — got ${result.hydratedBytes} bytes for a 1000-byte budget`
  );
  assert.equal(
    result.deferredIds.length,
    SESSION_HYDRATION_SLICE_SIZE * 2,
    "everything past the first slice is deferred, not loaded"
  );
});

test("hydrates every candidate when the whole set fits the budget", async () => {
  const result = await hydrateWithinByteBudget(
    idsFor(30),
    (sliceIds) => sliceIds.map((id) => session(id, 100)),
    { byteBudget: 2_097_152, sliceSize: 5 }
  );

  assert.equal(result.sessions.length, 30, "small sessions all fit");
  assert.deepEqual(
    result.deferredIds,
    [],
    "nothing deferred when under budget"
  );
});

test("a slice that hydrates nothing still records its ids as attempted", async () => {
  // Locally-deleted rows hydrate to nothing; those ids MUST be attributable so
  // the caller can dead-letter them as unhydratable rather than loop forever.
  const result = await hydrateWithinByteBudget(idsFor(3), () => [], {
    byteBudget: 2_097_152,
    sliceSize: 1,
  });

  assert.deepEqual(result.attemptedIds, ["s0", "s1", "s2"]);
  assert.equal(result.sessions.length, 0);
  assert.deepEqual(result.deferredIds, []);
});

test("the sync service hydrates through the byte budget, not in one unbounded load", async () => {
  // Production-wiring guard: the unit tests above prove the helper bounds
  // hydration, but nothing proved `AgentSessionSyncService` actually ROUTES
  // through it. Before ISS-5988 the service called
  // `loadSyncedSessions(hydratableCandidateIds)` once with every admitted id;
  // now that the count backstop is 100, restoring that call would hydrate the
  // whole admitted set in a single load. Asserting each recorded load is
  // slice-bounded fails in exactly that case.
  const admittedCount = SESSION_HYDRATION_SLICE_SIZE * 2 + 2;
  const source = new FakeSyncSource(
    Array.from({ length: admittedCount }, (_, index) =>
      makeSyncedSession(
        `session-${index}`,
        `2026-06-08T12:00:${String(index).padStart(2, "0")}.000Z`
      )
    )
  );
  const service = makeService(source, async () => ({ accepted: true }));

  service.start();
  await flushAgentSessionSync();
  service.stop();

  const loads = source.loadSyncedSessionIds;
  assert.ok(loads.length > 0, "the sync path must have hydrated something");
  const oversizedLoad = loads.find(
    (ids) => ids.length > SESSION_HYDRATION_SLICE_SIZE
  );
  assert.equal(
    oversizedLoad,
    undefined,
    `every hydrate must be slice-bounded to ${SESSION_HYDRATION_SLICE_SIZE}; ` +
      `got a load of ${oversizedLoad?.length} ids, which is the unbounded ` +
      "whole-admitted-set load this bound replaced"
  );
  const hydratedIds = loads.flat();
  assert.ok(
    hydratedIds.length > SESSION_HYDRATION_SLICE_SIZE,
    "more candidates than one slice must have been admitted, or the " +
      "slice bound is not actually being exercised"
  );
});

test("ISS-5988 (codex-connector P2): a PARTIAL hydration dead-letters only the missing id, and its healthy siblings still ship", async () => {
  // The regression this PR opened. While the request ceiling was 1 a missing row
  // WAS the whole batch, so it hit the all-empty branch and took the bounded
  // disposal path (`resolveEmptyHydration` since ISS-6031, which probes local
  // presence before disposing rather than inferring a deletion from the empty
  // read). Raising the ceiling made a PARTIAL result
  // reachable — one queued session locally deleted while its slice still has
  // valid siblings — and the all-empty gate then skipped the missing id
  // entirely: the siblings sent and dequeued while the absent id stayed queued,
  // rehydrating every tick, consuming no bounded budget and never letting the
  // cursor settle.
  //
  // Scoped to a SINGLE pass by holding the batch send open, which is what makes
  // this discriminating. On a queue that drains to empty the old gate
  // self-corrects a tick later: once the healthy siblings are sent and dequeued
  // the absent id is ALONE, hydration returns empty, and the all-empty branch
  // catches it. A test that lets the corpus drain therefore passes either way
  // and measures only a one-tick delay. The defect proper is the queue that
  // never empties — the absentee is never alone, never reaches the all-empty
  // branch, and re-hydrates on every pass while the never-empty queues also stop
  // the cursor from settling. Parking the send reproduces that condition with
  // three small sessions instead of a multi-megabyte corpus.
  //
  // COUNTERFACTUAL: with the drop re-gated on `candidateSessions.length === 0`,
  // "ghost" is never dead-lettered — its outbox row is still `pending` when this
  // pass ends, because its slice came back PARTIAL rather than empty.
  const TARGET = "target-partial-hydration";
  const key = buildAgentSessionSyncSourceKey(TARGET);
  // "ghost" is the NEWEST so it lands in the hydrated slice alongside siblings
  // that DO load — the partial-result shape.
  const source = new ResettingSyncSource([
    makeSyncedSession("ghost", "2026-06-08T12:03:00.000Z"),
    makeSyncedSession("keep-a", "2026-06-08T12:02:00.000Z"),
    makeSyncedSession("keep-b", "2026-06-08T12:01:00.000Z"),
  ]);
  // Delete ONE at hydrate time (delete-after-enqueue), so its slice comes back
  // partial rather than empty — the case the all-empty gate missed.
  source.onLoad = () => {
    source.deleteSession("ghost");
  };
  const sent: string[][] = [];
  // Never resolves during the assertions: the pass completes its hydrate + drop,
  // then parks on the send. No ack means no dequeue and no self-continue, so the
  // queue cannot drain into the all-empty branch behind our backs.
  const heldSend = deferred<DesktopAgentSessionsAck>();
  const service = makeServiceWithIdentity(
    source,
    (batch) => {
      sent.push(batch.sessions.map((s) => s.externalSessionId));
      return heldSend.promise;
    },
    TARGET
  );

  service.start();
  await flushAgentSessionSync();
  service.stop();

  // Guards the premise: the siblings shipped in one still-unacked batch, so the
  // all-empty branch cannot have fired on its own and made this test blind.
  assert.deepEqual(
    sent,
    [["keep-a", "keep-b"]],
    "the hydrated siblings ship in one still-unacked batch; only the absent id is dropped"
  );
  const ghostOutbox = [...source.outbox.values()].find(
    (row) => row.sourceKey === key && row.id === "ghost"
  );
  assert.equal(
    ghostOutbox?.status,
    "dead_lettered",
    "the id missing from a PARTIAL hydration is dead-lettered in the same pass, not left queued"
  );
  assert.equal(
    ghostOutbox?.reason,
    "unhydratable",
    "the reason is `unhydratable`"
  );
  // Bounded, not merely recorded: the drop dequeued it, so it stops consuming a
  // hydration slot instead of being re-requested for the life of the process.
  const ghostLoads = source.loadSyncedSessionIds.filter((ids) =>
    ids.includes("ghost")
  ).length;
  assert.equal(
    ghostLoads,
    1,
    `the absent id is hydrated once and then dropped, saw ${ghostLoads} load(s)`
  );
  heldSend.resolve({ accepted: true });
});

test("ISS-5988 (codex-connector P2): budget-DEFERRED ids are never dead-lettered — a deferral is not an absence", async () => {
  // The distinction the fix must not collapse. The unhydrated-id set is scoped
  // to `hydration.attemptedIds`, NOT to the full admitted candidate list, so an
  // id the byte budget stopped short of is untouched: it was never loaded, it is
  // perfectly healthy, and disposing of it would destroy real work.
  //
  // COUNTERFACTUAL (restated after ISS-6031 landed): the dead-letter assertion
  // below is no longer the discriminating one. It was, while an unhydrated id
  // was dead-lettered on the INFERENCE that a missing row meant a deleted
  // session — then filtering against `hydratableCandidateIds` destroyed every
  // deferred id on the first tick. ISS-6031 replaced that inference with a
  // presence probe, and a deferred session is genuinely still in `sessions`, so
  // the probe now answers StillPresent and `retainUnprovenCandidates` merely
  // parks it. Nothing is dead-lettered either way, and the old counterfactual
  // stopped biting the moment the two PRs merged.
  //
  // So the live assertion is the probe-call one: a budget deferral must never
  // REACH the absence machinery at all. Widen the filter back to
  // `hydratableCandidateIds` and every deferred id is handed to
  // `resolveEmptyHydration`, which probes it and then pins it behind
  // UNCONFIRMED_ABSENCE_BACKOFF_MS while logging a read failure that never
  // happened — throttling the exact drain this ticket exists to speed up. The
  // `findExistingSessionIdCalls` assertion fails there; the dead-letter one does
  // not. Both are kept: the first is the guard, the second is the floor.
  // ~150 KiB of raw JSON per session: heavy enough that a few slices reach the
  // 2 MiB hydration budget, but comfortably under the 256 KiB wire cap so these
  // never chunk and the test stays about deferral alone.
  const perSessionEvents = Array.from({ length: 1400 }, (_, index) => ({
    externalEventId: `pad-${index}`,
    eventType: "ToolUse",
    toolName: "Read",
    createdAt: "2026-06-08T12:00:00.000Z",
  }));
  // Several slices' worth, so the budget stops the hydrate partway through the
  // admitted set and leaves a genuine deferred remainder.
  const admittedCount = SESSION_HYDRATION_SLICE_SIZE * 5;
  const TARGET = "target-deferred-not-dropped";
  const source = new FakeSyncSource(
    Array.from({ length: admittedCount }, (_, index) =>
      makeSyncedSession(
        `session-${String(index).padStart(2, "0")}`,
        `2026-06-08T12:00:${String(index).padStart(2, "0")}.000Z`,
        perSessionEvents
      )
    )
  );
  // Parked like the test above, so this is exactly ONE pass: the deferral is a
  // property of a single hydrate, and letting the lane self-continue would drain
  // the backlog and cost seconds of suite time proving nothing extra.
  const heldSend = deferred<DesktopAgentSessionsAck>();
  const service = makeServiceWithIdentity(
    source,
    () => heldSend.promise,
    TARGET
  );

  service.start();
  await flushAgentSessionSync();
  service.stop();

  // Prove the budget actually deferred something — otherwise this asserts nothing.
  const hydratedIds = new Set(source.loadSyncedSessionIds.flat());
  assert.ok(
    hydratedIds.size < admittedCount,
    `the byte budget must have deferred some admitted ids (hydrated ${hydratedIds.size}/${admittedCount})`
  );
  // THE DISCRIMINATING ASSERTION. Every id the budget actually attempted came
  // back hydrated, so no id was unaccounted for and the ISS-6031 absence probe
  // must never have run. A deferral is not an unexplained miss, and routing one
  // into the probe would park a healthy session behind the absence backoff.
  assert.deepEqual(
    source.findExistingSessionIdCalls,
    [],
    "a budget-deferred id must never be handed to the absence probe — it was " +
      "never attempted, so its non-return needs no explaining"
  );
  // Nothing was locally deleted, so NOTHING may be dead-lettered — least of all
  // the ids the budget never attempted. The floor, not the guard: see the
  // counterfactual note above for why this one alone no longer discriminates.
  const deadLettered = [...source.outbox.values()].filter(
    (row) => row.status === "dead_lettered"
  );
  assert.deepEqual(
    deadLettered.map((row) => row.id).toSorted(),
    [],
    "a budget-deferred id was never loaded and must not be dead-lettered as unhydratable"
  );
  heldSend.resolve({ accepted: true });
});
