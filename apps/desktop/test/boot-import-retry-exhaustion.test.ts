/**
 * @file boot-import-retry-exhaustion.test.ts
 * @description ISS-6207 — an import that spent its retry budget and stopped is
 * NOT a complete import.
 *
 * ISS-5808 gave the abandoned pass a bounded in-session re-drive, and past that
 * bound `runImportFor` returned `completed: true` (`report.passCompleted ||
 * !budgeted`). One boolean was carrying two different questions — "should the
 * watcher re-queue this?" and "did the work finish?" — so the only way to stop
 * the re-drive loop was to tell the boot-import lifecycle the import had
 * finished. It had not: the tracker's own `unfinished` shortfall says so in the
 * same breath. Downstream, that false completion fires post-boot maintenance and
 * (through it) the cloud-read import-complete gate, hiding sessions that were
 * never imported behind a readiness state nothing will ever revisit.
 *
 * These cases follow the state across all three seams the ticket names:
 *   - the WATCHER's re-drive decision (`HarnessImportOutcome`),
 *   - the BOOT LIFECYCLE's terminal state (`onBootImportComplete` vs
 *     `onBootImportRetriesExhausted`),
 *   - the READINESS GATE the renderer and the cloud-read cutover read
 *     (`getIngestProgress()`).
 *
 * The cloud-read half of the last seam is wired downstream of
 * `onBootImportComplete` — it is post-boot maintenance settling that calls
 * `onInitialCollectorImportComplete` (pinned by `post-boot-maintenance-wire.test.ts`)
 * — so proving that hook never fires is what proves the gate stays closed.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import type { CollectionMode } from "../src/main/collectors/engine/collection-mode.js";
import { CollectorManager } from "../src/main/collectors/engine/collector-manager.js";
import {
  createHarnessWatcher,
  HarnessImportOutcome,
} from "../src/main/collectors/engine/watcher.js";
import type { HarnessCollector } from "../src/main/collectors/types.js";
import { DbHostExitError } from "../src/shared/db-host-exit-error.js";
import { fakeCollector } from "./normalized-session-test-utils.js";
import { waitForCondition } from "./wait-for-condition.js";

/**
 * Wall-clock bound for the re-drive chain; a bound, not a timing assertion.
 *
 * It is milliseconds rather than a count of yields because a count is worth
 * wildly different wall clock on different hosts: 20k `setImmediate` turns
 * measured 13.2s on a loaded dev box and expired in well under 60ms on the CI
 * runner. A bound that can run out before a timer the case is waiting on has
 * come due is not a bound.
 */
const REDRIVE_WAIT_MS = 5000;

/** A collector whose source enumeration fails with `error` on every pass. */
function failingCollector(error: Error): HarnessCollector {
  return {
    ...fakeCollector("claude"),
    listSources: () => {
      throw error;
    },
  };
}

/** Bounded wait for a predicate, throwing on exhaustion (no silent fall-through). */
function waitFor(predicate: () => boolean, describe: () => string) {
  return waitForCondition(
    predicate,
    REDRIVE_WAIT_MS,
    1,
    () => `condition not met within the bound; ${describe()}`
  );
}

type ExhaustionRun = {
  completeCalls: number;
  retriesExhaustedCalls: number;
  timeoutCalls: number;
  progress: ReturnType<CollectorManager["getIngestProgress"]>;
};

/**
 * Drive a real `CollectorManager` whose harness fails every pass with a
 * RECOVERABLE db-host exit — the one class ISS-5808 re-drives — until the
 * bounded budget is spent, then snapshot what the boot lifecycle claimed.
 */
