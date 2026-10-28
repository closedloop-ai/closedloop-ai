/**
 * @file e2e-boot-import-abandon-seam.test.ts
 * @description ISS-8982 — the gate, the per-harness budget, and the
 * manager-to-`scanImportPass` wiring of the boot-import abandon seam that
 * replaced the E2E's db-host kill loop.
 *
 * The last three cases are the seam's BOTH-WAYS proof, and they are the reason
 * this file exists rather than a set of predicate assertions. A stabilized spec
 * that cannot fail is worse than the flake it replaced, so the seam is driven
 * through a REAL `CollectorManager` at both sides of the production budget:
 * `MAX_CONSECUTIVE_ABANDON_REDRIVES + 1` passes must reach the degraded
 * terminal, and one fewer must NOT. Between them they pin the consecutive-abandon
 * accounting exactly — accounting that never exhausts fails the first, accounting
 * that exhausts early fails the second — so neither can go green against a broken
 * counter. The third drives TWO harnesses, which is the only shape that can fail
 * when the seam's countdown is not keyed the way the budget it simulates is.
 *
 * WHAT THIS FILE DOES NOT COVER, so nobody reads its green as wider than it is:
 * the `e2eAbandonHistoricalPass` SPREAD at the composition root. These cases
 * hand the hook to the manager directly, so deleting that spread in
 * `agent-dashboard-design-system-runtime.ts` leaves them green, and only the
 * launched-app spec catches it. The GATE feeding that spread is no longer
 * E2E-only: ISS-10110's `e2e-seam-packaging-gate-wiring.test.ts` pins that the
 * composition root passes `app.isPackaged` there rather than a literal. What
 * these cases do pin is everything from
 * `CollectorManagerOptions` inward, `getIngestProgress` included. The Electron
 * E2E adds the transport and render half — the `desktop:get-runtime-status` IPC,
 * preload, `useIngestProgress`, `isBootImportDegraded`, the rendered surface.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { CollectorManager } from "../src/main/collectors/engine/collector-manager.js";
import {
  createE2eBootImportAbandonFault,
  E2E_BOOT_IMPORT_ABANDON_ENV,
  E2E_BOOT_IMPORT_ABANDON_MAX_PASSES,
  e2eBootImportAbandonPasses,
} from "../src/main/collectors/engine/e2e-boot-import-abandon-seam.js";
import type { Harness } from "../src/main/collectors/types.js";
import { isRecoverableDbHostExitError } from "../src/shared/db-host-exit-error.js";
import { deferred } from "./deferred.js";
import { makeSession } from "./helpers/collector-manager-fixtures.js";

const PACKAGED = true;
const UNPACKAGED = false;

/**
 * The production budget, restated here as a literal ON PURPOSE.
 *
 * `MAX_CONSECUTIVE_ABANDON_REDRIVES` is module-private to
 * `collector-manager-ingest-progress.ts`, and exporting it so this file could
 * derive the number would make both sides of the proof below move together: a
 * change that widened the budget would silently re-aim these cases at the new
 * one and they would stay green without anyone deciding that was intended. The
 * pair is meant to fail when the budget changes.
 */
const PASSES_TO_EXHAUST = 4;

test("the seam stays closed for a packaged build, whatever the environment says", () => {
  assert.equal(
    e2eBootImportAbandonPasses(
      { [E2E_BOOT_IMPORT_ABANDON_ENV]: "4" },
      PACKAGED
    ),
    null,
    "process.env is inherited by a packaged client, so the env var alone must never arm a real first-launch import"
  );
});

test("the seam stays closed for every value that is not a small positive integer", () => {
  for (const raw of ["", " ", "0", "-1", "4x", "4.9", " 4", "+4", "0x4", "e"]) {
    assert.equal(
      e2eBootImportAbandonPasses(
        { [E2E_BOOT_IMPORT_ABANDON_ENV]: raw },
        UNPACKAGED
      ),
      null,
      `"${raw}" is not a pass count; a lenient parse would run a spec against a budget its author did not write`
    );
  }
  assert.equal(
    e2eBootImportAbandonPasses({}, UNPACKAGED),
    null,
    "an absent variable is the production state and must arm nothing"
  );
  assert.equal(
    e2eBootImportAbandonPasses(
      {
        [E2E_BOOT_IMPORT_ABANDON_ENV]: String(
          E2E_BOOT_IMPORT_ABANDON_MAX_PASSES + 1
        ),
      },
      UNPACKAGED
    ),
    null,
    "a count past the ceiling is refused at the gate rather than accepted and silently harmless, since injections past the terminal are never consumed"
  );
});

