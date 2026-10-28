/**
 * @file agent-session-sync-dead-letter-revisit.test.ts
 * @description The PERSISTED dead-letter set-aside/revisit lifecycle, split out
 * of the (grandfathered, shrink-only) main sync-service suite.
 *
 * One responsibility: what the session lane does with dead-letter ids it has
 * ALREADY recorded on the persisted cursor, as opposed to how a row gets
 * dead-lettered in the first place (that stays in the main suite).
 *
 *  - a promoted set-aside dead-letter that drains resets the idle-cycle guard,
 *    so the next one is revisited on the following tick rather than needing a
 *    restart;
 *  - the persisted set is bounded at MAX_DEAD_LETTERED_IDS on resume, and the
 *    next persist rewrites it capped (oldest-first eviction);
 *  - a validation_failed / ingestion_failed row resumed from the cursor is set
 *    aside on restart and revisited LAST;
 *  - genuinely-new work always drains BEFORE any dead-letter revisit, and a
 *    revisit happens at most once per idle cycle.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  MAX_CONSECUTIVE_VALIDATION_FAILED,
  MAX_DEAD_LETTERED_IDS,
  SESSION_LANE_STALL_CEILING_MS,
  VALIDATION_FAILED_BACKOFF_MS,
} from "../src/main/agent-sync/agent-session-sync-backoff-policy.js";
import type {
  AgentSessionSyncTransportPayload,
  SyncedAgentSession,
} from "../src/main/agent-sync/agent-session-sync-contract.js";
import type { DeadLetterLifecycleDeps } from "../src/main/agent-sync/agent-session-sync-dead-letter-lifecycle.js";
import { markDeadLettered } from "../src/main/agent-sync/agent-session-sync-dead-letter-lifecycle.js";
import { buildAgentSessionSyncSourceKey } from "../src/main/agent-sync/agent-session-sync-source.js";
import type { DesktopAgentSessionsAck } from "../src/main/cloud/cloud-protocol.js";
import { DesktopAgentSessionsAckReason } from "../src/main/cloud/cloud-protocol.js";
import { laneReArmDelayMs } from "../src/shared/lane-give-up.js";
import {
  flushAgentSessionSync,
  makeServiceWithIdentity,
  runWithMockedNow,
} from "./agent-session-sync-service-fixtures.js";
import { deferred } from "./deferred.js";
import { FakeSyncSource, makeSyncedSession } from "./fake-sync-source.js";

test("agent-session sync drains multiple set-aside dead-letters one per idle cycle after each success", async () => {
  // FIX (idle-guard reset after a successful promotion): once a promoted
  // set-aside dead-letter drains successfully, the idle-cycle guard must reset so
  // the NEXT persisted dead-letter can be promoted on a subsequent tick. Without
  // the reset only a single dead-letter would ever be revisited per process, and
  // the rest would need a restart (or unrelated new work) to recover.
  const top = "2026-06-08T12:05:00.000Z";
  const source = new FakeSyncSource([
    makeSyncedSession("dl-a", "2026-06-08T12:00:00.000Z"),
    makeSyncedSession("dl-b", "2026-06-08T12:01:00.000Z"),
    makeSyncedSession("top", top),
  ]);
  const key = buildAgentSessionSyncSourceKey("target-a");
  // Resume with two dead-letters set aside and "top" as the accepted top id, so
  // no backfill re-walk happens and both dead-letters must be promoted from the
  // persisted set.
  source.seedSyncState(key, {
    observedTopUpdatedAt: top,
    observedIdsAtTopUpdatedAt: ["top"],
    deadLetteredIds: ["dl-a", "dl-b"],
  });

  const sent: string[][] = [];
  // The server accepts every promoted dead-letter.
  const service = makeServiceWithIdentity(
    source,
    (batch) => {
      sent.push(batch.sessions.map((session) => session.externalSessionId));
      return Promise.resolve({ accepted: true as const });
    },
    "target-a"
  );

  service.start();
  await flushAgentSessionSync();
  assert.equal(
    service.getSyncProgress().deadLetteredSessions,
    1,
    "the first idle cycle promotes exactly one set-aside dead-letter"
  );

  // The successful drain reset the guard: the next idle tick promotes the second
  // dead-letter without any new unrelated work.
  service.refresh();
  await flushAgentSessionSync();
  assert.equal(
    service.getSyncProgress().deadLetteredSessions,
    0,
    "a second idle cycle promotes the remaining dead-letter after the first drained"
  );
  service.stop();

  assert.deepEqual(
    sent,
    [["dl-a"], ["dl-b"]],
    "both dead-letters reach the cloud, one per idle cycle, in insertion order"
  );
});

test("agent-session sync caps the persisted dead-letter set at MAX_DEAD_LETTERED_IDS on resume", async () => {
  // BOUNDED GROWTH: a long-lived install that keeps dead-lettering distinct
  // sessions must not grow `deadLetteredIds` — nor the persisted JSON derived
  // from it — without limit. A legacy cursor persisted before the cap could carry
  // more than MAX_DEAD_LETTERED_IDS; on resume the seeded set is bounded, and the
  // next persist rewrites it capped. Oldest ids (insertion order) are evicted.
  const overCap = MAX_DEAD_LETTERED_IDS + 25;
  const seededDeadIds = Array.from({ length: overCap }, (_, i) => `dl-${i}`);
  const top = "2026-06-08T12:05:00.000Z";
  const source = new FakeSyncSource([
    makeSyncedSession("top", top),
    // A genuinely-new row above the watermark drains and triggers a persist so we
    // can inspect the rewritten (capped) dead-letter array.
    makeSyncedSession("new", "2026-06-08T12:06:00.000Z"),
  ]);
  const key = buildAgentSessionSyncSourceKey("target-a");
  source.seedSyncState(key, {
    observedTopUpdatedAt: top,
    observedIdsAtTopUpdatedAt: ["top"],
    deadLetteredIds: seededDeadIds,
  });

  // Accept the genuinely-new row; keep every promoted set-aside dead-letter
  // dead-lettered (deterministic validation_failed) so the persisted set stays
  // pinned at the cap and the assertions are not raced by a draining promotion.
  const service = makeServiceWithIdentity(
    source,
    (batch) => {
      const ids = batch.sessions.map((session) => session.externalSessionId);
      return Promise.resolve(
        ids.some((id) => id.startsWith("dl-"))
          ? {
              accepted: false as const,
              reason: DesktopAgentSessionsAckReason.ValidationFailed,
            }
          : { accepted: true as const }
      );
    },
    "target-a"
  );

  // A single tick hydrates+caps the seeded set and drains the genuinely-new
  // incremental row (selected before any dead-letter promotion), which triggers
  // the persist that rewrites the capped dead-letter set. Read progress BEFORE
  // stop() (which clears the in-memory dead-letter set) and before any later tick
  // could promote/drain a set-aside id and change the live count.
  service.start();
  await flushAgentSessionSync();

  assert.equal(
    service.getSyncProgress().deadLetteredSessions,
    MAX_DEAD_LETTERED_IDS,
    "the seeded dead-letter set is bounded to the cap on resume"
  );
  service.stop();
  // Every persisted dead-letter array must stay bounded, and at least one persist
  // must have rewritten the capped set (proving the bound reaches disk).
  const persistedLengths = source.advanceCalls.map(
    (call) => call.state.deadLetteredIds.length
  );
  assert.ok(
    persistedLengths.every((length) => length <= MAX_DEAD_LETTERED_IDS),
    "no persisted cursor may exceed MAX_DEAD_LETTERED_IDS"
  );
  assert.ok(
    persistedLengths.includes(MAX_DEAD_LETTERED_IDS),
    "the rewritten persisted cursor is capped at MAX_DEAD_LETTERED_IDS"
  );
  const cappedState = source.advanceCalls.find(
    (call) => call.state.deadLetteredIds.length === MAX_DEAD_LETTERED_IDS
  )?.state;
  assert.ok(
    !cappedState?.deadLetteredIds.includes("dl-0"),
    "the oldest dead-letters are evicted first"
  );
  assert.ok(
    cappedState?.deadLetteredIds.includes(`dl-${overCap - 1}`),
    "the most-recently-recorded dead-letters are retained"
  );
});

test("ISS-7216: a dead-letter evicted by the cap is returned to the durable pending outbox, not forgotten", async () => {
  // SILENT DATA LOSS. `deadLetteredIds` has three exits, and the cap was the only
  // one that did not durably re-pend the row on the way out. That mattered because
  // a `dead_lettered` outbox row is invisible to EVERY other re-entry door:
  // `loadPendingOutboxIds` and stranded-row adoption both filter `status =
  // pending`, and the incremental scan cannot reach it because the watermark has
  // already advanced past it. So the in-memory Map was the only remaining record
  // that the session was still owed — and evicting an id destroyed it.
  //
  // The eviction docblock used to argue this was harmless because "a future
  // cold-restart re-backfill re-walks it". It does not:
  // `initializeBackfillQueueIfNeeded` early-returns as soon as a cursor is
  // resumed, so a device past its first backfill never re-walks the corpus. The
  // row stayed on disk as `dead_lettered` forever — never sent, and never purged
  // either, because `selectUndeliveredSessionIds` matches any status.
  //
  // This drives the REAL hydration path (`enforceDeadLetterCap` is called from
  // `hydratePersistedCursorIfNeeded` on an over-cap legacy cursor), and asserts
  // the observable DURABLE state rather than a spy call, so deleting the re-pend
  // reddens it. `main/sync/AGENTS.md` invariant 10 is the contract under test:
  // "Eviction must degrade to 're-discovered later', never to 'lost'."
  const overCap = MAX_DEAD_LETTERED_IDS + 25;
  const seededDeadIds = Array.from({ length: overCap }, (_, i) => `dl-${i}`);
  const top = "2026-06-08T12:05:00.000Z";
  // Insertion order decides eviction, so the oldest 25 (`dl-0`..`dl-24`) are the
  // ones evicted. One evicted id and one RETAINED id get a real local session
  // plus a real `dead_lettered` durable row. The retained one is the positive
  // sibling: it proves the assertion below can tell the two apart, and that the
  // fix re-pends only what it actually evicts rather than flipping the whole set
  // back indiscriminately.
  //
  // Both sessions must genuinely EXIST locally and sit below the watermark. A
  // re-pended row whose session the store cannot produce is confirmed-absent and
  // legitimately disposed, which would make this test pass or fail for a reason
  // that has nothing to do with eviction.
  const evictedId = "dl-0";
  const retainedId = `dl-${MAX_DEAD_LETTERED_IDS}`;
  const source = new FakeSyncSource([
    makeSyncedSession(evictedId, "2026-06-08T11:00:00.000Z"),
    makeSyncedSession(retainedId, "2026-06-08T11:01:00.000Z"),
    makeSyncedSession("top", top),
  ]);
  const key = buildAgentSessionSyncSourceKey("target-a");
  source.seedSyncState(key, {
    observedTopUpdatedAt: top,
    observedIdsAtTopUpdatedAt: ["top"],
    deadLetteredIds: seededDeadIds,
  });
  source.seedOutbox(key, evictedId, "dead_lettered");
  source.seedOutbox(key, retainedId, "dead_lettered");

  // Reject every send as `unauthenticated`. That is the one class that defers
  // with budgets INTACT and can never dead-letter, so a re-pended row cannot be
  // flipped back to `dead_lettered` by the very drain this test triggers — the
  // assertions below then observe the eviction's durable effect and nothing else.
  const service = makeServiceWithIdentity(
    source,
    () =>
      Promise.resolve({
        accepted: false as const,
        reason: DesktopAgentSessionsAckReason.Unauthenticated,
      }),
    "target-a"
  );
  service.start();
  await flushAgentSessionSync();
  service.stop();

  const pendingIds = await source.loadPendingOutboxIds(key);
  assert.ok(
    pendingIds.includes(evictedId),
    "an evicted dead-letter must be handed back to the pending outbox so it stays re-discoverable"
  );
  assert.ok(
    !pendingIds.includes(retainedId),
    "a dead-letter still inside the cap is NOT re-pended — the eviction is what re-pends, and this proves the assertion above can distinguish the two"
  );
});

test("ISS-7216: the LIVE dead-letter path enforces the cap, and the eviction it triggers re-pends", async () => {
  // WIRING. `enforceDeadLetterCap` has two call sites: the hydration one the test
  // above drives, and `markDeadLettered` — the live door, taken when a RUNNING
  // lane dead-letters its 1001st distinct session. Both share one `deps` object
  // and one function body, so a bug inside the eviction reddens either way; what
  // is uncovered without this test is the CALL. Delete the `enforceDeadLetterCap`
  // call from `markDeadLettered` and nothing else in the suite notices, because
  // no test drives 1000+ distinct live dead-letters through the service.
  //
  // Driven directly against the lifecycle module rather than through 1001 real
  // sends: the service round-trip adds minutes of CI time and proves nothing this
  // does not. The service's own wiring of the hand-off is what the hydration
  // tests above and below cover end to end.
  const probe = makeCapProbe(() => Promise.resolve(true));
  const { deps, deadLetteredIds, handedOff } = probe;

  // Fill to exactly the cap through the live path. `dl-0` is the oldest.
  for (let i = 0; i < MAX_DEAD_LETTERED_IDS; i += 1) {
    markDeadLettered(`dl-${i}`, true, "ingestion_failed", 5, null, deps);
  }
  assert.equal(
    deadLetteredIds.size,
    MAX_DEAD_LETTERED_IDS,
    "the set fills to the cap without evicting"
  );
  // The negative sibling, on the same spy: at exactly the cap nothing is evicted,
  // so nothing is re-pended. Without this, the assertion below could pass on a
  // build that re-pends on EVERY dead-letter rather than only on eviction.
  assert.deepEqual(
    handedOff,
    [],
    "no eviction has happened yet, so nothing has been handed back to the outbox"
  );

  // One more distinct session crosses the cap and must evict the oldest.
  markDeadLettered("dl-overflow", true, "ingestion_failed", 5, null, deps);
  assert.deepEqual(
    handedOff,
    ["dl-0"],
    "the evicted oldest id — and only it — is handed back to the durable pending outbox"
  );
  // ISS-7216 (PR #5708 review): the release is now SEQUENCED on that hand-off,
  // so the id leaves the set when the durable write confirms — not on the line
  // after the write was requested. The assertion is unchanged in substance
  // (the cap is enforced, the evicted id is gone); it moved after the await
  // because the behavior under test deliberately became a confirmed hand-off.
  await flushAgentSessionSync();
  assert.equal(
    deadLetteredIds.size,
    MAX_DEAD_LETTERED_IDS,
    "the live dead-letter path enforces the cap"
  );
  assert.ok(
    !deadLetteredIds.has("dl-0"),
    "the evicted id is gone from the in-memory set once its re-pend is confirmed"
  );
});

test("ISS-7216: a durable re-pend that THROWS must not lose the evicted dead-letter", async () => {
  // COUNTERFACTUAL 1 of 2 (PR #5708 review, whitlockk). The cap deletes the only
  // in-memory reference to the id, so it cannot inherit the sibling doors'
  // "a failed write only costs a hint" argument — they leave the id in
  // `deadLetteredIds` for the next persist, and this one cannot, because
  // removing it is the point. A re-pend that rejects (a locked or closing DB, a
  // db-host IPC fault) therefore used to lose the session outright: no durable
  // `pending` row, no in-memory entry, no persisted entry, and no other door
  // that can reach a `dead_lettered` row.
  //
  // Drives the REAL wiring — hydration → enforceDeadLetterCap →
  // OutboxWriters.handOffEvicted → the source — so the writer's catch and the
  // lifecycle's release gate are both under test, not a stub of them.
  const overCap = MAX_DEAD_LETTERED_IDS + 25;
  const evictedId = "dl-0";
  class RejectingRePendSource extends FakeSyncSource {
    rePendAttempts = 0;
    override reEnqueueRecoveredDeadLetter(): Promise<boolean> {
      this.rePendAttempts += 1;
      return Promise.reject(new Error("db-host exited"));
    }
  }
  const source = new RejectingRePendSource(capFixtureSessions(evictedId));
  const key = seedOverCapCursor(source, "cap-a", overCap, evictedId);

  const service = makeServiceWithIdentity(
    source,
    acceptFreshRejectDeadLetters,
    "cap-a"
  );
  service.start();
  await flushAgentSessionSync();

  assert.ok(
    source.rePendAttempts > 0,
    "the eviction did attempt the durable hand-off (otherwise this proves nothing)"
  );
  assert.deepEqual(
    await source.loadPendingOutboxIds(key),
    [],
    "the write rejected, so the row was NOT re-pended — this is the failure being survived"
  );
  assert.equal(
    service.getSyncProgress().deadLetteredSessions,
    overCap,
    "no id is released on a failed hand-off; the in-memory set still holds every one"
  );
  service.stop();
  assert.ok(
    persistedDeadLetterSets(source).some((ids) => ids.includes(evictedId)),
    "the evicted id is still written to the persisted cursor, so a restart sets it aside again — degraded to 're-discovered later', never 'lost'"
  );
});

test("ISS-7216: a durable re-pend that reports ZERO ROWS without throwing must not lose the evicted dead-letter", async () => {
  // COUNTERFACTUAL 2 of 2 (PR #5708 review, whitlockk), and the nastier of the pair:
  // nothing throws. `sqliteReEnqueueRecoveredDeadLetter` is an `updateMany`
  // guarded on `status = dead_lettered`, so a write that matches nothing
  // resolves normally — a try/catch around it stays silent and the caller
  // "succeeds" over a row it never touched. A fix that only handled rejections
  // would pass counterfactual 1 and still drop the session here, which is why
  // the source reports the CONFIRMATION (`false` = the row is still
  // `dead_lettered`) rather than just not throwing.
  const overCap = MAX_DEAD_LETTERED_IDS + 25;
  const evictedId = "dl-0";
  class NoOpRePendSource extends FakeSyncSource {
    rePendAttempts = 0;
    /** Resolves — but leaves the row `dead_lettered` and says so. */
    override reEnqueueRecoveredDeadLetter(): Promise<boolean> {
      this.rePendAttempts += 1;
      return Promise.resolve(false);
    }
  }
  const source = new NoOpRePendSource(capFixtureSessions(evictedId));
  const key = seedOverCapCursor(source, "cap-b", overCap, evictedId);

  const service = makeServiceWithIdentity(
    source,
    acceptFreshRejectDeadLetters,
    "cap-b"
  );
  service.start();
  await flushAgentSessionSync();

  assert.ok(
    source.rePendAttempts > 0,
    "the eviction did attempt the durable hand-off (otherwise this proves nothing)"
  );
  assert.deepEqual(
    await source.loadPendingOutboxIds(key),
    [],
    "the update matched nothing, so the row is still dead_lettered — invisible to every durable re-entry door"
  );
  assert.equal(
    service.getSyncProgress().deadLetteredSessions,
    overCap,
    "an unconfirmed hand-off releases nothing; the in-memory set still holds every id"
  );
  service.stop();
  assert.ok(
    persistedDeadLetterSets(source).some((ids) => ids.includes(evictedId)),
    "the evicted id is still written to the persisted cursor, so the session keeps a path back"
  );
});

