/**
 * @file harness-watcher.test.ts
 * @description Watcher-layer coverage split out of `ingest-orchestrator.test.ts`:
 * `createHarnessWatcher` live/historical import scheduling, and the
 * `sourcePathsForWatcherEvents` containment mapping. The orchestrator suite owns
 * `CollectorManager`; this suite owns the watcher that feeds it.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { sourcePathsForWatcherEvents } from "../src/main/collectors/engine/collector-pending-sources.js";
import { createHarnessWatcher } from "../src/main/collectors/engine/watcher.js";
import { fakeFsWatcher } from "./helpers/collector-manager-fixtures.js";
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
            completed: !controls?.shouldYieldToLiveEvents(),
          };
        }
        return { completed: true };
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
