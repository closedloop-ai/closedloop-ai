/**
 * @file transcript-discovery-sweep-coverage.test.ts
 * @description ISS-8730 coverage for `TranscriptDiscoverySweeper`
 * (`src/main/transcript-sync/transcript-discovery-sweep.ts`) — the archive
 * lane's periodic full-discovery pass, exercised directly against a mocked
 * `TranscriptDiscoverySweeperDeps` rather than through the full
 * `TranscriptSyncService`. Pins CURRENT behavior only; does not fix source.
 */
import assert from "node:assert/strict";
import { ImportHealthEvent } from "@closedloop-ai/telemetry-contract/app";
import { test } from "vitest";
import type { TranscriptSyncStore } from "../src/main/database/transcript-sync-store.js";
import type { MaterializeImportHealthEvent } from "../src/main/telemetry/app-otel-runtime-import-health.js";
import {
  OpencodeMaterializeError,
  OpencodeMaterializeFailure,
} from "../src/main/transcript-sync/opencode-materialize-outcome.js";
import { TranscriptDiscoverySweeper } from "../src/main/transcript-sync/transcript-discovery-sweep.js";
import type { TranscriptObserveDeps } from "../src/main/transcript-sync/transcript-observe.js";
import type { TranscriptSyncServiceOptions } from "../src/main/transcript-sync/transcript-sync-options.js";
import {
  TRANSCRIPT_UPLOAD_LEASE_MS,
  type TranscriptFileRef,
  TranscriptSourceHarness,
} from "../src/main/transcript-sync/transcript-sync-types.js";
import { createUtilityProcessOpencodeMaterializeRunner } from "../src/main/transcript-sync/utility-process-opencode-materialize-runner.js";
import { fakeOpencodeMaterializeWorkerFork } from "./helpers/opencode-materialize-worker-fixtures.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));

function ref(id: string): TranscriptFileRef {
  return {
    externalSessionId: id,
    fileKey: "main",
    sourceHarness: TranscriptSourceHarness.Claude,
    sourcePath: `/p/${id}.jsonl`,
  };
}

type StoreOverrides = {
  requeueExpiredResult?: number | (() => Promise<number>);
  requeueStrandedResult?: number | (() => Promise<number>);
  statFile?: (
    path: string
  ) => Promise<{ size: number; mtimeMs: number } | null>;
};

function makeFakeStore(overrides: StoreOverrides = {}) {
  const requeueExpiredCalls: Array<{
    now: string;
    leaseMs: number;
    claimableFrom: string;
  }> = [];
  const requeueStrandedCalls: Array<{
    now: string;
    computeTargetId: string | null;
  }> = [];
  const observed: Array<{
    externalSessionId: string;
    fileKey: string;
    sourcePath: string;
  }> = [];

  const requeueExpired =
    typeof overrides.requeueExpiredResult === "function"
      ? overrides.requeueExpiredResult
      : () => Promise.resolve(overrides.requeueExpiredResult ?? 0);
  const requeueStranded =
    typeof overrides.requeueStrandedResult === "function"
      ? overrides.requeueStrandedResult
      : () => Promise.resolve(overrides.requeueStrandedResult ?? 0);

  const store = {
    requeueExpiredUploadLeases: (input: {
      now: string;
      leaseMs: number;
      claimableFrom: string;
    }) => {
      requeueExpiredCalls.push(input);
      return requeueExpired();
    },
    requeueStrandedMissingBlobs: (input: {
      now: string;
      computeTargetId: string | null;
    }) => {
      requeueStrandedCalls.push(input);
      return requeueStranded();
    },
    observe: (input: {
      externalSessionId: string;
      fileKey: string;
      sourcePath: string;
    }) => {
      observed.push(input);
      return Promise.resolve({});
    },
  };

  return {
    store: store as unknown as TranscriptSyncStore,
    requeueExpiredCalls,
    requeueStrandedCalls,
    observed,
  };
}