test("agent-session sync sets a persisted validation_failed row aside on restart and revisits it last", async () => {
  // RESUME: the fix persists the cursor with the validation_failed id recorded
  // as a dead-letter, so a cold start (new instance, same target + source) does
  // NOT re-walk the whole corpus (listAllSessionCursorRows is not called). The
  // dead id is seeded SET ASIDE, then — only once both queues are empty —
  // revisited exactly once by the lowest-priority idle-cycle promotion.
  const source = new FakeSyncSource([
    makeSyncedSession("bad", "2026-06-08T12:00:00.000Z"),
  ]);
  const first = makeServiceWithIdentity(
    source,
    async () => ({
      accepted: false,
      reason: DesktopAgentSessionsAckReason.ValidationFailed,
    }),
    "target-a"
  );
  await runWithMockedNow(async ({ advance }) => {
    first.start();
    await flushAgentSessionSync();
    // FEA-3366: drive the validation retry budget past its per-session backoff
    // until it dead-letters at the threshold, then persists the recorded id.
    for (let i = 1; i < MAX_CONSECUTIVE_VALIDATION_FAILED; i += 1) {
      advance(VALIDATION_FAILED_BACKOFF_MS + 1);
      first.refresh();
      await flushAgentSessionSync();
    }
  });
  first.stop();
  assert.ok(
    source.advanceCalls.length >= 1,
    "the cursor must persist, recording the validation_failed id"
  );
  assert.deepEqual(source.advanceCalls.at(-1)?.state.deadLetteredIds, ["bad"]);

  // Restart: a new instance with the same identity and source. The server now
  // accepts. Reset the re-walk counter so we can prove the resume path skips it.
  source.listAllCursorCallCount = 0;
  const sent: string[][] = [];
  const restarted = makeServiceWithIdentity(
    source,
    (batch) => {
      sent.push(batch.sessions.map((session) => session.externalSessionId));
      return Promise.resolve({ accepted: true as const });
    },
    "target-a"
  );
  restarted.start();
  await flushAgentSessionSync();
  // The set-aside dead-letter is revisited only after the (empty) queues drain,
  // once per idle cycle — a second tick performs the promoted upload.
  restarted.refresh();
  await flushAgentSessionSync();
  restarted.stop();

  assert.equal(
    source.listAllCursorCallCount,
    0,
    "resume must skip the full re-walk (listAllSessionCursorRows) via the persisted cursor"
  );
  assert.deepEqual(
    sent,
    [["bad"]],
    "the set-aside dead-letter is revisited last and re-attempted once queues drain"
  );
});

