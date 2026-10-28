/**
 * @file transcript-lane-pause-scope.test.ts
 * @description ISS-9884: a transcript revived from an `environment_unavailable`
 * pause is uploaded under no compute target but the one whose cloud acknowledged
 * the pause.
 *
 * Scoping the revival alone does not hold that: the ready read, the pass that
 * lists, and the attempt that uploads each read the live target on their own. So
 * every case here switches the target at a different point and reads the target
 * each plan was SENT under off the wire. The store, the executor and the drain
 * are the production ones over a real libSQL database; only the filesystem and
 * the HTTP client are faked, and the client records the request bodies verbatim.
 */
import assert from "node:assert/strict";
import { TranscriptSkipReason } from "@repo/api/src/types/transcript-skip-reason-constants";
import { test } from "vitest";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import {
  createTranscriptSyncStore,
  type TranscriptObserveInput,
  type TranscriptSyncStore,
} from "../src/main/database/transcript-sync-store.js";
import { TranscriptDrainQueue } from "../src/main/transcript-sync/transcript-drain-queue.js";
import {
  createTranscriptSyncExecutor,
  type TranscriptSyncExecutor,
} from "../src/main/transcript-sync/transcript-sync-executor.js";
import {
  TranscriptSyncClass,
  TranscriptSyncStatus,
} from "../src/shared/transcript-sync-status-contract.js";
import {
  fakeFsDeps,
  type RecordingClient,
  recordingClient,
} from "./helpers/transcript-sync-executor-fixtures.js";
import { observeInput } from "./helpers/transcript-sync-store-fixtures.js";
import { openTestPrisma } from "./prisma-test-utils.js";

const NOW = "2026-07-09T00:00:00.000Z";
const CT_1 = "ct-1";
const CT_2 = "ct-2";
const FILE_BYTES = 500;

test("ISS-9884: a pause revived under ct-1 is not uploaded when the target switches to ct-2 after the revival, and uploads once ct-1 is back", async () => {
  await withLane(async (lane) => {
    await seedPaused(lane.store, "sess-paused", CT_1);
    await seedQueued(lane.store, "sess-open");
    // The switch lands the moment ct-1's revival commits: after the revival and
    // before the pass's ready read.
    const revive = lane.store.reviveEnvironmentUnavailableDeadLetters;
    lane.store.reviveEnvironmentUnavailableDeadLetters = async (
      now,
      computeTargetId
    ) => {
      const revived = await revive(now, computeTargetId);
      lane.target.id = CT_2;
      return revived;
    };

    await lane.drain.drainOnce();
    lane.store.reviveEnvironmentUnavailableDeadLetters = revive;

    assert.deepEqual(
      planTargets(lane.client),
      [],
      "the pass whose target moved after its revival attempts nothing, not even the unscoped row"
    );
    assert.deepEqual(
      await pauseScope(lane.prisma, "sess-paused"),
      { status: TranscriptSyncStatus.Queued, owedTo: CT_1 },
      "revived under ct-1, and still owed to ct-1"
    );

    await lane.drain.drainOnce();

    assert.deepEqual(
      planTargets(lane.client),
      ["sess-open@ct-2"],
      "under ct-2 the unscoped row uploads, and ct-1's revived pause is not attempted"
    );
    assert.deepEqual(await pauseScope(lane.prisma, "sess-paused"), {
      status: TranscriptSyncStatus.Queued,
      owedTo: CT_1,
    });

    lane.target.id = CT_1;
    await lane.drain.drainOnce();

    assert.deepEqual(
      planTargets(lane.client),
      ["sess-open@ct-2", "sess-paused@ct-1"],
      "back under ct-1 it uploads, under ct-1"
    );
    assert.deepEqual(
      await pauseScope(lane.prisma, "sess-paused"),
      { status: TranscriptSyncStatus.Idle, owedTo: null },
      "and once caught up it is owed to no target any more"
    );
  });
});

test("ISS-9884: a target switch under an in-flight attempt re-queues a revived pause still owed to its own target", async () => {
  await withLane(
    async (lane) => {
      await seedPaused(lane.store, "sess-paused", CT_1);

      await lane.drain.drainOnce();

      assert.deepEqual(
        planTargets(lane.client),
        [],
        "the attempt claimed under ct-1 aborted before its first egress"
      );
      assert.deepEqual(
        await pauseScope(lane.prisma, "sess-paused"),
        { status: TranscriptSyncStatus.Queued, owedTo: CT_1 },
        "re-queued by the revocation, still owed to ct-1"
      );

      await lane.drain.drainOnce();

      assert.deepEqual(
        planTargets(lane.client),
        [],
        "so a pass under ct-2 does not take it"
      );

      lane.target.id = CT_1;
      await lane.drain.drainOnce();

      assert.deepEqual(planTargets(lane.client), ["sess-paused@ct-1"]);
    },
    { switchTargetOnFirstStat: CT_2 }
  );
});

test("ISS-9884: the upload claim refuses a revived pause to another target even when handed a stale fingerprint, and grants it to its own", async () => {
  await withLane(async (lane) => {
    await seedPaused(lane.store, "sess-paused", CT_1);
    assert.equal(
      await lane.store.reviveEnvironmentUnavailableDeadLetters(NOW, CT_1),
      1
    );
    const fp = await lane.store.get("sess-paused", "main");
    assert.ok(fp);

    lane.target.id = CT_2;
    const refused = await lane.executor.syncFile(fp);

    assert.equal(refused.kind, "skipped");
    assert.deepEqual(
      planTargets(lane.client),
      [],
      "nothing is sent under ct-2"
    );
    assert.deepEqual(
      await pauseScope(lane.prisma, "sess-paused"),
      { status: TranscriptSyncStatus.Queued, owedTo: CT_1 },
      "and the row is not claimed: still queued, still owed to ct-1"
    );

    lane.target.id = CT_1;
    await lane.executor.syncFile(fp);

    assert.deepEqual(planTargets(lane.client), ["sess-paused@ct-1"]);
  });
});

