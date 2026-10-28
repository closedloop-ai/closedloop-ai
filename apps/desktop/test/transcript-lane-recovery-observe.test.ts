/**
 * @file transcript-lane-recovery-observe.test.ts
 * @description ISS-9884: what an observation that saw NO file change does to a
 * row the lane give-up paused. A compute-target switch rewrites the cursor, and
 * that alone must never re-queue an attributed `environment_unavailable` pause
 * under the observing target, while every other dead row keeps the ISS-4815
 * per-target re-arm. Against a real libSQL database, so the store reads the
 * row's actual cursor, status and terminal-skip pair.
 */
import assert from "node:assert/strict";
import { TranscriptSkipReason } from "@repo/api/src/types/transcript-skip-reason-constants";
import { test } from "vitest";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import {
  createTranscriptSyncStore,
  type TranscriptSyncStore,
} from "../src/main/database/transcript-sync-store.js";
import { redactedArchiveCursorTargetId } from "../src/main/transcript-sync/transcript-sync-types.js";
import { TranscriptSyncStatus } from "../src/shared/transcript-sync-status-contract.js";
import { observeInput, T0 } from "./helpers/transcript-sync-store-fixtures.js";
import { openTestPrisma } from "./prisma-test-utils.js";

const T1 = "2026-07-09T01:00:00.000Z";
const CT_1 = "ct-1";
const CT_2 = "ct-2";

test("ISS-9884: a compute-target switch alone leaves a paused row dead with its pause intact, so the new target can neither list nor claim it", async () => {
  await withPrismaStore(async (store, prisma) => {
    await deadAfterCt1Window(
      store,
      "sess-paused",
      TranscriptSkipReason.EnvironmentUnavailable,
      CT_1
    );
    assert.deepEqual(
      await terminalColumns(prisma, "sess-paused"),
      {
        status: TranscriptSyncStatus.Dead,
        terminalSkipReason: TranscriptSkipReason.EnvironmentUnavailable,
        terminalSkipComputeTargetId: CT_1,
        syncedComputeTargetId: redactedArchiveCursorTargetId(CT_1),
      },
      "precondition: the dead settle leaves ct-1's cursor on the paused row"
    );

    // The same file, same size and mtime, observed once ct-2 is signed in.
    const observed = await store.observe(
      observeInput({
        externalSessionId: "sess-paused",
        currentComputeTargetId: CT_2,
        now: T1,
      })
    );

    assert.deepEqual(
      await store.listReady(T1, 10, CT_2),
      [],
      "ct-1's pause is not ct-2's to upload"
    );
    assert.equal(
      await store.markUploading("sess-paused", "main", T1, CT_2),
      false,
      "and ct-2's claim refuses it"
    );
    assert.equal(observed.status, TranscriptSyncStatus.Dead);
    assert.deepEqual(
      await terminalColumns(prisma, "sess-paused"),
      {
        status: TranscriptSyncStatus.Dead,
        terminalSkipReason: TranscriptSkipReason.EnvironmentUnavailable,
        terminalSkipComputeTargetId: CT_1,
        syncedComputeTargetId: redactedArchiveCursorTargetId(CT_1),
      },
      "the pause keeps its reason and target"
    );
  });
});

test("ISS-9884: a paused row a target switch left dead is still revived by its own target's door", async () => {
  await withPrismaStore(async (store) => {
    await deadAfterCt1Window(
      store,
      "sess-paused",
      TranscriptSkipReason.EnvironmentUnavailable,
      CT_1
    );
    await store.observe(
      observeInput({
        externalSessionId: "sess-paused",
        currentComputeTargetId: CT_2,
        now: T1,
      })
    );

    assert.equal(
      await store.reviveEnvironmentUnavailableDeadLetters(T1, CT_2),
      0,
      "ct-2's door is not the pause's"
    );
    assert.equal(
      await store.reviveEnvironmentUnavailableDeadLetters(T1, CT_1),
      1,
      "ct-1's door still finds it"
    );
    assert.deepEqual(
      (await store.listReady(T1, 10, CT_1)).map((row) => row.externalSessionId),
      ["sess-paused"],
      "and it is ready under ct-1"
    );
    assert.deepEqual(await store.listReady(T1, 10, CT_2), []);
  });
});

