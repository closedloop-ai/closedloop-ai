/**
 * @file agent-session-sync-data-sync-level-stamp.test.ts
 * @description ISS-7516 — the machine's data-sync level must reach the WIRE,
 * not merely exist in settings.
 *
 * The whole ticket depends on this one hop. Everything downstream — the ingest
 * schema, the column, the served field, the transcript panel's copy — is
 * unreachable if the batch never carries the level, and nothing downstream can
 * tell "this machine is on full" from "this build never told us", because both
 * arrive as an absent field. That is a silent, permanent failure, so it is
 * asserted on the CAPTURED BATCH rather than on the options bag.
 *
 * Drives the real `AgentSessionSyncService` through `sendBatch`, the same way
 * `sync-service-opencode-upload-inclusion.test.ts` does. A regression that
 * dropped the stamp from `buildBatch` empties the captured value here.
 */
import assert from "node:assert/strict";
import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { test } from "vitest";
import type { AgentSessionSyncBatch } from "../src/main/agent-sync/agent-session-sync-contract.js";
import { AgentSessionSyncService } from "../src/main/agent-sync/agent-session-sync-service.js";
import {
  flushAgentSessionSync,
  makeOversizedSession,
  settleSelfContinuedDrain,
} from "./agent-session-sync-service-fixtures.js";
import { FakeSyncSource, makeSyncedSession } from "./fake-sync-source.js";

const COMPUTE_TARGET = "compute-target-iss7516";

/**
 * Drive the real service and return every batch that crossed `sendBatch`.
 *
 * `getDataSyncLevel` is passed through verbatim — including `undefined`, which
 * is how a caller that does not wire the option at all behaves.
 */
async function captureBatches(
  getDataSyncLevel?: () => DataSyncLevel
): Promise<AgentSessionSyncBatch[]> {
  const source = new FakeSyncSource([
    makeSyncedSession("s-iss7516", "2026-08-22T13:00:00.000Z"),
  ]);
  const batches: AgentSessionSyncBatch[] = [];
  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => source,
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    ...(getDataSyncLevel === undefined ? {} : { getDataSyncLevel }),
    sendBatch: (batch) => {
      batches.push(batch);
      return Promise.resolve({ accepted: true as const });
    },
  });
  service.start();
  try {
    await settleSelfContinuedDrain(service);
  } finally {
    service.stop();
  }
  return batches;
}

test("ISS-7516: a transcript-excluding level is stamped on the uploaded batch", async () => {
  const batches = await captureBatches(() => DataSyncLevel.Metadata);

  assert.ok(batches.length > 0, "no batch was uploaded; the corpus is empty");
  assert.equal(
    batches[0].dataSyncLevel,
    DataSyncLevel.Metadata,
    "the batch must carry the level, or the cloud cannot tell consent from lag"
  );
});

test("ISS-7516: the stamp reports the real level rather than a constant", async () => {
  // POSITIVE SIBLING for the case above. Without it, `dataSyncLevel: "metadata"`
  // hardcoded into `buildBatch` would pass — and would label every full-level
  // machine's sessions as transcript-excluding, suppressing real upload
  // progress for everyone.
  const batches = await captureBatches(() => DataSyncLevel.Full);

  assert.equal(batches[0].dataSyncLevel, DataSyncLevel.Full);
});

test("ISS-7516: a caller that supplies no level sends no level", async () => {
  // The absent case, at the producer end. The field must be OMITTED, not sent
  // as `null` — the ingest schema takes an optional enum, and a `null` would be
  // rejected, failing the whole batch for every session in it.
  const batches = await captureBatches();

  assert.equal(batches[0].dataSyncLevel, undefined);
  assert.ok(
    !Object.hasOwn(batches[0], "dataSyncLevel"),
    "an absent level must omit the key, never serialize it as null"
  );
});

test("ISS-7516 (review cid 3840055932): EVERY chunk of a drained tail carries the level", async () => {
  // An oversized session is split into byte-bounded chunks and drained one per
  // tick. Chunk 0 goes out via the fresh-drain `buildBatch`, which stamps the
  // level; the TAIL chunks are rebuilt by `resolvePendingChunkTransition`, which
  // did not — the identical omission, on the identical path, as the
  // `wantsAcceptedSessionIds` bug that function's own comment documents.
  //
  // It is not cosmetic. The server's write is omit-if-absent, so with a stamped
  // chunk 0 and unstamped tails, whether `session_detail.data_sync_level` ends up
  // set depends on which chunk happens to land last — and during a deploy skew
  // (chunk 0 to an old server, the tail to the upgraded one) the row stays NULL
  // even though this desktop did report a level. NULL is then read as "older
  // client, no evidence", so the panel goes on telling the reader a transcript is
  // still coming that was never queued.
  //
  // COUNTERFACTUAL: drop the `dataSyncLevel` spread from
  // `resolvePendingChunkTransition` and every chunk at index >= 1 reports
  // `undefined` here.
  const source = new FakeSyncSource([
    makeOversizedSession("oversized-iss7516"),
  ]);
  const batches: AgentSessionSyncBatch[] = [];
  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => source,
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    getDataSyncLevel: () => DataSyncLevel.Metadata,
    sendBatch: (batch) => {
      batches.push(batch);
      return Promise.resolve({
        accepted: true as const,
        acceptedSessionIds: batch.sessions.map((row) => row.externalSessionId),
      });
    },
  });
  service.start();
  try {
    for (let tick = 0; tick < 6; tick++) {
      await flushAgentSessionSync();
      service.refresh();
    }
  } finally {
    service.stop();
  }

  // Anti-vacuity: a single-batch drain would satisfy the loop below without ever
  // reaching the rebuilt-tail path this test exists for.
  assert.ok(
    batches.length > 1,
    `expected the oversized session to chunk into more than one batch, saw ${batches.length}`
  );
  for (const [index, batch] of batches.entries()) {
    assert.equal(
      batch.dataSyncLevel,
      DataSyncLevel.Metadata,
      `chunk ${index} lost the level; only chunk 0 goes through buildBatch`
    );
  }
});