test("the seam arms for an unpackaged build named an in-range count", () => {
  assert.equal(
    e2eBootImportAbandonPasses(
      { [E2E_BOOT_IMPORT_ABANDON_ENV]: "4" },
      UNPACKAGED
    ),
    4
  );
  assert.equal(
    e2eBootImportAbandonPasses(
      {
        [E2E_BOOT_IMPORT_ABANDON_ENV]: String(
          E2E_BOOT_IMPORT_ABANDON_MAX_PASSES
        ),
      },
      UNPACKAGED
    ),
    E2E_BOOT_IMPORT_ABANDON_MAX_PASSES,
    "the ceiling itself is in range; rejecting it would make the exported bound a lie by one"
  );
});

test("the fault throws a RECOVERABLE db-host exit exactly N times, then goes inert", () => {
  const fault = createE2eBootImportAbandonFault(3);
  for (let call = 1; call <= 3; call++) {
    const thrown = captureThrow(() => fault("claude"));
    assert.ok(thrown, `call ${call} must throw while the budget lasts`);
    assert.equal(
      isRecoverableDbHostExitError(thrown),
      true,
      "only `restartScheduled: true` classifies as `passCompleted: false`; an unrecoverable exit would be read as a COMPLETED pass and drive nothing"
    );
  }
  assert.equal(
    captureThrow(() => fault("claude")),
    null,
    "a spent budget must leave a WORKING app behind, so the pass after the terminal imports the corpus normally"
  );
});

/**
 * The budget is keyed the way `IngestProgressTracker.consecutiveAbandons` is.
 *
 * A single shared countdown would scatter its injections across whichever
 * harnesses happened to open a pass — the manager runs five — and leave no key
 * accumulating the consecutive abandons the terminal needs. That is invisible in
 * a suite that seeds one harness, which is exactly why it is pinned here.
 */
test("each harness gets its own budget, because the budget it mirrors is per harness", () => {
  const fault = createE2eBootImportAbandonFault(1);

  assert.ok(
    captureThrow(() => fault("claude")),
    "claude's first invocation spends claude's budget"
  );
  assert.ok(
    captureThrow(() => fault("codex")),
    "codex must still have its own budget; a shared counter would have gone inert here and left claude one abandon short of nothing"
  );
  assert.equal(
    captureThrow(() => fault("claude")),
    null,
    "and each harness's budget is still spent exactly once"
  );
});

test("the seam drives a real boot import to its degraded terminal in exactly the production budget", async () => {
  const run = await runBootImportWithAbandons(PASSES_TO_EXHAUST);

  assert.equal(
    run.progress.retriesExhausted,
    true,
    "the whole point of the spec this seam feeds: the boot import must actually reach `RetriesExhausted`, or the coverage has been deleted rather than stabilized"
  );
  assert.equal(
    run.progress.complete,
    false,
    "ISS-6207's defect was precisely a spent budget arriving as a completed import"
  );
  assert.equal(
    run.progress.timedOut,
    false,
    "the import SETTLED; folding in the watchdog's terminal would make this case pass for the other ticket's reason"
  );
  assert.equal(
    run.completeCalls,
    0,
    "completion fires post-boot maintenance and the cloud-read cutover over sources that were never imported"
  );
});

/**
 * The counterfactual half. One abandon short of the budget must NOT reach the
 * terminal, so a green from the case above cannot be bought by accounting that
 * exhausts on any abandon at all.
 *
 * It also proves the seam leaves a working app behind rather than a permanently
 * broken one: the fourth pass finds the fault inert, imports the corpus, and
 * settles complete.
 */
test("one abandon short of the budget completes instead, so the terminal is earned and not assumed", async () => {
  const run = await runBootImportWithAbandons(PASSES_TO_EXHAUST - 1);

  assert.equal(
    run.progress.retriesExhausted,
    false,
    "the budget tolerates this many consecutive abandons; reporting the terminal here would mean the counter is off by one in the direction that shows the user a give-up state on a recoverable import"
  );
  assert.equal(
    run.progress.complete,
    true,
    "the re-driven pass imported the corpus, so the boot import genuinely finished"
  );
});

