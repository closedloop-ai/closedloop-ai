import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CollectorManager } from "../src/main/collectors/engine/collector-manager.js";
import type { HarnessCollector } from "../src/main/collectors/types.js";
import { makeSession } from "./normalized-session-test-utils.js";

// The historical (lowDuty) import path yields through `cooperativeDelay`; a
// no-op keeps the boot import synchronous-fast for these lifecycle assertions.
async function noopCooperativeDelay(): Promise<void> {}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("waitUntil timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

// A stop()/restart can land while the folded-child cleanup loop in importSources
// is mid-`await deleteSessionRow`. The loop's active-check only runs at the top
// of each iteration, so after the final await a SUPERSEDED generation can fall
// through to the shared ingestProgress write. This test drives that exact
// interleaving: gen 1 is parked inside the delete loop, a fresh generation runs
// to completion, and only then does gen 1 resume. Without the post-loop guard,
// gen 1's stale continuation overwrites the live generation's settled progress
// with a reset {total, processed: 0}; with the guard it bails first.
test("CollectorManager.stop(): a generation parked in the folded-child delete loop does not repopulate/clobber ingestProgress when it resumes after a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "collector-manager-gen-guard-"));
  try {
    const stateDir = join(dir, "state");
    const burstSource = join(dir, "codex-burst.jsonl");
    const newSource = join(dir, "codex-new.jsonl");
    writeFileSync(burstSource, "{}\n");
    const burstSessionId = `session-${burstSource}`;

    // deleteSessionRow blocks ONLY its first invocation (gen 1's folded-child
    // cleanup); every later call (the restart generation) resolves immediately.
    let releaseFirstDelete: (() => void) | undefined;
    let deleteCalls = 0;
    const deleteSessionRow = (_sessionId: string): Promise<void> => {
      deleteCalls += 1;
      if (deleteCalls === 1) {
        return new Promise<void>((resolve) => {
          releaseFirstDelete = resolve;
        });
      }
      return Promise.resolve();
    };

    let listSources = [burstSource];
    const collector: HarnessCollector = {
      key: "codex",
      cacheName: "codex",
      allowUnscopedSourceAdmission: true,
      watchRoots: () => [],
      watchMatch: () => true,
      listSources: () => [...listSources],
      parse: async (source) => [
        makeSession({ sessionId: `session-${source}` }),
      ],
      // Burst artifact only for the already-imported source, so on the restart
      // pass it folds into its parent and drives deleteSessionRow.
      isBurstArtifactSource: (source: string) => source === burstSource,
      sessionIdForSource: (source: string) => `session-${source}`,
    };

    let resolveBoot: (() => void) | undefined;
    const makeManager = () =>
      new CollectorManager({
        importer: {
          importSession: async () => ({ skipped: false, reactivated: false }),
        },
        detectBillingMode: () => "metered_api",
        stateDir,
        emit: () => {},
        getCollectionMode: () => "disabled",
        catchupPollMs: null,
        cooperativeDelay: noopCooperativeDelay,
        deleteSessionRow,
        // The burst source is present in the DB, so on the restart pass it is a
        // folded child (unchanged + burst + row exists) rather than an orphan.
        listExistingSessionIds: async () => new Set<string>([burstSessionId]),
        onBootImportComplete: () => resolveBoot?.(),
        collectors: [collector],
      });

    // Pass 0: import the burst source with a first manager so the persisted
    // catchup cache marks it "unchanged" for the manager under test.
    const boot0 = new Promise<void>((resolve) => {
      resolveBoot = resolve;
    });
    const seed = makeManager();
    seed.start();
    await boot0;
    seed.stop();

    // Now the manager under test. A brand-new source appears alongside the
    // already-imported burst source.
    writeFileSync(newSource, "{}\n");
    listSources = [burstSource, newSource];
    const manager = makeManager();

    // Gen 1: starts, folds the burst source, and parks inside the delete loop
    // awaiting deleteSessionRow — BEFORE it reaches the ingestProgress.set.
    manager.start();
    await waitUntil(() => releaseFirstDelete !== undefined);
    assert.equal(
      deleteCalls,
      1,
      "gen 1 is parked in the folded-child delete loop"
    );

    // stop() supersedes gen 1 and clears the progress map.
    manager.stop();
    assert.deepEqual(
      manager.getIngestProgress().byHarness,
      [],
      "stop() clears ingestProgress"
    );

    // Gen 2: a fresh restart runs to completion over the SAME instance. It
    // imports the new source and settles its first-pass progress to 100%.
    const boot2 = new Promise<void>((resolve) => {
      resolveBoot = resolve;
    });
    manager.start();
    await boot2;
    const afterRestart = manager.getIngestProgress();
    const restartEntry = afterRestart.byHarness.find(
      (h) => h.harness === "codex"
    );
    assert.ok(
      restartEntry,
      "restart generation tracks its own first-pass progress"
    );
    assert.equal(
      restartEntry?.processed,
      restartEntry?.total,
      "restart generation settled to 100%"
    );

    // Now let gen 1 resume from its parked deleteSessionRow. It is superseded
    // (stopped + generation bumped), so the post-loop guard must make it bail
    // before touching ingestProgress. WITHOUT the guard it falls through to the
    // shared write and clobbers the live entry back to {processed: 0}.
    releaseFirstDelete?.();
    // Let gen 1's continuation and any trailing microtasks/timers drain.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const afterResume = manager.getIngestProgress();
    const resumedEntry = afterResume.byHarness.find(
      (h) => h.harness === "codex"
    );
    // The live generation's settled progress must be intact — no stale gen 1
    // repopulation, no reset to processed < total.
    assert.ok(
      resumedEntry,
      "live progress entry survives the stale generation resuming"
    );
    assert.equal(
      resumedEntry?.processed,
      resumedEntry?.total,
      "stale generation did not clobber the live entry back to processed:0"
    );
    assert.equal(
      afterResume.total > 0 && afterResume.processed < afterResume.total,
      false,
      "no false in-progress import state after the stale generation resumes"
    );

    manager.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
