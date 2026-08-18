/**
 * @file transcript-sync-force-archive-service.test.ts
 * @description FEA-3489 (PRD-536) user-initiated force-archive override at the
 * service layer. Covers reviving the one dead oversized row and running a single
 * bypass upload (dead → forced upload → uploaded, queue unblocks), the notFound
 * no-op, the lane-off `unavailable` guard, and the retryable-failure path (a
 * forced upload failure records a backoff and is NOT dead-lettered under the cap).
 * Uses a minimal fake store/executor scoped to the force-archive entrypoint.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TranscriptFailureInput } from "../src/main/database/transcript-sync-settle.js";
import type { TranscriptSyncStore } from "../src/main/database/transcript-sync-store.js";
import {
  type TranscriptSyncExecutor,
  type TranscriptSyncFileOptions,
  TranscriptSyncRevokedError,
} from "../src/main/transcript-sync/transcript-sync-executor.js";
import { TranscriptSyncService } from "../src/main/transcript-sync/transcript-sync-service.js";
import {
  TRANSCRIPT_OVERSIZED_DEAD_LETTER_PREFIX,
  type TranscriptFingerprint,
} from "../src/main/transcript-sync/transcript-sync-types.js";
import {
  emptyTranscriptStatusCounts,
  TranscriptEgressGate,
} from "../src/shared/transcript-sync-status-contract.js";
import { fakeExecutor } from "./helpers/transcript-sync-fixtures.js";

const NOW = "2026-07-09T00:00:00.000Z";
const SESSION = "sess";
const FILE_KEY = "main";

function fingerprint(
  overrides: Partial<TranscriptFingerprint> = {}
): TranscriptFingerprint {
  return {
    externalSessionId: SESSION,
    fileKey: FILE_KEY,
    sourceHarness: "claude",
    sourcePath: "/p/sess.jsonl",
    sourcePathHash: "h",
    lastMtimeMs: 1,
    lastSize: 10,
    syncedByteOffset: 0,
    syncedSha256: null,
    storedEtag: null,
    syncedComputeTargetId: null,
    status: "queued",
    syncClass: "live",
    retryCount: 0,
    missingSourceCount: 0,
    nextAttemptAt: null,
    lastError: null,
    ...overrides,
  };
}

type ForceFakeStore = TranscriptSyncStore & {
  fingerprints: Map<string, TranscriptFingerprint>;
  revived: Array<{ externalSessionId: string; fileKey: string }>;
  reviveCount: number;
  failures: TranscriptFailureInput[];
  /** ISS-4621: identities settled back to `queued` after a revoked upload. */
  revokedRequeues: string[];
};

function forceFakeStore(): ForceFakeStore {
  const store = {
    fingerprints: new Map<string, TranscriptFingerprint>(),
    revived: [] as Array<{ externalSessionId: string; fileKey: string }>,
    reviveCount: 0,
    failures: [] as TranscriptFailureInput[],
    revokedRequeues: [] as string[],
    get: (externalSessionId: string, fileKey: string) =>
      Promise.resolve(
        store.fingerprints.get(`${externalSessionId}:${fileKey}`) ?? null
      ),
    reviveForForcedSync: (input: {
      externalSessionId: string;
      fileKey: string;
      now: string;
    }) => {
      store.revived.push({
        externalSessionId: input.externalSessionId,
        fileKey: input.fileKey,
      });
      return Promise.resolve(store.reviveCount);
    },
    recordFailure: (input: TranscriptFailureInput) => {
      store.failures.push(input);
      return Promise.resolve();
    },
    listRecent: () => Promise.resolve([]),
    statusCounts: () => Promise.resolve(emptyTranscriptStatusCounts()),
    listReady: () => Promise.resolve([]),
    observe: (input: unknown) =>
      Promise.resolve(fingerprint(input as Partial<TranscriptFingerprint>)),
    markUploading: () => Promise.resolve(),
    markIdle: () => Promise.resolve(),
    markDead: () => Promise.resolve(),
    recordUploaded: () => Promise.resolve(),
    requeueStale: () => Promise.resolve(0),
    requeueRevoked: (externalSessionId: string, fileKey: string) => {
      store.revokedRequeues.push(`${externalSessionId}:${fileKey}`);
      return Promise.resolve(1);
    },
  };
  return store as unknown as ForceFakeStore;
}

