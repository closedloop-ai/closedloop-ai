/**
 * @file transcript-sync-sidecar-sweep.test.ts
 * @description ISS-4390 slice 2 — the Claude HOOK channel's subagent-sidecar
 * flush (`transcript-sidecar-sweep.ts`).
 *
 * A `SubagentStop` payload names the PARENT `transcript_path`, never the sidecar
 * that just finished, so this lane enumerates the session's sidecars and
 * enqueues the ones carrying new bytes instead of resolving one known file.
 * These cover the changed-detection unit (RAW size/mtime, never the redacted
 * byte cursor), the hook types that do and do not sweep, per-ref error
 * isolation, the session/path identity binding, and the consent-tier gate.
 *
 * This path is DORMANT in current production — `CLAUDE_LIVE_HOOK_ENABLED` is
 * hardcoded false (FEA-3729) — and is written and tested against the day that
 * kill switch flips. The live watcher equivalent is covered in
 * `transcript-sync-child-refs.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deferred,
  fakeScheduler,
  fakeStore,
  fingerprint,
  flush,
  makeService,
} from "./helpers/transcript-sync-fixtures.js";

test("ISS-4390: SubagentStop enqueues a sidecar that has new bytes", async () => {
  // On a hooks-installed install Claude's watcher never runs, so this channel is
  // the only live path — and `SubagentStop` names the PARENT transcript, never
  // the sidecar that just finished.
  let observeCount = 0;
  const both = deferred();
  const store = fakeStore([], () => {
    observeCount += 1;
    if (observeCount === 2) {
      both.resolve();
    }
  });
  const sched = fakeScheduler();
  const { service } = makeService({
    store,
    scheduler: sched.scheduler,
    statFile: () => Promise.resolve({ size: 500, mtimeMs: 1 }),
    listSubagentRefs: () =>
      Promise.resolve([
        {
          fileKey: "subagent:agent-abc",
          sourcePath: "/p/proj/sess-1/subagents/agent-abc.jsonl",
        },
      ]),
  });

  service.enqueueClaudeHook({
    hookType: "SubagentStop",
    sessionId: "sess-1",
    transcriptPath: "/p/proj/sess-1.jsonl",
  });
  await both.promise;

  const sidecar = store.observed.find(
    (o) => o.fileKey === "subagent:agent-abc"
  );
  assert.ok(sidecar, "the finished sidecar must be enqueued");
  assert.equal(
    sidecar.sourcePath,
    "/p/proj/sess-1/subagents/agent-abc.jsonl",
    "the SIDECAR's bytes are archived, not the parent's"
  );
});

test("ISS-4390: an unreadable sidecar does not abort the sweep for later ones", async () => {
  // Per-ref isolation. Without it, one rejected stat/store read drops every
  // LATER sidecar onto the 30-min pass.
  const observed = deferred();
  const store = fakeStore([], (input) => {
    if (input.fileKey === "subagent:agent-good") {
      observed.resolve();
    }
  });
  const sched = fakeScheduler();
  const { service } = makeService({
    store,
    scheduler: sched.scheduler,
    statFile: (p) =>
      p.includes("agent-bad")
        ? Promise.reject(new Error("EIO on sidecar"))
        : Promise.resolve({ size: 42, mtimeMs: 7 }),
    listSubagentRefs: () =>
      Promise.resolve([
        {
          fileKey: "subagent:agent-bad",
          sourcePath: "/p/proj/sess-1/subagents/agent-bad.jsonl",
        },
        {
          fileKey: "subagent:agent-good",
          sourcePath: "/p/proj/sess-1/subagents/agent-good.jsonl",
        },
      ]),
  });

  service.enqueueClaudeHook({
    hookType: "SubagentStop",
    sessionId: "sess-1",
    transcriptPath: "/p/proj/sess-1.jsonl",
  });
  await observed.promise;

  assert.ok(
    store.observed.some((o) => o.fileKey === "subagent:agent-good"),
    "a later sidecar still queues after an earlier one fails"
  );
});

test("ISS-4390: the sidecar sweep rejects a mismatched session/path pair", async () => {
  // The hook endpoint is unauthenticated localhost, so the session id and the
  // transcript path arrive as an attacker-choosable PAIR. The trust guard proves
  // the path is under a trusted root, not that it belongs to the claimed
  // session — unbound, one session's sidecars land in another's namespace.
  let listCalls = 0;
  const store = fakeStore();
  const sched = fakeScheduler();
  const { service } = makeService({
    store,
    scheduler: sched.scheduler,
    listSubagentRefs: () => {
      listCalls += 1;
      return Promise.resolve([]);
    },
  });

  service.enqueueClaudeHook({
    hookType: "SubagentStop",
    sessionId: "attacker-chosen-session",
    transcriptPath: "/p/proj/sess-1.jsonl",
  });
  await flush();

  assert.equal(listCalls, 0, "a mismatched pair must not enumerate sidecars");
  assert.equal(
    store.observed.filter((o) => o.fileKey.startsWith("subagent:")).length,
    0
  );
});

test("ISS-4390: SubagentStop skips a sidecar already fully uploaded", async () => {
  // Changed-detection is size vs the persisted byte cursor, so a sidecar whose
  // bytes are all uploaded must not grow the queue with a no-op enqueue.
  const mainObserved = deferred();
  const store = fakeStore([], (input) => {
    if (input.fileKey === "main") {
      mainObserved.resolve();
    }
  });
  store.rows.set(
    "sess-1/subagent:agent-abc",
    fingerprint({
      externalSessionId: "sess-1",
      fileKey: "subagent:agent-abc",
      lastSize: 500,
      lastMtimeMs: 1,
      // Deliberately NOT equal to lastSize: syncedByteOffset is a cursor into
      // the REDACTED object, and the skip must not key off it.
      syncedByteOffset: 320,
    })
  );
  const sched = fakeScheduler();
  const { service } = makeService({
    store,
    scheduler: sched.scheduler,
    statFile: () => Promise.resolve({ size: 500, mtimeMs: 1 }),
    listSubagentRefs: () =>
      Promise.resolve([
        {
          fileKey: "subagent:agent-abc",
          sourcePath: "/p/proj/sess-1/subagents/agent-abc.jsonl",
        },
      ]),
  });

  service.enqueueClaudeHook({
    hookType: "SubagentStop",
    sessionId: "sess-1",
    transcriptPath: "/p/proj/sess-1.jsonl",
  });
  await mainObserved.promise;
  await flush();

  assert.equal(
    store.observed.filter((o) => o.fileKey === "subagent:agent-abc").length,
    0,
    "a fully-uploaded sidecar must not be re-enqueued"
  );
});

test("ISS-4390: SubagentStop enqueues a sidecar that has grown past its cursor", async () => {
  let observeCount = 0;
  const both = deferred();
  const store = fakeStore([], () => {
    observeCount += 1;
    if (observeCount === 2) {
      both.resolve();
    }
  });
  store.rows.set(
    "sess-1/subagent:agent-abc",
    fingerprint({
      externalSessionId: "sess-1",
      fileKey: "subagent:agent-abc",
      lastSize: 100,
      lastMtimeMs: 1,
      syncedByteOffset: 100,
    })
  );
  const sched = fakeScheduler();
  const { service } = makeService({
    store,
    scheduler: sched.scheduler,
    statFile: () => Promise.resolve({ size: 900, mtimeMs: 1 }),
    listSubagentRefs: () =>
      Promise.resolve([
        {
          fileKey: "subagent:agent-abc",
          sourcePath: "/p/proj/sess-1/subagents/agent-abc.jsonl",
        },
      ]),
  });

  service.enqueueClaudeHook({
    hookType: "SubagentStop",
    sessionId: "sess-1",
    transcriptPath: "/p/proj/sess-1.jsonl",
  });
  await both.promise;

  assert.ok(
    store.observed.some((o) => o.fileKey === "subagent:agent-abc"),
    "new bytes past the cursor must re-enqueue"
  );
});

test("ISS-4390: a redacted cursor larger than the raw file does not suppress the enqueue", async () => {
  // `syncedByteOffset` indexes the REDACTED archive object, and redaction is
  // not length-preserving — `[REDACTED:<label>]` can be longer than the token it
  // replaces. Comparing raw `stat.size` against it would skip a sidecar with
  // genuinely unuploaded raw bytes, stranding it on the 30-min sweep while the
  // desktop status row reads as caught up.
  const observed = deferred();
  const store = fakeStore([], (input) => {
    if (input.fileKey === "subagent:agent-abc") {
      observed.resolve();
    }
  });
  store.rows.set(
    "sess-1/subagent:agent-abc",
    fingerprint({
      externalSessionId: "sess-1",
      fileKey: "subagent:agent-abc",
      lastSize: 400,
      lastMtimeMs: 1,
      syncedByteOffset: 9000, // redacted object ran far longer than the raw file
    })
  );
  const sched = fakeScheduler();
  const { service } = makeService({
    store,
    scheduler: sched.scheduler,
    statFile: () => Promise.resolve({ size: 500, mtimeMs: 2 }),
    listSubagentRefs: () =>
      Promise.resolve([
        {
          fileKey: "subagent:agent-abc",
          sourcePath: "/p/proj/sess-1/subagents/agent-abc.jsonl",
        },
      ]),
  });

  service.enqueueClaudeHook({
    hookType: "SubagentStop",
    sessionId: "sess-1",
    transcriptPath: "/p/proj/sess-1.jsonl",
  });
  await observed.promise;

  assert.ok(
    store.observed.some((o) => o.fileKey === "subagent:agent-abc"),
    "raw bytes grew, so the sidecar must queue regardless of the redacted cursor"
  );
});

test("ISS-4390: the hook sidecar sweep honors the consent tier", async () => {
  const store = fakeStore();
  const sched = fakeScheduler();
  const { service } = makeService({
    store,
    scheduler: sched.scheduler,
    tierAllowed: false,
    listSubagentRefs: () =>
      Promise.resolve([
        {
          fileKey: "subagent:agent-abc",
          sourcePath: "/p/proj/sess-1/subagents/agent-abc.jsonl",
        },
      ]),
  });

  service.enqueueClaudeHook({
    hookType: "SubagentStop",
    sessionId: "sess-1",
    transcriptPath: "/p/proj/sess-1.jsonl",
  });
  await flush();

  assert.equal(store.observed.length, 0);
});

test("ISS-4390: a failing sidecar enumeration does not break the main flush", async () => {
  const mainObserved = deferred();
  const logged: string[] = [];
  const store = fakeStore([], (input) => {
    if (input.fileKey === "main") {
      mainObserved.resolve();
    }
  });
  const sched = fakeScheduler();
  const { service } = makeService({
    store,
    scheduler: sched.scheduler,
    log: (message) => logged.push(message),
    listSubagentRefs: () => Promise.reject(new Error("subagents unreadable")),
  });

  service.enqueueClaudeHook({
    hookType: "SubagentStop",
    sessionId: "sess-1",
    transcriptPath: "/p/proj/sess-1.jsonl",
  });
  await mainObserved.promise;
  await flush();

  assert.equal(
    store.observed.filter((o) => o.fileKey === "main").length,
    1,
    "the main transcript still flushes"
  );
  assert.ok(logged.some((m) => m.includes("subagents unreadable")));
});

test("ISS-4390: Stop does not sweep sidecars — only SubagentStop does", async () => {
  // `Stop` fires once per TURN. Sweeping there would re-stat and re-read the
  // whole sidecar set every turn (O(turns × sidecars)) to find work that
  // SubagentStop — which fires exactly when a sidecar becomes final — already
  // reports. Anything genuinely missed is still covered by the 30-min sweep.
  let listCalls = 0;
  const mainObserved = deferred();
  const store = fakeStore([], (input) => {
    if (input.fileKey === "main") {
      mainObserved.resolve();
    }
  });
  const sched = fakeScheduler();
  const { service } = makeService({
    store,
    scheduler: sched.scheduler,
    listSubagentRefs: () => {
      listCalls += 1;
      return Promise.resolve([]);
    },
  });

  for (const hookType of ["Stop", "SessionEnd"]) {
    service.enqueueClaudeHook({
      hookType,
      sessionId: "sess-1",
      transcriptPath: "/p/proj/sess-1.jsonl",
    });
  }
  await mainObserved.promise;
  await flush();

  assert.equal(listCalls, 0, "per-turn hooks must not enumerate sidecars");
});