test("FEA-2258: a dead-lettered ingestion_failed row is recorded, set aside on restart, and revisited last", async () => {
  // The recovery path for the FEA-2258 NUL/lone-surrogate fix, updated to the
  // dead-letter-cursor-poison contract: a session the server keeps rejecting with
  // ingestion_failed dead-letters locally once its LANE-WIDE stall clock passes
  // SESSION_LANE_STALL_CEILING_MS (ISS-7730 — the class burns no per-row budget,
  // so wall clock is the terminal path). Previously `deadLetteredIds` blocked persistCursorIfCaughtUp, so the
  // cursor never advanced and every restart re-walked the whole corpus. Now the
  // cursor advances and RECORDS the id; a restart (the user relaunching after the
  // server sanitization deploys) sets it aside and revisits it last, re-attempting
  // and accepting it without a full re-walk.
  const source = new FakeSyncSource([
    makeSyncedSession("recovers", "2026-06-08T12:00:00.000Z"),
  ]);
  const first = makeServiceWithIdentity(
    source,
    async () => ({
      accepted: false,
      reason: DesktopAgentSessionsAckReason.IngestionFailed,
    }),
    "target-a"
  );
  // ISS-8610: pin the ORIGIN, because the ceiling this row dead-letters on is
  // now also the lane's environmental give-up ceiling, and that give-up is
  // DURABLE. Both instances have to read one timeline: a stamp written on the
  // virtual clock and read back on the real one is in the future, normalizes to
  // "gave up just now", and holds the relaunch for its whole re-arm window.
  const originMs = Date.parse("2026-06-08T12:00:00.000Z");
  await runWithMockedNow(async ({ advance }) => {
    first.start();
    await flushAgentSessionSync();
    // ISS-7730: the first rejection stamped the row's lane-stall clock; one
    // more past the ceiling is what dead-letters it.
    advance(SESSION_LANE_STALL_CEILING_MS + 1);
    first.refresh();
    await flushAgentSessionSync();
  }, originMs);
  first.stop();
  assert.ok(
    source.advanceCalls.length >= 1,
    "the cursor must advance, recording the dead-lettered session"
  );
  assert.deepEqual(source.advanceCalls.at(-1)?.state.deadLetteredIds, [
    "recovers",
  ]);

  // Restart: same identity + source, the server now accepts.
  source.listAllCursorCallCount = 0;
  const sent: string[][] = [];
  const restarted = makeServiceWithIdentity(
    source,
    (batch) => {
      sent.push(batch.sessions.map((session) => session.externalSessionId));
      return Promise.resolve({ accepted: true as const });
    },
    "target-a"
  );
  // The relaunch happens after the give-up's re-arm window: the server fix has
  // shipped, and the window arm is what buys this launch its one attempt.
  await runWithMockedNow(
    async () => {
      restarted.start();
      await flushAgentSessionSync();
      // Revisited last: only after the (empty) queues drain does the idle-cycle
      // promotion enqueue the set-aside dead-letter for a retry.
      restarted.refresh();
      await flushAgentSessionSync();
    },
    originMs + SESSION_LANE_STALL_CEILING_MS + laneReArmDelayMs(1) + 2
  );
  restarted.stop();

  assert.equal(
    source.listAllCursorCallCount,
    0,
    "resume must skip the full re-walk via the persisted cursor"
  );
  assert.deepEqual(
    sent,
    [["recovers"]],
    "the set-aside dead-letter is revisited last and re-attempted once queues drain"
  );
});