/**
 * A COMPLETE {@link TranscriptSyncExecutor} double for the force-archive path:
 * the shared fixture's `notifyPermanentSkip` recorder plus the `syncFile`
 * behavior this test cares about. Reusing the shared fixture keeps the double
 * honest about the whole executor contract instead of a `syncFile`-only literal.
 */
function forceFakeExecutor(
  syncFile: TranscriptSyncExecutor["syncFile"]
): TranscriptSyncExecutor {
  return fakeExecutor({ syncFile });
}

type ForceServiceOverrides = {
  store?: ForceFakeStore;
  executor?: TranscriptSyncExecutor;
  enabled?: boolean;
  online?: boolean;
  tierAllowed?: boolean;
};

function makeForceService(overrides: ForceServiceOverrides = {}) {
  const store = overrides.store ?? forceFakeStore();
  const executor =
    overrides.executor ??
    forceFakeExecutor(() => Promise.resolve({ kind: "noop" as const }));
  const service = new TranscriptSyncService({
    getStore: () => store,
    buildExecutor: () => executor,
    discover: () => [],
    isEnabled: () => overrides.enabled ?? true,
    isOnline: () => overrides.online ?? true,
    getCloudSyncTierGate: () =>
      (overrides.tierAllowed ?? true)
        ? TranscriptEgressGate.Allowed
        : TranscriptEgressGate.Denied,
    resolveTrustedTranscriptPath: (path) => path,
    statFile: () => Promise.resolve({ size: 10, mtimeMs: 1 }),
    now: () => NOW,
    concurrency: 2,
  });
  return { service, store };
}

test("FEA-3489: forceSyncOversized revives the dead row and uploads it past the cap", async () => {
  const store = forceFakeStore();
  store.reviveCount = 1;
  // After the revive, `get` returns the now-queued live fingerprint.
  store.fingerprints.set(
    `${SESSION}:${FILE_KEY}`,
    fingerprint({ status: "queued", retryCount: 0 })
  );
  const bypassSeen: Array<boolean | undefined> = [];
  const executor = forceFakeExecutor(
    (_fp: TranscriptFingerprint, options?: TranscriptSyncFileOptions) => {
      bypassSeen.push(options?.bypassSizeCap);
      return Promise.resolve({ kind: "uploaded" as const, caughtUp: true });
    }
  );
  const { service } = makeForceService({ store, executor });

  const result = await service.forceSyncOversized(SESSION, FILE_KEY);

  assert.deepEqual(result, { kind: "uploaded", caughtUp: true });
  // The dead row was force-revived (dead → queued) so the queue unblocks, then a
  // single upload ran with the size cap waived for THIS file only.
  assert.deepEqual(store.revived, [
    { externalSessionId: SESSION, fileKey: FILE_KEY },
  ]);
  assert.deepEqual(bypassSeen, [true]);
  // A successful forced upload does not record a failure or dead-letter again.
  assert.equal(store.failures.length, 0);
});

test("FEA-3489: forceSyncOversized continues bypass windows until caught up (partial upload not re-dead-lettered)", async () => {
  const store = forceFakeStore();
  store.reviveCount = 1;
  store.fingerprints.set(
    `${SESSION}:${FILE_KEY}`,
    fingerprint({ status: "queued", retryCount: 0 })
  );
  // A large oversized file needs two plan windows: the first upload is NOT caught
  // up (the durable lane would re-dead-letter it under the cap without a bypass),
  // so the force-sync must drive the second window under the same bypass.
  const bypassSeen: Array<boolean | undefined> = [];
  let calls = 0;
  const executor = forceFakeExecutor(
    (_fp: TranscriptFingerprint, options?: TranscriptSyncFileOptions) => {
      bypassSeen.push(options?.bypassSizeCap);
      calls += 1;
      return Promise.resolve({
        kind: "uploaded" as const,
        caughtUp: calls >= 2,
      });
    }
  );
  const { service } = makeForceService({ store, executor });

  const result = await service.forceSyncOversized(SESSION, FILE_KEY);

  assert.deepEqual(result, { kind: "uploaded", caughtUp: true });
  // Both windows ran under the cap bypass — the partial first window was NOT left
  // for the non-bypass drain to dead-letter.
  assert.deepEqual(bypassSeen, [true, true]);
});

