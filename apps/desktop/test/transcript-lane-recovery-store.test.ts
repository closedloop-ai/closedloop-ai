/**
 * @file transcript-lane-recovery-store.test.ts
 * @description ISS-9884 (PLN-1986 §4/§5): the transcript store's lane-recovery
 * slice against a real libSQL database — the give-up stamp on its own
 * `sync_state` row, and the scope of the paused-row revival.
 */
import assert from "node:assert/strict";
import { TranscriptSkipReason } from "@repo/api/src/types/transcript-skip-reason-constants";
import { test } from "vitest";
import { splitAgentSessionSyncSourceKey } from "../src/main/agent-sync/agent-session-sync-source.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import { createTranscriptSyncStore } from "../src/main/database/transcript-sync-store.js";
import { buildTranscriptSyncSourceKey } from "../src/main/transcript-sync/transcript-lane-give-up.js";
import { redactedArchiveCursorTargetId } from "../src/main/transcript-sync/transcript-sync-types.js";
import { TranscriptSyncStatus } from "../src/shared/transcript-sync-status-contract.js";
import {
  observeInput,
  T0,
  withStore,
} from "./helpers/transcript-sync-store-fixtures.js";
import { openTestPrisma } from "./prisma-test-utils.js";

const T1 = "2026-07-09T01:00:00.000Z";
const CT_1 = "ct-1";
const CT_2 = "ct-2";

test("ISS-9884: the lane give-up stamp round-trips on its own per-target row, which no session cursor reads", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    const store = createTranscriptSyncStore(prisma);
    const sourceKey = buildTranscriptSyncSourceKey("ct-1");

    assert.equal(await store.loadLaneGiveUp(sourceKey), null);

    await store.recordLaneGiveUp(sourceKey, T0);

    assert.equal(await store.loadLaneGiveUp(sourceKey), T0);
    assert.equal(
      await store.loadLaneGiveUp(buildTranscriptSyncSourceKey("ct-2")),
      null,
      "another compute target is another row"
    );
    const row = await prisma.client.syncState.findUnique({
      where: { sourceKey },
    });
    assert.equal(
      row?.observedTopUpdatedAt,
      null,
      "the give-up mints the lane's row without inventing a cursor"
    );
    assert.equal(
      splitAgentSessionSyncSourceKey(sourceKey),
      null,
      "and its prefix is foreign to the session lane's key space"
    );

    await store.recordLaneGiveUp(sourceKey, null);

    assert.equal(await store.loadLaneGiveUp(sourceKey), null);
  } finally {
    await close();
  }
});

