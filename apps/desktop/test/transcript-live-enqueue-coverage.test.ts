/**
 * @file transcript-live-enqueue-coverage.test.ts
 * @description ISS-8730 coverage for `TranscriptLiveEnqueue`
 * (`src/main/transcript-sync/transcript-live-enqueue.ts`) — the archive lane's
 * live-trigger class, exercised directly against a mocked
 * `TranscriptLiveEnqueueDeps` rather than through the full
 * `TranscriptSyncService`. Pins CURRENT behavior only; does not fix source.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  TranscriptLiveEnqueue,
  type TranscriptLiveEnqueueDeps,
} from "../src/main/transcript-sync/transcript-live-enqueue.js";
import type { TranscriptObserveDeps } from "../src/main/transcript-sync/transcript-observe.js";
import type {
  Scheduler,
  TimerHandle,
  TranscriptSyncServiceOptions,
} from "../src/main/transcript-sync/transcript-sync-options.js";
import type { TranscriptFileRef } from "../src/main/transcript-sync/transcript-sync-types.js";
import {
  TRANSCRIPT_MAIN_FILE_KEY,
  TRANSCRIPT_SYNC_ACTIVITY_DEBOUNCE_MS,
  TranscriptSourceHarness,
} from "../src/main/transcript-sync/transcript-sync-types.js";

type ArmedTimer = { handle: TimerHandle; fn: () => void; ms: number };

function makeScheduler() {
  const armed: ArmedTimer[] = [];
  const cleared: TimerHandle[] = [];
  let nextHandle = 1;
  const scheduler: Scheduler = {
    setInterval: () => 0 as unknown as TimerHandle,
    clearInterval: () => undefined,
    setTimeout: (fn, ms) => {
      const handle = nextHandle as unknown as TimerHandle;
      nextHandle += 1;
      armed.push({ handle, fn, ms });
      return handle;
    },
    clearTimeout: (handle) => {
      cleared.push(handle);
    },
  };
  return { scheduler, armed, cleared };
}

type DepsOverrides = {
  isEnabled?: () => boolean;
  resolveTrustedTranscriptPath?: (path: string) => string | null;
  isPendingTrustedTranscriptPath?: (path: string) => boolean;
  resolveLiveRef?: TranscriptSyncServiceOptions["resolveLiveRef"];
  listSubagentRefs?: TranscriptSyncServiceOptions["listSubagentRefs"];
  tierAllowsSync?: () => boolean;
  scheduler?: Scheduler;
};

function makeDeps(overrides: DepsOverrides = {}) {
  const logs: string[] = [];
  const runDetachedPromises: Promise<unknown>[] = [];
  const enqueueAndDrainCalls: TranscriptFileRef[] = [];
  const drainOnceCalls = { count: 0 };
  const getStoreCalls = { count: 0 };
  const sched = overrides.scheduler ? null : makeScheduler();
  const scheduler =
    overrides.scheduler ??
    (sched as ReturnType<typeof makeScheduler>).scheduler;

  const opts: TranscriptSyncServiceOptions = {
    getStore: () => {
      getStoreCalls.count += 1;
      return null;
    },
    buildExecutor: () => {
      throw new Error(
        "buildExecutor must not be called by TranscriptLiveEnqueue"
      );
    },
    discover: () => [],
    isEnabled: overrides.isEnabled ?? (() => true),
    isOnline: () => true,
    resolveTrustedTranscriptPath:
      overrides.resolveTrustedTranscriptPath ?? ((path) => path),
    isPendingTrustedTranscriptPath: overrides.isPendingTrustedTranscriptPath,
    resolveLiveRef: overrides.resolveLiveRef,
    listSubagentRefs: overrides.listSubagentRefs,
    statFile: () => Promise.resolve({ size: 10, mtimeMs: 1 }),
  };

  const observe: TranscriptObserveDeps = {
    statFile: () => Promise.resolve(null),
    hashPath: (path) => `hash:${path}`,
    getComputeTargetId: () => null,
    now: () => "2026-01-01T00:00:00.000Z",
  };

  const deps: TranscriptLiveEnqueueDeps = {
    opts,
    scheduler,
    observe,
    tierAllowsSync: overrides.tierAllowsSync ?? (() => true),
    log: (message) => logs.push(message),
    runDetached: (work) => {
      runDetachedPromises.push(work);
    },
    enqueueAndDrain: (ref) => {
      enqueueAndDrainCalls.push(ref);
      return Promise.resolve();
    },
    drainOnce: () => {
      drainOnceCalls.count += 1;
      return Promise.resolve();
    },
  };

  return {
    deps,
    logs,
    runDetachedPromises,
    enqueueAndDrainCalls,
    drainOnceCalls,
    getStoreCalls,
    armed: sched ? sched.armed : undefined,
    cleared: sched ? sched.cleared : undefined,
  };
}

async function flushRunDetached(runDetachedPromises: Promise<unknown>[]) {
  await Promise.all(runDetachedPromises);
}

// --- enqueueClaudeHook ------------------------------------------------------

test("enqueueClaudeHook: no-ops when the lane is disabled", () => {
  const { deps, armed } = makeDeps({ isEnabled: () => false });
  const enqueue = new TranscriptLiveEnqueue(deps);

  enqueue.enqueueClaudeHook({
    hookType: "Stop",
    sessionId: "sess-1",
    transcriptPath: "/p/sess-1.jsonl",
  });

  assert.equal(armed?.length, 0, "a disabled lane must arm nothing");
});

test("enqueueClaudeHook: no-ops when sessionId is missing", () => {
  const { deps, armed } = makeDeps();
  const enqueue = new TranscriptLiveEnqueue(deps);

  enqueue.enqueueClaudeHook({
    hookType: "Stop",
    transcriptPath: "/p/sess-1.jsonl",
  });

  assert.equal(armed?.length, 0);
});

test("enqueueClaudeHook: no-ops when transcriptPath is missing", () => {
  const { deps, armed } = makeDeps();
  const enqueue = new TranscriptLiveEnqueue(deps);

  enqueue.enqueueClaudeHook({ hookType: "Stop", sessionId: "sess-1" });

  assert.equal(armed?.length, 0);
});

test("enqueueClaudeHook: an untrusted, non-pending path is rejected and logged, no timer armed", () => {
  const { deps, armed, logs, runDetachedPromises } = makeDeps({
    resolveTrustedTranscriptPath: () => null,
    isPendingTrustedTranscriptPath: () => false,
  });
  const enqueue = new TranscriptLiveEnqueue(deps);

  enqueue.enqueueClaudeHook({
    hookType: "UserPromptSubmit",
    sessionId: "sess-1",
    transcriptPath: "/p/sess-1.jsonl",
  });

  assert.equal(armed?.length, 0);
  assert.equal(runDetachedPromises.length, 0);
  assert.ok(
    logs.some((m) => m.includes("rejected untrusted path")),
    "an untrusted path must be logged"
  );
});

test("enqueueClaudeHook: a pending untrusted ACTIVITY path arms the debounce without logging", () => {
  // FEA-3464: `SessionStart`/first `UserPromptSubmit` can fire before the
  // <uuid>.jsonl is flushed to disk — that benign race defers via the shared
  // activity debounce rather than logging a rejection.
  const { deps, armed, logs } = makeDeps({
    resolveTrustedTranscriptPath: () => null,
    isPendingTrustedTranscriptPath: () => true,
  });
  const enqueue = new TranscriptLiveEnqueue(deps);

  enqueue.enqueueClaudeHook({
    hookType: "UserPromptSubmit",
    sessionId: "sess-1",
    transcriptPath: "/p/sess-1.jsonl",
  });

  assert.equal(armed?.length, 1, "the benign race still arms a retry timer");
  assert.equal(armed?.[0].ms, TRANSCRIPT_SYNC_ACTIVITY_DEBOUNCE_MS);
  assert.equal(logs.length, 0, "a pending race must not log a rejection");
});

test("enqueueClaudeHook: a pending untrusted TERMINAL path is silently dropped", () => {
  // flushTerminalHook only enqueues an already-resolved path; a pending race
  // has no file to flush yet and must not arm or clear anything either.
  const { deps, armed, logs, runDetachedPromises } = makeDeps({
    resolveTrustedTranscriptPath: () => null,
    isPendingTrustedTranscriptPath: () => true,
  });
  const enqueue = new TranscriptLiveEnqueue(deps);

  enqueue.enqueueClaudeHook({
    hookType: "Stop",
    sessionId: "sess-1",
    transcriptPath: "/p/sess-1.jsonl",
  });

  assert.equal(armed?.length, 0);
  assert.equal(runDetachedPromises.length, 0);
  assert.equal(logs.length, 0);
});

test("enqueueClaudeHook: an activity hook arms one MAIN debounce timer at the shared cadence", () => {
  const { deps, armed } = makeDeps();
  const enqueue = new TranscriptLiveEnqueue(deps);

  enqueue.enqueueClaudeHook({
    hookType: "UserPromptSubmit",
    sessionId: "sess-1",
    transcriptPath: "/p/sess-1.jsonl",
  });

  assert.equal(armed?.length, 1);
  assert.equal(armed?.[0].ms, TRANSCRIPT_SYNC_ACTIVITY_DEBOUNCE_MS);
});

test("enqueueClaudeHook: a terminal hook flushes immediately and clears an armed MAIN debounce", async () => {
  const { deps, armed, cleared, runDetachedPromises, enqueueAndDrainCalls } =
    makeDeps();
  const enqueue = new TranscriptLiveEnqueue(deps);

  enqueue.enqueueClaudeHook({
    hookType: "UserPromptSubmit",
    sessionId: "sess-1",
    transcriptPath: "/p/sess-1.jsonl",
  });
  assert.equal(armed?.length, 1);
  const mainHandle = armed?.[0].handle;

  enqueue.enqueueClaudeHook({
    hookType: "Stop",
    sessionId: "sess-1",
    transcriptPath: "/p/sess-1.jsonl",
  });

  assert.deepEqual(cleared, [mainHandle]);
  await flushRunDetached(runDetachedPromises);
  assert.equal(enqueueAndDrainCalls.length, 1);
  assert.deepEqual(enqueueAndDrainCalls[0], {
    externalSessionId: "sess-1",
    fileKey: TRANSCRIPT_MAIN_FILE_KEY,
    sourceHarness: TranscriptSourceHarness.Claude,
    sourcePath: "/p/sess-1.jsonl",
  });
});

test("enqueueClaudeHook: SubagentStop sweeps sidecars, Stop/SessionEnd do not", async () => {
  for (const hookType of ["Stop", "SessionEnd"]) {
    const { deps, getStoreCalls, runDetachedPromises } = makeDeps({
      listSubagentRefs: () => Promise.resolve([]),
    });
    const enqueue = new TranscriptLiveEnqueue(deps);

    enqueue.enqueueClaudeHook({
      hookType,
      sessionId: "sess-1",
      transcriptPath: "/p/sess-1.jsonl",
    });
    await flushRunDetached(runDetachedPromises);

    assert.equal(
      getStoreCalls.count,
      0,
      `${hookType} must not attempt a sidecar sweep`
    );
  }

  const { deps, getStoreCalls, runDetachedPromises } = makeDeps({
    listSubagentRefs: () => Promise.resolve([]),
  });
  const enqueue = new TranscriptLiveEnqueue(deps);

  enqueue.enqueueClaudeHook({
    hookType: "SubagentStop",
    sessionId: "sess-1",
    transcriptPath: "/p/sess-1.jsonl",
  });
  await flushRunDetached(runDetachedPromises);

  assert.equal(
    getStoreCalls.count,
    1,
    "SubagentStop must attempt a sidecar sweep"
  );
});

// --- enqueueActivity ---------------------------------------------------------

test("enqueueActivity: no-ops when the lane is disabled", () => {
  const { deps, armed } = makeDeps({ isEnabled: () => false });
  const enqueue = new TranscriptLiveEnqueue(deps);

  enqueue.enqueueActivity({
    harness: "claude",
    externalSessionId: "sess-1",
    sourcePath: "/p/sess-1.jsonl",
  });

  assert.equal(armed?.length, 0);
});

test("enqueueActivity: no-ops when externalSessionId or sourcePath is empty", () => {
  const { deps, armed } = makeDeps();
  const enqueue = new TranscriptLiveEnqueue(deps);

  enqueue.enqueueActivity({
    harness: "claude",
    externalSessionId: "",
    sourcePath: "/p/sess-1.jsonl",
  });
  enqueue.enqueueActivity({
    harness: "claude",
    externalSessionId: "sess-1",
    sourcePath: "",
  });

  assert.equal(armed?.length, 0);
});

test("enqueueActivity: a batch-materialized harness (opencode) arms nothing", () => {
  // OpenCode's source is a foreign SQLite DB, not a raw transcript; enqueuing
  // its "path" from a single changed path would archive the wrong bytes.
  const { deps, armed } = makeDeps();
  const enqueue = new TranscriptLiveEnqueue(deps);

  enqueue.enqueueActivity({
    harness: TranscriptSourceHarness.OpenCode,
    externalSessionId: "sess-1",
    sourcePath: "/oc/sess-1.jsonl",
  });

  assert.equal(armed?.length, 0);
});

test("enqueueActivity: arms one timer per changed file; an unchanged main is not re-armed", () => {
  const { deps, armed } = makeDeps({
    resolveLiveRef: () => Promise.resolve("subagent:child-1"),
  });
  const enqueue = new TranscriptLiveEnqueue(deps);

  enqueue.enqueueActivity({
    harness: "claude",
    externalSessionId: "sess-1",
    sourcePath: "/p/proj/sess-1.jsonl",
    changedPaths: ["/p/proj/sess-1/subagents/agent-abc.jsonl"],
  });

  assert.equal(armed?.length, 1, "only the changed child arms a timer");
});

test("enqueueActivity: an already-armed key is not re-armed until it fires (max-wait)", () => {
  const { deps, armed } = makeDeps();
  const enqueue = new TranscriptLiveEnqueue(deps);

  enqueue.enqueueActivity({
    harness: "claude",
    externalSessionId: "sess-1",
    sourcePath: "/p/sess-1.jsonl",
  });
  enqueue.enqueueActivity({
    harness: "claude",
    externalSessionId: "sess-1",
    sourcePath: "/p/sess-1.jsonl",
  });

  assert.equal(armed?.length, 1, "continuous activity rides one timer");
});

// --- timer firing -------------------------------------------------------------

test("timer fires: clears its own map entry, allowing a fresh re-arm afterward", () => {
  const { deps, armed } = makeDeps();
  const enqueue = new TranscriptLiveEnqueue(deps);

  enqueue.enqueueActivity({
    harness: "claude",
    externalSessionId: "sess-1",
    sourcePath: "/p/sess-1.jsonl",
  });
  assert.equal(armed?.length, 1);
  (armed as ArmedTimer[])[0].fn();

  enqueue.enqueueActivity({
    harness: "claude",
    externalSessionId: "sess-1",
    sourcePath: "/p/sess-1.jsonl",
  });

  assert.equal(armed?.length, 2, "the fired key can be armed again");
});

test("timer fires: a still-untrusted path is silently dropped", async () => {
  let resolveCalls = 0;
  const { deps, armed, runDetachedPromises, enqueueAndDrainCalls } = makeDeps({
    resolveTrustedTranscriptPath: () => {
      resolveCalls += 1;
      return null;
    },
  });
  const enqueue = new TranscriptLiveEnqueue(deps);

  enqueue.enqueueActivity({
    harness: "claude",
    externalSessionId: "sess-1",
    sourcePath: "/p/sess-1.jsonl",
  });
  (armed as ArmedTimer[])[0].fn();
  await flushRunDetached(runDetachedPromises);

  assert.equal(resolveCalls, 1, "the path is re-resolved when the timer fires");
  assert.equal(enqueueAndDrainCalls.length, 0);
});

test("timer fires: a MAIN arm enqueues via enqueueAndDrain with fileKey main", async () => {
  const { deps, armed, runDetachedPromises, enqueueAndDrainCalls } = makeDeps();
  const enqueue = new TranscriptLiveEnqueue(deps);

  enqueue.enqueueActivity({
    harness: "codex",
    externalSessionId: "sess-1",
    sourcePath: "/c/sess-1.jsonl",
  });
  (armed as ArmedTimer[])[0].fn();
  await flushRunDetached(runDetachedPromises);

  assert.equal(enqueueAndDrainCalls.length, 1);
  assert.deepEqual(enqueueAndDrainCalls[0], {
    externalSessionId: "sess-1",
    fileKey: TRANSCRIPT_MAIN_FILE_KEY,
    sourceHarness: TranscriptSourceHarness.Codex,
    sourcePath: "/c/sess-1.jsonl",
  });
});

test("timer fires (child arm): an unwired resolveLiveRef silently drops the enqueue", async () => {
  const { deps, armed, runDetachedPromises, enqueueAndDrainCalls, logs } =
    makeDeps();
  const enqueue = new TranscriptLiveEnqueue(deps);

  enqueue.enqueueActivity({
    harness: "codex",
    externalSessionId: "sess-1",
    sourcePath: "/c/root.jsonl",
    changedPaths: ["/c/child.jsonl"],
  });
  (armed as ArmedTimer[])[0].fn();
  await flushRunDetached(runDetachedPromises);

  assert.equal(enqueueAndDrainCalls.length, 0);
  assert.equal(logs.length, 0, "no resolver wired means a silent drop");
});

test("timer fires (child arm): a throwing resolveLiveRef logs and drops the enqueue", async () => {
  const { deps, armed, runDetachedPromises, enqueueAndDrainCalls, logs } =
    makeDeps({
      resolveLiveRef: () => Promise.reject(new Error("rollout unreadable")),
    });
  const enqueue = new TranscriptLiveEnqueue(deps);

  enqueue.enqueueActivity({
    harness: "codex",
    externalSessionId: "sess-1",
    sourcePath: "/c/root.jsonl",
    changedPaths: ["/c/child.jsonl"],
  });
  (armed as ArmedTimer[])[0].fn();
  await flushRunDetached(runDetachedPromises);

  assert.equal(enqueueAndDrainCalls.length, 0);
  assert.ok(logs.some((m) => m.includes("rollout unreadable")));
});

test("timer fires (child arm): a null-resolving resolveLiveRef logs 'unresolved' and drops", async () => {
  const { deps, armed, runDetachedPromises, enqueueAndDrainCalls, logs } =
    makeDeps({
      resolveLiveRef: () => Promise.resolve(null),
    });
  const enqueue = new TranscriptLiveEnqueue(deps);

  enqueue.enqueueActivity({
    harness: "codex",
    externalSessionId: "sess-1",
    sourcePath: "/c/root.jsonl",
    changedPaths: ["/c/child.jsonl"],
  });
  (armed as ArmedTimer[])[0].fn();
  await flushRunDetached(runDetachedPromises);

  assert.equal(enqueueAndDrainCalls.length, 0);
  assert.ok(logs.some((m) => m.includes("unresolved")));
});

test("timer fires (child arm): a resolved key enqueues under the CHILD's sourcePath", async () => {
  const { deps, armed, runDetachedPromises, enqueueAndDrainCalls } = makeDeps({
    resolveLiveRef: () => Promise.resolve("subagent:child-1"),
  });
  const enqueue = new TranscriptLiveEnqueue(deps);

  enqueue.enqueueActivity({
    harness: "codex",
    externalSessionId: "sess-1",
    sourcePath: "/c/root.jsonl",
    changedPaths: ["/c/child.jsonl"],
  });
  (armed as ArmedTimer[])[0].fn();
  await flushRunDetached(runDetachedPromises);

  assert.equal(enqueueAndDrainCalls.length, 1);
  assert.deepEqual(enqueueAndDrainCalls[0], {
    externalSessionId: "sess-1",
    fileKey: "subagent:child-1",
    sourceHarness: TranscriptSourceHarness.Codex,
    sourcePath: "/c/child.jsonl",
  });
});

// --- stop() -------------------------------------------------------------------

test("stop(): clears every armed timer, and a cleared key can be re-armed", () => {
  const { deps, armed, cleared } = makeDeps();
  const enqueue = new TranscriptLiveEnqueue(deps);

  enqueue.enqueueActivity({
    harness: "claude",
    externalSessionId: "sess-1",
    sourcePath: "/p/sess-1.jsonl",
  });
  enqueue.enqueueActivity({
    harness: "claude",
    externalSessionId: "sess-2",
    sourcePath: "/p/sess-2.jsonl",
  });
  assert.equal(armed?.length, 2);
  const handles = (armed as ArmedTimer[]).map((t) => t.handle);

  enqueue.stop();

  assert.deepEqual(new Set(cleared), new Set(handles));

  enqueue.enqueueActivity({
    harness: "claude",
    externalSessionId: "sess-1",
    sourcePath: "/p/sess-1.jsonl",
  });
  assert.equal(armed?.length, 3, "a cleared key arms a fresh timer");
});

test("a terminal main hook does not clear a child's independently-armed timer", async () => {
  const { deps, armed, cleared, runDetachedPromises, enqueueAndDrainCalls } =
    makeDeps({
      resolveLiveRef: () => Promise.resolve("subagent:child-1"),
    });
  const enqueue = new TranscriptLiveEnqueue(deps);

  enqueue.enqueueActivity({
    harness: "claude",
    externalSessionId: "sess-1",
    sourcePath: "/p/proj/sess-1.jsonl",
    changedPaths: ["/p/proj/sess-1/subagents/agent-abc.jsonl"],
  });
  assert.equal(armed?.length, 1, "only the child armed — main never changed");

  enqueue.enqueueClaudeHook({
    hookType: "Stop",
    sessionId: "sess-1",
    transcriptPath: "/p/proj/sess-1.jsonl",
  });

  assert.equal(
    cleared?.length,
    0,
    "the main key was never armed, so the terminal clear finds nothing"
  );

  (armed as ArmedTimer[])[0].fn();
  await flushRunDetached(runDetachedPromises);

  assert.equal(
    enqueueAndDrainCalls.length,
    2,
    "main flush + child's own flush"
  );
  const keys = enqueueAndDrainCalls.map((c) => c.fileKey).sort();
  assert.deepEqual(keys, [TRANSCRIPT_MAIN_FILE_KEY, "subagent:child-1"]);
});