type DepsOverrides = {
  isEnabled?: () => boolean;
  store?: TranscriptSyncStore | null;
  discover?: () => TranscriptFileRef[] | Promise<TranscriptFileRef[]>;
  redriveOnStart?: TranscriptSyncServiceOptions["redriveOnStart"];
  materialize?: TranscriptSyncServiceOptions["materialize"];
  noteMaterializeOutcome?: TranscriptSyncServiceOptions["noteMaterializeOutcome"];
  tierAllowsSync?: () => boolean;
  now?: () => string;
  concurrency?: number;
  computeTargetId?: string | null;
  statFile?: (
    path: string
  ) => Promise<{ size: number; mtimeMs: number } | null>;
};

function makeDeps(overrides: DepsOverrides = {}) {
  const logs: string[] = [];
  const drainOnceCalls = { count: 0 };
  const store =
    overrides.store === undefined ? makeFakeStore().store : overrides.store;

  const opts: TranscriptSyncServiceOptions = {
    getStore: () => store,
    buildExecutor: () => {
      throw new Error("buildExecutor must not be called by the sweeper");
    },
    discover: overrides.discover ?? (() => []),
    isEnabled: overrides.isEnabled ?? (() => true),
    isOnline: () => true,
    resolveTrustedTranscriptPath: (path) => path,
    redriveOnStart: overrides.redriveOnStart,
    materialize: overrides.materialize,
    noteMaterializeOutcome: overrides.noteMaterializeOutcome,
    statFile: () => Promise.resolve(null),
  };

  const observe: TranscriptObserveDeps = {
    statFile:
      overrides.statFile ?? (() => Promise.resolve({ size: 1, mtimeMs: 1 })),
    hashPath: (path) => `hash:${path}`,
    getComputeTargetId: () => overrides.computeTargetId ?? null,
    now: () => "2026-01-01T00:00:00.000Z",
  };

  const deps = {
    opts,
    observe,
    tierAllowsSync: overrides.tierAllowsSync ?? (() => true),
    now: overrides.now ?? (() => "2026-01-01T00:00:00.000Z"),
    log: (message: string) => logs.push(message),
    concurrency: overrides.concurrency ?? 2,
    drainOnce: () => {
      drainOnceCalls.count += 1;
      return Promise.resolve();
    },
  };

  return { deps, logs, drainOnceCalls };
}

// --- top-level enable/store gates -------------------------------------------

test("sweepOnce: no-ops when the lane is disabled", async () => {
  const { requeueExpiredCalls } = makeFakeStore();
  const { deps, drainOnceCalls } = makeDeps({ isEnabled: () => false });
  const sweeper = new TranscriptDiscoverySweeper(deps);

  await sweeper.sweepOnce();

  assert.equal(requeueExpiredCalls.length, 0, "no recovery must run either");
  assert.equal(drainOnceCalls.count, 0);
});

test("sweepOnce: no-ops when the store is not ready", async () => {
  const { deps, drainOnceCalls } = makeDeps({ store: null });
  const sweeper = new TranscriptDiscoverySweeper(deps);

  await sweeper.sweepOnce();

  assert.equal(drainOnceCalls.count, 0);
});

// --- recoveries run before AND regardless of the tier gate -----------------

test("sweepOnce: both recoveries run even while the consent tier is closed, but discovery does not", async () => {
  const fake = makeFakeStore();
  let discoverCalls = 0;
  const { deps, drainOnceCalls } = makeDeps({
    store: fake.store,
    tierAllowsSync: () => false,
    discover: () => {
      discoverCalls += 1;
      return [];
    },
  });
  const sweeper = new TranscriptDiscoverySweeper(deps);

  await sweeper.sweepOnce();

  assert.equal(fake.requeueExpiredCalls.length, 1);
  assert.equal(fake.requeueStrandedCalls.length, 1);
  assert.equal(discoverCalls, 0, "a closed tier must not grow the queue");
  assert.equal(drainOnceCalls.count, 0);
});