test("ISS-9884: the revival returns ONLY environment_unavailable dead rows to the queue, with the canonical revived reset", async () => {
  await withStore(async (store) => {
    const deadByReason: [string, TranscriptSkipReason | null][] = [
      ["sess-large", TranscriptSkipReason.TooLarge],
      ["sess-gone", TranscriptSkipReason.SourceGone],
      ["sess-exhausted", TranscriptSkipReason.RetriesExhausted],
      ["sess-legacy", null],
    ];
    for (const [externalSessionId, reason] of deadByReason) {
      await store.observe(observeInput({ externalSessionId }));
      await store.markDead({
        externalSessionId,
        fileKey: "main",
        reason: "terminal",
        terminalSkipReason: reason,
        terminalSkipComputeTargetId: CT_1,
        now: T0,
      });
    }
    await store.observe(observeInput({ externalSessionId: "sess-paused" }));
    await store.recordFailure({
      externalSessionId: "sess-paused",
      fileKey: "main",
      retryCount: 3,
      missingSourceCount: 0,
      dead: true,
      nextAttemptAt: null,
      lastError: "transcripts bucket is not configured",
      laneStalledSince: null,
      terminalSkipReason: TranscriptSkipReason.EnvironmentUnavailable,
      terminalSkipComputeTargetId: CT_1,
      now: T0,
    });
    await store.observe(observeInput({ externalSessionId: "sess-retrying" }));
    await store.recordFailure({
      externalSessionId: "sess-retrying",
      fileKey: "main",
      retryCount: 0,
      missingSourceCount: 0,
      dead: false,
      nextAttemptAt: T1,
      lastError: "upstream unavailable",
      laneStalledSince: T0,
      terminalSkipReason: null,
      terminalSkipComputeTargetId: null,
      now: T0,
    });

    assert.equal(
      await store.reviveEnvironmentUnavailableDeadLetters(T1, CT_1),
      1
    );

    const revived = await store.get("sess-paused", "main");
    assert.equal(revived?.status, TranscriptSyncStatus.Queued);
    assert.equal(revived?.retryCount, 0);
    assert.equal(revived?.lastError, null);
    assert.equal(revived?.nextAttemptAt, null);
    const states = await store.listMainBlobStates([
      "sess-paused",
      ...deadByReason.map(([externalSessionId]) => externalSessionId),
    ]);
    const reasonById = new Map(
      states.map((state) => [state.externalSessionId, state])
    );
    assert.equal(
      reasonById.get("sess-paused")?.terminalSkipReason,
      null,
      "a revived row no longer carries the reason it was paused for"
    );
    for (const [externalSessionId, reason] of deadByReason) {
      assert.equal(
        reasonById.get(externalSessionId)?.status,
        TranscriptSyncStatus.Dead,
        `${externalSessionId} (${reason}) is not the environment's to revive`
      );
      assert.equal(
        reasonById.get(externalSessionId)?.terminalSkipReason,
        reason
      );
    }
    assert.equal(
      (await store.get("sess-retrying", "main"))?.status,
      TranscriptSyncStatus.Failed,
      "a row still on the ladder is left to its own schedule"
    );
    assert.equal(
      await store.reviveEnvironmentUnavailableDeadLetters(T1, CT_1),
      0,
      "and a second revival finds nothing"
    );
  });
});

test("ISS-9884: the revival is scoped to the compute target whose cloud acknowledged the pause — never another target's row, never an unattributed one", async () => {
  await withStore(async (store) => {
    // Both writers of a paused row: the drain's dead-letter arm, and the
    // executor's terminal-skip settle.
    await store.observe(observeInput({ externalSessionId: "sess-ct1" }));
    await store.recordFailure({
      externalSessionId: "sess-ct1",
      fileKey: "main",
      retryCount: 0,
      missingSourceCount: 0,
      dead: true,
      nextAttemptAt: null,
      lastError: "transcripts bucket is not configured",
      laneStalledSince: null,
      terminalSkipReason: TranscriptSkipReason.EnvironmentUnavailable,
      terminalSkipComputeTargetId: CT_1,
      now: T0,
    });
    const pausedByMarkDead = [
      ["sess-ct2", CT_2],
      ["sess-unattributed", null],
    ] as const;
    for (const [externalSessionId, computeTargetId] of pausedByMarkDead) {
      await store.observe(observeInput({ externalSessionId }));
      await store.markDead({
        externalSessionId,
        fileKey: "main",
        reason: "paused",
        terminalSkipReason: TranscriptSkipReason.EnvironmentUnavailable,
        terminalSkipComputeTargetId: computeTargetId,
        now: T0,
      });
    }

    assert.equal(
      await store.reviveEnvironmentUnavailableDeadLetters(T1, CT_2),
      1,
      "a door under ct-2 revives ct-2's pause and nothing else"
    );
    assert.equal(
      (await store.get("sess-ct2", "main"))?.status,
      TranscriptSyncStatus.Queued
    );
    assert.equal(
      (await store.get("sess-ct1", "main"))?.status,
      TranscriptSyncStatus.Dead,
      "ct-1's paused transcript is not ct-2's to upload"
    );

    assert.equal(
      await store.reviveEnvironmentUnavailableDeadLetters(T1, CT_1),
      1,
      "and ct-1's own door revives it"
    );
    assert.equal(
      (await store.get("sess-ct1", "main"))?.status,
      TranscriptSyncStatus.Queued
    );
    assert.equal(
      (await store.get("sess-unattributed", "main"))?.status,
      TranscriptSyncStatus.Dead,
      "a pause that recorded no target is no target's to revive"
    );
  });
});