test("ISS-7775 (review: codex P1): a level change during prep defers the batch instead of posting it", async () => {
  // The level is captured at the top of the pass and the payload is sanitized
  // under it across the hydration and worker-prep awaits. `applyDataSyncLevel`
  // refreshes rather than cancelling an active pass, so without a pre-send
  // re-read a user who picked Metadata mid-pass still had THIS batch's turn text
  // posted — under a card that says it stays local.
  //
  // The stub reports Full until the pre-send read, then Metadata: exactly the
  // race, with no timing dependence. Deferring is only safe because nothing was
  // dequeued, which the second half of this test is what proves.
  //
  // COUNTERFACTUAL: delete the pre-send level comparison in `syncOnce` and the
  // first assertion reddens — a Full-tier batch posts after the downgrade.
  const source = new FakeSyncSource([
    makeSyncedSession("s-iss7775-race", "2026-08-25T13:00:00.000Z"),
  ]);
  const batches: AgentSessionSyncBatch[] = [];
  let levelReads = 0;
  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => source,
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    getDataSyncLevel: () => {
      levelReads += 1;
      // Reads 1 (drain check) and 2 (capture) see the pre-change level; every
      // read from the pre-send comparison onward sees the user's new choice.
      return levelReads <= 2 ? DataSyncLevel.Full : DataSyncLevel.Metadata;
    },
    sendBatch: (batch) => {
      batches.push(batch);
      return Promise.resolve({
        accepted: true as const,
        acceptedSessionIds: batch.sessions.map((row) => row.externalSessionId),
      });
    },
  });
  service.start();
  try {
    await flushAgentSessionSync();
    assert.equal(
      batches.length,
      0,
      "a batch prepared at `full` must not post after the user picked Metadata"
    );

    // Eventual consistency (the deferral must not starve the queue): the session
    // was never dequeued, so a later pass ships it under the level that actually
    // holds. A guard that DROPPED the work instead of deferring it would leave
    // this at zero forever.
    for (let tick = 0; tick < 6; tick++) {
      service.refresh();
      await flushAgentSessionSync();
    }
    assert.ok(
      batches.length > 0,
      "the deferred session must still reach the cloud on a later pass"
    );
    assert.equal(
      batches[0].dataSyncLevel,
      DataSyncLevel.Metadata,
      "it must ship under the CURRENT level, not the one it was prepared at"
    );
  } finally {
    service.stop();
  }
});

test("ISS-7775 (review: codex P1): a level change mid-drain discards the pinned chunk tail", async () => {
  // The chunk-tail half of the same race. A tail sequestered at `full` drains
  // across LATER ticks, so a downgrade between chunks would keep posting turn
  // text the user just withdrew consent for. `resolvePendingChunkTransition` now
  // discards such a tail exactly as it already does for a compression or
  // activity-chunking downgrade, and the still-queued session re-chunks WHOLE
  // under the new level — which also preserves ISS-7516's pin, since every chunk
  // of the re-prepared sequence then carries one answer rather than two.
  //
  // COUNTERFACTUAL: drop the level comparison from
  // `resolvePendingChunkTransition` and a `full`-stamped tail chunk appears here.
  const source = new FakeSyncSource([makeOversizedSession("oversized-7775")]);
  const batches: AgentSessionSyncBatch[] = [];
  let level: DataSyncLevel = DataSyncLevel.Full;
  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => source,
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    getDataSyncLevel: () => level,
    sendBatch: (batch) => {
      batches.push(batch);
      // Downgrade the moment the first chunk is on the wire, leaving a pinned
      // tail that was sized and sanitized under the wider level.
      level = DataSyncLevel.Metadata;
      return Promise.resolve({
        accepted: true as const,
        acceptedSessionIds: batch.sessions.map((row) => row.externalSessionId),
      });
    },
  });
  service.start();
  try {
    for (let tick = 0; tick < 8; tick++) {
      await flushAgentSessionSync();
      service.refresh();
    }
  } finally {
    service.stop();
  }

  assert.ok(batches.length > 0, "no batch was uploaded; the corpus is empty");
  const fullAfterFirst = batches
    .slice(1)
    .filter((batch) => batch.dataSyncLevel === DataSyncLevel.Full);
  assert.deepEqual(
    fullAfterFirst,
    [],
    "a chunk pinned at `full` reached the wire after the user picked Metadata"
  );
});
