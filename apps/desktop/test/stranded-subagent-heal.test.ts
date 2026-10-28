/**
 * @file stranded-subagent-heal.test.ts
 * @description ISS-7474: close subagents the PRE-ISS-6902 terminal hook left at
 * `working` on a session it had already flipped to `error`.
 *
 * ISS-6902 fixed the forward path only. Rows stranded by an earlier release are
 * reachable by NOTHING — `sweepStaleActiveSessions` selects `active` sessions so
 * it cannot see their terminal parent, `maybeReactivate` never revives an
 * `error` session, and reimport re-derives only the parser-owned subagent rows,
 * not the live-hook spawner's. Each one tells the cloud a finished subagent is
 * still working, forever.
 *
 * FIXTURE DISCIPLINE, because a heal pass is trivial to make vacuously green:
 *
 *  - Every case seeds a row in the GENUINELY WRONG state (`working` under a
 *    terminal session). A corpus with no stranded row would let a pass that
 *    heals nothing pass every assertion here.
 *  - Every negative has a POSITIVE SIBLING in the same corpus. "Leaves active
 *    sessions alone" is worthless without a stranded row proving the pass ran
 *    and did reach something.
 *  - The `ended_at` fixtures use the mixed-encoding event pair, whose TEXTUAL
 *    and CHRONOLOGICAL maxima are different rows. A single-encoding corpus is
 *    green under a byte-wise fold and proves nothing about which one is used.
 *  - Idempotency is asserted over TWO runs. One run cannot observe double-heal.
 */
import assert from "node:assert/strict";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { test } from "vitest";
import { startBootMaintenance } from "../src/main/database/boot-maintenance.js";
import { DESKTOP_AGENT_STATUS } from "../src/main/database/db-constants.js";
import { healStrandedSubagents } from "../src/main/database/stranded-subagent-heal.js";
import { createSqliteSessionSyncSource } from "../src/main/database/sync-source.js";
import {
  AGENT_STARTED_AT,
  CHRONOLOGICAL_ENDED_AT,
  failWriteOnCall,
  mutateBeforeWrite,
  noopLog,
  OLD_UPDATED_AT,
  RETRY_NEXT_BOOT_LOG_RE,
  seedMixedEncodingEvents,
} from "./agent-ended-at-heal-fixtures.js";
import { emptyAttributionCache } from "./attribution-test-helpers.js";
import { openTestPrisma } from "./prisma-test-utils.js";
import {
  getAgent,
  getSession,
  NOW,
  type Store,
  seedAgent,
  seedSession,
} from "./session-sweep-fixtures.js";

/**
 * The outcome a subagent recorded for ITSELF, an hour before this pass runs at
 * {@link NOW}. Hand-written rather than derived, so the "keeps its own value"
 * assertions cannot be satisfied by the pass simply writing `NOW`.
 */
const SELF_REPORTED_ENDED_AT = "2026-06-22T11:00:00.000Z";

const FAILED_CHUNK_LOG_RE = /stranded subagent heal failed for chunk/;

/** A terminal session plus its stranded `working` subagent — the defect shape. */
async function seedStrandedRun(
  store: Store,
  sessionId: string,
  sessionStatus: string
): Promise<void> {
  await seedSession(
    store,
    sessionId,
    sessionStatus,
    OLD_UPDATED_AT,
    OLD_UPDATED_AT,
    AGENT_STARTED_AT
  );
  await seedAgent(
    store,
    `${sessionId}-sub`,
    sessionId,
    DESKTOP_AGENT_STATUS.WORKING,
    AGENT_STARTED_AT,
    "subagent",
    null
  );
  await seedMixedEncodingEvents(store, sessionId, `${sessionId}-sub`);
}

test("ISS-7474: a subagent stranded on an `error` session is closed at `completed`", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedStrandedRun(store, "err-run", SESSION_STATUS.ERROR);

    const result = await healStrandedSubagents(prisma, NOW, noopLog);
    assert.deepEqual(result, { healed: 1, failedChunks: 0, skipped: 0 });

    const sub = await getAgent(store, "err-run-sub");
    // `completed`, NOT `error`: `matchSubagent` admits only `working` and
    // `completed` candidates, so an `error` subagent would put a late
    // `SubagentStop` outside BOTH candidate sets — a null-agent event and a
    // skipped sidecar transcript ingest (the #5553 data-loss regression).
    assert.equal(sub?.status, DESKTOP_AGENT_STATUS.COMPLETED);
  } finally {
    await close();
  }
});

