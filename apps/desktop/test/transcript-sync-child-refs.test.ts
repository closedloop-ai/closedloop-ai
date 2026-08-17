/**
 * @file transcript-sync-child-refs.test.ts
 * @description ISS-4390 — child/sidechain transcripts ride the same ~5 min live
 * flush as their session's `main`, on the WATCHER channel.
 *
 * The reported bug: the collector seam maps a child watch event back to its ROOT
 * import source (Codex `findCodexRootSource`, Claude's `subagents/` → parent
 * fold), so a child-only edit armed a no-op flush of the unchanged root and the
 * file that actually grew waited for the 30-min discovery sweep. These cover the
 * per-file debounce keying, the injected child-ref resolver seam, and the
 * degradations that must leave a child to the sweep rather than archive it under
 * a guessed key.
 *
 * The base FEA-3640 main-transcript trigger is covered in
 * `transcript-sync-activity.test.ts`, the hook channel's sidecar sweep in
 * `transcript-sync-sidecar-sweep.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deferred,
  fakeScheduler,
  fakeStore,
  flush,
  makeService,
} from "./helpers/transcript-sync-fixtures.js";

/**
 * ISS-4390 fake child-key resolver: keys a child by its basename. The REAL
 * derivation (Claude relId path math, Codex rollout head-read) is covered in
 * `live-transcript-ref-resolver.test.ts`, including its byte-exact agreement
 * with what the discovery sweep produces; these service tests only care that a
 * child is routed through the seam and enqueued under whatever it returns.
 */
const fakeChildKey = (
  _harness: string,
  _mapped: string,
  changedPath: string
): Promise<string> =>
  Promise.resolve(`subagent:${changedPath.split("/").pop()}`);

test("ISS-4390: a changed Codex child rollout enqueues under its own subagent ref", async () => {
  // The reported bug: the collector maps a child-rollout watch event back to the
  // ROOT source, so the lane observed the (unchanged) root `main` and the child
  // that actually grew waited for the 30-min sweep.
  const observed = deferred();
  const store = fakeStore([], () => observed.resolve());
  const sched = fakeScheduler();
  const { service } = makeService({
    store,
    scheduler: sched.scheduler,
    resolveLiveRef: fakeChildKey,
  });

  service.enqueueActivity({
    harness: "codex",
    externalSessionId: "rollout-root",
    sourcePath: "/c/sessions/rollout-root.jsonl",
    changedPaths: ["/c/sessions/rollout-child.jsonl"],
  });
  sched.timeouts[0]();
  await observed.promise;

  assert.equal(store.observed.length, 1);
  assert.equal(store.observed[0].externalSessionId, "rollout-root");
  assert.equal(store.observed[0].fileKey, "subagent:rollout-child.jsonl");
  assert.equal(
    store.observed[0].sourcePath,
    "/c/sessions/rollout-child.jsonl",
    "the CHILD's bytes are archived, not the root's"
  );
});

test("ISS-4390: a changed Claude sidecar enqueues under its own subagent ref", async () => {
  const observed = deferred();
  const store = fakeStore([], () => observed.resolve());
  const sched = fakeScheduler();
  const { service } = makeService({
    store,
    scheduler: sched.scheduler,
    resolveLiveRef: fakeChildKey,
  });

  service.enqueueActivity({
    harness: "claude",
    externalSessionId: "sess-1",
    sourcePath: "/p/proj/sess-1.jsonl",
    changedPaths: ["/p/proj/sess-1/subagents/agent-abc.jsonl"],
  });
  sched.timeouts[0]();
  await observed.promise;

  assert.equal(store.observed.length, 1);
  assert.equal(store.observed[0].externalSessionId, "sess-1");
  assert.equal(store.observed[0].fileKey, "subagent:agent-abc.jsonl");
});

test("ISS-4390: a child-only change does not enqueue the unchanged root main", async () => {
  const observed = deferred();
  const store = fakeStore([], () => observed.resolve());
  const sched = fakeScheduler();
  const { service } = makeService({
    store,
    scheduler: sched.scheduler,
    resolveLiveRef: fakeChildKey,
  });

  service.enqueueActivity({
    harness: "codex",
    externalSessionId: "rollout-root",
    sourcePath: "/c/sessions/rollout-root.jsonl",
    changedPaths: ["/c/sessions/rollout-child.jsonl"],
  });
  assert.equal(sched.timeouts.length, 1, "one arm for the one changed file");
  sched.timeouts[0]();
  await observed.promise;

  assert.equal(
    store.observed.filter((o) => o.fileKey === "main").length,
    0,
    "the untouched root must not be re-enqueued"
  );
});

test("ISS-4390: main and a child changing together arm two independent timers", async () => {
  // Before the per-file key, `debounceTimers.has(key)` was checked against a
  // session-wide (sessionId, "main") key, so a main-armed timer swallowed every
  // child arm for that session.
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
    resolveLiveRef: fakeChildKey,
  });

  service.enqueueActivity({
    harness: "claude",
    externalSessionId: "sess-1",
    sourcePath: "/p/proj/sess-1.jsonl",
    changedPaths: [
      "/p/proj/sess-1.jsonl",
      "/p/proj/sess-1/subagents/agent-abc.jsonl",
    ],
  });

  assert.equal(sched.timeouts.length, 2);
  for (const fire of sched.timeouts) {
    fire();
  }
  await both.promise;

  const keys = store.observed.map((o) => o.fileKey).sort();
  assert.deepEqual(keys, ["main", "subagent:agent-abc.jsonl"]);
});

