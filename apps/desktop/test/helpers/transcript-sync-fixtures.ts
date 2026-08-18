/**
 * @file transcript-sync-fixtures.ts
 * @description Shared fakes for the transcript-archive-lane service tests: a
 * fake `TranscriptSyncStore`, a fake scheduler (so the ~5 min activity debounce
 * and the 5s/30min timers are driven deterministically, never by wall clock),
 * and a `makeService` builder. Extracted so the orchestrator suite and the
 * FEA-3640 activity-trigger suite share one fixture set instead of duplicating
 * it (and so neither file carries the whole surface past the size ceiling).
 */
import { TranscriptUploadStatus } from "@repo/api/src/types/desktop-transcripts";
import type {
  TranscriptFailureInput,
  TranscriptSettle,
} from "../../src/main/database/transcript-sync-settle.js";
import type {
  TranscriptObserveInput,
  TranscriptSyncStore,
} from "../../src/main/database/transcript-sync-store.js";
import type { TranscriptSyncExecutor } from "../../src/main/transcript-sync/transcript-sync-executor.js";
import { TranscriptSyncService } from "../../src/main/transcript-sync/transcript-sync-service.js";
import type {
  TranscriptFileRef,
  TranscriptFingerprint,
  TranscriptSourceHarness,
} from "../../src/main/transcript-sync/transcript-sync-types.js";
import {
  emptyTranscriptStatusCounts,
  TranscriptEgressGate,
  type TranscriptSyncStatusCounts,
} from "../../src/shared/transcript-sync-status-contract.js";

export const NOW = "2026-07-09T00:00:00.000Z";

export function fingerprint(
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
    missingSourceCount: 0,
    nextAttemptAt: null,
    lastError: null,
    ...overrides,
  };
}

export type FakeStore = TranscriptSyncStore & {
  ready: TranscriptFingerprint[];
  recent: TranscriptFingerprint[];
  recentLimits: number[];
  observed: TranscriptObserveInput[];
  failures: TranscriptFailureInput[];
  idleCalls: number;
  /**
   * ISS-4815: identities settled through the DURABLE cloud-uploaded terminal
   * (`markCloudUploaded`), kept separate from `idleCalls` so a test can prove
   * an authoritative `uploaded` acknowledgement was persisted as such instead of
   * being collapsed into a bare `idle` that the stranded-blob recovery re-arms.
   */
  cloudUploadedSettles: string[];
  /** ISS-4815: the compute target each cloud acknowledgement was scoped to. */
  cloudUploadedTargets: (string | null)[];
  requeueCalls: number;
  strandedRequeueCalls: number;
  /** ISS-4621: rows the fake reports as re-armed from stranded `idle` blobs. */
  strandedRequeueResult: number;
  /** ISS-4647: the compute target each stranded re-arm was scoped to. */
  strandedRequeueTargets: (string | null)[];
  /** ISS-4621: identities settled back to `queued` after a revoked upload. */
  revokedRequeues: string[];
  /** ISS-4849: one entry per in-process re-queue of a failed settle flush. */
  unsettledRequeues: string[][];
  /**
   * ISS-4723 PR2: one entry per `recordBatchSettled` call (the coalesced batch
   * settle write). Lets a test assert the SETTLE writes collapsed into ONE write
   * per drain batch. Each entry is that batch's settles, in order.
   */
  settledBatches: TranscriptSettle[][];
  /**
   * ISS-4390: persisted rows by `${externalSessionId}/${fileKey}`, backing
   * `get`. The sidecar changed-check compares a file's size against the row's
   * `syncedByteOffset`, so tests seed this to express "already fully uploaded".
   */
  rows: Map<string, TranscriptFingerprint>;
  /**
   * ISS-5348: the whole-table status census `getStatusSnapshot` now reads.
   * Defaults to all-zero; a case seeds the statuses it wants observed.
   */
  counts: TranscriptSyncStatusCounts;
  /** How many times `statusCounts()` was called, to prove the polled path. */
  statusCountsCalls: number;
};