test("ISS-9884: the revival leaves a re-queued row and an in-flight upload alone, though both still carry the pause's reason and target", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    const store = createTranscriptSyncStore(prisma);
    const ids = ["sess-requeued", "sess-uploading"];
    for (const externalSessionId of ids) {
      await store.observe(observeInput({ externalSessionId }));
      await store.markDead({
        externalSessionId,
        fileKey: "main",
        reason: "paused",
        terminalSkipReason: TranscriptSkipReason.EnvironmentUnavailable,
        terminalSkipComputeTargetId: CT_1,
        now: T0,
      });
      // The file grew, and observe re-queues the dead row.
      await store.observe(
        observeInput({ externalSessionId, size: 900, mtimeMs: 2000, now: T1 })
      );
    }
    await store.markUploading("sess-uploading", "main", T1, CT_1);
    // A re-queue ends the pause it recorded, so the pause's columns are put back
    // by hand: a persisted row is a trust boundary, and what this pins is that
    // the revival reads the STATUS, not the reason and target alone.
    await prisma.write((client) =>
      client.transcriptSyncState.updateMany({
        where: { externalSessionId: { in: ids } },
        data: {
          terminalSkipReason: TranscriptSkipReason.EnvironmentUnavailable,
          terminalSkipComputeTargetId: CT_1,
        },
      })
    );

    const before = await revivalColumns(prisma, ids);
    assert.deepEqual(
      before.map(
        ({ status, terminalSkipReason, terminalSkipComputeTargetId }) => ({
          status,
          terminalSkipReason,
          terminalSkipComputeTargetId,
        })
      ),
      [
        {
          status: TranscriptSyncStatus.Queued,
          terminalSkipReason: TranscriptSkipReason.EnvironmentUnavailable,
          terminalSkipComputeTargetId: CT_1,
        },
        {
          status: TranscriptSyncStatus.Uploading,
          terminalSkipReason: TranscriptSkipReason.EnvironmentUnavailable,
          terminalSkipComputeTargetId: CT_1,
        },
      ],
      "precondition: only the status tells these rows from a paused one"
    );

    assert.equal(
      await store.reviveEnvironmentUnavailableDeadLetters(T1, CT_1),
      0
    );
    assert.deepEqual(
      await revivalColumns(prisma, ids),
      before,
      "neither the queued row nor the upload in flight is reset, and the upload keeps its lease"
    );
  } finally {
    await close();
  }
});

test("ISS-9884: a file change re-queues a paused row with its pause cleared, so the new content is no target's to withhold", async () => {
  await withStore(async (store) => {
    await store.observe(observeInput({ externalSessionId: "sess-grew" }));
    await store.markDead({
      externalSessionId: "sess-grew",
      fileKey: "main",
      reason: "paused",
      terminalSkipReason: TranscriptSkipReason.EnvironmentUnavailable,
      terminalSkipComputeTargetId: CT_1,
      now: T0,
    });

    await store.observe(
      observeInput({
        externalSessionId: "sess-grew",
        size: 900,
        mtimeMs: 2000,
        currentComputeTargetId: CT_2,
        now: T1,
      })
    );

    assert.deepEqual(
      (await store.listReady(T1, 10, CT_2)).map((row) => row.externalSessionId),
      ["sess-grew"],
      "the grown transcript is ready under the target that observed it"
    );
  });
});

