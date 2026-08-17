/**
 * @file transcript-sync-service-hooks.test.ts
 * @description The transcript sync service's HOOK-TRIGGER path: terminal hooks
 * enqueue immediately, activity hooks debounce behind the max-wait timer, and
 * the FEA-2808/FEA-3464 trusted-path guard (canonicalized real path, benign
 * not-yet-flushed race handled silently, genuinely out-of-root path rejected
 * AND logged).
 *
 * #4195: split out of `transcript-sync-service.test.ts` so that suite stays
 * under the 1,000-line ceiling as the ISS-4695 terminal-skip cluster lands.
 * Shares the service fakes with its siblings via
 * `./helpers/transcript-sync-fixtures.js`; the FEA-3640 harness-agnostic
 * activity trigger has its own suite in `transcript-sync-activity.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fakeScheduler,
  fakeStore,
  flush,
  makeService,
} from "./helpers/transcript-sync-fixtures.js";

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

test("an activity hook for a not-yet-created transcript re-resolves when the timer fires (FEA-3464)", async () => {
  // SessionStart / the first UserPromptSubmit fire before the `<uuid>.jsonl` is
  // flushed. Resolution is deferred to the max-wait timer so the file resolves
  // once created — the benign race must NOT be logged as an untrusted rejection.
  const store = fakeStore();
  const sched = fakeScheduler();
  const logs: string[] = [];
  let flushedToDisk = false;
  const { service } = makeService({
    store,
    scheduler: sched.scheduler,
    log: (message) => logs.push(message),
    trustPath: () => (flushedToDisk ? "/real/p/sess-9.jsonl" : null),
    isPendingPath: () => !flushedToDisk, // under the root, not on disk yet
  });

  service.enqueueClaudeHook({
    hookType: "UserPromptSubmit",
    sessionId: "sess-9",
    transcriptPath: "/p/some-project/sess-9.jsonl",
  });
  // Armed, not resolved: no enqueue and — crucially — no rejection log.
  assert.equal(sched.timeouts.length, 1);
  assert.equal(store.observed.length, 0);
  assert.equal(logs.length, 0);

  flushedToDisk = true; // Claude Code flushes the transcript file.
  sched.timeouts[0](); // fire the ~5-min max-wait timer → re-resolve
  await flush();

  assert.equal(store.observed.length, 1);
  assert.equal(store.observed[0].sourcePath, "/real/p/sess-9.jsonl");
  assert.equal(store.observed[0].syncClass, "live");
  assert.equal(logs.length, 0); // never logged as an untrusted rejection
});

test("a terminal hook for a benign not-yet-created transcript is skipped silently, not logged (FEA-3464)", async () => {
  const store = fakeStore();
  const logs: string[] = [];
  const { service } = makeService({
    store,
    log: (message) => logs.push(message),
    trustPath: () => null, // absent → anchor rejects
    isPendingPath: () => true, // ...but it WOULD live under a trusted root
  });

  service.enqueueClaudeHook({
    hookType: "SessionEnd",
    sessionId: "sess-9",
    transcriptPath: "/p/some-project/sess-9.jsonl",
  });
  await flush();

  assert.equal(store.observed.length, 0);
  assert.equal(logs.length, 0); // benign race is not a rejection
});

test("a pending terminal hook preserves an armed activity retry timer (FEA-3464)", async () => {
  // Short session: an activity hook arms the ~5-min re-resolve timer while the
  // `<uuid>.jsonl` is still unflushed, then a terminal hook (Stop/SessionEnd)
  // arrives BEFORE the flush. The terminal branch must NOT clear the armed timer
  // for this benign race — otherwise the fast retry is lost and the transcript
  // falls back to the 30-min discovery sweep.
  const store = fakeStore();
  const sched = fakeScheduler();
  const logs: string[] = [];
  let flushedToDisk = false;
  const { service } = makeService({
    store,
    scheduler: sched.scheduler,
    log: (message) => logs.push(message),
    trustPath: () => (flushedToDisk ? "/real/p/sess-9.jsonl" : null),
    isPendingPath: () => !flushedToDisk, // under the root, not on disk yet
  });

  service.enqueueClaudeHook({
    hookType: "UserPromptSubmit",
    sessionId: "sess-9",
    transcriptPath: "/p/some-project/sess-9.jsonl",
  });
  assert.equal(sched.timeouts.length, 1); // retry timer armed

  // Terminal hook while still a pending race: must leave the timer armed.
  service.enqueueClaudeHook({
    hookType: "SessionEnd",
    sessionId: "sess-9",
    transcriptPath: "/p/some-project/sess-9.jsonl",
  });
  await flush();
  assert.equal(store.observed.length, 0);
  assert.equal(logs.length, 0); // benign race, never logged

  // The debounce key must still be tracked: a later activity hook re-uses the
  // armed timer instead of arming a second one. If the terminal branch had
  // cleared the debounce, this would arm a NEW timer (timeouts.length === 2).
  service.enqueueClaudeHook({
    hookType: "UserPromptSubmit",
    sessionId: "sess-9",
    transcriptPath: "/p/some-project/sess-9.jsonl",
  });
  assert.equal(sched.timeouts.length, 1); // still the single armed retry timer

  flushedToDisk = true; // Claude Code flushes the transcript file.
  sched.timeouts[0](); // the surviving timer fires → re-resolve + enqueue
  await flush();

  assert.equal(store.observed.length, 1);
  assert.equal(store.observed[0].sourcePath, "/real/p/sess-9.jsonl");
});

test("a genuinely out-of-root hook path is still rejected AND logged (FEA-3464 security)", async () => {
  const store = fakeStore();
  const logs: string[] = [];
  const { service } = makeService({
    store,
    log: (message) => logs.push(message),
    trustPath: () => null, // resolves outside every trusted root
    isPendingPath: () => false, // not a race — a real untrusted path
  });

  service.enqueueClaudeHook({
    hookType: "SessionEnd",
    sessionId: "sess-9",
    transcriptPath: "/etc/shadow.jsonl",
  });
  await flush();

  assert.equal(store.observed.length, 0);
  assert.equal(logs.length, 1);
  assert.ok(logs[0].includes("rejected untrusted path"));
});