test("agent-session sync drains pending work before any dead-letter, and revisits dead-letters once per idle cycle", async () => {
  // PRIORITY: dead-lettered sessions are set aside and de-prioritized. A pending
  // incremental/backfill row always drains before any dead-letter retry, the
  // idle-cycle revisit fires at most once per cycle (not a hot loop), and
  // genuinely-new work re-defers dead-letters behind it. A promoted dead-letter
  // that re-fails re-enters the dead-letter set but is NOT immediately re-promoted.
  const top = "2026-06-08T12:05:00.000Z";
  const source = new FakeSyncSource([
    makeSyncedSession("dl", "2026-06-08T12:00:00.000Z"),
    makeSyncedSession("top", top),
    // A genuinely-new session above the resumed watermark → incremental work
    // that must drain BEFORE the set-aside dead-letter is revisited.
    makeSyncedSession("new", "2026-06-08T12:06:00.000Z"),
  ]);
  const key = buildAgentSessionSyncSourceKey("target-a");
  // Resume with "dl" recorded as a dead-letter and "top" as the accepted top id.
  source.seedSyncState(key, {
    observedTopUpdatedAt: top,
    observedIdsAtTopUpdatedAt: ["top"],
    deadLetteredIds: ["dl"],
  });

  const sent: string[][] = [];
  // ISS-4758: the final step of this test races FEA-4375's self-continuing
  // `setTimeout(0)` drain, so it cannot observe "how much has drained by now"
  // after a fixed pump. This test owns `sendBatch`, so the SEND ITSELF is the
  // real completion signal — resolve a deferred from it rather than polling
  // `sent.length` (desktop AGENTS.md FEA-2399: a bounded poll is only for when
  // no real signal exists).
  const newWorkPhase = { started: false };
  const new2Sent = deferred();
  const deferredRetrySent = deferred();
  const service = makeServiceWithIdentity(
    source,
    (batch) => {
      const ids = batch.sessions.map((session) => session.externalSessionId);
      sent.push(ids);
      if (newWorkPhase.started) {
        if (ids.includes("new2")) {
          new2Sent.resolve();
        } else if (ids.includes("dl")) {
          deferredRetrySent.resolve();
        }
      }
      // The server never accepts "dl", so a promoted retry re-fails and the id
      // re-enters the dead-letter set (deterministic validation_failed path).
      return Promise.resolve(
        ids.includes("dl")
          ? {
              accepted: false as const,
              reason: DesktopAgentSessionsAckReason.ValidationFailed,
            }
          : { accepted: true as const }
      );
    },
    "target-a"
  );

  // The mocked clock lets us step past the 30s incremental throttle
  // deterministically, so each genuinely-new incremental row is actually
  // selected (rather than throttle-skipped into the backfill/dead-letter path).
  await runWithMockedNow(async ({ advance }) => {
    service.start();
    await flushAgentSessionSync();
    // "dl" is set aside; the genuinely-new incremental row "new" drains FIRST —
    // the dead-letter is not promoted while real work is queued.
    assert.deepEqual(
      sent.at(-1),
      ["new"],
      "genuinely-new incremental work drains before any dead-letter retry"
    );
    assert.equal(service.getSyncProgress().deadLetteredSessions, 1);

    // Now both queues are empty → the idle-cycle promotion fires ONCE, promoting
    // "dl". FEA-3366: on this revisit the validation_failed row re-enters its
    // bounded retry budget (deferred with backoff) instead of dropping straight
    // back into the dead-letter set — it stays queued for a bounded retry, not
    // lost and not hot-looping.
    service.refresh();
    await flushAgentSessionSync();
    assert.deepEqual(
      sent.at(-1),
      ["dl"],
      "once queues drain, the set-aside dead-letter is revisited exactly once"
    );
    assert.equal(
      service.getSyncProgress().deadLetteredSessions,
      0,
      "the revisited validation_failed row re-enters its retry budget (deferred), leaving the dead-letter set"
    );

    // Hot-loop guard: with no new real work and its backoff still pending, the
    // revisited row is NOT re-sent on the very next idle tick.
    const sentCountBeforeIdleTick = sent.length;
    service.refresh();
    await flushAgentSessionSync();
    assert.equal(
      sent.length,
      sentCountBeforeIdleTick,
      "the deferred revisit is not re-sent until its backoff elapses or new work starts a fresh cycle"
    );

    // Genuinely-new work drains first; advancing past both the incremental
    // throttle and the validation backoff makes "new2" the selected incremental
    // work this tick and leaves "dl" ready to retry on the following tick.
    //
    // ISS-4758: this is the ONE step here where ready work REMAINS after the
    // batch ("dl" is out of backoff), so FEA-4375's drain self-continues on a
    // `setTimeout(0)` — and whether that landed inside a single
    // `flushAgentSessionSync()` was a coin flip that failed under CI load with
    // `['dl'] !== ['new2']`. Await the sends themselves and assert their ORDER,
    // which is what "drains before" actually claims. (The earlier steps leave no
    // ready work behind their batch, so the self-continue never reschedules
    // there and their snapshots are stable.)
    const sentBeforeNewWork = sent.length;
    newWorkPhase.started = true;
    source.upsert(makeSyncedSession("new2", "2026-06-08T12:07:00.000Z"));
    advance(60_000);
    service.refresh();
    await new2Sent.promise;
    service.refresh();
    await deferredRetrySent.promise;
    assert.deepEqual(
      sent.slice(sentBeforeNewWork, sentBeforeNewWork + 2),
      [["new2"], ["dl"]],
      "genuinely-new work drains before the deferred retry, which is re-attempted once its backoff elapses"
    );
  });

  service.stop();
});