test("sweepOnce: a closed tier logs the suppression once per episode and re-logs after reopening", async () => {
  const fake = makeFakeStore();
  let tierOpen = false;
  let discoverCalls = 0;
  const { deps, logs } = makeDeps({
    store: fake.store,
    tierAllowsSync: () => tierOpen,
    discover: () => {
      discoverCalls += 1;
      return [];
    },
  });
  const sweeper = new TranscriptDiscoverySweeper(deps);

  await sweeper.sweepOnce(); // closed: logs
  await sweeper.sweepOnce(); // still closed: latched, no 2nd log
  tierOpen = true;
  await sweeper.sweepOnce(); // opens: resets the latch, discovery runs
  tierOpen = false;
  await sweeper.sweepOnce(); // closed again: logs again

  const suppressedLogs = logs.filter((m) =>
    m.includes("suppressed by consent tier")
  );
  assert.equal(
    suppressedLogs.length,
    2,
    "logged on entry and on re-closure only"
  );
  assert.equal(discoverCalls, 1, "only the one open sweep grew the queue");
});

// --- reclaimExpiredUploadLeases ---------------------------------------------

test("reclaimExpiredUploadLeases: passes the lease constant and the construction-time claimableFrom", async () => {
  const fake = makeFakeStore();
  let nowValue = "2026-01-01T00:00:00.000Z";
  const { deps } = makeDeps({ store: fake.store, now: () => nowValue });
  const sweeper = new TranscriptDiscoverySweeper(deps); // captures claimableFrom = nowValue here

  nowValue = "2026-01-01T01:00:00.000Z"; // clock moves before the sweep runs
  await sweeper.sweepOnce();

  assert.equal(fake.requeueExpiredCalls.length, 1);
  assert.equal(fake.requeueExpiredCalls[0].leaseMs, TRANSCRIPT_UPLOAD_LEASE_MS);
  assert.equal(
    fake.requeueExpiredCalls[0].claimableFrom,
    "2026-01-01T00:00:00.000Z",
    "claimableFrom is fixed at construction time, not re-read per sweep"
  );
  assert.equal(fake.requeueExpiredCalls[0].now, "2026-01-01T01:00:00.000Z");
});

test("reclaimExpiredUploadLeases: logs only when rows were actually revived", async () => {
  const zero = makeFakeStore({ requeueExpiredResult: 0 });
  const { deps: zeroDeps, logs: zeroLogs } = makeDeps({ store: zero.store });
  await new TranscriptDiscoverySweeper(zeroDeps).sweepOnce();
  assert.ok(
    !zeroLogs.some((m) => m.includes("reclaimed")),
    "zero revived rows must not log"
  );

  const some = makeFakeStore({ requeueExpiredResult: 3 });
  const { deps: someDeps, logs: someLogs } = makeDeps({ store: some.store });
  await new TranscriptDiscoverySweeper(someDeps).sweepOnce();
  assert.ok(
    someLogs.some((m) => m.includes("reclaimed 3 expired upload lease"))
  );
});

// --- rearmStrandedBlobs -------------------------------------------------------

test("rearmStrandedBlobs: forwards the live compute target id and logs only when rows were re-armed", async () => {
  const fake = makeFakeStore({ requeueStrandedResult: 5 });
  const { deps, logs } = makeDeps({
    store: fake.store,
    computeTargetId: "target-9",
  });
  await new TranscriptDiscoverySweeper(deps).sweepOnce();

  assert.equal(fake.requeueStrandedCalls.length, 1);
  assert.equal(fake.requeueStrandedCalls[0].computeTargetId, "target-9");
  assert.ok(
    logs.some((m) => m.includes("re-armed 5 stranded missing-blob row"))
  );
});

// --- best-effort recovery: a rejection must not abort discovery ------------

