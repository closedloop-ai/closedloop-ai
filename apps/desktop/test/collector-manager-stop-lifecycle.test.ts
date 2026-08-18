import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CollectorManager } from "../src/main/collectors/engine/collector-manager.js";
import { makeSession } from "./normalized-session-test-utils.js";

// The historical (lowDuty) import path yields through `cooperativeDelay`; a
// no-op keeps the boot import synchronous-fast for these lifecycle assertions.
async function noopCooperativeDelay(): Promise<void> {}

test("CollectorManager stop() clears stranded ingestProgress but preserves the first-pass gate, so a mid-session restart of an already-imported machine does not report false first-pass/importing state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "collector-manager-stop-progress-"));
  try {
    const sources: string[] = [];
    for (let i = 0; i < 2; i++) {
      const source = join(dir, `codex-${i}.jsonl`);
      writeFileSync(source, "{}\n");
      sources.push(source);
    }
    let resolveBootComplete: (() => void) | undefined;
    const nextBootComplete = () =>
      new Promise<void>((resolve) => {
        resolveBootComplete = resolve;
      });
    let bootComplete = nextBootComplete();

    const manager = new CollectorManager({
      importer: {
        importSession: async () => ({ skipped: false, reactivated: false }),
      },
      detectBillingMode: () => "metered_api",
      stateDir: join(dir, "state"),
      emit: () => {},
      getCollectionMode: () => "disabled",
      cooperativeDelay: noopCooperativeDelay,
      onBootImportComplete: () => resolveBootComplete?.(),
      collectors: [
        {
          key: "codex",
          cacheName: "codex",
          allowUnscopedSourceAdmission: true,
          watchRoots: () => [],
          watchMatch: () => true,
          listSources: () => [...sources],
          parse: async (source) => [
            makeSession({ sessionId: `session-${source}` }),
          ],
        },
      ],
    });

    manager.start();
    await bootComplete;
    // First pass finished: the backfill progress is fully tracked and settled.
    assert.deepEqual(manager.getIngestProgress(), {
      byHarness: [{ harness: "codex", total: 2, processed: 2 }],
      total: 2,
      processed: 2,
      preparing: false,
      // ISS-5281: the pass ended with nothing left retryable, so the producer
      // reports the queue drained rather than leaving the renderer to infer it.
      drained: true,
      // Nothing ever paused this run, so the import loop never parked on the gate.
      importParked: false,
      complete: true,
      timedOut: false,
      quarantinedByStage: { import: 0, parse: 0 },
      quarantinedCount: 0,
    });

    // stop() must drop the stranded ingestProgress map (the real stranding fix:
    // a restart that finds zero pending sources otherwise keeps a settled
    // {total, processed} entry alive, so getIngestProgress() reports it forever).
    // It must NOT clear the ingestFirstPassDone gate — first-pass semantics are
    // per-manager-lifecycle and the renderer treats the signal as first-launch,
    // so re-arming the gate on an in-process restart of an already-imported
    // machine would surface routine catch-ups as a false "importing" state.
    manager.stop();
    assert.deepEqual(
      manager.getIngestProgress().byHarness,
      [],
      "stop() clears the stranded first-pass progress entry"
    );
    assert.equal(manager.getIngestProgress().total, 0);

    // Phase 2 — a mid-session restart (e.g. a hooks toggle via restartCollectors)
    // that finds ZERO pending sources: both sources are already imported, so the
    // catch-up pass has nothing to do. getIngestProgress() must stay neutral: no
    // {total > 0, processed < total} entry, and not `preparing` with total 0.
    bootComplete = nextBootComplete();
    manager.start();
    await bootComplete;
    const zeroPending = manager.getIngestProgress();
    assert.deepEqual(
      zeroPending.byHarness,
      [],
      "zero-pending restart reports no first-pass progress"
    );
    assert.equal(zeroPending.total, 0);
    assert.equal(
      zeroPending.preparing,
      false,
      "zero-pending restart does not flash preparing"
    );

    manager.stop();

    // Phase 3 — a routine catch-up: one brand-new source appears and the manager
    // restarts in the same process. Because codex genuinely finished its first
    // pass earlier, the preserved gate keeps trackProgress FALSE, so this catch-up
    // is NOT treated as first-pass progress: getIngestProgress() stays neutral and
    // no {total > 0, processed < total} entry is ever created. This assertion
    // FAILS under the old blanket `ingestFirstPassDone.clear()` (which re-armed the
    // gate and surfaced the catch-up as a {total: 1, processed: 0 → 1} first-pass
    // entry) and PASSES with the narrowed clear.
    const restartSource = join(dir, "codex-restart.jsonl");
    writeFileSync(restartSource, "{}\n");
    sources.push(restartSource);

    bootComplete = nextBootComplete();
    manager.start();
    await bootComplete;
    const catchUp = manager.getIngestProgress();
    assert.deepEqual(
      catchUp.byHarness,
      [],
      "preserved first-pass gate keeps a mid-session catch-up out of first-pass progress"
    );
    assert.equal(catchUp.total, 0);
    assert.equal(catchUp.processed, 0);
    assert.equal(
      catchUp.preparing,
      false,
      "catch-up on an already-imported harness does not flash preparing"
    );

    manager.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