async function runUntilRetryBudgetSpent(
  collectionMode: CollectionMode = "watcher"
): Promise<ExhaustionRun> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss-6207-exhaustion-"));
  const logs: string[] = [];
  let completeCalls = 0;
  let retriesExhaustedCalls = 0;
  let timeoutCalls = 0;
  try {
    const manager = new CollectorManager({
      importer: {
        importSession: () => ({ skipped: false, reactivated: false }),
      },
      stateDir: dir,
      emit: () => {
        // unused
      },
      getCollectionMode: () => collectionMode,
      // No missed-event sweep: the re-drive chain under test must be the only
      // thing re-queueing the historical pass.
      catchupPollMs: null,
      log: (message: string) => logs.push(message),
      onBootImportComplete: () => {
        completeCalls++;
      },
      onBootImportRetriesExhausted: () => {
        retriesExhaustedCalls++;
      },
      onBootImportTimeout: () => {
        timeoutCalls++;
      },
      collectors: [
        failingCollector(
          new DbHostExitError(0, true, "db-host exited (code: 0)")
        ),
      ],
    });
    manager.start();
    try {
      await waitFor(
        () => retriesExhaustedCalls + completeCalls > 0,
        () =>
          `the boot import never reached a terminal state; saw ${JSON.stringify(logs)}`
      );
      return {
        completeCalls,
        retriesExhaustedCalls,
        timeoutCalls,
        progress: manager.getIngestProgress(),
      };
    } finally {
      // ALWAYS stop the manager. A failed wait would otherwise leave the import
      // loop running and hang the whole test FILE instead of failing this case.
      await manager.stop();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a boot import whose retry budget is spent does not fire completion", async () => {
  const run = await runUntilRetryBudgetSpent();

  assert.equal(
    run.completeCalls,
    0,
    "onBootImportComplete fires post-boot maintenance and, through it, the cloud-read import-complete gate — it must not fire over sources that were never imported"
  );
  assert.equal(
    run.retriesExhaustedCalls,
    1,
    "the exhausted budget must settle the boot import into its own degraded terminal, exactly once"
  );
  assert.equal(
    run.timeoutCalls,
    0,
    "the import DID settle, so this is not the watchdog's wedged-import case"
  );
});

test("the readiness gate reports the spent retry budget as degraded, not complete", async () => {
  const run = await runUntilRetryBudgetSpent();

  assert.equal(
    run.progress.complete,
    false,
    "`complete` is what the splash and the sessions summary latch on; an import that gave up has not completed"
  );
  assert.equal(
    run.progress.retriesExhausted,
    true,
    "the degraded terminal must be reported, or the UI has nothing honest to resolve on and waits forever"
  );
  assert.equal(
    run.progress.timedOut,
    false,
    "the three terminal claims stay distinguishable: this one settled, it did not time out"
  );
});

/**
 * review-soul: the defect re-opens on the timeout-first path unless the
 * exhaustion is still RECORDED after the watchdog has fired.
 *
 * The watchdog firing does not end the import — the harness keeps running and
 * its promise settles later. If `noteRetriesExhausted` swallowed the exhaustion
 * once `timedOut` was set, that late `settle()` fell straight through to
 * `onComplete`, firing post-boot maintenance and the cloud-read gate over the
 * very sources the budget could not recover.
 *
 * The timeout-first ORDER is established by construction rather than by racing
 * two clocks: the first pass parks on the injected renderer-background-slot
 * gate (awaited before the source scan), so the import CANNOT settle until this
 * test opens it, and it only opens it once the watchdog has actually fired.
 *
 * The first revision instead delayed the first sweep 60ms and trusted the
 * bounded wait to outlast it. On the CI runner it did not: the wait below threw
 * `never settled after the timeout` because its turns ran out while the sweep
 * was still parked on that delay, which is the whole of this case's CI failure.
 */