export function fakeStore(
  ready: TranscriptFingerprint[] = [],
  /**
   * ISS-4390: fired after each `observe`. Child enqueues resolve their
   * `subagent:{id}` key through an ASYNC seam, so tests synchronize on this real
   * completion signal (per the desktop `test:node` determinism rule) instead of
   * guessing how many microtask turns the chain needs.
   */
  onObserve?: (input: TranscriptObserveInput) => void
): FakeStore {
  const store = {
    ready,
    recent: [] as TranscriptFingerprint[],
    recentLimits: [] as number[],
    observed: [] as TranscriptObserveInput[],
    failures: [] as TranscriptFailureInput[],
    idleCalls: 0,
    cloudUploadedSettles: [] as string[],
    cloudUploadedTargets: [] as (string | null)[],
    requeueCalls: 0,
    strandedRequeueCalls: 0,
    strandedRequeueResult: 0,
    strandedRequeueTargets: [] as (string | null)[],
    revokedRequeues: [] as string[],
    unsettledRequeues: [] as string[][],
    settledBatches: [] as TranscriptSettle[][],
    rows: new Map<string, TranscriptFingerprint>(),
    /** ISS-5348: whole-table status census the status snapshot now reads. */
    counts: emptyTranscriptStatusCounts(),
    statusCountsCalls: 0,
    get: (externalSessionId: string, fileKey: string) =>
      Promise.resolve(
        store.rows.get(`${externalSessionId}/${fileKey}`) ?? null
      ),
    listRecent: (limit: number) => {
      store.recentLimits.push(limit);
      return Promise.resolve(store.recent);
    },
    statusCounts: () => {
      store.statusCountsCalls += 1;
      return Promise.resolve(store.counts);
    },
    listReady: () => Promise.resolve(store.ready),
    observe: (input: TranscriptObserveInput) => {
      store.observed.push(input);
      onObserve?.(input);
      return Promise.resolve(fingerprint(input));
    },
    markUploading: () => Promise.resolve(),
    markIdle: () => {
      store.idleCalls += 1;
      return Promise.resolve();
    },
    markCloudUploaded: (
      externalSessionId: string,
      fileKey: string,
      _now: string,
      computeTargetId: string | null
    ) => {
      store.cloudUploadedSettles.push(`${externalSessionId}:${fileKey}`);
      store.cloudUploadedTargets.push(computeTargetId);
      return Promise.resolve();
    },
    markDead: () => Promise.resolve(),
    recordUploaded: () => Promise.resolve(),
    recordFailure: (input: TranscriptFailureInput) => {
      store.failures.push(input);
      return Promise.resolve();
    },
    requeueStale: () => {
      store.requeueCalls += 1;
      return Promise.resolve(0);
    },
    requeueStrandedMissingBlobs: (input: {
      now: string;
      computeTargetId: string | null;
    }) => {
      store.strandedRequeueCalls += 1;
      store.strandedRequeueTargets.push(input.computeTargetId);
      return Promise.resolve(store.strandedRequeueResult);
    },
    requeueRevoked: (externalSessionId: string, fileKey: string) => {
      store.revokedRequeues.push(`${externalSessionId}:${fileKey}`);
      return Promise.resolve(1);
    },
    recordBatchSettled: (settles: TranscriptSettle[]) => {
      // ISS-4723 PR2: an empty batch is a no-op write (matches production), so
      // don't record it as a batch write. Otherwise record the whole batch AND
      // fold each settle into the same per-kind recorders the individual store
      // methods feed, so existing `idleCalls`/`failures` assertions still hold
      // when a settle is delivered via the batch path.
      if (settles.length === 0) {
        return Promise.resolve();
      }
      store.settledBatches.push(settles);
      for (const settle of settles) {
        if (settle.kind === "idle") {
          store.idleCalls += 1;
        } else if (settle.kind === "cloudUploaded") {
          store.cloudUploadedSettles.push(
            `${settle.externalSessionId}:${settle.fileKey}`
          );
        } else if (settle.kind === "failure") {
          store.failures.push(settle);
        }
      }
      return Promise.resolve();
    },
    // ISS-4849: in-process recovery for a rejected batch flush. Records the
    // identities the drain asked to re-arm so a test can assert the batch was
    // re-queued rather than stranded `uploading` until the next boot.
    requeueUnsettledBatch: (
      identities: readonly { externalSessionId: string; fileKey: string }[]
    ) => {
      if (identities.length === 0) {
        return Promise.resolve(0);
      }
      store.unsettledRequeues.push(
        identities.map(
          (identity) => `${identity.externalSessionId}:${identity.fileKey}`
        )
      );
      return Promise.resolve(identities.length);
    },
  };
  return store as unknown as FakeStore;
}