test("ISS-7474: an `inactive` session's stranded subagent is closed too", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedStrandedRun(store, "done-run", SESSION_STATUS.INACTIVE);

    assert.deepEqual(await healStrandedSubagents(prisma, NOW, noopLog), {
      healed: 1,
      failedChunks: 0,
      skipped: 0,
    });
    assert.equal(
      (await getAgent(store, "done-run-sub"))?.status,
      DESKTOP_AGENT_STATUS.COMPLETED
    );
  } finally {
    await close();
  }
});

test("ISS-7474: a closed subagent's `ended_at` is its own last activity, not the pass clock", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedStrandedRun(store, "err-run", SESSION_STATUS.ERROR);

    await healStrandedSubagents(prisma, NOW, noopLog);

    const sub = await getAgent(store, "err-run-sub");
    // The CHRONOLOGICAL fold over the agent's own events. Stamping `NOW` would
    // give every healed subagent a phantom idle tail (FEA-3266); a byte-wise
    // `MAX` over this mixed-encoding pair would return the EARLIER instant
    // (ISS-6893).
    assert.equal(sub?.ended_at, CHRONOLOGICAL_ENDED_AT);
    assert.notEqual(sub?.ended_at, NOW);
  } finally {
    await close();
  }
});

test("ISS-7474: an already-terminal subagent is excluded by discovery and keeps its own `ended_at`", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    // The POSITIVE SIBLING shares this session, so the pass provably ran and
    // reached a row here — "left alone" is not "did nothing".
    await seedStrandedRun(store, "err-run", SESSION_STATUS.ERROR);
    await seedAgent(
      store,
      "self-closed-sub",
      "err-run",
      DESKTOP_AGENT_STATUS.COMPLETED,
      AGENT_STARTED_AT,
      "subagent",
      SELF_REPORTED_ENDED_AT
    );
    await seedMixedEncodingEvents(store, "err-run", "self-closed-sub");

    const result = await healStrandedSubagents(prisma, NOW, noopLog);
    // Exactly ONE row written: the stranded one. A pass that healed both would
    // report 2 here and clobber the self-reported stamp below. `skipped: 0`
    // because the self-closed row never entered the corpus at all — discovery
    // excluded it, so it is not a candidate this pass declined.
    assert.deepEqual(result, { healed: 1, failedChunks: 0, skipped: 0 });

    const selfClosed = await getAgent(store, "self-closed-sub");
    assert.equal(selfClosed?.ended_at, SELF_REPORTED_ENDED_AT);
    assert.equal(selfClosed?.status, DESKTOP_AGENT_STATUS.COMPLETED);
    // Its own value survives even though the event fold would have moved it.
    assert.notEqual(selfClosed?.ended_at, CHRONOLOGICAL_ENDED_AT);

    assert.equal(
      (await getAgent(store, "err-run-sub"))?.status,
      DESKTOP_AGENT_STATUS.COMPLETED
    );
  } finally {
    await close();
  }
});

test("ISS-7474: a stranded subagent already carrying an `ended_at` keeps that value", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedSession(
      store,
      "err-run",
      SESSION_STATUS.ERROR,
      OLD_UPDATED_AT,
      OLD_UPDATED_AT,
      AGENT_STARTED_AT
    );
    await seedAgent(
      store,
      "stamped-sub",
      "err-run",
      DESKTOP_AGENT_STATUS.WORKING,
      AGENT_STARTED_AT,
      "subagent",
      SELF_REPORTED_ENDED_AT
    );
    await seedMixedEncodingEvents(store, "err-run", "stamped-sub");

    await healStrandedSubagents(prisma, NOW, noopLog);

    const sub = await getAgent(store, "stamped-sub");
    // The status is repaired; the timestamp another writer produced is filled,
    // never overwritten.
    assert.equal(sub?.status, DESKTOP_AGENT_STATUS.COMPLETED);
    assert.equal(sub?.ended_at, SELF_REPORTED_ENDED_AT);
  } finally {
    await close();
  }
});

test("ISS-7474: a subagent on a still-ACTIVE session is left running", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedStrandedRun(store, "err-run", SESSION_STATUS.ERROR);
    await seedStrandedRun(store, "live-run", SESSION_STATUS.ACTIVE);

    const result = await healStrandedSubagents(prisma, NOW, noopLog);
    assert.deepEqual(result, { healed: 1, failedChunks: 0, skipped: 0 });

    // The healthy row, untouched...
    const live = await getAgent(store, "live-run-sub");
    assert.equal(live?.status, DESKTOP_AGENT_STATUS.WORKING);
    assert.equal(live?.ended_at, null);
    // ...and its positive sibling, proving the pass reached bad rows.
    assert.equal(
      (await getAgent(store, "err-run-sub"))?.status,
      DESKTOP_AGENT_STATUS.COMPLETED
    );
  } finally {
    await close();
  }
});

