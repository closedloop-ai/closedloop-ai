/**
 * @file transcript-sync-activity.test.ts
 * @description FEA-3640 — the SHARED live-activity trigger for the transcript
 * archive lane. The ~5 min flush used to be armed only by the Claude hook
 * channel, so every watcher-mode harness (Codex especially) reached the cloud
 * solely via the 30-min discovery sweep. These cover the harness-agnostic
 * `enqueueActivity` entry point for a session's MAIN transcript: the debounced
 * live enqueue, max-wait semantics, the shared debounce key across both
 * live-capture channels, the harnesses deliberately left to the sweep, and the
 * trust/tier/flag gates.
 *
 * The ISS-4390 extension of this trigger to CHILD transcripts is covered in
 * `transcript-sync-child-refs.test.ts`, and the hook channel's sidecar sweep in
 * `transcript-sync-sidecar-sweep.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fakeScheduler,
  fakeStore,
  flush,
  makeService,
} from "./helpers/transcript-sync-fixtures.js";

test("FEA-3640: watcher activity debounces then enqueues a Codex transcript live", async () => {
  // The reported bug: a live Codex session only reached the cloud via the 30-min
  // discovery sweep because the ~5 min activity flush was armed exclusively by
  // the Claude hook channel. The watcher channel must ride the same cadence.
  const store = fakeStore();
  const sched = fakeScheduler();
  const { service } = makeService({ store, scheduler: sched.scheduler });

  service.enqueueActivity({
    harness: "codex",
    externalSessionId: "rollout-9",
    sourcePath: "/c/sessions/2026/07/27/rollout-9.jsonl",
  });
  assert.equal(store.observed.length, 0); // debounced, not immediate
  assert.equal(sched.timeouts.length, 1);

  sched.timeouts[0](); // fire the ~5 min max-wait timer
  await flush();

  assert.equal(store.observed.length, 1);
  assert.equal(store.observed[0].externalSessionId, "rollout-9");
  assert.equal(store.observed[0].fileKey, "main");
  assert.equal(store.observed[0].sourceHarness, "codex");
  assert.equal(store.observed[0].syncClass, "live");
});

test("FEA-3640: watcher activity is max-wait — repeat activity does not re-arm or starve the flush", async () => {
  const store = fakeStore();
  const sched = fakeScheduler();
  const { service } = makeService({ store, scheduler: sched.scheduler });

  for (let i = 0; i < 5; i++) {
    service.enqueueActivity({
      harness: "codex",
      externalSessionId: "rollout-9",
      sourcePath: "/c/sessions/rollout-9.jsonl",
    });
  }
  // One armed timer for the file, not one per event: a continuously-active
  // session must still flush on a steady cadence.
  assert.equal(sched.timeouts.length, 1);

  sched.timeouts[0]();
  await flush();
  assert.equal(store.observed.length, 1);
});

test("FEA-3640: watcher activity shares one debounce with the Claude hook channel", () => {
  // Both live-capture channels key on (externalSessionId, main), so a harness
  // running BOTH cannot arm two competing timers for the same file.
  const store = fakeStore();
  const sched = fakeScheduler();
  const { service } = makeService({ store, scheduler: sched.scheduler });

  service.enqueueClaudeHook({
    hookType: "PostToolUse",
    sessionId: "sess-9",
    transcriptPath: "/p/sess-9.jsonl",
  });
  service.enqueueActivity({
    harness: "claude",
    externalSessionId: "sess-9",
    sourcePath: "/p/sess-9.jsonl",
  });

  assert.equal(sched.timeouts.length, 1);
});

test("FEA-3640: a harness with no raw transcript in the archive lane is left to the sweep", async () => {
  // `cursor`/`copilot` have no archive-lane refs at all, and `opencode` is
  // BATCH-materialized (its collector source is the foreign opencode.db, not a
  // transcript), so enqueuing the changed path would archive the wrong bytes.
  const store = fakeStore();
  const sched = fakeScheduler();
  const { service } = makeService({ store, scheduler: sched.scheduler });

  for (const harness of ["cursor", "copilot", "opencode"]) {
    service.enqueueActivity({
      harness,
      externalSessionId: "sess-9",
      sourcePath: "/some/source",
    });
  }
  await flush();

  assert.equal(sched.timeouts.length, 0); // never armed
  assert.equal(store.observed.length, 0);
});

test("FEA-3640: watcher activity enqueues the guard-resolved real path", async () => {
  const store = fakeStore();
  const sched = fakeScheduler();
  const { service } = makeService({
    store,
    scheduler: sched.scheduler,
    trustPath: () => "/real/c/rollout-9.jsonl",
  });

  service.enqueueActivity({
    harness: "codex",
    externalSessionId: "rollout-9",
    sourcePath: "/c/alias.jsonl",
  });
  sched.timeouts[0]();
  await flush();

  assert.equal(store.observed.length, 1);
  assert.equal(store.observed[0].sourcePath, "/real/c/rollout-9.jsonl");
});

test("FEA-3640: watcher activity honors the consent tier", async () => {
  const store = fakeStore();
  const sched = fakeScheduler();
  const { service } = makeService({
    store,
    scheduler: sched.scheduler,
    tierAllowed: false,
  });

  service.enqueueActivity({
    harness: "codex",
    externalSessionId: "rollout-9",
    sourcePath: "/c/rollout-9.jsonl",
  });
  sched.timeouts[0]();
  await flush();

  assert.equal(store.observed.length, 0); // tier closed → queue not grown
});

test("FEA-3640: watcher activity is a no-op while the transcript flag is off", () => {
  const store = fakeStore();
  const sched = fakeScheduler();
  const { service } = makeService({
    store,
    scheduler: sched.scheduler,
    enabled: false,
  });

  service.enqueueActivity({
    harness: "codex",
    externalSessionId: "rollout-9",
    sourcePath: "/c/rollout-9.jsonl",
  });

  assert.equal(sched.timeouts.length, 0);
});