export type TimerHandle = ReturnType<typeof setTimeout>;
export type FakeSchedulerImpl = {
  setInterval: (fn: () => void, ms: number) => TimerHandle;
  clearInterval: (h: TimerHandle) => void;
  setTimeout: (fn: () => void, ms: number) => TimerHandle;
  clearTimeout: (h: TimerHandle) => void;
};
export type FakeScheduler = {
  scheduler: FakeSchedulerImpl;
  timeouts: Array<() => void>;
};

const asHandle = (n: number): TimerHandle => n as unknown as TimerHandle;

export function fakeScheduler(): FakeScheduler {
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

export const flush = () => new Promise((resolve) => setImmediate(resolve));

export type ServiceOverrides = {
  store?: FakeStore | null;
  executor?: TranscriptSyncExecutor;
  enabled?: boolean;
  online?: boolean;
  tierAllowed?: boolean;
  discover?: () => TranscriptFileRef[];
  scheduler?: FakeScheduler["scheduler"];
  getComputeTargetId?: () => string | null;
  trustPath?: (path: string) => string | null;
  /** Dynamic tier gate (takes precedence over `tierAllowed`) for reopen tests. */
  tierAllowedFn?: () => boolean;
  /**
   * ISS-5348: the raw tri-state gate, for suites that need `Unresolved`.
   * Outranks both boolean overrides above.
   */
  tierGateFn?: () => TranscriptEgressGate;
  isPendingPath?: (path: string) => boolean;
  log?: (message: string) => void;
  concurrency?: number;
  materialize?: () => void | Promise<void>;
  redriveOnStart?: () => Promise<number>;
  /**
   * ISS-4390: child `subagent:{id}` key resolver (unwired by default). Mirrors
   * the production seam exactly — `null` means "this changed path is not an
   * identifiable child", which the enqueue path must DROP rather than file under
   * `main`, and is a case the suites exercise.
   */
  resolveLiveRef?: (
    harness: TranscriptSourceHarness,
    mappedSourcePath: string,
    changedPath: string
  ) => Promise<string | null>;
  /** ISS-4390 slice 2: per-session sidecar enumerator (unwired by default). */
  listSubagentRefs?: (
    mainTranscriptPath: string
  ) => Promise<Array<{ fileKey: string; sourcePath: string }>>;
  /** Per-file stat used by the sidecar changed-check (defaults to size 10). */
  statFile?: (
    path: string
  ) => Promise<{ size: number; mtimeMs: number } | null>;
};

/** A promise plus its resolver, for synchronizing on a real completion signal. */
export function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * ISS-5348: the service now takes the TRI-STATE gate. Suites overwhelmingly care
 * about allowed-vs-not, so the ergonomic boolean overrides are kept and mapped
 * here; `tierGateFn` is the escape hatch for the suites that specifically
 * exercise `Unresolved`. Returning `undefined` leaves the option unwired, which
 * is the documented fail-open the service defaults to.
 */
function resolveTierGate(
  overrides: ServiceOverrides
): (() => TranscriptEgressGate) | undefined {
  if (overrides.tierGateFn) {
    return overrides.tierGateFn;
  }
  if (overrides.tierAllowedFn) {
    const allowedFn = overrides.tierAllowedFn;
    return () => booleanToGate(allowedFn());
  }
  if (overrides.tierAllowed === undefined) {
    return undefined;
  }
  return () => booleanToGate(overrides.tierAllowed as boolean);
}

/**
 * A boolean override means a SETTLED verdict — `Denied`, never `Unresolved`.
 * Mapping `false` to `Unresolved` would quietly turn every existing
 * closed-gate suite into a pending-policy suite.
 */
function booleanToGate(allowed: boolean): TranscriptEgressGate {
  return allowed ? TranscriptEgressGate.Allowed : TranscriptEgressGate.Denied;
}

export type FakeExecutor = TranscriptSyncExecutor & {
  /** ISS-4621: identity/reason/pinned-target triples notify was called with. */
  skipNotifications: {
    key: string;
    reason: string;
    computeTargetId: string | null;
  }[];
};

/**
 * Fake executor for service tests. `syncFile` defaults to a successful noop;
 * `notifyPermanentSkip` records its calls and answers with a
 * {@link PermanentSkipEmitResult} driven by `skipAck` + `skipStatus`, so
 * dead-letter tests can drive the acked-recorded, acked-but-uploaded
 * (ISS-4695), and ack-failed (ISS-4621) branches.
 *
 * `skipAck` defaults to acknowledged; `skipStatus` defaults to `skipped` (the
 * cloud recorded the terminal skip → the drain-queue may dead-letter). Set
 * `skipStatus: uploaded` to exercise the ISS-4695 case where the cloud already
 * holds a verified archive and the row must NOT go dead.
 */
export function fakeExecutor(
  overrides: {
    syncFile?: TranscriptSyncExecutor["syncFile"];
    skipAck?: boolean;
    skipStatus?: TranscriptUploadStatus;
  } = {}
): FakeExecutor {
  const executor = {
    skipNotifications: [] as {
      key: string;
      reason: string;
      computeTargetId: string | null;
    }[],
    syncFile:
      overrides.syncFile ?? (() => Promise.resolve({ kind: "noop" as const })),
    notifyPermanentSkip: (
      fp: TranscriptFingerprint,
      reason: string,
      computeTargetId?: string | null
    ) => {
      executor.skipNotifications.push({
        key: `${fp.externalSessionId}:${fp.fileKey}`,
        reason,
        computeTargetId: computeTargetId ?? null,
      });
      if ((overrides.skipAck ?? true) === false) {
        return Promise.resolve({ acked: false as const });
      }
      return Promise.resolve({
        acked: true as const,
        status: overrides.skipStatus ?? TranscriptUploadStatus.Skipped,
      });
    },
  };
  return executor as unknown as FakeExecutor;
}

export function makeService(overrides: ServiceOverrides = {}) {
  const store = overrides.store === undefined ? fakeStore() : overrides.store;
  const executor = overrides.executor ?? fakeExecutor();
  const service = new TranscriptSyncService({
    getStore: () => store,
    buildExecutor: () => executor,
    discover: overrides.discover ?? (() => []),
    materialize: overrides.materialize,
    redriveOnStart: overrides.redriveOnStart,
    isEnabled: () => overrides.enabled ?? true,
    isOnline: () => overrides.online ?? true,
    getCloudSyncTierGate: resolveTierGate(overrides),
    getComputeTargetId: overrides.getComputeTargetId,
    resolveTrustedTranscriptPath: overrides.trustPath ?? ((path) => path),
    resolveLiveRef: overrides.resolveLiveRef,
    listSubagentRefs: overrides.listSubagentRefs,
    isPendingTrustedTranscriptPath: overrides.isPendingPath,
    statFile:
      overrides.statFile ?? (() => Promise.resolve({ size: 10, mtimeMs: 1 })),
    now: () => NOW,
    log: overrides.log,
    scheduler: overrides.scheduler,
    concurrency: overrides.concurrency ?? 2,
  });
  return { service, store };
}