test("ISS-9884: a cursor rewrite alone still re-arms a dead row with another reason or no recorded target", async () => {
  await withPrismaStore(async (store, prisma) => {
    const deadRows: [string, TranscriptSkipReason | null, string | null][] = [
      ["sess-exhausted", TranscriptSkipReason.RetriesExhausted, CT_1],
      ["sess-gone", TranscriptSkipReason.SourceGone, CT_1],
      ["sess-legacy", null, CT_1],
      ["sess-unattributed", TranscriptSkipReason.EnvironmentUnavailable, null],
    ];
    for (const [externalSessionId, reason, computeTargetId] of deadRows) {
      await deadAfterCt1Window(
        store,
        externalSessionId,
        reason,
        computeTargetId
      );
      assert.equal(
        (await terminalColumns(prisma, externalSessionId))?.status,
        TranscriptSyncStatus.Dead,
        `precondition: ${externalSessionId} is dead`
      );
      await store.observe(
        observeInput({
          externalSessionId,
          currentComputeTargetId: CT_2,
          now: T1,
        })
      );
    }

    for (const [externalSessionId] of deadRows) {
      assert.deepEqual(
        await terminalColumns(prisma, externalSessionId),
        {
          status: TranscriptSyncStatus.Queued,
          terminalSkipReason: null,
          terminalSkipComputeTargetId: null,
          syncedComputeTargetId: redactedArchiveCursorTargetId(CT_1),
        },
        `${externalSessionId} re-arms under the new target with its terminal cleared`
      );
    }
    assert.deepEqual(
      (await store.listReady(T1, 10, CT_2))
        .map((row) => row.externalSessionId)
        .sort(),
      deadRows.map(([externalSessionId]) => externalSessionId).sort()
    );
  });
});

async function withPrismaStore(
  run: (store: TranscriptSyncStore, prisma: DesktopPrisma) => Promise<void>
): Promise<void> {
  const { prisma, close } = await openTestPrisma();
  try {
    await run(createTranscriptSyncStore(prisma), prisma);
  } finally {
    await close();
  }
}

/**
 * One window of the file reached ct-1, then the row was acked dead — so ct-1's
 * cursor is on the row, and any later observation under another target is a
 * cursor rewrite with no file change.
 */
async function deadAfterCt1Window(
  store: TranscriptSyncStore,
  externalSessionId: string,
  terminalSkipReason: TranscriptSkipReason | null,
  terminalSkipComputeTargetId: string | null
): Promise<void> {
  await store.observe(
    observeInput({ externalSessionId, currentComputeTargetId: CT_1 })
  );
  await store.recordUploaded({
    externalSessionId,
    fileKey: "main",
    syncedByteOffset: 200,
    syncedSha256: "sha-200",
    storedEtag: "etag-200",
    syncedComputeTargetId: redactedArchiveCursorTargetId(CT_1),
    caughtUp: false,
    now: T0,
  });
  await store.markDead({
    externalSessionId,
    fileKey: "main",
    reason: "terminal",
    terminalSkipReason,
    terminalSkipComputeTargetId,
    now: T0,
  });
}

/** The row's status, terminal-skip pair and cursor target, read straight off it. */
function terminalColumns(prisma: DesktopPrisma, externalSessionId: string) {
  return prisma.client.transcriptSyncState.findUnique({
    where: {
      externalSessionId_fileKey: { externalSessionId, fileKey: "main" },
    },
    select: {
      status: true,
      terminalSkipReason: true,
      terminalSkipComputeTargetId: true,
      syncedComputeTargetId: true,
    },
  });
}
