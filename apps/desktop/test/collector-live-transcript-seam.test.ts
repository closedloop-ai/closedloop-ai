/**
 * @file collector-live-transcript-seam.test.ts
 * @description ISS-4390 — the collector seam that carries a watcher event's
 * ORIGINAL changed path alongside the root/parent source it was folded onto.
 *
 * The collector folds a child event back to its import source because that
 * answers "which source do I re-parse?". The transcript archive lane asks a
 * different question — "which file's bytes changed?" — and without these
 * origins that identity is destroyed inside the manager, leaving the lane able
 * to flush only the unchanged root while the file that actually grew waits for
 * the 30-min discovery sweep.
 *
 * Kept out of `ingest-orchestrator.test.ts`: these pin one narrow seam, and that
 * suite is already far past the file-size ceiling.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { CollectorManager } from "../src/main/collectors/engine/collector-manager.js";
import { sourcePathsForWatcherEventsWithOrigins } from "../src/main/collectors/engine/collector-pending-sources.js";
import {
  fakeFsWatcher,
  makeSession,
  waitUntil,
} from "./helpers/collector-manager-fixtures.js";
import { fakeCollector } from "./normalized-session-test-utils.js";

test("ISS-4390: the manager forwards the original child path to onLiveTranscriptActivity", async () => {
  // The helper tests prove `changedPathsBySource` is BUILT and the transcript
  // service tests prove `changedPaths` is CONSUMED, but nothing pinned the
  // production seam in between — dropping the fourth argument here would leave
  // both suites green while restoring the child-only 30-minute lag.
  const dir = mkdtempSync(join(tmpdir(), "collector-manager-live-seam-"));
  try {
    const rootSource = join(dir, "rollout-root.jsonl");
    const childSource = join(dir, "rollout-child.jsonl");
    writeFileSync(rootSource, "{}\n");
    writeFileSync(childSource, "{}\n");

    let emitWatcherEvent: ((filename: string) => void) | undefined;
    const activity: Array<{
      harness: string;
      sessionId: string;
      sourcePath: string;
      changedPaths?: readonly string[];
    }> = [];
    let resolveActivity: (() => void) | undefined;
    const sawActivity = new Promise<void>((resolve) => {
      resolveActivity = resolve;
    });

    const collector = fakeCollector("codex", {
      sources: [rootSource],
      sessions: [makeSession("rollout-root")],
      watchRoots: [dir],
    });
    // Mirror the real Codex/Claude fold: a child event maps to the ROOT source.
    collector.sourcePathsForWatchEvent = () => [rootSource];

    const manager = new CollectorManager({
      importer: {
        importSession: async () => ({ skipped: false, reactivated: false }),
      },
      detectBillingMode: () => "metered_api",
      stateDir: dir,
      emit: () => {},
      getCollectionMode: () => "watcher",
      collectors: [collector],
      watchDirectory: (_root, listener) => {
        emitWatcherEvent = (filename) => listener("change", filename);
        return fakeFsWatcher();
      },
      onLiveTranscriptActivity: (
        harness,
        sessionId,
        sourcePath,
        changedPaths
      ) => {
        activity.push({ harness, sessionId, sourcePath, changedPaths });
        resolveActivity?.();
      },
    });

    manager.start();
    // Let the boot import settle so the live event is not folded into it — only
    // a genuine LiveWatcher import arms the transcript lane.
    await waitUntil(() => emitWatcherEvent !== undefined);
    emitWatcherEvent?.("rollout-child.jsonl");
    await sawActivity;
    manager.stop();

    const live = activity.at(-1);
    assert.ok(live, "the live watcher import must report activity");
    assert.equal(live.sourcePath, rootSource, "the mapped source is the root");
    assert.deepEqual(
      live.changedPaths,
      [childSource],
      "the ORIGINAL child path must reach the transcript lane"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ISS-4390: watcher event mapping reports the changed path behind a folded source", () => {
  // The collector folds a child event onto its parent/root source because that
  // answers "which source do I re-parse?". The transcript archive lane asks
  // "which file's bytes changed?" — without the origins map that identity is
  // destroyed here, and the lane can only ever flush the unchanged root.
  const dir = mkdtempSync(join(tmpdir(), "collector-manager-origins-"));
  try {
    const root = join(dir, "rollout-root.jsonl");
    const child = join(dir, "rollout-child.jsonl");
    writeFileSync(root, "{}\n");
    writeFileSync(child, "{}\n");
    const collector = fakeCollector("codex", {});
    collector.sourcePathsForWatchEvent = () => [root];

    const result = sourcePathsForWatcherEventsWithOrigins(collector, [
      { root: dir, filename: "rollout-child.jsonl" },
    ]);

    assert.deepEqual(result.sources, [root]);
    assert.deepEqual(result.changedPathsBySource.get(root), [child]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ISS-4390: watcher event origins are held to the same admission check as sources", () => {
  // An origin must never widen what a downstream consumer may open: a changed
  // path outside the watched root is dropped even when the mapped source is
  // itself admissible.
  const dir = mkdtempSync(join(tmpdir(), "collector-manager-origin-escape-"));
  const outsideDir = mkdtempSync(
    join(tmpdir(), "collector-manager-origin-escape-outside-")
  );
  try {
    const mapped = join(dir, "rollout-root.jsonl");
    writeFileSync(mapped, "{}\n");
    writeFileSync(join(outsideDir, "outside.jsonl"), "{}\n");
    const collector = fakeCollector("codex", {});
    collector.sourcePathsForWatchEvent = () => [mapped];

    const result = sourcePathsForWatcherEventsWithOrigins(collector, [
      {
        root: dir,
        filename: join("..", basename(outsideDir), "outside.jsonl"),
      },
    ]);

    assert.deepEqual(result.sources, [mapped]);
    assert.equal(result.changedPathsBySource.get(mapped), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});
