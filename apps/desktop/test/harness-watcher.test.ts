/**
 * @file harness-watcher.test.ts
 * @description Watcher-layer coverage split out of `ingest-orchestrator.test.ts`:
 * `createHarnessWatcher` live/historical import scheduling, and the
 * `sourcePathsForWatcherEvents` containment mapping. The orchestrator suite owns
 * `CollectorManager`; this suite owns the watcher that feeds it.
 *
 * The watcher's ISS-8600 watch-lost seam is its own sibling suite,
 * `harness-watcher-watch-lost.test.ts`.
 */

import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { sourcePathsForWatcherEvents } from "../src/main/collectors/engine/collector-pending-sources.js";
import {
  createHarnessWatcher,
  HarnessImportOutcome,
} from "../src/main/collectors/engine/watcher.js";
import {
  fakeFsWatcher,
  type RecordingDirectoryWatcher,
  recordingFsWatcher,
} from "./helpers/collector-manager-fixtures.js";
import { fakeCollector } from "./normalized-session-test-utils.js";
import { nodeTestTimers } from "./support/node-test-fake-timers.js";

afterEach(() => {
  nodeTestTimers.reset();
});

test("first-party HarnessWatcher drains live events queued during historical import", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-watcher-queued-events-"));
  try {
    nodeTestTimers.enable(["setTimeout"]);
    let emitWatcherEvent: ((filename: string) => void) | undefined;
    let resolveHistoricalStarted: (() => void) | undefined;
    let resolveHistorical: (() => void) | undefined;
    const historicalStarted = new Promise<void>((resolve) => {
      resolveHistoricalStarted = resolve;
    });
    const releaseHistorical = new Promise<void>((resolve) => {
      resolveHistorical = resolve;
    });
    const eventImports: string[][] = [];
    const watcher = createHarnessWatcher({
      roots: () => [dir],
      match: (filename) => filename.endsWith(".jsonl"),
      watchDirectory: (_root, listener) => {
        emitWatcherEvent = (filename) => listener("change", filename);
        return fakeFsWatcher();
      },
      runImport: async (events) => {
        if (events === null) {
          resolveHistoricalStarted?.();
          await releaseHistorical;
          return undefined;
        }
        eventImports.push(events.map((event) => event.filename));
        return undefined;
      },
    });

    const firstImport = watcher.start();
    await historicalStarted;
    emitWatcherEvent?.("live.jsonl");
    nodeTestTimers.tick(600);
    resolveHistorical?.();
    await firstImport;
    assert.equal(
      eventImports.some((events) =>
        events.some((filename) => filename.endsWith("live.jsonl"))
      ),
      true
    );
    watcher.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("first-party HarnessWatcher lets live events preempt resumable historical import", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-watcher-preempt-live-"));
  try {
    nodeTestTimers.enable(["setTimeout"]);
    let emitWatcherEvent: ((filename: string) => void) | undefined;
    let resolveHistoricalStarted: (() => void) | undefined;
    let resolveLiveQueued: (() => void) | undefined;
    const historicalStarted = new Promise<void>((resolve) => {
      resolveHistoricalStarted = resolve;
    });
    const liveQueued = new Promise<void>((resolve) => {
      resolveLiveQueued = resolve;
    });
    const imports: string[] = [];
    let historicalRuns = 0;
    const watcher = createHarnessWatcher({
      roots: () => [dir],
      match: (filename) => filename.endsWith(".jsonl"),
      watchDirectory: (_root, listener) => {
        emitWatcherEvent = (filename) => listener("change", filename);
        return fakeFsWatcher();
      },
      runImport: async (events, controls) => {
        if (events !== null) {
          imports.push(`live:${events[0]?.filename}`);
          return;
        }
        historicalRuns++;
        imports.push(`historical:${historicalRuns}`);
        if (historicalRuns === 1) {
          resolveHistoricalStarted?.();
          await liveQueued;
          return {
            outcome: controls?.shouldYieldToLiveEvents()
              ? HarnessImportOutcome.Incomplete
              : HarnessImportOutcome.Completed,
          };
        }
        return { outcome: HarnessImportOutcome.Completed };
      },
    });

    const firstImport = watcher.start();
    await historicalStarted;
    emitWatcherEvent?.("live.jsonl");
    nodeTestTimers.tick(600);
    resolveLiveQueued?.();
    await firstImport;
    watcher.stop();

    assert.deepEqual(imports, [
      "historical:1",
      "live:live.jsonl",
      "historical:2",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("first-party HarnessWatcher settles delayed initial import when stopped before it fires", async () => {
  let importCount = 0;
  const watcher = createHarnessWatcher({
    roots: () => [],
    match: () => true,
    runImport: () => {
      importCount++;
      return Promise.resolve(undefined);
    },
    initialImportDelayMs: 10_000,
  });

  const firstImport = watcher.start();
  watcher.stop();
  await firstImport;

  assert.equal(importCount, 0);
});

test("first-party HarnessWatcher coalesces excessive event bursts to a historical import", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-watcher-event-burst-"));
  try {
    nodeTestTimers.enable(["setTimeout"]);
    let emitWatcherEvent: ((filename: string) => void) | undefined;
    const imports: Array<"historical" | number> = [];
    const watcher = createHarnessWatcher({
      roots: () => [dir],
      match: (filename) => filename.endsWith(".jsonl"),
      runInitialImport: false,
      catchupPollMs: null,
      watchDirectory: (_root, listener) => {
        emitWatcherEvent = (filename) => listener("change", filename);
        return fakeFsWatcher();
      },
      runImport: (events) => {
        imports.push(events === null ? "historical" : events.length);
        return Promise.resolve(undefined);
      },
    });

    await watcher.start();
    for (let index = 0; index < 1005; index++) {
      emitWatcherEvent?.(`burst-${index}.jsonl`);
    }
    nodeTestTimers.tick(600);
    await new Promise((resolve) => setImmediate(resolve));
    watcher.stop();

    assert.deepEqual(imports, ["historical"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("first-party watcher event mapping keeps imports scoped to contained regular files", () => {
  const dir = mkdtempSync(join(tmpdir(), "collector-manager-event-scope-"));
  const outsideDir = mkdtempSync(join(tmpdir(), "collector-manager-outside-"));
  try {
    const mapped = join(dir, "mapped.jsonl");
    const outside = join(outsideDir, "outside.jsonl");
    const linked = join(dir, "linked.jsonl");
    const linkedParent = join(dir, "linked-parent");
    const linkedParentTranscript = join(linkedParent, "outside.jsonl");
    writeFileSync(mapped, "{}\n");
    writeFileSync(outside, "{}\n");
    symlinkSync(outside, linked);
    symlinkSync(outsideDir, linkedParent);

    const collector = fakeCollector("codex", {});
    collector.sourcePathsForWatchEvent = () => [
      mapped,
      outside,
      linked,
      linkedParentTranscript,
    ];

    assert.deepEqual(
      sourcePathsForWatcherEvents(collector, [
        { root: dir, filename: "changed.jsonl" },
      ]),
      [mapped]
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("first-party watcher event mapping rejects traversal-shaped default paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "collector-manager-traversal-"));
  const outsideDir = mkdtempSync(
    join(tmpdir(), "collector-manager-traversal-outside-")
  );
  try {
    const outside = join(outsideDir, "outside.jsonl");
    writeFileSync(outside, "{}\n");

    assert.deepEqual(
      sourcePathsForWatcherEvents(fakeCollector("codex", {}), [
        { root: dir, filename: "../outside.jsonl" },
      ]),
      []
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("first-party HarnessWatcher recovers live delivery after an attached watch fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-watcher-watch-failure-"));
  try {
    nodeTestTimers.enable(["setTimeout", "setInterval"]);
    const handles: RecordingDirectoryWatcher[] = [];
    const listeners: Array<(filename: string) => void> = [];
    const logs: string[] = [];
    const imports: string[] = [];
    const watcher = createHarnessWatcher({
      roots: () => [dir],
      match: (filename) => filename.endsWith(".jsonl"),
      // No poll: a catch-up sweep here can only have come from the re-attach.
      catchupPollMs: null,
      watchDirectory: (_root, listener) => {
        const handle = recordingFsWatcher();
        handles.push(handle);
        listeners.push((filename) => listener("change", filename));
        return handle;
      },
      runImport: (events) => {
        imports.push(
          events === null ? "historical" : `live:${events[0]?.filename}`
        );
        return Promise.resolve(undefined);
      },
      log: (message) => logs.push(message),
    });

    await watcher.start();
    assert.equal(handles.length, 1);
    assert.equal(
      logs.includes(`live watch attached to ${dir}`),
      true,
      "attaching the live channel must be visible in the collector log"
    );

    handles[0]?.emitError(new Error("EMFILE"));
    assert.equal(
      handles[0]?.closeCount(),
      1,
      "the failed handle must be closed, not left dangling"
    );
    assert.equal(
      logs.some(
        (message) =>
          message.includes(`live watch on ${dir} failed`) &&
          message.includes("EMFILE")
      ),
      true,
      "a failed live watch must be reported, not swallowed"
    );

    nodeTestTimers.tick(4000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(handles.length, 2, "the failed root must be re-attached");
    assert.equal(
      imports.filter((entry) => entry === "historical").length,
      2,
      "re-attaching must sweep the window the dead watch was blind for"
    );

    listeners[1]?.("2026/08/19/rollout-after-recovery.jsonl");
    nodeTestTimers.tick(600);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      imports.includes("live:2026/08/19/rollout-after-recovery.jsonl"),
      true,
      "the re-attached watch must actually deliver live events again"
    );

    // The retry loop must STOP on success. Left armed it re-fires every
    // RETRY_MS, and because `attach()` short-circuits on an already-attached
    // root each tick sweeps the whole transcript tree — the exact cost the
    // low-frequency poll exists to avoid.
    nodeTestTimers.tick(4000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      imports.filter((entry) => entry === "historical").length,
      2,
      "a successful re-attach must disarm the retry loop, not keep sweeping"
    );

    // A repeat error on the handle already dropped must not splice a HEALTHY
    // one out of `watchers` (an unguarded indexOf of -1 removes the last entry)
    // nor arm a second recovery.
    handles[0]?.emitError(new Error("EMFILE"));
    nodeTestTimers.tick(4000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      handles.length,
      2,
      "a repeat error on a dropped handle must not re-attach again"
    );
    assert.equal(
      handles[0]?.closeCount(),
      1,
      "a repeat error must not re-close the handle already dropped"
    );

    watcher.stop();
    assert.equal(
      handles[1]?.closeCount(),
      1,
      "stop() must close the live re-attached handle, not a stale one"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("first-party HarnessWatcher sweeps for a root that recovered while a sibling root is still absent", async () => {
  const parent = mkdtempSync(join(tmpdir(), "harness-watcher-multi-root-"));
  // Copilot's real shape: VS Code workspace storage AND ~/.copilot/session-state.
  // A user who only runs Copilot inside VS Code never has the CLI root, so it is
  // absent for the whole life of the process — it is NOT a root that died.
  const presentRoot = join(parent, "vscode-workspace-storage");
  const absentRoot = join(parent, "copilot-session-state");
  try {
    mkdirSync(presentRoot, { recursive: true });
    nodeTestTimers.enable(["setTimeout", "setInterval"]);
    const handles: RecordingDirectoryWatcher[] = [];
    const attachedRoots: string[] = [];
    const listeners: Array<(filename: string) => void> = [];
    const imports: string[] = [];
    const watcher = createHarnessWatcher({
      roots: () => [presentRoot, absentRoot],
      match: (filename) => filename.endsWith(".jsonl"),
      // No poll: a historical sweep here can only have come from the re-attach.
      catchupPollMs: null,
      watchDirectory: (root, listener) => {
        const handle = recordingFsWatcher();
        handles.push(handle);
        attachedRoots.push(root);
        listeners.push((filename) => listener("change", filename));
        return handle;
      },
      runImport: (events) => {
        imports.push(
          events === null ? "historical" : `live:${events[0]?.filename}`
        );
        return Promise.resolve(undefined);
      },
    });

    await watcher.start();
    assert.deepEqual(
      attachedRoots,
      [presentRoot],
      "only the root that exists can attach; the sibling is never present"
    );
    assert.equal(
      imports.filter((entry) => entry === "historical").length,
      1,
      "boot sweep only"
    );

    // The root that DID attach now dies. This is the distinction the bug turned
    // on: it was live and lost its handle, unlike the sibling that never was.
    handles[0]?.emitError(new Error("EMFILE"));
    assert.equal(
      handles[0]?.closeCount(),
      1,
      "the failed handle must be closed, not left dangling"
    );

    nodeTestTimers.tick(4000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      attachedRoots,
      [presentRoot, presentRoot],
      "the root that died must be re-attached; the absent sibling still cannot be"
    );
    assert.equal(
      imports.filter((entry) => entry === "historical").length,
      2,
      "recovering one root must sweep ITS blind window even though a sibling root is still absent — otherwise those events wait for the 30 minute catch-up"
    );

    // The counterweight to the assertion above: the sweep is owed to a root that
    // just came back, NOT to every tick of a loop still armed for the sibling.
    // An unconditional sweep here would re-scan the whole transcript tree every
    // RETRY_MS, which is the cost the low-frequency poll exists to avoid.
    nodeTestTimers.tick(4000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      attachedRoots,
      [presentRoot, presentRoot],
      "a tick with nothing new to attach must not re-attach"
    );
    assert.equal(
      imports.filter((entry) => entry === "historical").length,
      2,
      "a retry tick that recovered nothing must not sweep"
    );

    listeners[1]?.("copilot/events.jsonl");
    nodeTestTimers.tick(600);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      imports.includes("live:copilot/events.jsonl"),
      true,
      "the re-attached watch must actually deliver live events again"
    );

    watcher.stop();
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("first-party HarnessWatcher still re-attaches on the catch-up poll after the fast retry gives up", async () => {
  const parent = mkdtempSync(
    join(tmpdir(), "harness-watcher-retry-exhausted-")
  );
  const missingRoot = join(parent, "sessions");
  try {
    nodeTestTimers.enable(["setTimeout", "setInterval"]);
    const handles: RecordingDirectoryWatcher[] = [];
    const logs: string[] = [];
    const watcher = createHarnessWatcher({
      roots: () => [missingRoot],
      match: (filename) => filename.endsWith(".jsonl"),
      runInitialImport: false,
      catchupPollMs: 60_000,
      watchDirectory: () => {
        const handle = recordingFsWatcher();
        handles.push(handle);
        return handle;
      },
      runImport: () => Promise.resolve(undefined),
      log: (message) => logs.push(message),
    });

    await watcher.start();
    assert.equal(handles.length, 0, "a missing root cannot be attached");

    // Past MAX_RETRY_ATTEMPTS * RETRY_MS (75 * 4000ms). Pinned as literals on
    // purpose: reading the production constants back would make this assert
    // whatever the code currently does.
    nodeTestTimers.tick(6 * 60_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      logs.some((message) =>
        message.includes("gave up the fast re-attach loop")
      ),
      true,
      "exhausting the fast retry must be reported"
    );
    assert.equal(handles.length, 0, "the root still does not exist");

    mkdirSync(missingRoot, { recursive: true });
    nodeTestTimers.tick(60_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      handles.length,
      1,
      "the catch-up poll must keep re-attaching after the fast retry gave up"
    );

    watcher.stop();
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("first-party HarnessWatcher delivers a file created in a directory that did not exist when it attached", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-watcher-new-subdir-"));
  try {
    mkdirSync(join(dir, "2026", "08", "18"), { recursive: true });
    const existingDirFile = join(
      dir,
      "2026",
      "08",
      "18",
      "rollout-existing.jsonl"
    );
    writeFileSync(existingDirFile, "{}\n");

    let resolveExistingDir: (() => void) | undefined;
    let resolveNewDir: (() => void) | undefined;
    const existingDirDelivered = new Promise<void>((resolve) => {
      resolveExistingDir = resolve;
    });
    const newDirDelivered = new Promise<void>((resolve) => {
      resolveNewDir = resolve;
    });
    const watcher = createHarnessWatcher({
      roots: () => [dir],
      match: (filename) => filename.endsWith(".jsonl"),
      // Neither a boot sweep nor a poll can import here, so a delivery below is
      // attributable to the live fs.watch channel and to nothing else.
      runInitialImport: false,
      catchupPollMs: null,
      runImport: (events) => {
        for (const event of events ?? []) {
          if (event.filename.endsWith("rollout-existing.jsonl")) {
            resolveExistingDir?.();
          }
          if (event.filename.endsWith("rollout-new-day.jsonl")) {
            resolveNewDir?.();
          }
        }
        return Promise.resolve(undefined);
      },
    });
    await watcher.start();

    try {
      await changeUntilDelivered(
        () => appendFileSync(existingDirFile, '{"appended":true}\n'),
        existingDirDelivered,
        "a change under a directory that existed when the watch attached"
      );

      const newDayFile = join(dir, "2026", "08", "19", "rollout-new-day.jsonl");
      mkdirSync(join(dir, "2026", "08", "19"), { recursive: true });
      await changeUntilDelivered(
        () => appendFileSync(newDayFile, '{"session_meta":true}\n'),
        newDirDelivered,
        "a file under a NEW directory (ISS-7255: the first Codex session of a day)"
      );
    } finally {
      watcher.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Ceiling on a real platform event, well inside the lane's per-test timeout. */
const LIVE_DELIVERY_TIMEOUT_MS = 30_000;
/** Re-touch cadence — `fs.watch` arms asynchronously, so one write can be missed. */
const LIVE_DELIVERY_RETRY_MS = 250;

/**
 * Keep making the change until the live channel reports it, then resolve; on
 * expiry, fail naming what never arrived. A bounded event wait rather than a
 * fixed sleep: repeating an append cannot make a watch that does not cover the
 * path deliver it, so this removes the arming race without weakening the claim.
 */
function changeUntilDelivered(
  change: () => void,
  delivered: Promise<void>,
  what: string
): Promise<void> {
  let retry: NodeJS.Timeout | undefined;
  let expiry: NodeJS.Timeout | undefined;
  change();
  const failed = new Promise<never>((_resolve, reject) => {
    retry = setInterval(change, LIVE_DELIVERY_RETRY_MS);
    expiry = setTimeout(
      () =>
        reject(
          new Error(
            `the live fs.watch channel never delivered ${what} within ${LIVE_DELIVERY_TIMEOUT_MS}ms`
          )
        ),
      LIVE_DELIVERY_TIMEOUT_MS
    );
  });
  return Promise.race([delivered, failed]).finally(() => {
    if (retry) {
      clearInterval(retry);
    }
    if (expiry) {
      clearTimeout(expiry);
    }
  });
}
