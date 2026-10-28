/**
 * @file agent-ended-at-heal-delivery.test.ts
 * @description ISS-7069: how the correction is DELIVERED and EXECUTED.
 *
 * Sibling of `agent-ended-at-heal.test.ts` (what the repair computes) and
 * `agent-ended-at-heal-scope.test.ts` (which rows it declines to judge). A right
 * value that never leaves the device is not a repair: the wrong values are
 * ALREADY exported to cloud, so this file owns the path out — the session bump,
 * the sync payload, the boot wiring that runs the pass at all, and the chunking,
 * failure isolation, and discovery→write race the pass runs under.
 */
import assert from "node:assert/strict";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { test } from "vitest";
import { healSweptAgentEndedAt } from "../src/main/database/agent-ended-at-heal.js";
import { startBootMaintenance } from "../src/main/database/boot-maintenance.js";
import { DESKTOP_AGENT_STATUS } from "../src/main/database/db-constants.js";
import { chunkWatermark } from "../src/main/database/session-sync-watermark.js";
import { createSqliteSessionSyncSource } from "../src/main/database/sync-source.js";
import {
  AGENT_STARTED_AT,
  BYTE_WISE_ENDED_AT,
  CHRONOLOGICAL_ENDED_AT,
  FAILED_CHUNK_LOG_RE,
  failWriteOnCall,
  mutateBeforeWrite,
  noopLog,
  OLD_UPDATED_AT,
  RETRY_NEXT_BOOT_LOG_RE,
  seedMixedEncodingEvents,
  seedSweptRun,
  seedSweptSoloAgents,
} from "./agent-ended-at-heal-fixtures.js";
import { emptyAttributionCache } from "./attribution-test-helpers.js";
import { openTestPrisma } from "./prisma-test-utils.js";
import {
  getAgent,
  getSession,
  NOW,
  seedAgent,
  seedSession,
} from "./session-sweep-fixtures.js";

/*
 * The half that makes this a data-integrity repair rather than a local one: the
 * wrong values are ALREADY exported, so the corrected value has to reach the
 * cloud. `sync-source.ts` maps `agents.ended_at` onto the wire `agents[].endedAt`,
 * and the sync cursor selects on `sessions.updated_at` ONLY — so without the
 * session bump the corrected row is never re-hydrated and the cloud stays stale.
 */
test("ISS-7069: the corrected values reach the cloud sync payload, for main AND subagent", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedSweptRun(store);
    await healSweptAgentEndedAt(prisma, NOW, noopLog);

    // The re-queue that makes the payload reachable at all.
    assert.equal(
      (await getSession(store, "run"))?.updated_at,
      chunkWatermark(NOW, 0),
      "the owning session is re-queued past the durable sync cursor"
    );

    const syncSource = createSqliteSessionSyncSource(prisma);
    const [session] = await syncSource.loadSyncedSessions(
      ["run"],
      emptyAttributionCache()
    );
    assert.ok(session, "the healed session hydrated for sync");
    for (const externalAgentId of ["main-agent", "sub-agent"]) {
      const synced = session.agents?.find(
        (row) => row.externalAgentId === externalAgentId
      );
      assert.ok(synced, `${externalAgentId} is in the payload`);
      assert.equal(
        synced.endedAt,
        CHRONOLOGICAL_ENDED_AT,
        `the cloud receives ${externalAgentId}'s chronological end`
      );
      assert.notEqual(synced.endedAt, BYTE_WISE_ENDED_AT);
    }
  } finally {
    await close();
  }
});

/*
 * The active-session carve-out, inherited from `healSessionLastActivityAtFloor`:
 * `updated_at < cutoff` is the ONLY predicate the orphan sweep applies to an
 * active row, so bumping one keeps a genuinely-stale session alive forever. A
 * finished subagent inside a still-running run makes the case reachable, so the
 * agent is still corrected — only the session bump is withheld.
 */