/**
 * The per-harness keying, proven through the PRODUCTION path rather than on the
 * closure.
 *
 * `IngestProgressTracker.consecutiveAbandons` is keyed by `collector.key` and
 * `scanImportPass` runs once per collector, so a countdown that is NOT keyed the
 * same way stops reproducing the condition it claims to: two harnesses with
 * sources interleave their passes, the four injections split between them, and
 * neither key accumulates the four CONSECUTIVE abandons the terminal needs — so
 * both imports quietly succeed and the terminal never arrives. That is the whole
 * deliverable of a deflake PR failing silently, which is why it is pinned here
 * and not only as a unit assertion on the closure.
 *
 * Two collectors is the shape that proves it. The launched-app spec cannot: its
 * harness homes are isolated (ISS-7731), so only one harness ever has a
 * non-empty pending set there and a shared counter would pass.
 *
 * The expectation is stated as its own literal — `retriesExhausted` must be
 * true — rather than derived from the budget or the harness count. A case that
 * computed what to expect from the thing it polices cannot be failed by breaking
 * that thing.
 */
test("two harnesses each reach the terminal, because the budget is keyed per harness", async () => {
  const run = await runBootImportWithAbandons(PASSES_TO_EXHAUST, [
    "codex",
    "claude",
  ]);

  assert.equal(
    run.progress.retriesExhausted,
    true,
    "with a shared countdown the four injections split across the two harnesses, neither reaches four CONSECUTIVE abandons, and both imports settle complete — the seam would then be simulating a condition the product cannot actually be in"
  );
  assert.equal(
    run.progress.complete,
    false,
    "and the degraded terminal must still refuse completion with sources left behind"
  );
});

type BootImportRun = {
  completeCalls: number;
  progress: ReturnType<CollectorManager["getIngestProgress"]>;
};

/**
 * Drive a real `CollectorManager` over a real on-disk corpus with the seam armed
 * for `abandons` passes, and snapshot what the boot lifecycle claimed.
 *
 * Synchronized on the lifecycle's own terminal hooks rather than a poll loop
 * (`apps/desktop/AGENTS.md`): whichever of the two fires resolves the gate, so
 * the wait ends on a real completion signal and the ASSERTIONS discriminate
 * which terminal it was.
 *
 * The corpus is three files rather than the 200 the kill fixture needed: the
 * abandon no longer has to be raced against a pass that might settle first, so
 * the size that mattered there carries no meaning here.
 */
async function runBootImportWithAbandons(
  abandons: number,
  harnessKeys: readonly Harness[] = ["codex"]
): Promise<BootImportRun> {
  const dir = mkdtempSync(join(tmpdir(), "iss-8982-abandon-seam-"));
  const sourcesFor = (key: Harness) =>
    ["a", "b", "c"].map((name) => {
      const source = join(dir, `${key}-${name}.jsonl`);
      writeFileSync(source, "{}\n");
      return source;
    });
  const settled = deferred();
  let completeCalls = 0;
  try {
    const manager = new CollectorManager({
      importer: {
        importSession: () => ({ skipped: false, reactivated: false }),
      },
      stateDir: dir,
      emit: () => {
        // unused
      },
      getCollectionMode: () => "watcher",
      historicalImportDelayMs: 0,
      // No missed-event sweep: the re-drive chain under test must be the only
      // thing re-queueing the historical pass.
      catchupPollMs: null,
      log: () => {
        // unused
      },
      onBootImportComplete: () => {
        completeCalls++;
        settled.resolve();
      },
      onBootImportRetriesExhausted: () => settled.resolve(),
      e2eAbandonHistoricalPass: createE2eBootImportAbandonFault(abandons),
      collectors: harnessKeys.map((key) => {
        const sources = sourcesFor(key);
        return {
          key,
          cacheName: key,
          allowUnscopedSourceAdmission: true,
          watchRoots: () => [],
          watchMatch: () => true,
          listSources: () => sources,
          parse: (source: string) =>
            Promise.resolve([makeSession(`session-${source}`)]),
        };
      }),
    });
    manager.start();
    try {
      await settled.promise;
      return { completeCalls, progress: manager.getIngestProgress() };
    } finally {
      // ALWAYS stop the manager. A rejected wait would otherwise leave the
      // import loop running and hang the whole test FILE instead of failing
      // this case.
      await manager.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** What `invoke` threw, or null when it returned — never a swallowed throw. */
function captureThrow(invoke: () => void): unknown {
  try {
    invoke();
  } catch (error) {
    return error;
  }
  return null;
}