test("ISS-4390: activity with no changed paths keeps the legacy main-only behavior", async () => {
  // Back-compat: boot/backfill imports and any caller that does not report
  // changed paths must behave exactly as before this change.
  const observed = deferred();
  const store = fakeStore([], () => observed.resolve());
  const sched = fakeScheduler();
  const { service } = makeService({
    store,
    scheduler: sched.scheduler,
    resolveLiveRef: fakeChildKey,
  });

  service.enqueueActivity({
    harness: "codex",
    externalSessionId: "rollout-9",
    sourcePath: "/c/sessions/rollout-9.jsonl",
  });
  sched.timeouts[0]();
  await observed.promise;

  assert.equal(store.observed.length, 1);
  assert.equal(store.observed[0].fileKey, "main");
});

test("ISS-4390: an unwired child resolver leaves the child to the sweep", async () => {
  // Degrade-safe: archiving a child under a GUESSED key would not match the key
  // the discovery sweep computes, duplicating the object. Doing nothing costs
  // the child at most the 30-min sweep — the pre-ISS-4390 status quo.
  const store = fakeStore();
  const sched = fakeScheduler();
  const { service } = makeService({ store, scheduler: sched.scheduler });

  service.enqueueActivity({
    harness: "codex",
    externalSessionId: "rollout-root",
    sourcePath: "/c/sessions/rollout-root.jsonl",
    changedPaths: ["/c/sessions/rollout-child.jsonl"],
  });
  sched.timeouts[0]();
  await flush();

  assert.equal(store.observed.length, 0);
});

test("ISS-4390: a throwing child resolver is logged and does not reject the drain", async () => {
  const logged: string[] = [];
  const store = fakeStore();
  const sched = fakeScheduler();
  const { service } = makeService({
    store,
    scheduler: sched.scheduler,
    log: (message) => logged.push(message),
    resolveLiveRef: () => Promise.reject(new Error("unreadable rollout")),
  });

  service.enqueueActivity({
    harness: "codex",
    externalSessionId: "rollout-root",
    sourcePath: "/c/sessions/rollout-root.jsonl",
    changedPaths: ["/c/sessions/rollout-child.jsonl"],
  });
  sched.timeouts[0]();
  await flush();

  assert.equal(store.observed.length, 0);
  assert.ok(
    logged.some((m) => m.includes("unreadable rollout")),
    "the resolve failure is surfaced, not swallowed silently"
  );
});

test("ISS-4390: a null child key drops the enqueue instead of filing under main", async () => {
  // The regression this guards: `sourcePath` at this point is the CHILD's path,
  // so falling back to `main` would advance the MAIN transcript's byte cursor
  // over the child's bytes — corrupting main's archive, not just duplicating it.
  const logged: string[] = [];
  const store = fakeStore();
  const sched = fakeScheduler();
  const { service } = makeService({
    store,
    scheduler: sched.scheduler,
    log: (message) => logged.push(message),
    resolveLiveRef: () => Promise.resolve(null),
  });

  service.enqueueActivity({
    harness: "claude",
    externalSessionId: "sess-1",
    sourcePath: "/p/proj/sess-1.jsonl",
    changedPaths: ["/elsewhere/agent-abc.jsonl"],
  });
  sched.timeouts[0]();
  await flush();

  assert.equal(
    store.observed.length,
    0,
    "an unresolvable child must not be archived under ANY key"
  );
  assert.ok(logged.some((m) => m.includes("unresolved")));
});

test("ISS-4390: hook and watcher child enqueues share one debounce key", () => {
  // Both live-capture channels must key a given child identically, so a harness
  // seen by both cannot arm two competing timers for one sidecar.
  const store = fakeStore();
  const sched = fakeScheduler();
  const { service } = makeService({
    store,
    scheduler: sched.scheduler,
    resolveLiveRef: fakeChildKey,
  });

  const changedPaths = ["/p/proj/sess-1/subagents/agent-abc.jsonl"];
  service.enqueueActivity({
    harness: "claude",
    externalSessionId: "sess-1",
    sourcePath: "/p/proj/sess-1.jsonl",
    changedPaths,
  });
  service.enqueueActivity({
    harness: "claude",
    externalSessionId: "sess-1",
    sourcePath: "/p/proj/sess-1.jsonl",
    changedPaths,
  });

  assert.equal(sched.timeouts.length, 1, "one timer for the one sidecar");
});

test("ISS-4390: a terminal main hook does not tear down a child's armed timer", async () => {
  // A `Stop` flushes main immediately; a child with an armed timer still fires
  // within the debounce window and flushes itself. Clearing children here would
  // drop them onto the 30-min sweep — the exact lag this issue fixes.
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
    resolveLiveRef: fakeChildKey,
  });

  service.enqueueActivity({
    harness: "claude",
    externalSessionId: "sess-1",
    sourcePath: "/p/proj/sess-1.jsonl",
    changedPaths: ["/p/proj/sess-1/subagents/agent-abc.jsonl"],
  });
  assert.equal(sched.timeouts.length, 1);

  service.enqueueClaudeHook({
    hookType: "Stop",
    sessionId: "sess-1",
    transcriptPath: "/p/proj/sess-1.jsonl",
  });
  // The child's timer survived the terminal clear and still flushes.
  sched.timeouts[0]();
  await both.promise;

  const keys = store.observed.map((o) => o.fileKey).sort();
  assert.deepEqual(keys, ["main", "subagent:agent-abc.jsonl"]);
});