test("ISS-7474: a stranded MAIN agent is out of scope", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedStrandedRun(store, "err-run", SESSION_STATUS.ERROR);
    await seedAgent(
      store,
      "main-agent",
      "err-run",
      DESKTOP_AGENT_STATUS.WORKING,
      AGENT_STARTED_AT,
      "main",
      null
    );

    assert.deepEqual(await healStrandedSubagents(prisma, NOW, noopLog), {
      healed: 1,
      failedChunks: 0,
      skipped: 0,
    });

    // Both terminal hooks close the main agent BEFORE the rest, so it was never
    // in the ISS-6902 stranding population; closing it `completed` here would
    // also contradict the main/subagent status split `sweepStaleChunk` applies.
    assert.equal(
      (await getAgent(store, "main-agent"))?.status,
      DESKTOP_AGENT_STATUS.WORKING
    );
  } finally {
    await close();
  }
});

test("ISS-7474: the correction reaches the cloud payload without a re-enqueue", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedStrandedRun(store, "err-run", SESSION_STATUS.ERROR);

    await healStrandedSubagents(prisma, NOW, noopLog);

    // The metadata sync lane selects on `sessions.updated_at`
    // (`listUpdatedSessionCursorRows`) and never looks at `agents.updated_at`,
    // so the session bump is what makes the corrected row reachable at all.
    assert.equal((await getSession(store, "err-run"))?.updated_at, NOW);

    // ...and hydration re-reads every agent fresh, so the wire actually carries
    // the closed status instead of the `working` it has been asserting.
    const syncSource = createSqliteSessionSyncSource(prisma);
    const [session] = await syncSource.loadSyncedSessions(
      ["err-run"],
      emptyAttributionCache()
    );
    assert.ok(session, "the healed session hydrated for sync");
    const synced = session.agents?.find(
      (row) => row.externalAgentId === "err-run-sub"
    );
    assert.ok(synced, "the healed subagent is in the payload");
    assert.equal(synced.status, DESKTOP_AGENT_STATUS.COMPLETED);
    assert.equal(synced.endedAt, CHRONOLOGICAL_ENDED_AT);
  } finally {
    await close();
  }
});

/*
 * Production wiring. The pass only repairs anything if the boot chain runs it —
 * deleting the `.then(() => healStrandedSubagents(...))` step from
 * `boot-maintenance.ts` leaves every other test here green and ships nothing.
 */
test("ISS-7474: the boot-maintenance chain runs the repair", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedStrandedRun(store, "err-run", SESSION_STATUS.ERROR);

    await startBootMaintenance(prisma, noopLog);

    assert.equal(
      (await getAgent(store, "err-run-sub"))?.status,
      DESKTOP_AGENT_STATUS.COMPLETED,
      "the background boot chain closed the stranded subagent"
    );
  } finally {
    await close();
  }
});

/*
 * Per-chunk failure isolation: one failing chunk must not take the healthy tail
 * with it, and `healed` must report what was WRITTEN rather than what was
 * discovered.
 */
test("ISS-7474: a failed chunk is isolated and reported, and the rest still heal", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedStrandedRun(store, "run-a", SESSION_STATUS.ERROR);
    await seedStrandedRun(store, "run-b", SESSION_STATUS.ERROR);
    const logged: string[] = [];

    const result = await healStrandedSubagents(
      failWriteOnCall(prisma, 1),
      NOW,
      (message) => logged.push(message),
      1
    );

    assert.equal(result.failedChunks, 1);
    assert.equal(result.healed, 1, "the surviving chunk still landed");
    // A chunk that THREW is described by `failedChunks` only. Counting its rows
    // as `skipped` too would report the same candidates under two outcomes.
    assert.equal(result.skipped, 0, "a failed chunk is not double-counted");
    assert.ok(
      logged.some((line) => FAILED_CHUNK_LOG_RE.test(line)),
      "the failed chunk is reported rather than swallowed"
    );
    assert.ok(logged.some((line) => RETRY_NEXT_BOOT_LOG_RE.test(line)));
  } finally {
    await close();
  }
});