test("FEA-3489: forceSyncOversized reports notFound when there is no dead row", async () => {
  const store = forceFakeStore();
  store.reviveCount = 0; // nothing flipped dead→queued
  let synced = 0;
  const executor = forceFakeExecutor(() => {
    synced += 1;
    return Promise.resolve({ kind: "noop" as const });
  });
  const { service } = makeForceService({ store, executor });

  const result = await service.forceSyncOversized(SESSION, FILE_KEY);

  assert.deepEqual(result, { kind: "notFound" });
  assert.equal(synced, 0); // no dead row → the executor is never touched
});

test("FEA-3489: forceSyncOversized reports permanent for a dead row the cap-bypass can't fix", async () => {
  const store = forceFakeStore();
  // The store's scoped revive matched nothing (a `source_gone` dead row is not
  // whole-file-cap), so reviveCount stays 0 — but a DEAD row for a non-cap reason
  // exists, so the action must be a terminal `permanent`, not a retryable `failed`
  // and not a `notFound` (there IS a row, it just can't be helped).
  store.reviveCount = 0;
  store.fingerprints.set(
    `${SESSION}:${FILE_KEY}`,
    fingerprint({
      status: "dead",
      lastError: "skipped: local transcript source gone after 3 attempt(s)",
    })
  );
  let synced = 0;
  const executor = forceFakeExecutor(() => {
    synced += 1;
    return Promise.resolve({ kind: "noop" as const });
  });
  const { service } = makeForceService({ store, executor });

  const result = await service.forceSyncOversized(SESSION, FILE_KEY);

  assert.deepEqual(result, {
    kind: "permanent",
    reason: "skipped: local transcript source gone after 3 attempt(s)",
  });
  assert.equal(synced, 0); // nothing revived → the executor is never touched
});

test("FEA-3489: a terminal skip (source gone) during the forced upload is permanent, not retryable", async () => {
  const store = forceFakeStore();
  store.reviveCount = 1;
  // The row WAS whole-file-cap dead (so it revived), but between the revive and
  // the upload the local source vanished — the executor returns a permanent skip.
  // That must surface as terminal `permanent` (no retry invitation), and must NOT
  // record a retryable failure.
  store.fingerprints.set(
    `${SESSION}:${FILE_KEY}`,
    fingerprint({
      status: "queued",
      lastError: `${TRANSCRIPT_OVERSIZED_DEAD_LETTER_PREFIX}: 3 bytes exceeds cap`,
    })
  );
  const executor = forceFakeExecutor(() =>
    Promise.resolve({
      kind: "skipped" as const,
      reason: "source gone",
      permanent: true,
    })
  );
  const { service } = makeForceService({ store, executor });

  const result = await service.forceSyncOversized(SESSION, FILE_KEY);

  assert.deepEqual(result, { kind: "permanent", reason: "source gone" });
  assert.equal(store.failures.length, 0);
});

test("FEA-3489: a transient skip (no complete line yet) during the forced upload is retryable failed", async () => {
  const store = forceFakeStore();
  store.reviveCount = 1;
  store.fingerprints.set(
    `${SESSION}:${FILE_KEY}`,
    fingerprint({ status: "queued" })
  );
  // No `permanent` flag → a transient skip the user can retry.
  const executor = forceFakeExecutor(() =>
    Promise.resolve({ kind: "skipped" as const, reason: "no complete line" })
  );
  const { service } = makeForceService({ store, executor });

  const result = await service.forceSyncOversized(SESSION, FILE_KEY);

  assert.deepEqual(result, { kind: "failed", reason: "no complete line" });
});