/**
 * ISS-7216: the local sessions the cap counterfactuals need. Both the id that
 * gets evicted and the watermark row must genuinely EXIST locally — a re-pended
 * row whose session the store cannot produce is confirmed-absent and
 * legitimately disposed, which would make an assertion pass or fail for a reason
 * that has nothing to do with eviction. `fresh` sits above the watermark so it
 * drains, which is what triggers the cursor persist the assertions read.
 */
function capFixtureSessions(evictedId: string): SyncedAgentSession[] {
  return [
    makeSyncedSession(evictedId, "2026-06-08T11:00:00.000Z"),
    makeSyncedSession(CAP_FIXTURE_TOP, "2026-06-08T12:05:00.000Z"),
    makeSyncedSession("fresh", "2026-06-08T12:06:00.000Z"),
  ];
}

/**
 * Seed a legacy cursor carrying more than `MAX_DEAD_LETTERED_IDS` set-aside ids
 * plus a real `dead_lettered` outbox row for `evictedId`, so hydration takes the
 * cap door. Returns the source key the assertions read the outbox under.
 */
function seedOverCapCursor(
  source: FakeSyncSource,
  targetId: string,
  overCap: number,
  evictedId: string
): string {
  const key = buildAgentSessionSyncSourceKey(targetId);
  source.seedSyncState(key, {
    observedTopUpdatedAt: CAP_FIXTURE_TOP_UPDATED_AT,
    observedIdsAtTopUpdatedAt: [CAP_FIXTURE_TOP],
    deadLetteredIds: Array.from({ length: overCap }, (_, i) => `dl-${i}`),
  });
  source.seedOutbox(key, evictedId, "dead_lettered");
  return key;
}