/*
 * THE SAME-SESSION MULTI-CHUNK CASE. The pass BUMPS `sessions.updated_at` as it
 * heals, and the write's session guard is evaluated per chunk. If that guard is
 * pinned to the PASS-START stamp, the first chunk's own bump makes every later
 * chunk for the same session fail it — the tail stays stranded for another boot,
 * and because no chunk ERRORED the pass reports `failedChunks: 0`, i.e. a clean
 * completion for a half-repair. One subagent per chunk is the smallest corpus
 * that can observe it; every other case here fits its whole session in chunk 0.
 */
test("ISS-7474: a terminal session with more stranded subagents than the chunk size is fully healed in ONE pass", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedSession(
      store,
      "err-run",
      SESSION_STATUS.ERROR,
      OLD_UPDATED_AT,
      OLD_UPDATED_AT,
      AGENT_STARTED_AT
    );
    const subIds = ["err-run-sub-0", "err-run-sub-1", "err-run-sub-2"];
    for (const id of subIds) {
      await seedAgent(
        store,
        id,
        "err-run",
        DESKTOP_AGENT_STATUS.WORKING,
        AGENT_STARTED_AT,
        "subagent",
        null
      );
      await seedMixedEncodingEvents(store, "err-run", id);
    }

    // chunkSize 1 → three chunks, ALL on the same session.
    const result = await healStrandedSubagents(prisma, NOW, noopLog, 1);

    for (const id of subIds) {
      assert.equal(
        (await getAgent(store, id))?.status,
        DESKTOP_AGENT_STATUS.COMPLETED,
        `${id} was closed rather than left stranded by this pass's own bump`
      );
    }
    // ...and the counters describe that, rather than reporting a clean pass over
    // a corpus it only half-repaired.
    assert.deepEqual(result, { healed: 3, failedChunks: 0, skipped: 0 });
    // Each chunk's bump is strictly FORWARD, so the session lands on the LAST
    // chunk's watermark (`chunkWatermark(NOW, 2)`), never back on the first.
    assert.equal(
      (await getSession(store, "err-run"))?.updated_at,
      "2026-06-22T12:00:00.002Z"
    );
  } finally {
    await close();
  }
});

test("ISS-7474: a session a live writer touched during the pass is held back, not stamped backwards", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedStrandedRun(store, "err-run", SESSION_STATUS.ERROR);
    // Ahead of the pass-start stamp: a bump to NOW would move this row BACKWARDS
    // and, if the durable cursor had passed the newer value, strand it forever.
    const AFTER_PASS_START = "2026-06-22T12:30:00.000Z";
    await store.query("UPDATE sessions SET updated_at = $1 WHERE id = $2", [
      AFTER_PASS_START,
      "err-run",
    ]);
    await seedStrandedRun(store, "quiet-run", SESSION_STATUS.ERROR);

    const result = await healStrandedSubagents(prisma, NOW, noopLog);
    // `skipped: 0`: discovery never admitted `err-run`, so it is not a candidate
    // this pass declined at write time.
    assert.deepEqual(result, { healed: 1, failedChunks: 0, skipped: 0 });

    assert.equal(
      (await getSession(store, "err-run"))?.updated_at,
      AFTER_PASS_START
    );
    assert.equal(
      (await getAgent(store, "err-run-sub"))?.status,
      DESKTOP_AGENT_STATUS.WORKING
    );
    // The quiescent sibling proves the pass ran rather than bailing outright.
    assert.equal(
      (await getAgent(store, "quiet-run-sub"))?.status,
      DESKTOP_AGENT_STATUS.COMPLETED
    );
  } finally {
    await close();
  }
});

/*
 * THE DISCOVERY→WRITE WINDOW. Discovery runs on `prisma.read()`, OUTSIDE the
 * write queue that serializes the repair transaction, so a row can stop
 * qualifying in between. Every case above seeds and then calls with nothing
 * mutating in between, so discovery and the write always see the same set — which
 * leaves the UPDATE's re-assertion deletable with the whole suite still green.
 * `mutateBeforeWrite` runs its mutation INSIDE that real window.
 */