test("ISS-9884: a compute-target rewrite alone re-queues a revived pause still owed to its own target", async () => {
  await withStore(async (store) => {
    await store.observe(observeInput({ externalSessionId: "sess-owed" }));
    // Part of it reached ct-1 before the outage, so ct-1's cursor is on the row.
    await store.recordUploaded({
      externalSessionId: "sess-owed",
      fileKey: "main",
      syncedByteOffset: 200,
      syncedSha256: "sha-200",
      storedEtag: "etag-200",
      syncedComputeTargetId: redactedArchiveCursorTargetId(CT_1),
      caughtUp: false,
      now: T0,
    });
    await store.markDead({
      externalSessionId: "sess-owed",
      fileKey: "main",
      reason: "paused",
      terminalSkipReason: TranscriptSkipReason.EnvironmentUnavailable,
      terminalSkipComputeTargetId: CT_1,
      now: T0,
    });
    assert.equal(
      await store.reviveEnvironmentUnavailableDeadLetters(T1, CT_1),
      1
    );

    // The same file, observed under ct-2: only the cursor's target differs.
    await store.observe(
      observeInput({
        externalSessionId: "sess-owed",
        currentComputeTargetId: CT_2,
        now: T1,
      })
    );

    assert.deepEqual(
      await store.listReady(T1, 10, CT_2),
      [],
      "ct-2's switch does not make ct-1's revived pause ct-2's to upload"
    );
    assert.deepEqual(
      (await store.listReady(T1, 10, CT_1)).map((row) => row.externalSessionId),
      ["sess-owed"],
      "it is still ready under ct-1"
    );
  });
});

test("ISS-9884: a retryable failure and a partial window leave a revived pause owed to its own target", async () => {
  await withStore(async (store) => {
    for (const externalSessionId of ["sess-retrying", "sess-partial"]) {
      await store.observe(observeInput({ externalSessionId }));
      await store.markDead({
        externalSessionId,
        fileKey: "main",
        reason: "paused",
        terminalSkipReason: TranscriptSkipReason.EnvironmentUnavailable,
        terminalSkipComputeTargetId: CT_1,
        now: T0,
      });
    }
    assert.equal(
      await store.reviveEnvironmentUnavailableDeadLetters(T0, CT_1),
      2
    );

    // Neither settle ends what the row is owed: one retries, one has more to
    // send. The failure passes a null target, as every non-dead failure does.
    await store.recordFailure({
      externalSessionId: "sess-retrying",
      fileKey: "main",
      retryCount: 0,
      missingSourceCount: 0,
      dead: false,
      nextAttemptAt: null,
      lastError: "upstream unavailable",
      laneStalledSince: T0,
      terminalSkipReason: null,
      terminalSkipComputeTargetId: null,
      now: T1,
    });
    await store.recordUploaded({
      externalSessionId: "sess-partial",
      fileKey: "main",
      syncedByteOffset: 200,
      syncedSha256: "sha-200",
      storedEtag: "etag-200",
      syncedComputeTargetId: redactedArchiveCursorTargetId(CT_1),
      caughtUp: false,
      now: T1,
    });

    assert.deepEqual(
      await store.listReady(T1, 10, CT_2),
      [],
      "neither is ct-2's to upload"
    );
    assert.deepEqual(
      (await store.listReady(T1, 10, CT_1))
        .map((row) => row.externalSessionId)
        .sort(),
      ["sess-partial", "sess-retrying"],
      "both are still ready under ct-1"
    );
  });
});

/** What a revival would reset, read straight off the rows. */
function revivalColumns(prisma: DesktopPrisma, externalSessionIds: string[]) {
  return prisma.client.transcriptSyncState.findMany({
    where: { externalSessionId: { in: externalSessionIds } },
    orderBy: { externalSessionId: "asc" },
    select: {
      status: true,
      terminalSkipReason: true,
      terminalSkipComputeTargetId: true,
      uploadingSince: true,
      retryCount: true,
      updatedAt: true,
    },
  });
}