test("ISS-7069: a terminal agent in an ACTIVE session is corrected without bumping the session", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedSession(
      store,
      "run",
      SESSION_STATUS.ACTIVE,
      OLD_UPDATED_AT,
      OLD_UPDATED_AT,
      AGENT_STARTED_AT
    );
    await seedAgent(
      store,
      "sub-agent",
      "run",
      DESKTOP_AGENT_STATUS.COMPLETED,
      AGENT_STARTED_AT,
      "general-purpose",
      BYTE_WISE_ENDED_AT
    );
    await seedMixedEncodingEvents(store, "run", "sub-agent");

    assert.equal((await healSweptAgentEndedAt(prisma, NOW, noopLog)).healed, 1);
    assert.equal(
      (await getAgent(store, "sub-agent"))?.ended_at,
      CHRONOLOGICAL_ENDED_AT
    );
    assert.equal(
      (await getSession(store, "run"))?.updated_at,
      OLD_UPDATED_AT,
      "an active session is not lifted out of the orphan sweep's cutoff predicate"
    );
  } finally {
    await close();
  }
});

/*
 * Production wiring. The pass is only a repair if the boot chain actually runs
 * it — deleting the `.then(() => healSweptAgentEndedAt(...))` step from
 * `boot-maintenance.ts` leaves every other test green and ships nothing.
 */
test("ISS-7069: the boot-maintenance chain runs the repair", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedSweptRun(store);

    await startBootMaintenance(prisma, noopLog);

    assert.equal(
      (await getAgent(store, "main-agent"))?.ended_at,
      CHRONOLOGICAL_ENDED_AT,
      "the background boot chain repaired the main agent"
    );
    assert.equal(
      (await getAgent(store, "sub-agent"))?.ended_at,
      CHRONOLOGICAL_ENDED_AT,
      "the background boot chain repaired the subagent"
    );
  } finally {
    await close();
  }
});

/*
 * Chunking. Two chunks of one agent each must both land, and each must carry its
 * OWN strictly-increasing watermark — collapsing a multi-chunk heal onto one top
 * `updated_at` is the FEA-3485 sync-cursor failure.
 */
test("ISS-7069: a multi-chunk heal lands every chunk on its own sync watermark", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedSweptSoloAgents(store, ["a", "b"]);

    const result = await healSweptAgentEndedAt(prisma, NOW, noopLog, 1);
    assert.deepEqual(result, {
      healed: 2,
      failedChunks: 0,
      unreadable: 0,
      legacy: 0,
    });

    const watermarks = new Set<string>();
    for (const suffix of ["a", "b"]) {
      assert.equal(
        (await getAgent(store, `worker-${suffix}`))?.ended_at,
        CHRONOLOGICAL_ENDED_AT
      );
      const updatedAt = (await getSession(store, `run-${suffix}`))?.updated_at;
      assert.ok(updatedAt && updatedAt !== OLD_UPDATED_AT);
      watermarks.add(updatedAt);
    }
    assert.equal(
      watermarks.size,
      2,
      "each chunk gets its own watermark, not one collapsed top value"
    );
  } finally {
    await close();
  }
});

/*
 * Per-chunk error ISOLATION. Every other test asserts `failedChunks: 0`, which
 * never exercises the catch at all — a heal that aborted the whole pass on the
 * first bad chunk would pass all of them. One chunk is forced to reject; the
 * other must still land, and the failure must be counted and logged for the
 * next-boot retry rather than swallowed.
 */