test("ISS-7474: a subagent closed by a live writer inside the discovery→write window is not re-written", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedStrandedRun(store, "err-run", SESSION_STATUS.ERROR);

    const result = await healStrandedSubagents(
      mutateBeforeWrite(prisma, async () => {
        await store.query(
          "UPDATE agents SET status = $1, ended_at = $2 WHERE id = $3",
          [
            DESKTOP_AGENT_STATUS.COMPLETED,
            SELF_REPORTED_ENDED_AT,
            "err-run-sub",
          ]
        );
      }),
      NOW,
      noopLog
    );

    // The re-assertion in the UPDATE's WHERE is what makes this 0. With an
    // id-only WHERE the pass overwrites the live writer's fresher stamp, and
    // that damage is NOT self-correcting — the row is terminal afterwards, so no
    // later boot revisits it.
    // ...and the pass says so: `failedChunks: 0` alone would read as "the corpus
    // is repaired" for a corpus it wrote nothing to.
    assert.deepEqual(result, { healed: 0, failedChunks: 0, skipped: 1 });
    assert.equal(
      (await getAgent(store, "err-run-sub"))?.ended_at,
      SELF_REPORTED_ENDED_AT
    );
    // ...and the session is NOT re-queued for a correction that never happened.
    assert.equal(
      (await getSession(store, "err-run"))?.updated_at,
      OLD_UPDATED_AT
    );
  } finally {
    await close();
  }
});

/*
 * The OTHER half of the session guard, and the reason it cannot simply be
 * dropped to make the multi-chunk case above work: a GENUINE live write to
 * `sessions.updated_at` inside the discovery→write window still has to hold the
 * row back. The guard admits this pass's own bump because every chunk watermark
 * is strictly BELOW the next one; it must keep rejecting a stamp at or above the
 * watermark it is writing, or the bump would move the session backwards and
 * park the correction behind the durable sync cursor.
 */
test("ISS-7474: a session a live writer stamps forward inside the discovery→write window is held back", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedStrandedRun(store, "err-run", SESSION_STATUS.ERROR);
    const LIVE_WRITE_AT = "2026-06-22T12:30:00.000Z";

    const result = await healStrandedSubagents(
      mutateBeforeWrite(prisma, async () => {
        await store.query("UPDATE sessions SET updated_at = $1 WHERE id = $2", [
          LIVE_WRITE_AT,
          "err-run",
        ]);
      }),
      NOW,
      noopLog
    );

    assert.deepEqual(result, { healed: 0, failedChunks: 0, skipped: 1 });
    // Neither the agent nor the live writer's stamp is touched...
    assert.equal(
      (await getAgent(store, "err-run-sub"))?.status,
      DESKTOP_AGENT_STATUS.WORKING
    );
    assert.equal(
      (await getSession(store, "err-run"))?.updated_at,
      LIVE_WRITE_AT
    );
  } finally {
    await close();
  }
});

test("ISS-7474: a chunk-mate that stops qualifying does not drag its own session into the sync bump", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedStrandedRun(store, "run-a", SESSION_STATUS.ERROR);
    await seedStrandedRun(store, "run-b", SESSION_STATUS.ERROR);

    // Both discovered into ONE chunk; only `run-b` still qualifies at write time.
    const result = await healStrandedSubagents(
      mutateBeforeWrite(prisma, async () => {
        await store.query("UPDATE agents SET status = $1 WHERE id = $2", [
          DESKTOP_AGENT_STATUS.COMPLETED,
          "run-a-sub",
        ]);
      }),
      NOW,
      noopLog,
      10
    );

    // `healed` reports what was WRITTEN, never the chunk size — a confident
    // number for a row the pass deliberately skipped — and that skipped row is
    // COUNTED rather than folded into a clean-looking completion.
    assert.deepEqual(result, { healed: 1, failedChunks: 0, skipped: 1 });
    // The bump set is derived from the UPDATE's RETURNING, not from the
    // discovery chunk: re-queueing `run-a` would ask the cloud to re-fetch a
    // correction that never happened and hand the retention purge an outbox row
    // to defer on.
    assert.equal(
      (await getSession(store, "run-a"))?.updated_at,
      OLD_UPDATED_AT
    );
    assert.equal((await getSession(store, "run-b"))?.updated_at, NOW);
  } finally {
    await close();
  }
});

test("ISS-7474: the pass is idempotent — a second run writes nothing", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedStrandedRun(store, "err-run", SESSION_STATUS.ERROR);

    assert.deepEqual(await healStrandedSubagents(prisma, NOW, noopLog), {
      healed: 1,
      failedChunks: 0,
      skipped: 0,
    });
    const afterFirst = await getAgent(store, "err-run-sub");

    const SECOND_PASS = "2026-06-22T13:00:00.000Z";
    assert.deepEqual(
      await healStrandedSubagents(prisma, SECOND_PASS, noopLog),
      { healed: 0, failedChunks: 0, skipped: 0 }
    );

    // A convergent pass re-selects nothing, so neither the agent nor the
    // sync watermark moves on the second boot.
    assert.deepEqual(await getAgent(store, "err-run-sub"), afterFirst);
    assert.equal((await getSession(store, "err-run"))?.updated_at, NOW);
  } finally {
    await close();
  }
});
