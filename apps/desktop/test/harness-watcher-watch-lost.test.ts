/**
 * @file harness-watcher-watch-lost.test.ts
 * @description ISS-8600's watch-lost seam on `createHarnessWatcher`: which
 * exhaustion of the bounded re-attach loop is owed an import-health record, and
 * which must stay silent.
 *
 * Split out of `harness-watcher.test.ts` — which owns live/historical import
 * scheduling and the containment mapping — because this one contract is the
 * larger half of that file and every case it needs is a ~60-line timer
 * choreography. Both suites drive the same watcher through the same shared
 * fixtures (`recordingFsWatcher`, `nodeTestTimers`) rather than either growing a
 * private copy.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { createHarnessWatcher } from "../src/main/collectors/engine/watcher.js";
import {
  type RecordingDirectoryWatcher,
  recordingFsWatcher,
} from "./helpers/collector-manager-fixtures.js";
import { nodeTestTimers } from "./support/node-test-fake-timers.js";

afterEach(() => {
  nodeTestTimers.reset();
});

test("ISS-8600: exhausting the fast re-attach loop reports watch-lost exactly once", async () => {
  const parent = mkdtempSync(join(tmpdir(), "harness-watcher-watch-lost-"));
  const root = join(parent, "sessions");
  mkdirSync(root, { recursive: true });
  try {
    nodeTestTimers.enable(["setTimeout", "setInterval"]);
    const handles: RecordingDirectoryWatcher[] = [];
    let watchLost = 0;
    const watcher = createHarnessWatcher({
      roots: () => [root],
      match: (filename) => filename.endsWith(".jsonl"),
      runInitialImport: false,
      // No poll: the only thing that can move here is the fast retry loop.
      catchupPollMs: null,
      watchDirectory: () => {
        const handle = recordingFsWatcher();
        handles.push(handle);
        return handle;
      },
      runImport: () => Promise.resolve(undefined),
      onWatchLost: () => {
        watchLost += 1;
      },
    });

    await watcher.start();
    assert.equal(handles.length, 1, "the root must hold a live watch first");

    // The watch dies and its directory goes with it, so every re-attach fails.
    // Losing a live watch is what this record MEANS, so it is what the test
    // drives: exhausting the loop without one is the sibling case below.
    handles[0]?.emitError(new Error("EMFILE"));
    rmSync(root, { recursive: true, force: true });

    // One tick short of MAX_RETRY_ATTEMPTS * RETRY_MS (75 * 4000ms). Literals
    // on purpose: reading the production constants back would make this assert
    // whatever the code currently does.
    nodeTestTimers.tick(74 * 4000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      watchLost,
      0,
      "a loop still retrying has not lost the watch yet"
    );

    nodeTestTimers.tick(6 * 60_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(watchLost, 1, "giving up must report watch-lost");

    // The give-up branch clears the interval, so no later tick can re-report
    // the same exhaustion and turn one dead watch into a stream of records.
    nodeTestTimers.tick(6 * 60_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(watchLost, 1, "exhaustion must report once, not per tick");

    watcher.stop();
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("ISS-8600: an existing root whose watch never arms reports watch-lost", async () => {
  // The half `everAttached` alone cannot see. `attach()` wraps its whole body in
  // one try, so an uninstalled harness (existsSync false) and an INSTALLED one
  // whose `fs.watch` throws -- EMFILE/ENFILE/ENOSPC on a descriptor or inotify
  // limit, EPERM -- both return false. The second never reaches
  // `everAttached.add`, so gating the report on that set alone makes exactly the
  // case this record exists for invisible: the harness is installed, its live
  // watch is dead, and only the 30-minute catch-up poll still moves its data.
  const dir = mkdtempSync(join(tmpdir(), "harness-watcher-arm-throws-"));
  try {
    nodeTestTimers.enable(["setTimeout", "setInterval"]);
    const logs: string[] = [];
    let attachAttempts = 0;
    let watchLost = 0;
    const watcher = createHarnessWatcher({
      roots: () => [dir],
      match: (filename) => filename.endsWith(".jsonl"),
      runInitialImport: false,
      // No poll: the only thing that can move here is the fast retry loop.
      catchupPollMs: null,
      watchDirectory: () => {
        attachAttempts += 1;
        throw new Error("EMFILE: too many open files");
      },
      runImport: () => Promise.resolve(undefined),
      onWatchLost: () => {
        watchLost += 1;
      },
      log: (message) => logs.push(message),
    });

    await watcher.start();
    assert.equal(attachAttempts, 1, "an existing root must be attempted");
    assert.equal(
      logs.filter((message) => message.includes("could not be armed")).length,
      1,
      "a watch that cannot be armed must say so on the collector log"
    );

    // One tick short of MAX_RETRY_ATTEMPTS * RETRY_MS (75 * 4000ms). Literals on
    // purpose: reading the production constants back would make this assert
    // whatever the code currently does.
    nodeTestTimers.tick(74 * 4000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      watchLost,
      0,
      "a loop still retrying has not given up on the watch yet"
    );
    assert.equal(
      logs.filter((message) => message.includes("could not be armed")).length,
      1,
      "the arm failure is logged on the transition, not once per retry tick"
    );

    nodeTestTimers.tick(6 * 60_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      watchLost,
      1,
      "an installed harness whose watch never armed must report watch-lost"
    );

    watcher.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ISS-8600: a root whose watch arms on a later retry reports nothing", async () => {
  // The counterfactual for the case above, in the only shape that can reach
  // exhaustion after a recovery: a first-attempt EMFILE that clears four seconds
  // later is a routine flap, not a dead watch, and a never-existent sibling then
  // holds the loop open to the give-up branch. The arm-failure record must be
  // forgotten the moment the root actually attaches, exactly as a recovered
  // `dropFailedWatch` root is -- otherwise the flap reports itself dead.
  const parent = mkdtempSync(join(tmpdir(), "harness-watcher-arm-recovers-"));
  const flappyRoot = join(parent, "live");
  const missingRoot = join(parent, "never");
  mkdirSync(flappyRoot, { recursive: true });
  try {
    nodeTestTimers.enable(["setTimeout", "setInterval"]);
    const handles: RecordingDirectoryWatcher[] = [];
    let armThrows = true;
    let watchLost = 0;
    const watcher = createHarnessWatcher({
      roots: () => [flappyRoot, missingRoot],
      match: (filename) => filename.endsWith(".jsonl"),
      runInitialImport: false,
      catchupPollMs: null,
      watchDirectory: () => {
        if (armThrows) {
          throw new Error("EMFILE: too many open files");
        }
        const handle = recordingFsWatcher();
        handles.push(handle);
        return handle;
      },
      runImport: () => Promise.resolve(undefined),
      onWatchLost: () => {
        watchLost += 1;
      },
    });

    await watcher.start();
    assert.equal(handles.length, 0, "the first arm must fail");

    armThrows = false;
    nodeTestTimers.tick(4000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(handles.length, 1, "the retry must arm the watch");

    // The missing sibling keeps `allAttached` false, so the loop runs to the
    // give-up branch even though the root that mattered recovered in 4s.
    nodeTestTimers.tick(6 * 60_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      watchLost,
      0,
      "a watch that armed on a retry must never report itself lost"
    );

    watcher.stop();
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("ISS-8600: a root installed after the loop exhausted still reports a watch it cannot arm", async () => {
  // The sequence neither case above reaches, and the one a real install takes:
  // the harness is not installed at boot, so the loop runs to its correctly
  // silent exhaustion; the user installs the tool an hour later; the catch-up
  // tick finds the root and `fs.watch` throws. The tick attaches and imports but
  // re-arms nothing, so without an arm failure re-arming the bounded loop itself
  // the give-up branch is never reached again and an installed harness with no
  // live watch stays unreported for the life of the process.
  const parent = mkdtempSync(join(tmpdir(), "harness-watcher-late-install-"));
  const root = join(parent, "sessions");
  try {
    nodeTestTimers.enable(["setTimeout", "setInterval"]);
    const logs: string[] = [];
    let armAttempts = 0;
    let watchLost = 0;
    const watcher = createHarnessWatcher({
      roots: () => [root],
      match: (filename) => filename.endsWith(".jsonl"),
      runInitialImport: false,
      // The tick that discovers the late-installed root. It is also the only
      // thing still running once the fast loop has given up.
      catchupPollMs: 60_000,
      watchDirectory: () => {
        armAttempts += 1;
        throw new Error("EMFILE: too many open files");
      },
      runImport: () => Promise.resolve(undefined),
      onWatchLost: () => {
        watchLost += 1;
      },
      log: (message) => logs.push(message),
    });

    await watcher.start();
    assert.equal(armAttempts, 0, "an absent root is never handed to fs.watch");

    // Past MAX_RETRY_ATTEMPTS * RETRY_MS (75 * 4000ms). Literals on purpose:
    // reading the production constants back would make this assert whatever the
    // code currently does.
    nodeTestTimers.tick(6 * 60_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      watchLost,
      0,
      "exhausting on an uninstalled harness must stay silent"
    );

    // The harness is installed. The next catch-up tick finds the root, and
    // arming its watch fails.
    mkdirSync(root, { recursive: true });
    nodeTestTimers.tick(60_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(armAttempts, 1, "the catch-up tick must attempt the new root");
    assert.equal(
      logs.filter((message) => message.includes("could not be armed")).length,
      1,
      "the arm failure must reach the collector log"
    );
    assert.equal(watchLost, 0, "the re-armed loop has not given up yet");

    nodeTestTimers.tick(6 * 60_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      watchLost,
      1,
      "a watch that cannot be armed after exhaustion must still be reported"
    );

    // Still once: the arm failure is already recorded, so no later tick re-arms
    // the loop and turns one dead watch into a stream of records.
    nodeTestTimers.tick(6 * 60_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(watchLost, 1, "one dead watch must report once, not per tick");

    watcher.stop();
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("ISS-8600: a root that never appears stays silent through the same sequence", async () => {
  // The counterfactual for the case above. The catch-up tick runs for the whole
  // process either way, so a re-arm driven by the TICK rather than by an arm
  // failure would report every uninstalled harness on this exact timeline --
  // which is four of five collectors on a single-harness install.
  const parent = mkdtempSync(
    join(tmpdir(), "harness-watcher-never-installed-")
  );
  const missingRoot = join(parent, "sessions");
  try {
    nodeTestTimers.enable(["setTimeout", "setInterval"]);
    let armAttempts = 0;
    let watchLost = 0;
    const watcher = createHarnessWatcher({
      roots: () => [missingRoot],
      match: (filename) => filename.endsWith(".jsonl"),
      runInitialImport: false,
      catchupPollMs: 60_000,
      watchDirectory: () => {
        armAttempts += 1;
        throw new Error("EMFILE: too many open files");
      },
      runImport: () => Promise.resolve(undefined),
      onWatchLost: () => {
        watchLost += 1;
      },
    });

    await watcher.start();
    nodeTestTimers.tick(6 * 60_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(watchLost, 0, "exhaustion on an absent root reports nothing");

    // The same hour of catch-up ticks the installed root above was reported on.
    nodeTestTimers.tick(60 * 60_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(armAttempts, 0, "an absent root is never handed to fs.watch");
    assert.equal(
      watchLost,
      0,
      "a harness that was never installed must never be reported"
    );

    watcher.stop();
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("ISS-8600: a root that never existed reports nothing when the loop gives up", async () => {
  // The population this record would otherwise be dominated by. Every collector
  // is registered and enabled by default, so a Claude-only install arms this
  // same loop for codex/cursor/copilot/opencode, whose roots nothing will ever
  // create -- four reports about five minutes after every launch, for four
  // harnesses that never had live delivery to lose. A monitor whose records are
  // mostly that is a monitor nobody reads.
  const parent = mkdtempSync(join(tmpdir(), "harness-watcher-never-attached-"));
  const missingRoot = join(parent, "sessions");
  try {
    nodeTestTimers.enable(["setTimeout", "setInterval"]);
    let watchLost = 0;
    const watcher = createHarnessWatcher({
      roots: () => [missingRoot],
      match: (filename) => filename.endsWith(".jsonl"),
      runInitialImport: false,
      catchupPollMs: null,
      watchDirectory: () => recordingFsWatcher(),
      runImport: () => Promise.resolve(undefined),
      onWatchLost: () => {
        watchLost += 1;
      },
    });

    await watcher.start();
    nodeTestTimers.tick(6 * 60_000);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(
      watchLost,
      0,
      "a harness that never attached has no live delivery to lose"
    );

    watcher.stop();
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("ISS-8600: a sibling root that never existed does not report the root that recovered", async () => {
  // The mixed watcher, which neither case above reaches: one root attaches and
  // dies, a sibling never exists. The missing sibling keeps `allAttached` false
  // so the loop runs to exhaustion even after the first root comes back -- and
  // at that point nothing is lost, because the only unattached root never held
  // a watch.
  const parent = mkdtempSync(join(tmpdir(), "harness-watcher-mixed-roots-"));
  const liveRoot = join(parent, "live");
  const missingRoot = join(parent, "never");
  mkdirSync(liveRoot, { recursive: true });
  try {
    nodeTestTimers.enable(["setTimeout", "setInterval"]);
    const handles: RecordingDirectoryWatcher[] = [];
    let watchLost = 0;
    const watcher = createHarnessWatcher({
      roots: () => [liveRoot, missingRoot],
      match: (filename) => filename.endsWith(".jsonl"),
      runInitialImport: false,
      catchupPollMs: null,
      watchDirectory: () => {
        const handle = recordingFsWatcher();
        handles.push(handle);
        return handle;
      },
      runImport: () => Promise.resolve(undefined),
      onWatchLost: () => {
        watchLost += 1;
      },
    });

    await watcher.start();
    assert.equal(handles.length, 1, "only the root that exists can attach");

    // It dies and re-attaches on the next retry tick, well inside the budget.
    handles[0]?.emitError(new Error("EMFILE"));
    nodeTestTimers.tick(4000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(handles.length, 2, "the failed watch must re-attach");

    nodeTestTimers.tick(6 * 60_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      watchLost,
      0,
      "exhaustion driven by a never-existent sibling must report nothing"
    );

    watcher.stop();
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("ISS-8600: a watch that fails and recovers inside the retry budget reports nothing", async () => {
  // The counterfactual that carries this signal. A test asserting only the
  // give-up path stays green if the report were moved into `dropFailedWatch`,
  // which would turn every routine flap -- an EMFILE, a transient unmount --
  // into a false alarm saying live delivery is dead when it recovered in 4s.
  const dir = mkdtempSync(join(tmpdir(), "harness-watcher-watch-flap-"));
  try {
    nodeTestTimers.enable(["setTimeout", "setInterval"]);
    const handles: RecordingDirectoryWatcher[] = [];
    let watchLost = 0;
    const watcher = createHarnessWatcher({
      roots: () => [dir],
      match: (filename) => filename.endsWith(".jsonl"),
      runInitialImport: false,
      catchupPollMs: null,
      watchDirectory: () => {
        const handle = recordingFsWatcher();
        handles.push(handle);
        return handle;
      },
      runImport: () => Promise.resolve(undefined),
      onWatchLost: () => {
        watchLost += 1;
      },
    });

    await watcher.start();
    assert.equal(handles.length, 1, "the existing root must attach");

    handles[0]?.emitError(new Error("EMFILE"));
    nodeTestTimers.tick(4000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(handles.length, 2, "the failed watch must re-attach");

    // Well past the give-up threshold. The loop disarmed itself on the
    // successful re-attach, so there is nothing left to exhaust.
    nodeTestTimers.tick(6 * 60_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      watchLost,
      0,
      "a watch that recovered must never report itself lost"
    );

    watcher.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ISS-8600: a throwing watch-lost sink does not break the retry loop", async () => {
  const parent = mkdtempSync(join(tmpdir(), "harness-watcher-sink-throws-"));
  const root = join(parent, "sessions");
  mkdirSync(root, { recursive: true });
  try {
    nodeTestTimers.enable(["setTimeout", "setInterval"]);
    const handles: RecordingDirectoryWatcher[] = [];
    const watcher = createHarnessWatcher({
      roots: () => [root],
      match: (filename) => filename.endsWith(".jsonl"),
      runInitialImport: false,
      catchupPollMs: 60_000,
      watchDirectory: () => {
        const handle = recordingFsWatcher();
        handles.push(handle);
        return handle;
      },
      runImport: () => Promise.resolve(undefined),
      onWatchLost: () => {
        throw new Error("telemetry seam exploded");
      },
    });

    await watcher.start();
    assert.equal(handles.length, 1, "the root must hold a live watch first");

    // Attach, then lose it: only a lost watch reaches the report at all, so
    // only a lost watch can prove the throw is swallowed.
    handles[0]?.emitError(new Error("EMFILE"));
    rmSync(root, { recursive: true, force: true });
    nodeTestTimers.tick(6 * 60_000);
    await new Promise((resolve) => setImmediate(resolve));

    // The sink threw inside the give-up branch. Everything downstream of the
    // report must still work: the catch-up poll is what makes re-attachment
    // eventual, and losing it to a telemetry failure would cost live delivery
    // for the whole process.
    mkdirSync(root, { recursive: true });
    nodeTestTimers.tick(60_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      handles.length,
      2,
      "a throwing telemetry sink must not stop the catch-up poll re-attaching"
    );

    watcher.stop();
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