test("sweepOnce: a rejecting recovery is logged and does not abort discovery or drain", async () => {
  const fake = makeFakeStore({
    requeueExpiredResult: () =>
      Promise.reject(new Error("db-host unreachable")),
    requeueStrandedResult: () => Promise.reject(new Error("db-host wedged")),
  });
  const refs = [ref("sess-1")];
  const { deps, logs, drainOnceCalls } = makeDeps({
    store: fake.store,
    discover: () => refs,
  });
  const sweeper = new TranscriptDiscoverySweeper(deps);

  await sweeper.sweepOnce();

  assert.ok(
    logs.some((m) =>
      m.includes(
        "transcript expired upload-lease recovery failed: db-host unreachable"
      )
    )
  );
  assert.ok(
    logs.some((m) =>
      m.includes("transcript stranded-blob recovery failed: db-host wedged")
    )
  );
  assert.equal(
    fake.observed.length,
    1,
    "discovery still ran after both failures"
  );
  assert.equal(
    drainOnceCalls.count,
    1,
    "the drain still ran after both failures"
  );
});

// --- one-shot dead-letter redrive -------------------------------------------

test("runOneShotRedrive: calls redriveOnStart at most once across repeated sweeps", async () => {
  let redriveCalls = 0;
  const fake = makeFakeStore();
  const { deps, logs } = makeDeps({
    store: fake.store,
    redriveOnStart: () => {
      redriveCalls += 1;
      return Promise.resolve(2);
    },
  });
  const sweeper = new TranscriptDiscoverySweeper(deps);

  await sweeper.sweepOnce();
  await sweeper.sweepOnce();

  assert.equal(redriveCalls, 1, "guarded for the whole process lifetime");
  assert.equal(
    logs.filter((m) => m.includes("redrove 2 dead-lettered row")).length,
    1
  );
});

test("runOneShotRedrive: an unwired redriveOnStart is a silent no-op", async () => {
  const fake = makeFakeStore();
  const { deps, logs } = makeDeps({ store: fake.store });
  await new TranscriptDiscoverySweeper(deps).sweepOnce();

  assert.ok(!logs.some((m) => m.includes("redrove")));
});

// --- materialize --------------------------------------------------------------

test("runMaterialize: a rejecting materialize is logged best-effort and discovery still runs", async () => {
  const fake = makeFakeStore();
  const refs = [ref("sess-1")];
  const { deps, logs } = makeDeps({
    store: fake.store,
    discover: () => refs,
    materialize: () => Promise.reject(new Error("opencode.db locked")),
  });
  await new TranscriptDiscoverySweeper(deps).sweepOnce();

  assert.ok(
    logs.some((m) =>
      m.includes("transcript materialize failed: opencode.db locked")
    )
  );
  assert.equal(
    fake.observed.length,
    1,
    "discovery still ran after the failure"
  );
});

test("ISS-8600: runMaterialize reports a failed pass and stays silent on a deliberate cancel", async () => {
  // The production wiring, driven end to end: the sweep's own catch is what
  // classifies, so deleting the call site leaves this red rather than green.
  const reported: (MaterializeImportHealthEvent | "called")[] = [];
  const sweepWith = async (materialize: () => Promise<void>): Promise<void> => {
    const { deps } = makeDeps({
      discover: () => [ref("sess-1")],
      materialize,
      noteMaterializeOutcome: (kind) => reported.push(kind),
    });
    await new TranscriptDiscoverySweeper(deps).sweepOnce();
  };

  await sweepWith(() =>
    Promise.reject(
      new OpencodeMaterializeError(
        OpencodeMaterializeFailure.TimedOut,
        "opencode materialize worker timed out"
      )
    )
  );
  await sweepWith(() =>
    Promise.reject(
      new OpencodeMaterializeError(
        OpencodeMaterializeFailure.Failed,
        "opencode materialize worker exited with code 1"
      )
    )
  );
  // The cancel `TranscriptSyncService.stop()` produces on a clean quit. It
  // arrives through the identical catch as the two above, so nothing but the
  // typed reason can keep it out of the record set.
  await sweepWith(() =>
    Promise.reject(
      new OpencodeMaterializeError(
        OpencodeMaterializeFailure.Canceled,
        "opencode materialize worker stopped"
      )
    )
  );
  // And a pass that simply worked.
  await sweepWith(() => Promise.resolve());

  assert.deepEqual(reported, [
    ImportHealthEvent.MaterializeTimedOut,
    ImportHealthEvent.MaterializeFailed,
  ]);
});

