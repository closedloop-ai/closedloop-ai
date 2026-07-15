/**
 * @file transcript-sync-service.test.ts
 * @description FEA-2715 orchestrator with fake store/executor + a fake scheduler.
 * Covers bounded-concurrency drain, exponential backoff + consecutive-failure
 * dead-lettering, the flag/connectivity no-op, hook triggers (terminal immediate
 * vs activity debounce), and the discovery sweep (startup mini-backfill).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  TranscriptFailureInput,
  TranscriptObserveInput,
  TranscriptSyncStore,
} from "../src/main/database/transcript-sync-store.js";
import type { TranscriptSyncExecutor } from "../src/main/transcript-sync/transcript-sync-executor.js";
import { TranscriptSyncService } from "../src/main/transcript-sync/transcript-sync-service.js";
import type {
  TranscriptFileRef,
  TranscriptFingerprint,
} from "../src/main/transcript-sync/transcript-sync-types.js";

const NOW = "2026-07-09T00:00:00.000Z";

function fingerprint(
  overrides: Partial<TranscriptFingerprint> = {}
): TranscriptFingerprint {
  return {
    externalSessionId: "sess",
    fileKey: "main",
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
    nextAttemptAt: null,
    lastError: null,
    ...overrides,
  };
}

type FakeStore = TranscriptSyncStore & {
  ready: TranscriptFingerprint[];
  observed: TranscriptObserveInput[];
  failures: TranscriptFailureInput[];
  requeueCalls: number;
};

function fakeStore(ready: TranscriptFingerprint[] = []): FakeStore {
  const store = {
    ready,
    observed: [] as TranscriptObserveInput[],
    failures: [] as TranscriptFailureInput[],
    requeueCalls: 0,
    get: () => Promise.resolve(null),
    listAll: () => Promise.resolve([]),
    listReady: () => Promise.resolve(store.ready),
    observe: (input: TranscriptObserveInput) => {
      store.observed.push(input);
      return Promise.resolve(fingerprint(input));
    },
    markUploading: () => Promise.resolve(),
    markIdle: () => Promise.resolve(),
    recordUploaded: () => Promise.resolve(),
    recordFailure: (input: TranscriptFailureInput) => {
      store.failures.push(input);
      return Promise.resolve();
    },
    requeueStale: () => {
      store.requeueCalls += 1;
      return Promise.resolve(0);
    },
  };
  return store as unknown as FakeStore;
}

type TimerHandle = ReturnType<typeof setTimeout>;
type FakeSchedulerImpl = {
  setInterval: (fn: () => void, ms: number) => TimerHandle;
  clearInterval: (h: TimerHandle) => void;
  setTimeout: (fn: () => void, ms: number) => TimerHandle;
  clearTimeout: (h: TimerHandle) => void;
};
type FakeScheduler = {
  scheduler: FakeSchedulerImpl;
  timeouts: Array<() => void>;
};

const asHandle = (n: number): TimerHandle => n as unknown as TimerHandle;

function fakeScheduler(): FakeScheduler {
  const timeouts: Array<() => void> = [];
  return {
    timeouts,
    scheduler: {
      setInterval: () => asHandle(0),
      clearInterval: () => undefined,
      setTimeout: (fn) => {
        timeouts.push(fn);
        return asHandle(timeouts.length);
      },
      clearTimeout: () => undefined,
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

type ServiceOverrides = {
  store?: FakeStore | null;
  executor?: TranscriptSyncExecutor;
  enabled?: boolean;
  online?: boolean;
  discover?: () => TranscriptFileRef[];
  scheduler?: FakeScheduler["scheduler"];
  getComputeTargetId?: () => string | null;
  trustPath?: (path: string) => string | null;
};

function makeService(overrides: ServiceOverrides = {}) {
  const store = overrides.store === undefined ? fakeStore() : overrides.store;
  const executor =
    overrides.executor ??
    ({
      syncFile: () => Promise.resolve({ kind: "noop" as const }),
    } as TranscriptSyncExecutor);
  const service = new TranscriptSyncService({
    getStore: () => store,
    buildExecutor: () => executor,
    discover: overrides.discover ?? (() => []),
    isEnabled: () => overrides.enabled ?? true,
    isOnline: () => overrides.online ?? true,
    getComputeTargetId: overrides.getComputeTargetId,
    resolveTrustedTranscriptPath: overrides.trustPath ?? ((path) => path),
    statFile: () => Promise.resolve({ size: 10, mtimeMs: 1 }),
    now: () => NOW,
    scheduler: overrides.scheduler,
    concurrency: 2,
  });
  return { service, store };
}

test("drainOnce processes ready files up to the concurrency cap", async () => {
  const calls: string[] = [];
  const executor = {
    syncFile: (fp: TranscriptFingerprint) => {
      calls.push(fp.externalSessionId);
      return Promise.resolve({ kind: "noop" as const });
    },
  } as TranscriptSyncExecutor;
  const store = fakeStore([
    fingerprint({ externalSessionId: "a" }),
    fingerprint({ externalSessionId: "b" }),
    fingerprint({ externalSessionId: "c" }),
  ]);
  const { service } = makeService({ store, executor });

  await service.drainOnce();
  assert.equal(calls.length, 2); // concurrency 2 — 'c' waits for a later tick
});

test("a failed sync records a backoff retry", async () => {
  const executor = {
    syncFile: () => {
      throw new Error("upload failed");
    },
  } as TranscriptSyncExecutor;
  const store = fakeStore([fingerprint({ retryCount: 0 })]);
  const { service } = makeService({ store, executor });

  await service.drainOnce();
  assert.equal(store.failures.length, 1);
  assert.equal(store.failures[0].retryCount, 1);
  assert.equal(store.failures[0].dead, false);
  // exponential base = 30s for the first retry.
  assert.equal(store.failures[0].nextAttemptAt, "2026-07-09T00:00:30.000Z");
});

test("the fifth consecutive failure dead-letters the file", async () => {
  const executor = {
    syncFile: () => {
      throw new Error("still failing");
    },
  } as TranscriptSyncExecutor;
  const store = fakeStore([fingerprint({ retryCount: 4 })]);
  const { service } = makeService({ store, executor });

  await service.drainOnce();
  assert.equal(store.failures[0].retryCount, 5);
  assert.equal(store.failures[0].dead, true);
  assert.equal(store.failures[0].nextAttemptAt, null);
});

test("drainOnce never touches the executor unless the lane may run", async () => {
  const calls: string[] = [];
  const executor = {
    syncFile: (fp: TranscriptFingerprint) => {
      calls.push(fp.externalSessionId);
      return Promise.resolve({ kind: "noop" as const });
    },
  } as TranscriptSyncExecutor;

  // Both `shouldRun()` gates must independently stop the drain: the feature flag
  // being off (hard no-op) and being offline (no compute target / signed out).
  const flagOff = makeService({
    store: fakeStore([fingerprint()]),
    executor,
    enabled: false,
  });
  await flagOff.service.drainOnce();

  const offline = makeService({
    store: fakeStore([fingerprint()]),
    executor,
    online: false,
  });
  await offline.service.drainOnce();

  assert.equal(calls.length, 0);
});

test("a terminal Claude hook enqueues the transcript immediately (live)", async () => {
  const store = fakeStore();
  const { service } = makeService({ store });

  service.enqueueClaudeHook({
    hookType: "Stop",
    sessionId: "sess-9",
    transcriptPath: "/p/sess-9.jsonl",
  });
  await flush();

  assert.equal(store.observed.length, 1);
  assert.equal(store.observed[0].externalSessionId, "sess-9");
  assert.equal(store.observed[0].syncClass, "live");
});

test("a hook whose path fails the trust guard is never enqueued", async () => {
  const store = fakeStore();
  const { service } = makeService({ store, trustPath: () => null });

  service.enqueueClaudeHook({
    hookType: "Stop",
    sessionId: "sess-9",
    transcriptPath: "/etc/shadow.jsonl",
  });
  await flush();

  assert.equal(store.observed.length, 0);
});

test("enqueues the guard-resolved real path, not the original hook path", async () => {
  const store = fakeStore();
  // The guard canonicalizes symlinks; the service must upload the resolved
  // target so a symlink can't be repointed between check and read (FEA-2808).
  const { service } = makeService({
    store,
    trustPath: () => "/real/projects/p/session.jsonl",
  });

  service.enqueueClaudeHook({
    hookType: "Stop",
    sessionId: "sess-9",
    transcriptPath: "/p/some-project/alias.jsonl",
  });
  await flush();

  assert.equal(store.observed.length, 1);
  assert.equal(store.observed[0].sourcePath, "/real/projects/p/session.jsonl");
});

test("an activity hook debounces: no enqueue until the timer fires", async () => {
  const store = fakeStore();
  const sched = fakeScheduler();
  const { service } = makeService({ store, scheduler: sched.scheduler });

  service.enqueueClaudeHook({
    hookType: "PostToolUse",
    sessionId: "sess-9",
    transcriptPath: "/p/sess-9.jsonl",
  });
  assert.equal(store.observed.length, 0); // debounced, not yet enqueued
  assert.equal(sched.timeouts.length, 1);

  sched.timeouts[0](); // fire the ~5-min max-wait timer
  await flush();
  assert.equal(store.observed.length, 1);
  assert.equal(store.observed[0].syncClass, "live");
});

test("the first sweep requeues crash-stranded uploading rows exactly once", async () => {
  const store = fakeStore();
  const { service } = makeService({ store });

  await service.sweepOnce();
  await service.sweepOnce();
  // Boot recovery is one-shot per start (not repeated every 30-min sweep).
  assert.equal(store.requeueCalls, 1);
});

test("observe carries the current compute target so a target switch re-queues", async () => {
  const store = fakeStore();
  const { service } = makeService({
    store,
    getComputeTargetId: () => "ct-current",
  });

  service.enqueueClaudeHook({
    hookType: "Stop",
    sessionId: "sess-9",
    transcriptPath: "/p/sess-9.jsonl",
  });
  await flush();

  assert.equal(store.observed[0].currentComputeTargetId, "ct-current");
});

test("sweepOnce observes every discovered file as backfill then drains", async () => {
  const store = fakeStore();
  const refs: TranscriptFileRef[] = [
    {
      externalSessionId: "s1",
      fileKey: "main",
      sourceHarness: "claude",
      sourcePath: "/p/s1.jsonl",
    },
    {
      externalSessionId: "s1",
      fileKey: "subagent:x",
      sourceHarness: "claude",
      sourcePath: "/p/s1/subagents/x.jsonl",
    },
  ];
  const { service } = makeService({ store, discover: () => refs });

  await service.sweepOnce();
  assert.equal(store.observed.length, 2);
  assert.ok(store.observed.every((o) => o.syncClass === "backfill"));
});
