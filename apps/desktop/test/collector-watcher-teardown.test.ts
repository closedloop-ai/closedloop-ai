/**
 * @file collector-watcher-teardown.test.ts
 * @description ISS-5154 — pins the `HarnessWatcher` teardown contract: `stop()`
 * must close EVERY handle it attached.
 *
 * `AttachedDirectoryWatcher.close(): void` is satisfied by a no-op, so before
 * this suite the teardown loop was entirely unasserted: a regression that
 * stopped closing attached roots would leave stale `fs.watch` handles firing
 * `scheduleImport` into a torn-down importer, and every collector suite would
 * stay green. The seam is where the contract is written down, so this is where
 * it is pinned.
 *
 * Kept out of `ingest-orchestrator.test.ts`: that suite is already far past the
 * file-size ceiling and this pins one narrow seam.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHarnessWatcher } from "../src/main/collectors/engine/watcher.js";
import {
  type RecordingDirectoryWatcher,
  recordingFsWatcher,
} from "./helpers/collector-manager-fixtures.js";

test("ISS-5154: stop() closes every attached watch handle", async () => {
  const base = mkdtempSync(join(tmpdir(), "harness-watcher-teardown-"));
  try {
    const rootA = join(base, "a");
    const rootB = join(base, "b");
    mkdirSync(rootA);
    mkdirSync(rootB);

    const handles: RecordingDirectoryWatcher[] = [];
    const watcher = createHarnessWatcher({
      roots: () => [rootA, rootB],
      match: () => true,
      runImport: () => Promise.resolve({ completed: true }),
      runInitialImport: false,
      catchupPollMs: null,
      watchDirectory: () => {
        const handle = recordingFsWatcher();
        handles.push(handle);
        return handle;
      },
    });

    await watcher.start();
    assert.equal(handles.length, 2, "both existing roots must attach");
    assert.deepEqual(
      handles.map((handle) => handle.closeCount()),
      [0, 0],
      "start() must not close the handles it just attached"
    );

    watcher.stop();
    assert.deepEqual(
      handles.map((handle) => handle.closeCount()),
      [1, 1],
      "stop() must close every attached root exactly once"
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("ISS-5154: a root that appears after stop() is not left attached", async () => {
  // The teardown loop also clears `attached`, so a restart re-attaches rather
  // than silently reusing a closed handle.
  const base = mkdtempSync(join(tmpdir(), "harness-watcher-restart-"));
  try {
    const root = join(base, "only");
    mkdirSync(root);

    const handles: RecordingDirectoryWatcher[] = [];
    const watcher = createHarnessWatcher({
      roots: () => [root],
      match: () => true,
      runImport: () => Promise.resolve({ completed: true }),
      runInitialImport: false,
      catchupPollMs: null,
      watchDirectory: () => {
        const handle = recordingFsWatcher();
        handles.push(handle);
        return handle;
      },
    });

    await watcher.start();
    watcher.stop();
    await watcher.start();
    watcher.stop();

    assert.equal(handles.length, 2, "the restart must attach a fresh handle");
    assert.deepEqual(
      handles.map((handle) => handle.closeCount()),
      [1, 1],
      "each attached handle must be closed by the stop() that follows it"
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