test("ISS-7069: a failing chunk is counted and logged, and the other chunk still heals", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedSweptSoloAgents(store, ["a", "b"]);

    const logs: string[] = [];
    const result = await healSweptAgentEndedAt(
      failWriteOnCall(prisma, 1),
      NOW,
      (m) => logs.push(m),
      1
    );
    assert.deepEqual(result, {
      healed: 1,
      failedChunks: 1,
      unreadable: 0,
      legacy: 0,
    });
    assert.equal(logs.length, 2);
    assert.match(logs[0] ?? "", FAILED_CHUNK_LOG_RE);
    assert.match(logs[1] ?? "", RETRY_NEXT_BOOT_LOG_RE);

    // Order out of the discovery query is unspecified, so assert the PARTITION
    // rather than which id landed in which chunk.
    const endedAts = [
      (await getAgent(store, "worker-a"))?.ended_at,
      (await getAgent(store, "worker-b"))?.ended_at,
    ];
    assert.equal(
      endedAts.filter((v) => v === CHRONOLOGICAL_ENDED_AT).length,
      1,
      "exactly one agent healed"
    );
    assert.equal(
      endedAts.filter((v) => v === BYTE_WISE_ENDED_AT).length,
      1,
      "the failed chunk's agent is untouched, awaiting the next boot"
    );
  } finally {
    await close();
  }
});

/*
 * The discovery→write window, which is REAL: discovery runs on the reader pool,
 * outside the write queue that serializes the repair transaction. `ended_at` has
 * a second legitimate writer — `advanceTerminalEndedAt` advances the main agent
 * to the session's PARSED end, a value deliberately not derived from the event
 * fold. If this pass wrote blind on the id list it would clobber that fresher
 * evidence with an older fold, and the damage would NOT be self-correcting:
 * stored would then equal the fold, so no later boot would ever revisit it.
 */
test("ISS-7069: a row that stops qualifying between discovery and write is skipped, not clobbered", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedSweptSoloAgents(store, ["a"]);
    // Strictly later than the chronological fold, as a concurrent parser-driven
    // advance would be.
    const parserEnd = "2026-06-22T18:00:00.000Z";

    const result = await healSweptAgentEndedAt(
      mutateBeforeWrite(prisma, async () => {
        await store.query("UPDATE agents SET ended_at = $1 WHERE id = $2", [
          parserEnd,
          "worker-a",
        ]);
      }),
      NOW,
      noopLog
    );

    assert.equal(
      result.healed,
      0,
      "the no-longer-qualifying row is not written"
    );
    assert.equal(
      (await getAgent(store, "worker-a"))?.ended_at,
      parserEnd,
      "the fresher parser evidence survives — it is not overwritten by the fold"
    );
    assert.equal(
      (await getSession(store, "run-a"))?.updated_at,
      OLD_UPDATED_AT,
      "and nothing is re-queued to the cloud for a correction that never happened"
    );
  } finally {
    await close();
  }
});

/*
 * The bump set has to follow the rows that were actually WRITTEN, not the rows
 * that were discovered. Two candidates share ONE chunk and only one of them
 * still qualifies at write time; bumping both would re-queue a session to the
 * cloud for a correction that never happened, and hand the retention purge an
 * outbox row to defer on.
 */
test("ISS-7069: only the sessions whose agents were written are re-queued", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedSweptSoloAgents(store, ["a", "b"]);
    const parserEnd = "2026-06-22T18:00:00.000Z";

    const result = await healSweptAgentEndedAt(
      mutateBeforeWrite(prisma, async () => {
        await store.query("UPDATE agents SET ended_at = $1 WHERE id = $2", [
          parserEnd,
          "worker-a",
        ]);
      }),
      NOW,
      noopLog
    );

    assert.equal(result.healed, 1, "only the still-qualifying row is written");
    assert.equal((await getAgent(store, "worker-a"))?.ended_at, parserEnd);
    assert.equal(
      (await getAgent(store, "worker-b"))?.ended_at,
      CHRONOLOGICAL_ENDED_AT
    );

    assert.equal(
      (await getSession(store, "run-a"))?.updated_at,
      OLD_UPDATED_AT,
      "the SKIPPED row's session is not re-queued by its chunk-mate's write"
    );
    assert.equal(
      (await getSession(store, "run-b"))?.updated_at,
      chunkWatermark(NOW, 0),
      "the written row's session still is"
    );
  } finally {
    await close();
  }
});