test("ISS-8600: a throwing outcome sink neither fails the pass nor aborts discovery", async () => {
  const fake = makeFakeStore();
  const { deps, logs } = makeDeps({
    store: fake.store,
    discover: () => [ref("sess-1")],
    materialize: () => Promise.reject(new Error("opencode.db locked")),
    noteMaterializeOutcome: () => {
      throw new Error("telemetry seam exploded");
    },
  });

  await new TranscriptDiscoverySweeper(deps).sweepOnce();

  assert.ok(
    logs.some((m) =>
      m.includes("transcript materialize failed: opencode.db locked")
    ),
    "the existing failure log is unchanged by the report"
  );
  assert.equal(
    fake.observed.length,
    1,
    "a throwing telemetry sink must not abort the discovery sweep"
  );
});

test("ISS-8600: two sweeps joined on one failed pass report exactly one record", async () => {
  // The REAL runner, because its single-flight is the subject: `sweepOnce` has
  // none of its own and is called from the start path and from the tier/policy
  // kick, so two sweeps overlap routinely and both await the SAME pass promise.
  // A rejection then runs both sweeps' catch, and one failed pass would arrive
  // as N records -- inflating the exact count this signal is counted by.
  const reported: MaterializeImportHealthEvent[] = [];
  const { children, forkWorker } = fakeOpencodeMaterializeWorkerFork();
  const runner = createUtilityProcessOpencodeMaterializeRunner({
    stateDir: "/state",
    forkWorker,
  });
  const { deps, logs } = makeDeps({
    discover: () => [ref("sess-1")],
    materialize: () => runner.materialize(),
    noteMaterializeOutcome: (kind) => reported.push(kind),
  });
  const sweeper = new TranscriptDiscoverySweeper(deps);

  const first = sweeper.sweepOnce();
  const second = sweeper.sweepOnce();
  await flush();
  assert.equal(children.length, 1, "the second sweep must join the same pass");

  children[0]?.emit("exit", 1);
  await Promise.all([first, second]);

  assert.deepEqual(
    reported,
    [ImportHealthEvent.MaterializeFailed],
    "one failed pass owes one record however many sweeps awaited it"
  );
  // Both sweeps really did run the classify-and-report catch, so the single
  // record above is the suppression working and not one sweep never arriving.
  assert.equal(
    logs.filter((m) => m.includes("transcript materialize failed")).length,
    2,
    "each sweep still logs that its own discovery ran without fresh projections"
  );
});

test("ISS-8600: a single sweep over a failed pass still reports it", async () => {
  // The counterfactual the suppression must not swallow: suppressing the
  // FOLLOWER is correct, suppressing the owner would silence the signal
  // entirely and still satisfy the exactly-one assertion above.
  const reported: MaterializeImportHealthEvent[] = [];
  const { children, forkWorker } = fakeOpencodeMaterializeWorkerFork();
  const runner = createUtilityProcessOpencodeMaterializeRunner({
    stateDir: "/state",
    forkWorker,
  });
  const { deps } = makeDeps({
    discover: () => [ref("sess-1")],
    materialize: () => runner.materialize(),
    noteMaterializeOutcome: (kind) => reported.push(kind),
  });

  const sweep = new TranscriptDiscoverySweeper(deps).sweepOnce();
  await flush();
  children[0]?.emit("exit", 1);
  await sweep;

  assert.deepEqual(reported, [ImportHealthEvent.MaterializeFailed]);
});