test("a timeout followed by an exhausted budget still refuses completion", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss-6207-timeout-first-"));
  let completeCalls = 0;
  let retriesExhaustedCalls = 0;
  let timeoutCalls = 0;
  const firstScan = createGate();
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
      catchupPollMs: null,
      bootImportWatchdogMs: 1,
      // Park the first pass BEFORE its source scan (`scanImportPass` awaits this
      // gate) so the watchdog cannot lose the race — it is opened below, only
      // once the timeout has fired.
      waitForRendererBackgroundSlot: () => firstScan.gate,
      log: () => {
        // unused
      },
      onBootImportComplete: () => {
        completeCalls++;
      },
      onBootImportRetriesExhausted: () => {
        retriesExhaustedCalls++;
      },
      onBootImportTimeout: () => {
        timeoutCalls++;
      },
      collectors: [
        failingCollector(
          new DbHostExitError(0, true, "db-host exited (code: 0)")
        ),
      ],
    });
    manager.start();
    try {
      await waitFor(
        () => timeoutCalls > 0,
        () => "the watchdog never fired"
      );
      // Only now can the parked pass run, abandon, and spend its budget — every
      // terminal claim this case asserts on lands strictly after the timeout.
      firstScan.open();
      await waitFor(
        () => retriesExhaustedCalls + completeCalls > 0,
        () => "the boot import never settled after the timeout"
      );
      assert.equal(
        completeCalls,
        0,
        "a late settle after a timeout must not claim completion when the re-drive budget was spent — that is this ticket's defect on the timeout-first path"
      );
      assert.equal(
        retriesExhaustedCalls,
        1,
        "the exhaustion is still news after the watchdog fired: the import had not ended when the bound elapsed"
      );
    } finally {
      // ALWAYS open the gate as well as stopping: a failed wait would otherwise
      // leave the first pass parked on an unresolved promise forever, hanging
      // the whole test FILE instead of failing this case.
      firstScan.open();
      await manager.stop();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * davetho (#5917): the timeout-first path re-opens the defect a SECOND way,
 * and the case above does not cover it.
 *
 * That case pairs the timeout with a SPENT re-drive budget, so the late
 * `settle()` is carried by the `sawRetriesExhausted` arm. Nothing covered the
 * pairing where the harness the watchdog gave up on later settles CLEANLY: no
 * budget was spent, `sawRetriesExhausted` stays false, and `settle()` fell
 * straight through to `completed = true` — firing post-boot maintenance and the
 * cloud-read cutover on a boot import whose degraded terminal the renderer had
 * ALREADY been shown. "Every promise settled" is not evidence every source was
 * imported once the watchdog stopped accounting for the harness that ran past
 * the bound.
 *
 * The clean settle is the whole point of the case: this collector enumerates no
 * sources and fails nothing, so the timeout the watchdog already recorded is the
 * only fact standing between it and `onComplete`.
 *
 * Order is established by construction rather than by racing two clocks — the
 * same renderer-background-slot gate the case above uses parks the pass before
 * its source scan, and it is opened only once the timeout has actually fired.
 */
test("a timeout followed by a clean settle still refuses completion", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss-6207-timeout-clean-"));
  // Not an assertion — the synchronization point. It is reached on the FIXED
  // path; the broken path reaches `completeCalls > 0` instead. The wait below
  // therefore ends on either, so the ASSERTIONS discriminate rather than a
  // timeout.
  const settleAfterTimeoutLog =
    "boot import settled after the watchdog had already given up on it";
  const logs: string[] = [];
  let completeCalls = 0;
  let retriesExhaustedCalls = 0;
  let timeoutCalls = 0;
  const firstScan = createGate();
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
      catchupPollMs: null,
      bootImportWatchdogMs: 1,
      waitForRendererBackgroundSlot: () => firstScan.gate,
      log: (message: string) => logs.push(message),
      onBootImportComplete: () => {
        completeCalls++;
      },
      onBootImportRetriesExhausted: () => {
        retriesExhaustedCalls++;
      },
      onBootImportTimeout: () => {
        timeoutCalls++;
      },
      // Succeeds, with nothing to do: no failure, so no re-drive budget is ever
      // spent and the late settle is genuinely clean.
      collectors: [fakeCollector("claude")],
    });
    manager.start();
    try {
      await waitFor(
        () => timeoutCalls > 0,
        () => "the watchdog never fired"
      );
      firstScan.open();
      await waitFor(
        () =>
          completeCalls > 0 ||
          logs.some((line) => line.includes(settleAfterTimeoutLog)),
        () =>
          `the boot import never settled after the timeout; saw ${JSON.stringify(logs)}`
      );
      assert.equal(
        completeCalls,
        0,
        "a clean settle after a timeout must not claim completion — the renderer was already told this boot import was degraded, and completing it fires post-boot maintenance and the cloud-read cutover over sources the watchdog stopped accounting for"
      );
      assert.equal(
        retriesExhaustedCalls,
        0,
        "no re-drive budget was spent in this case; if this fires, the collector failed and the case has stopped covering the CLEAN settle it names"
      );
      const progress = manager.getIngestProgress();
      assert.equal(
        progress.complete,
        false,
        "the readiness gate must not report a timed-out boot import as complete"
      );
      assert.equal(
        progress.timedOut,
        true,
        "the degraded timed-out terminal must survive the late settle rather than be retracted by it"
      );
    } finally {
      // ALWAYS open the gate as well as stopping: a failed wait would otherwise
      // leave the first pass parked on an unresolved promise forever, hanging
      // the whole test FILE instead of failing this case.
      firstScan.open();
      await manager.stop();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * whitlockk (#5917): the hooks/disabled lane reaches the same false completion by a
 * different route, and the fix above does not cover it.
 *
 * That lane is `captureDeferredImport`, not a watcher — one scheduled pass, no
 * `drainImports` loop, and a wrapper that resolves on FINISH rather than
 * success. So its pass abandons with re-drive budget still to spare, reports
 * `Incomplete`, and that outcome reaches nobody: `allSettled` sees a resolved
 * promise, `settle()` sees no degraded vote, and completion fires over sources
 * that were never imported and that nothing will re-read this boot. It is the
 * lane Claude takes whenever its hook collection mode is active.
 *
 * ONE abandon, deliberately — the budget is NOT spent here. That is what makes
 * this case distinct from every one above rather than a second spelling of them.
 */
test("a hooks-mode boot import that abandoned its only pass does not fire completion", async () => {
  const run = await runUntilRetryBudgetSpent("hooks");

  assert.equal(
    run.completeCalls,
    0,
    "the deferred lane has no re-drive loop, so its abandoned pass is the end of that harness's boot import — claiming completion is this ticket's defect on the hooks path"
  );
  assert.equal(
    run.retriesExhaustedCalls,
    1,
    "it must settle into the degraded terminal instead, exactly once"
  );
  assert.equal(
    run.progress.complete,
    false,
    "and report that terminal to the renderer, or the readiness surfaces resolve on a completion that never happened"
  );
  assert.equal(
    run.progress.retriesExhausted,
    true,
    "the degraded terminal is the honest claim the UI has to resolve on"
  );
});

test("the watcher re-queues an incomplete pass but not an exhausted one", async () => {
  const outcomes = [
    HarnessImportOutcome.Incomplete,
    HarnessImportOutcome.Incomplete,
    HarnessImportOutcome.RetriesExhausted,
    HarnessImportOutcome.Completed,
  ];
  let sweeps = 0;
  const watcher = createHarnessWatcher({
    roots: () => [],
    match: () => true,
    runImport: (events) => {
      assert.equal(events, null, "only the full sweep is under test here");
      const outcome = outcomes[sweeps] ?? HarnessImportOutcome.Completed;
      sweeps++;
      return Promise.resolve({ outcome });
    },
    catchupPollMs: null,
  });

  await watcher.start();
  watcher.stop();

  // Two `Incomplete` sweeps re-queue; the third reports the budget spent and the
  // loop stops there — the fourth entry is never reached. A `Completed` third
  // sweep would look identical from the watcher's side, which is exactly why the
  // outcome (not a boolean) is what the boot lifecycle reads.
  assert.equal(
    sweeps,
    3,
    "an exhausted pass must end the immediate re-drive chain, and only that chain"
  );
});

/**
 * A promise plus the function that opens it. Lets a case pin the ORDER of two
 * events that would otherwise race — park the production code on `gate` and
 * `open()` it once the other event has been observed — instead of pinning a
 * delay and hoping.
 */
function createGate(): { gate: Promise<void>; open: () => void } {
  let open: () => void = () => {
    // Replaced synchronously by the executor below, which always runs first.
  };
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { gate, open };
}
