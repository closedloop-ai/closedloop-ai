/**
 * @file collector-manager-watch-lost-wiring.test.ts
 * @description ISS-8600 — pins that `CollectorManager`'s `onWatchLost` option
 * actually reaches the watcher the manager constructs, carrying the harness the
 * engine itself does not hold.
 *
 * Its own file because no existing `collector-manager-*.test.ts` suite covers
 * watcher-OPTION forwarding: they drive imports, stop/generation lifecycle, and
 * teardown, none of which touch the options bag `scheduleHarnessStartup` builds.
 * Without this, the seam is three hops of plumbing (manager option → startup
 * input → watcher option) that every other suite would stay green through if any
 * hop were deleted — and the give-up path that fires it is five minutes deep in
 * a retry loop nothing else exercises through the manager.
 *
 * The harness binding is the part worth pinning rather than the call itself:
 * `createHarnessWatcher` is generic and holds no harness identity, so a
 * regression that forwarded the sink without closing over the collector would
 * still fire — and would ship a record naming the wrong collector, or none.
 *
 * TWO collectors is what makes that assertable, and the second one is not
 * scenery. With a single entry every wiring that names SOME collector satisfies
 * the final `deepEqual` — a hardcoded key, the last collector iterated, a
 * module-level global — so the case would pin the call it already had and not
 * the binding its own description claims. The second collector's root is live
 * for the whole case and never errors, so the harness a mis-bound sink reaches
 * for is never the harness the manager owes a record.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Harness } from "@repo/lib/harness/types";
import { afterEach, test } from "vitest";
import { CollectorManager } from "../src/main/collectors/engine/collector-manager.js";
import type { HarnessCollector } from "../src/main/collectors/types.js";
import {
  noopCooperativeDelay,
  type RecordingDirectoryWatcher,
  recordingFsWatcher,
} from "./helpers/collector-manager-fixtures.js";
import { nodeTestTimers } from "./support/node-test-fake-timers.js";

afterEach(() => {
  nodeTestTimers.reset();
});

test("ISS-8600: onWatchLost reaches the watcher CollectorManager constructs, bound to that collector's harness", async () => {
  const dir = mkdtempSync(join(tmpdir(), "collector-manager-watch-lost-"));
  // Attached first, then destroyed: a root that never existed exhausts the same
  // loop and deliberately reports nothing (see `hasLostLiveWatch` in the
  // watcher), so only a watch that was live can drive this wiring end to end.
  const lostRoot = join(dir, "copilot-sessions");
  // The second collector's root, live and unbroken for the whole case — what
  // makes the assertion below name ONE harness rather than accept any.
  const liveRoot = join(dir, "claude-sessions");
  mkdirSync(lostRoot, { recursive: true });
  mkdirSync(liveRoot, { recursive: true });
  try {
    // NOT `setImmediate`: the flushes below are real ones, and faking it would
    // park them until a tick this test never owes.
    nodeTestTimers.enable(["setTimeout", "setInterval"]);
    // Keyed by root, not indexed: which handle belongs to which collector is
    // the whole subject, so reading it off attach ORDER would be assuming the
    // answer.
    const handles = new Map<string, RecordingDirectoryWatcher>();
    const lost: Harness[] = [];
    const manager = new CollectorManager({
      importer: {
        importSession: () =>
          Promise.resolve({ skipped: false, reactivated: false }),
      },
      stateDir: join(dir, "state"),
      emit: () => undefined,
      // Watcher mode is what builds a watcher at all; "hooks"/"disabled" take
      // the deferred-import path and would make this test vacuous.
      getCollectionMode: () => "watcher",
      // No historical import, so the watcher runs neither a boot sweep nor a
      // catch-up poll and the retry loop is the only thing on the clock.
      historicalImportDelayMs: null,
      cooperativeDelay: noopCooperativeDelay,
      watchDirectory: (root) => {
        const handle = recordingFsWatcher();
        handles.set(root, handle);
        return handle;
      },
      onWatchLost: (harness) => lost.push(harness),
      collectors: [
        watchedCollector("copilot", lostRoot),
        watchedCollector("claude", liveRoot),
      ],
    });

    manager.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      [...handles.keys()],
      [lostRoot, liveRoot],
      "both collectors' roots must attach first"
    );
    assert.deepEqual(lost, [], "a live watch has lost nothing yet");

    handles.get(lostRoot)?.emitError(new Error("EMFILE"));
    rmSync(lostRoot, { recursive: true, force: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(lost, [], "a loop still retrying has lost nothing yet");

    // Past MAX_RETRY_ATTEMPTS * RETRY_MS (75 * 4000ms). Literals on purpose:
    // reading the production constants back would make this assert whatever
    // the code currently does.
    nodeTestTimers.tick(6 * 60_000);
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(
      lost,
      ["copilot"],
      "the manager's sink must fire once, carrying the harness whose watch died"
    );
    // The other collector's watch is still the live one it was, so "copilot"
    // above is a binding and not whichever key the loop happened to reach.
    assert.equal(
      handles.get(liveRoot)?.closeCount(),
      0,
      "the surviving collector's watch must not have been dropped"
    );

    await manager.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A minimal `"watcher"`-mode collector over exactly one root. */
function watchedCollector(key: Harness, root: string): HarnessCollector {
  return {
    key,
    cacheName: key,
    allowUnscopedSourceAdmission: true,
    watchRoots: () => [root],
    watchMatch: () => true,
    listSources: () => [],
    parse: () => Promise.resolve([]),
  };
}