test("runMaterialize: an unwired materialize is a no-op and discovery still runs", async () => {
  const fake = makeFakeStore();
  const refs = [ref("sess-1")];
  const { deps } = makeDeps({ store: fake.store, discover: () => refs });
  await new TranscriptDiscoverySweeper(deps).sweepOnce();

  assert.equal(fake.observed.length, 1);
});

// --- observeRefsBounded --------------------------------------------------------

test("observeRefsBounded: a failing ref is skipped and logged without blocking later refs in the batch", async () => {
  const fake = makeFakeStore();
  const refs = [ref("bad"), ref("good")];
  const { deps, logs } = makeDeps({
    store: fake.store,
    discover: () => refs,
    statFile: (path) =>
      path.includes("bad")
        ? Promise.reject(new Error("EIO on read"))
        : Promise.resolve({ size: 1, mtimeMs: 1 }),
  });
  await new TranscriptDiscoverySweeper(deps).sweepOnce();

  assert.equal(fake.observed.length, 1);
  assert.equal(fake.observed[0].externalSessionId, "good");
  assert.ok(
    logs.some((m) =>
      m.includes(
        "transcript sweep skipped /p/bad.jsonl (bad/main): EIO on read"
      )
    )
  );
});

test("sweepOnce: the summary log names the skip count only when something was skipped", async () => {
  const failing = makeFakeStore();
  const failingRefs = [ref("bad"), ref("good")];
  const { deps: failingDeps, logs: failingLogs } = makeDeps({
    store: failing.store,
    discover: () => failingRefs,
    statFile: (path) =>
      path.includes("bad")
        ? Promise.reject(new Error("EIO"))
        : Promise.resolve({ size: 1, mtimeMs: 1 }),
  });
  await new TranscriptDiscoverySweeper(failingDeps).sweepOnce();
  assert.ok(
    failingLogs.some((m) =>
      m.includes("transcript sweep observed 1 of 2 file(s) (1 skipped)")
    )
  );

  const clean = makeFakeStore();
  const cleanRefs = [ref("a"), ref("b")];
  const { deps: cleanDeps, logs: cleanLogs } = makeDeps({
    store: clean.store,
    discover: () => cleanRefs,
  });
  await new TranscriptDiscoverySweeper(cleanDeps).sweepOnce();
  assert.ok(
    cleanLogs.some((m) => m.includes("transcript sweep observed 2 file(s)")),
    "a clean sweep must not mention a skip count"
  );
});

test("observeRefsBounded: processes refs in fixed-size batches, not all at once", async () => {
  const fake = makeFakeStore();
  const refs = [ref("a"), ref("b"), ref("c")];
  const starts: string[] = [];
  const resolvers: Array<() => void> = [];
  const { deps } = makeDeps({
    store: fake.store,
    discover: () => refs,
    concurrency: 2,
    statFile: (path) => {
      starts.push(path);
      return new Promise((resolve) => {
        resolvers.push(() => resolve({ size: 1, mtimeMs: 1 }));
      });
    },
  });
  const sweeper = new TranscriptDiscoverySweeper(deps);

  const donePromise = sweeper.sweepOnce();
  await flush();
  assert.equal(starts.length, 2, "only the first fixed-size batch starts");

  for (const resolve of resolvers.splice(0)) {
    resolve();
  }
  await flush();
  assert.equal(
    starts.length,
    3,
    "the next batch starts once the first settles"
  );

  for (const resolve of resolvers.splice(0)) {
    resolve();
  }
  await donePromise;
});

test("observeRefsBounded: a concurrency of 0 still processes refs one at a time (floored to 1)", async () => {
  const fake = makeFakeStore();
  const refs = [ref("a"), ref("b")];
  const { deps } = makeDeps({
    store: fake.store,
    discover: () => refs,
    concurrency: 0,
  });
  await new TranscriptDiscoverySweeper(deps).sweepOnce();

  assert.equal(
    fake.observed.length,
    2,
    "a non-positive concurrency never stalls the sweep"
  );
});
