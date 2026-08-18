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
import { test } from "node:test";
import {
  INGESTION_FAILED_BACKOFF_MS,
  MAX_CONSECUTIVE_INGESTION_FAILED,
  MAX_CONSECUTIVE_VALIDATION_FAILED,
  MAX_DEAD_LETTERED_IDS,
  VALIDATION_FAILED_BACKOFF_MS,
} from "../src/main/agent-sync/agent-session-sync-backoff-policy.js";
import { buildAgentSessionSyncSourceKey } from "../src/main/agent-sync/agent-session-sync-source.js";
import { DesktopAgentSessionsAckReason } from "../src/main/cloud/cloud-protocol.js";
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
  // ingestion_failed dead-letters locally after MAX_CONSECUTIVE_INGESTION_FAILED
  // attempts. Previously `deadLetteredIds` blocked persistCursorIfCaughtUp, so the
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
  await runWithMockedNow(async ({ advance }) => {
    first.start();
    await flushAgentSessionSync();
    // Drive the remaining attempts past the per-session backoff until it
    // dead-letters at the threshold.
    for (let i = 1; i < MAX_CONSECUTIVE_INGESTION_FAILED; i += 1) {
      advance(INGESTION_FAILED_BACKOFF_MS + 1);
      first.refresh();
      await flushAgentSessionSync();
    }
  });
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
  restarted.start();
  await flushAgentSessionSync();
  // Revisited last: only after the (empty) queues drain does the idle-cycle
  // promotion enqueue the set-aside dead-letter for a retry.
  restarted.refresh();
  await flushAgentSessionSync();
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