test("ISS-4621: a mid-force revocation re-queues without advancing the failure ladder", async () => {
  const store = forceFakeStore();
  store.reviveCount = 1;
  store.fingerprints.set(
    `${SESSION}:${FILE_KEY}`,
    fingerprint({ status: "queued", retryCount: 3 })
  );
  // Consent lowered while the forced upload streams: NOT a failure. The row
  // must be re-queued clean — advancing the ladder here would (a) count a
  // deliberate user action toward the dead-letter threshold and (b) burn the
  // revived force attempt on a `failed` settle, sending an offset-zero file
  // back through the size cap it was just revived past.
  const executor = forceFakeExecutor(() => {
    throw new TranscriptSyncRevokedError();
  });
  const { service } = makeForceService({ store, executor });

  const result = await service.forceSyncOversized(SESSION, FILE_KEY);

  assert.deepEqual(result, { kind: "failed", reason: "sync revoked" });
  assert.equal(store.failures.length, 0, "no ladder advance on a revocation");
  assert.deepEqual(store.revokedRequeues, [`${SESSION}:${FILE_KEY}`]);
});

test("FEA-3489: forceSyncOversized is unavailable when the lane is disabled (never revives)", async () => {
  const store = forceFakeStore();
  store.reviveCount = 1;
  const { service } = makeForceService({ store, enabled: false });

  const result = await service.forceSyncOversized(SESSION, FILE_KEY);

  assert.deepEqual(result, { kind: "unavailable" });
  assert.equal(store.revived.length, 0); // lane off → the dead row is untouched
});

test("FEA-3489: the inFlight key is claimed BEFORE the revive so a concurrent pass can't race", async () => {
  const store = forceFakeStore();
  store.reviveCount = 1;
  store.fingerprints.set(
    `${SESSION}:${FILE_KEY}`,
    fingerprint({ status: "queued" })
  );
  // Gate the first upload so it holds the inFlight key while a second force call
  // arrives. The second must short-circuit to `unavailable` WITHOUT reviving
  // (proving the claim precedes the revive — otherwise the second revive would
  // fire and a drain could steal the freshly-queued row).
  let releaseFirst: () => void = () => undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstStarted: () => void = () => undefined;
  const firstStartedPromise = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  const executor = forceFakeExecutor(async () => {
    firstStarted();
    await firstGate;
    return { kind: "uploaded" as const, caughtUp: true };
  });
  const { service } = makeForceService({ store, executor });

  const first = service.forceSyncOversized(SESSION, FILE_KEY);
  await firstStartedPromise; // the first pass now holds the inFlight key
  const second = await service.forceSyncOversized(SESSION, FILE_KEY);

  assert.deepEqual(second, { kind: "unavailable" });
  // Only the first pass revived — the second never touched the dead row.
  assert.equal(store.revived.length, 1);
  releaseFirst();
  assert.deepEqual(await first, { kind: "uploaded", caughtUp: true });
});

test("FEA-3489: a forced upload failure is retryable and records a backoff (not re-dead-lettered under threshold)", async () => {
  const store = forceFakeStore();
  store.reviveCount = 1;
  // The revived row has one prior failure; the forced attempt fails, so retryCount
  // climbs to 2 — still under the consecutive-failure cap, so it stays queued for
  // the durable retry ladder rather than being dead-lettered again.
  store.fingerprints.set(
    `${SESSION}:${FILE_KEY}`,
    fingerprint({ status: "queued", retryCount: 1 })
  );
  const executor = forceFakeExecutor(() => {
    throw new Error("network reset");
  });
  const { service } = makeForceService({ store, executor });

  const result = await service.forceSyncOversized(SESSION, FILE_KEY);

  assert.deepEqual(result, { kind: "failed", reason: "network reset" });
  assert.equal(store.failures.length, 1);
  assert.equal(store.failures[0].retryCount, 2);
  // Retryable: distinct from the size-cap permanent state — not dead-lettered.
  assert.equal(store.failures[0].dead, false);
  assert.ok(store.failures[0].nextAttemptAt !== null);
});
