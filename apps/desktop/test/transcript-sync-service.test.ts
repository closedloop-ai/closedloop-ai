/**
 * @file transcript-sync-service.test.ts
 * @description FEA-2715 orchestrator with fake store/executor + a fake scheduler.
 * Covers bounded-concurrency drain, exponential backoff + consecutive-failure
 * dead-lettering, the flag/connectivity no-op, hook triggers (terminal immediate
 * vs activity debounce), and the discovery sweep (startup mini-backfill).
 *
 * Shared fakes live in `./helpers/transcript-sync-fixtures`; the FEA-3640
 * harness-agnostic activity trigger has its own suite in
 * `transcript-sync-activity.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TranscriptSkipReason,
  TranscriptUploadStatus,
} from "@repo/api/src/types/desktop-transcripts";
import {
  type TranscriptSyncExecutor,
  TranscriptSyncRevokedError,
} from "../src/main/transcript-sync/transcript-sync-executor.js";
import type {
  TranscriptFileRef,
  TranscriptFingerprint,
} from "../src/main/transcript-sync/transcript-sync-types.js";
import {
  emptyTranscriptStatusCounts,
  TranscriptEgressGate,
} from "../src/shared/transcript-sync-status-contract.js";
import {
  fakeExecutor,
  fakeScheduler,
  fakeStore,
  fingerprint,
  flush,
  makeService,
} from "./helpers/transcript-sync-fixtures.js";

type Deferred = { promise: Promise<void>; resolve: () => void };
function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
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
  const executor = fakeExecutor({
    syncFile: () => {
      throw new Error("upload failed");
    },
  });
  const store = fakeStore([fingerprint({ retryCount: 0 })]);
  const { service } = makeService({ store, executor });

  await service.drainOnce();
  assert.equal(store.failures.length, 1);
  assert.equal(store.failures[0].retryCount, 1);
  assert.equal(store.failures[0].dead, false);
  // exponential base = 30s for the first retry.
  assert.equal(store.failures[0].nextAttemptAt, "2026-07-09T00:00:30.000Z");
});

test("the fifth consecutive failure dead-letters the file once the cloud acknowledged the skip", async () => {
  // ISS-4621: the generic dead-letter is ack-gated — the row goes `dead` only
  // after the cloud acknowledged a `retries_exhausted` terminal skip, so the
  // read path derives `failedPermanent` instead of an eternal `syncing`.
  const executor = fakeExecutor({
    syncFile: () => {
      throw new Error("still failing");
    },
    skipAck: true,
  });
  const store = fakeStore([fingerprint({ retryCount: 4 })]);
  const { service } = makeService({ store, executor });

  await service.drainOnce();
  assert.equal(store.failures[0].retryCount, 5);
  assert.equal(store.failures[0].dead, true);
  assert.equal(store.failures[0].nextAttemptAt, null);
  assert.deepEqual(executor.skipNotifications, [
    {
      key: "sess:main",
      reason: TranscriptSkipReason.RetriesExhausted,
      computeTargetId: null,
    },
  ]);
});

test("the terminal skip is pinned to the target the failed attempt ran against (ISS-4621)", async () => {
  // A reconnect between the attempt and the skip must not record the terminal
  // state under the NEW target while the original target's cloud row stays
  // `syncing` — the service snapshots the target before the attempt.
  const executor = fakeExecutor({
    syncFile: () => {
      throw new Error("still failing");
    },
  });
  const store = fakeStore([fingerprint({ retryCount: 4 })]);
  const { service } = makeService({
    store,
    executor,
    getComputeTargetId: () => "ct-attempt",
  });

  await service.drainOnce();
  assert.equal(executor.skipNotifications[0]?.computeTargetId, "ct-attempt");
});

test("the fifth consecutive failure stays retryable when the cloud skip is NOT acknowledged (ISS-4621)", async () => {
  // The ack failed (offline / transport error): the row must NOT go `dead` — a
  // dead row is invisible to re-observation unless the file changes, so the
  // cloud would show `syncing` forever with no failure reason. Instead the row
  // stays on the backoff ladder and the whole transition re-runs next drain.
  const executor = fakeExecutor({
    syncFile: () => {
      throw new Error("still failing");
    },
    skipAck: false,
  });
  const store = fakeStore([fingerprint({ retryCount: 4 })]);
  const { service } = makeService({ store, executor });

  await service.drainOnce();
  assert.equal(store.failures[0].retryCount, 5);
  assert.equal(store.failures[0].dead, false);
  // attempt 5 on the shared ladder: 30s * 2^4 = 8 min.
  assert.equal(store.failures[0].nextAttemptAt, "2026-07-09T00:08:00.000Z");
  assert.equal(executor.skipNotifications.length, 1);
});

test("ISS-4695: the fifth consecutive failure settles the row READABLE (not failed) when the cloud already holds the upload (status uploaded)", async () => {
  // The retry ladder is exhausted, but the terminal `retries_exhausted` skip
  // comes back `uploaded` — a verified archive already exists (the server
  // refused to mask it). Dead-lettering here would project `failedPermanent`
  // for a transcript the cloud actually has; and recording ANOTHER failed
  // backoff attempt would make the panel read "sync failed" for an archive the
  // cloud can read (wongk's ISS-4695 review point). The row settles `idle`
  // (readable) instead of staying on the retry ladder.
  const executor = fakeExecutor({
    syncFile: () => {
      throw new Error("still failing");
    },
    skipAck: true,
    skipStatus: TranscriptUploadStatus.Uploaded,
  });
  const store = fakeStore([fingerprint({ retryCount: 4 })]);
  const { service } = makeService({ store, executor });

  await service.drainOnce();
  // No new failed/backoff attempt was recorded — the row is NOT kept on the
  // retry ladder for an already-uploaded archive.
  assert.equal(store.failures.length, 0);
  // The row was settled readable, so re-observation resolves it as synced
  // rather than failed. ISS-4815: through the DURABLE cloud-uploaded terminal,
  // NOT a bare `markIdle` — a bare idle at a zero cursor is exactly what the
  // stranded-blob recovery re-arms on the next launch.
  assert.deepEqual(store.cloudUploadedSettles, ["sess:main"]);
  assert.equal(store.idleCalls, 0);
  // The skip WAS emitted; it just settled uploaded instead of dead-lettering.
  assert.equal(executor.skipNotifications.length, 1);
});

test("an under-threshold failure never emits a terminal skip notification", async () => {
  // The blob is still on the normal retry ladder — telling the cloud it is
  // permanently skipped would be a lie (`failedPermanent` for a transcript the
  // desktop is about to retry).
  const executor = fakeExecutor({
    syncFile: () => {
      throw new Error("first failure");
    },
  });
  const store = fakeStore([fingerprint({ retryCount: 0 })]);
  const { service } = makeService({ store, executor });

  await service.drainOnce();
  assert.equal(store.failures[0].dead, false);
  assert.equal(executor.skipNotifications.length, 0);
});

test("a mid-upload revocation re-queues the row without dead-lettering or a retry (ISS-4621)", async () => {
  // FEA-3907: the executor threw because the privacy gate revoked egress while
  // the upload was in flight. That is not a failure — no bytes escaped — so the
  // service must NOT record a backoff failure or advance the retry ladder.
  // ISS-4621: the row settles back to `queued`, NOT `idle` — an idle row only
  // re-queues when the file CHANGES, and an ended session's transcript never
  // changes again, so idling stranded it at zero bytes forever (SES-78221).
  // Queued costs nothing while the gate is closed (shouldRun suppresses the
  // drain) and resumes as soon as the tier reopens.
  const executor = fakeExecutor({
    syncFile: () => {
      throw new TranscriptSyncRevokedError();
    },
  });
  const store = fakeStore([fingerprint({ retryCount: 3 })]);
  const { service } = makeService({ store, executor });

  await service.drainOnce();
  assert.equal(store.failures.length, 0, "no backoff failure on a revocation");
  assert.equal(store.idleCalls, 0, "never settles to the absorbing idle state");
  assert.deepEqual(store.revokedRequeues, ["sess:main"]);
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

test("the transcript lane is suppressed when the consent tier disallows it", async () => {
  // PRD-532 §7 fix-forward for the #2985 P1: only the `full` tier permits
  // session CONTENTS to leave the machine. When the tier gate reports false
  // (tier `metadata`/`local`, or not-yet-consented `null`), shouldRun() must be
  // false so the executor is NEVER touched — even though the feature flag is on
  // and the lane is online with a ready file.
  const calls: string[] = [];
  const executor = {
    syncFile: (fp: TranscriptFingerprint) => {
      calls.push(fp.externalSessionId);
      return Promise.resolve({ kind: "noop" as const });
    },
  } as TranscriptSyncExecutor;
  const { service } = makeService({
    store: fakeStore([fingerprint()]),
    executor,
    enabled: true,
    online: true,
    tierAllowed: false,
  });

  await service.drainOnce();
  assert.equal(
    calls.length,
    0,
    "no transcript contents may leave the machine when the tier disallows it"
  );
});

test("the transcript lane runs when the consent tier allows it", async () => {
  // A `full` tier leaves current behavior unchanged.
  const calls: string[] = [];
  const executor = {
    syncFile: (fp: TranscriptFingerprint) => {
      calls.push(fp.externalSessionId);
      return Promise.resolve({ kind: "noop" as const });
    },
  } as TranscriptSyncExecutor;
  const { service } = makeService({
    store: fakeStore([fingerprint({ externalSessionId: "allowed" })]),
    executor,
    enabled: true,
    online: true,
    tierAllowed: true,
  });

  await service.drainOnce();
  assert.deepEqual(calls, ["allowed"]);
});

test("the first sweep requeues crash-stranded uploading rows exactly once", async () => {
  const store = fakeStore();
  const { service } = makeService({ store });

  await service.sweepOnce();
  await service.sweepOnce();
  // Boot recovery is one-shot per start (not repeated every 30-min sweep).
  assert.equal(store.requeueCalls, 1);
});

test("ISS-4647: stranded missing-blob recovery runs on EVERY sweep, not once per boot", async () => {
  const store = fakeStore();
  store.strandedRequeueResult = 3; // pretend 3 stranded rows were re-armed
  const { service } = makeService({ store });

  await service.sweepOnce();
  await service.sweepOnce();
  await service.sweepOnce();
  // Stranding is not a boot-only condition: a row settled `idle` at zero bytes
  // mid-session strands as soon as its file stops changing, long after the boot
  // sweep. A one-shot latch never revisited it.
  assert.equal(store.strandedRequeueCalls, 3);
});

test("ISS-4647: the stranded re-arm is scoped to the CURRENT compute target", async () => {
  const store = fakeStore();
  const { service } = makeService({
    store,
    getComputeTargetId: () => "ct-current",
  });

  await service.sweepOnce();

  // Without the target the recovery cannot tell "the cloud has these bytes" from
  // "a previous target's cloud had them", so a vanished source with an old-target
  // cursor would stay excluded.
  assert.deepEqual(store.strandedRequeueTargets, ["ct-current"]);
});

test("ISS-4647: a rejected stranded re-arm does NOT abort the sweep and retries next sweep", async () => {
  const store = fakeStore();
  const logs: string[] = [];
  let calls = 0;
  store.requeueStrandedMissingBlobs = () => {
    calls += 1;
    return calls === 1
      ? Promise.reject(new Error("db-host busy"))
      : Promise.resolve(2);
  };
  const { service } = makeService({
    store,
    log: (message) => logs.push(message),
    discover: () => [
      {
        externalSessionId: "sess-1",
        fileKey: "main",
        sourceHarness: "claude",
        sourcePath: "/p/sess-1.jsonl",
      },
    ],
  });

  await service.sweepOnce();

  // Recovery is a repair lane, not a precondition: a failing db-host must not
  // take discovery down with it (it runs at the TOP of sweepOnce), and the
  // failure must be visible.
  assert.equal(store.observed.length, 1, "discovery still ran");
  assert.ok(logs.some((line) => line.includes("db-host busy")));

  // And it is re-attempted next sweep — the pre-ISS-4647 latch was set BEFORE
  // the mutation ran, so one rejection retired the recovery for good.
  await service.sweepOnce();
  assert.equal(calls, 2);
});

test("ISS-4647: a rejected stale-upload recovery does NOT abort the sweep and retries next sweep", async () => {
  const store = fakeStore();
  const logs: string[] = [];
  let calls = 0;
  store.requeueStale = () => {
    calls += 1;
    return calls === 1
      ? Promise.reject(new Error("db-host busy"))
      : Promise.resolve(1);
  };
  const { service } = makeService({
    store,
    log: (message) => logs.push(message),
  });

  await service.sweepOnce();
  assert.ok(logs.some((line) => line.includes("db-host busy")));

  // The latch is not burned by a failure, so the next sweep re-attempts it — and
  // once it succeeds the one-shot semantics resume (no third call).
  await service.sweepOnce();
  await service.sweepOnce();
  assert.equal(calls, 2);
});

test("stranded missing-blob recovery runs even while the consent tier is closed (ISS-4621)", async () => {
  // It only RE-ARMS existing rows (never grows the queue with new files) and the
  // drain's own shouldRun still gates egress by tier, so it must run before the
  // tier gate — otherwise a tier-off install could never terminate a stranded
  // transcript. Mirrors the requeueStale boot-recovery placement.
  const store = fakeStore();
  const { service } = makeService({ store, tierAllowed: false });

  await service.sweepOnce();

  assert.equal(store.strandedRequeueCalls, 1);
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

test("an overlapping drainOnce refills a free slot mid-batch (FEA-3388)", async () => {
  // A slow in-flight upload must NOT block a concurrent drain (the 5s tick or a
  // live hook enqueue) from starting another file in the still-free slot — the
  // old batch-wide `draining` guard held every slot until the slowest upload
  // finished, defeating live-first preemption and the ~5min freshness intent.
  const gates = new Map<string, Deferred>();
  const started: string[] = [];
  const executor = {
    syncFile: (fp: TranscriptFingerprint) => {
      started.push(fp.externalSessionId);
      const gate = deferred();
      gates.set(fp.externalSessionId, gate);
      return gate.promise.then(() => ({ kind: "noop" as const }));
    },
  } as TranscriptSyncExecutor;
  const store = fakeStore([fingerprint({ externalSessionId: "slow" })]);
  const { service } = makeService({ store, executor });

  const first = service.drainOnce(); // claims 'slow', then blocks on its upload
  await flush();
  assert.deepEqual(started, ["slow"]);

  // A live file arrives while 'slow' is still uploading; a second drain must be
  // able to claim the idle slot without waiting for 'slow' to finish.
  store.ready = [
    fingerprint({ externalSessionId: "slow" }),
    fingerprint({ externalSessionId: "live" }),
  ];
  const second = service.drainOnce();
  await flush();
  assert.deepEqual(
    started,
    ["slow", "live"],
    "the second drain filled the free slot while the first was still in flight"
  );

  gates.get("slow")?.resolve();
  gates.get("live")?.resolve();
  await Promise.all([first, second]);
});

test("overlapping drains never exceed the concurrency cap (FEA-3388)", async () => {
  // Dropping the `draining` guard must not let two concurrent drains
  // over-subscribe: the synchronous claim loop re-reads inFlight.size, so the
  // cap holds even when both drains read the same ready list.
  const gates = new Map<string, Deferred>();
  let active = 0;
  let maxActive = 0;
  const executor = {
    syncFile: (fp: TranscriptFingerprint) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const gate = deferred();
      gates.set(fp.externalSessionId, gate);
      return gate.promise.then(() => {
        active -= 1;
        return { kind: "noop" as const };
      });
    },
  } as TranscriptSyncExecutor;
  const store = fakeStore([
    fingerprint({ externalSessionId: "a" }),
    fingerprint({ externalSessionId: "b" }),
    fingerprint({ externalSessionId: "c" }),
    fingerprint({ externalSessionId: "d" }),
  ]);
  const { service } = makeService({ store, executor });

  // Fire two drains "simultaneously" (a tick racing a live enqueue).
  const drains = [service.drainOnce(), service.drainOnce()];
  await flush();
  assert.ok(
    maxActive <= 2,
    `concurrency cap breached: ${maxActive} uploads ran at once`
  );

  for (const gate of gates.values()) {
    gate.resolve();
  }
  await Promise.all(drains);
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

test("sweepOnce does not enqueue rows the drain can't process when the tier is closed (FEA-3463)", async () => {
  // The drain (shouldRun) early-returns while the tier gate is closed, so if the
  // sweep still observed files they'd sit `queued` forever and the queue would
  // grow every 30-min sweep. The sweep must skip the discovery write entirely.
  const store = fakeStore();
  const refs: TranscriptFileRef[] = [
    {
      externalSessionId: "s1",
      fileKey: "main",
      sourceHarness: "claude",
      sourcePath: "/p/s1.jsonl",
    },
  ];
  const { service } = makeService({
    store,
    discover: () => refs,
    tierAllowed: false,
  });

  await service.sweepOnce();
  assert.equal(
    store.observed.length,
    0,
    "no queued rows may be written while the consent tier is closed"
  );
});

test("sweepOnce still runs one-shot boot recovery even when the tier is closed", async () => {
  // Reviving crash-stranded `uploading` rows is bounded (it doesn't grow the
  // queue) and keeps DB state honest, so it must run before the tier short-circuit.
  const store = fakeStore();
  const { service } = makeService({ store, tierAllowed: false });

  await service.sweepOnce();
  assert.equal(store.requeueCalls, 1);
  assert.equal(store.observed.length, 0);
});

test("a closed tier logs suppression once, then re-logs after a reopen→reclose", async () => {
  const logs: string[] = [];
  let allowed = false;
  const { service } = makeService({
    tierAllowedFn: () => allowed,
    log: (message) => logs.push(message),
  });

  const suppressed = () =>
    logs.filter((m) => m.includes("suppressed by consent tier")).length;

  await service.sweepOnce();
  await service.sweepOnce();
  assert.equal(suppressed(), 1, "suppression is logged once, not every sweep");

  allowed = true;
  await service.sweepOnce(); // reopen resets the one-shot guard
  allowed = false;
  await service.sweepOnce();
  assert.equal(suppressed(), 2, "a later re-closure logs again");
});

test("a live hook does not enqueue when the consent tier is closed (FEA-3463)", async () => {
  const store = fakeStore();
  const { service } = makeService({ store, tierAllowed: false });

  service.enqueueClaudeHook({
    hookType: "Stop",
    sessionId: "sess-9",
    transcriptPath: "/p/sess-9.jsonl",
  });
  await flush();

  assert.equal(
    store.observed.length,
    0,
    "no live queued rows while the consent tier is closed"
  );
});

test("a debounce timer armed while the tier was open drops the row if the tier closes before it fires (FEA-3463)", async () => {
  // The activity-hook debounce arms a ~5-min timer; the tier can close in that
  // window. Because the gate is at the write point (enqueueAndDrain), the timer
  // firing after the tier closes must NOT observe a row the drain can't process.
  const store = fakeStore();
  const sched = fakeScheduler();
  let allowed = true;
  const { service } = makeService({
    store,
    scheduler: sched.scheduler,
    tierAllowedFn: () => allowed,
  });

  service.enqueueClaudeHook({
    hookType: "PostToolUse",
    sessionId: "sess-9",
    transcriptPath: "/p/sess-9.jsonl",
  });
  assert.equal(sched.timeouts.length, 1); // armed while tier open

  allowed = false; // user revokes consent before the max-wait timer fires
  sched.timeouts[0]();
  await flush();

  assert.equal(
    store.observed.length,
    0,
    "a debounce firing after the tier closes must not enqueue an un-drainable row"
  );
});

test("a failing observe on one file does not prevent later files from being queued (FEA-3475)", async () => {
  // AC-6: per-item error isolation in observeRefsBounded — one bad observe
  // (SQLite/IPC error, pathological path) must not abort the whole sweep and
  // starve subsequent files in discovery order.
  const observedPaths: string[] = [];
  const store = fakeStore();
  const originalObserve = store.observe.bind(store);
  store.observe = (input) => {
    if (input.sourcePath === "/bad/path.jsonl") {
      return Promise.reject(new Error("simulated SQLite error"));
    }
    observedPaths.push(input.sourcePath);
    return originalObserve(input);
  };

  const refs: TranscriptFileRef[] = [
    {
      externalSessionId: "s1",
      fileKey: "main",
      sourceHarness: "claude",
      sourcePath: "/good/before.jsonl",
    },
    {
      externalSessionId: "s2",
      fileKey: "main",
      sourceHarness: "claude",
      sourcePath: "/bad/path.jsonl",
    },
    {
      externalSessionId: "s3",
      fileKey: "main",
      sourceHarness: "claude",
      sourcePath: "/good/after.jsonl",
    },
  ];

  const logs: string[] = [];
  // Use concurrency: 1 so each ref is its own batch iteration, proving
  // isolation works per-item (not just per-batch) in the sequential path.
  const { service } = makeService({
    store,
    discover: () => refs,
    log: (message) => logs.push(message),
    concurrency: 1,
  });

  await service.sweepOnce();

  assert.ok(
    observedPaths.includes("/good/before.jsonl"),
    "file before the bad one must be observed"
  );
  assert.ok(
    observedPaths.includes("/good/after.jsonl"),
    "file after the bad one must not be starved"
  );
  assert.ok(
    logs.some(
      (l) =>
        l.includes("transcript sweep skipped") && l.includes("/bad/path.jsonl")
    ),
    "skipped file must be logged with its path"
  );
});

test("ISS-5348: getStatusSnapshot reports the whole-table status census, not a sampled window", async () => {
  // The snapshot used to map the newest 100 ROWS. That was an unindexed
  // full-table sort on every 5s poll, and a sample: a device whose only
  // dead-lettered rows were older than the window reported a clean lane. It now
  // reads counts over every row.
  const store = fakeStore();
  store.counts = {
    ...emptyTranscriptStatusCounts(),
    queued: 3,
    failed: 1,
  };
  const { service } = makeService({ store, enabled: true, online: false });

  const snapshot = await service.getStatusSnapshot();

  assert.equal(store.statusCountsCalls, 1);
  // The expensive ordered read is no longer on the polled path at all.
  assert.deepEqual(store.recentLimits, []);
  assert.equal(snapshot.enabled, true);
  assert.equal(snapshot.online, false);
  assert.deepEqual(snapshot.statusCounts, {
    idle: 0,
    queued: 3,
    uploading: 0,
    failed: 1,
    dead: 0,
  });
});

test("getStatusSnapshot returns a zero census and skips the store read when unavailable", async () => {
  const { service } = makeService({ store: null });

  const snapshot = await service.getStatusSnapshot();

  assert.deepEqual(snapshot.statusCounts, emptyTranscriptStatusCounts());
});

test("FEA-3932: sweepOnce materializes BEFORE discovery so discovery sees fresh files", async () => {
  const order: string[] = [];
  const { service } = makeService({
    materialize: () => {
      order.push("materialize");
    },
    discover: () => {
      order.push("discover");
      return [];
    },
  });
  await service.sweepOnce();
  assert.deepEqual(order, ["materialize", "discover"]);
});

test("FEA-3932: a materialize failure does not abort the discovery sweep", async () => {
  let discovered = false;
  const { service } = makeService({
    materialize: () => {
      throw new Error("db locked");
    },
    discover: () => {
      discovered = true;
      return [];
    },
  });
  await service.sweepOnce();
  assert.equal(discovered, true);
});

test("FEA-3932: materialize is suppressed while the consent tier is closed", async () => {
  let materialized = false;
  const { service } = makeService({
    tierAllowed: false,
    materialize: () => {
      materialized = true;
    },
  });
  await service.sweepOnce();
  assert.equal(materialized, false);
});

test("FEA-3932: redriveOnStart runs exactly once across repeated sweeps", async () => {
  let redriveCalls = 0;
  const { service } = makeService({
    redriveOnStart: () => {
      redriveCalls += 1;
      return Promise.resolve(2);
    },
  });
  await service.sweepOnce();
  await service.sweepOnce();
  assert.equal(redriveCalls, 1);
});

test("FEA-3932: redriveOnStart does NOT fire (or burn its latch) while the consent tier is closed", async () => {
  let redriveCalls = 0;
  let tierOpen = false;
  const { service } = makeService({
    tierAllowedFn: () => tierOpen,
    redriveOnStart: () => {
      redriveCalls += 1;
      return Promise.resolve(2);
    },
  });
  // Tier closed: the sweep suppresses growth AND the redrive (it runs below the
  // tier gate now), so the one-shot latch is NOT burned.
  await service.sweepOnce();
  assert.equal(redriveCalls, 0);
  // Tier reopens: the redrive fires on the next sweep because the latch survived.
  tierOpen = true;
  await service.sweepOnce();
  assert.equal(redriveCalls, 1);
});

test("ISS-4716: getStatusSnapshot exposes the tier and store preconditions shouldRun() gates on", async () => {
  // `enabled` alone is just the persisted toggle. A consumer that reads only it
  // describes a lane that cannot run as if it were healthy — which is exactly
  // the misleading footer this ticket removes.
  const { service } = makeService({
    enabled: true,
    online: true,
    tierAllowed: false,
  });

  const snapshot = await service.getStatusSnapshot();

  assert.equal(snapshot.enabled, true);
  assert.equal(snapshot.tierGate, TranscriptEgressGate.Denied);
  assert.equal(snapshot.storeReady, true);
});

test("ISS-4716: getStatusSnapshot reports storeReady false when the store is not up", async () => {
  const { service } = makeService({ store: null, enabled: true });

  const snapshot = await service.getStatusSnapshot();

  assert.equal(snapshot.storeReady, false);
  assert.deepEqual(snapshot.statusCounts, emptyTranscriptStatusCounts());
});

test("ISS-4716: an unwired tier gate reports Allowed (the documented fail-open)", async () => {
  // `tierGate()` is `getCloudSyncTierGate?.() ?? Allowed`. The desktop factory
  // always wires it, so this pins the default as deliberate rather than letting
  // a future non-desktop construction silently claim consent.
  const { service } = makeService({ enabled: true, online: true });

  const snapshot = await service.getStatusSnapshot();

  assert.equal(snapshot.tierGate, TranscriptEgressGate.Allowed);
});

test("ISS-5348: an unresolved org policy surfaces as Unresolved but still blocks the drain", async () => {
  // The whole point of the tri-state: the SNAPSHOT can say "no verdict yet",
  // while egress keeps failing closed exactly as the boolean gate did.
  const synced: string[] = [];
  const executor = fakeExecutor({
    syncFile: (fp: TranscriptFingerprint) => {
      synced.push(fp.externalSessionId);
      return Promise.resolve({ kind: "noop" as const });
    },
  });
  const store = fakeStore([fingerprint({ externalSessionId: "s1" })]);
  const { service } = makeService({
    store,
    executor,
    enabled: true,
    online: true,
    tierGateFn: () => TranscriptEgressGate.Unresolved,
  });

  const snapshot = await service.getStatusSnapshot();
  assert.equal(snapshot.tierGate, TranscriptEgressGate.Unresolved);

  service.start();
  await flush();
  assert.deepEqual(
    synced,
    [],
    "an unresolved policy must not egress a single file"
  );
  service.stop();
});