test("ISS-9884: a queued row with no recorded target uploads under whichever target is live", async () => {
  await withLane(async (lane) => {
    await seedQueued(lane.store, "sess-under-ct2");
    lane.target.id = CT_2;
    await lane.drain.drainOnce();

    await seedQueued(lane.store, "sess-under-ct1");
    lane.target.id = CT_1;
    await lane.drain.drainOnce();

    assert.deepEqual(planTargets(lane.client), [
      "sess-under-ct2@ct-2",
      "sess-under-ct1@ct-1",
    ]);
  });
});

test("ISS-9884: more ready rows owed to ct-1 than a batch holds do not starve ct-2's own ready work", async () => {
  await withLane(async (lane) => {
    // Live and newer than ct-2's row, so an unscoped ready read lists every
    // batch slot with them first and never reaches it.
    for (let index = 0; index < OVERFULL_BATCH; index += 1) {
      await seedPaused(lane.store, `sess-ct1-${index}`, CT_1, {
        syncClass: TranscriptSyncClass.Live,
        mtimeMs: 10_000 + index,
      });
    }
    assert.equal(
      await lane.store.reviveEnvironmentUnavailableDeadLetters(NOW, CT_1),
      OVERFULL_BATCH
    );
    await seedQueued(lane.store, "sess-ct2-work", {
      syncClass: TranscriptSyncClass.Backfill,
      mtimeMs: 1,
    });

    lane.target.id = CT_2;
    await lane.drain.drainOnce();

    assert.deepEqual(
      planTargets(lane.client),
      ["sess-ct2-work@ct-2"],
      "the first pass under ct-2 reaches its own row"
    );
  });
});

type Lane = {
  prisma: DesktopPrisma;
  store: TranscriptSyncStore;
  target: { id: string | null };
  client: RecordingClient;
  executor: TranscriptSyncExecutor;
  drain: TranscriptDrainQueue;
};

async function withLane(
  run: (lane: Lane) => Promise<void>,
  options: { switchTargetOnFirstStat?: string } = {}
): Promise<void> {
  const { prisma, close } = await openTestPrisma();
  try {
    const store = createTranscriptSyncStore(prisma);
    const target: Lane["target"] = { id: CT_1 };
    const client = recordingClient(
      { mode: "noop", syncedByteOffset: FILE_BYTES, storedEtag: "etag-1" },
      FILE_BYTES
    );
    const fs = fakeFsDeps(Buffer.alloc(FILE_BYTES, 1));
    let pendingSwitch = options.switchTargetOnFirstStat ?? null;
    const executor = createTranscriptSyncExecutor({
      store,
      client,
      getComputeTargetId: () => target.id,
      now: () => NOW,
      ...fs,
      // After the claim and before the first egress: the window the executor's
      // own egress guard exists for.
      statFile: () => {
        if (pendingSwitch !== null) {
          target.id = pendingSwitch;
          pendingSwitch = null;
        }
        return fs.statFile();
      },
    });
    const drain = new TranscriptDrainQueue({
      shouldRun: () => true,
      resolveRuntime: () => ({ store, executor }),
      getComputeTargetId: () => target.id,
      now: () => NOW,
      log: () => undefined,
      concurrency: 2,
    });
    await run({ prisma, store, target, client, executor, drain });
  } finally {
    await close();
  }
}

/** A transcript whose pause the cloud of `computeTargetId` acknowledged. */
async function seedPaused(
  store: TranscriptSyncStore,
  externalSessionId: string,
  computeTargetId: string,
  overrides: Partial<TranscriptObserveInput> = {}
): Promise<void> {
  await seedQueued(store, externalSessionId, overrides);
  await store.markDead({
    externalSessionId,
    fileKey: "main",
    reason: "transcripts bucket is not configured",
    terminalSkipReason: TranscriptSkipReason.EnvironmentUnavailable,
    terminalSkipComputeTargetId: computeTargetId,
    now: NOW,
  });
}

/** A transcript observed now: queued, due at once, owed to no target. */
async function seedQueued(
  store: TranscriptSyncStore,
  externalSessionId: string,
  overrides: Partial<TranscriptObserveInput> = {}
): Promise<void> {
  await store.observe(
    observeInput({
      externalSessionId,
      sourcePathHash: `hash-${externalSessionId}`,
      now: NOW,
      ...overrides,
    })
  );
}

/** `session@target` for every plan request, read off the body that was sent. */
function planTargets(client: RecordingClient): string[] {
  return client.planRequests.map((request) => {
    const body = request as {
      externalSessionId: string;
      computeTargetId: string;
    };
    return `${body.externalSessionId}@${body.computeTargetId}`;
  });
}

/** The row's status and the target its upload is owed to, off the row itself. */
async function pauseScope(prisma: DesktopPrisma, externalSessionId: string) {
  const row = await prisma.client.transcriptSyncState.findUnique({
    where: {
      externalSessionId_fileKey: { externalSessionId, fileKey: "main" },
    },
    select: { status: true, terminalSkipComputeTargetId: true },
  });
  return { status: row?.status, owedTo: row?.terminalSkipComputeTargetId };
}

/** More rows than one drain batch lists (the drain reads 32). */
const OVERFULL_BATCH = 40;