/**
 * Accept genuinely-new work (so a cursor persist happens and the assertions have
 * a persisted dead-letter array to read) and keep every set-aside `dl-` id
 * dead-lettered, so the cap's population is not changed out from under the
 * assertions by a promotion draining successfully.
 */
function acceptFreshRejectDeadLetters(
  batch: AgentSessionSyncTransportPayload
): Promise<DesktopAgentSessionsAck> {
  const ids = batch.sessions.map((session) => session.externalSessionId);
  return Promise.resolve(
    ids.some((id) => id.startsWith("dl-"))
      ? {
          accepted: false as const,
          reason: DesktopAgentSessionsAckReason.ValidationFailed,
        }
      : { accepted: true as const }
  );
}

/** Every dead-letter id array this source has been asked to persist. */
function persistedDeadLetterSets(source: FakeSyncSource): string[][] {
  return source.advanceCalls.map((call) => call.state.deadLetteredIds);
}

/**
 * A minimal `DeadLetterLifecycleDeps` for driving the lifecycle module directly,
 * with the cap's durable hand-off under the caller's control. `handedOff`
 * records what the cap ASKED to hand over, which is separate from what it
 * released — the point of ISS-7216's review fix is that those are no longer the
 * same event.
 */
function makeCapProbe(handOff: (id: string) => Promise<boolean>): {
  deps: DeadLetterLifecycleDeps;
  deadLetteredIds: Map<string, number>;
  handedOff: string[];
} {
  const handedOff: string[] = [];
  const deadLetteredIds = new Map<string, number>();
  const deps: DeadLetterLifecycleDeps = {
    deadLetteredIds,
    deadLetterCountById: new Map<string, number>(),
    chunkValidationCycleById: new Map<string, number>(),
    ackOmittedCycleById: new Map<string, number>(),
    backfillQueue: [],
    backfillQueuedIds: new Set<string>(),
    incrementalQueue: [],
    incrementalQueuedIds: new Set<string>(),
    hasPendingChunks: () => false,
    isHistoricalBackfillEnabled: () => true,
    wasDeadLetterRevisitedThisIdleCycle: () => false,
    setDeadLetterRevisitedThisIdleCycle: () => undefined,
    clearFailureStateForId: () => undefined,
    recordOutboxDeadLetter: () => undefined,
    recordOutboxReEnqueue: (id) => {
      handedOff.push(id);
      return handOff(id);
    },
    logInfo: () => undefined,
    logWarn: () => undefined,
  };
  return { deps, deadLetteredIds, handedOff };
}

/** The watermark row every cap fixture resumes on. */
const CAP_FIXTURE_TOP = "top";
const CAP_FIXTURE_TOP_UPDATED_AT = "2026-06-08T12:05:00.000Z";
