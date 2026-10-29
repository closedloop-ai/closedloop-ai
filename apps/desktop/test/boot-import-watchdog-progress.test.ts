import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { BootImportLifecycle } from "../src/main/collectors/engine/boot-import-watchdog.js";
import type { IngestProgressTracker } from "../src/main/collectors/engine/collector-manager-ingest-progress.js";
import {
  IMPORT_NO_MOVEMENT_GIVE_UP_MS,
  SANCTIONED_SOURCE_STALL_MS,
} from "../src/shared/historical-import-bounds.js";
import { createTracker } from "./helpers/ingest-progress-fixture.js";
import { nodeTestTimers } from "./support/node-test-fake-timers.js";

// ISS-8058. The boot watchdog was a fixed wall clock with no progress input, so
// it could not tell WEDGED from BIG. On a real 10,366-transcript profile it
// fired at exactly 30 minutes over an import that was still climbing at 72ms
// parse / 415ms import per source, and the first screen a new user ever sees
// told them "Import didn't finish — Stopped after 3,480 of 10,366 transcripts".
// At the collector's own measured pace that corpus needs ~90 minutes, so the
// fixed bound accused every large profile.
//
// The window below is INJECTED rather than read from
// DEFAULT_BOOT_IMPORT_WATCHDOG_MS: these cases drive the window, they do not
// police its value.
const WATCHDOG_WINDOW_MS = 30 * 60_000;
const NINETY_MINUTES_MS = 90 * 60_000;
// One source lands per step — far slower than the real 0.49s/source, and still
// unambiguously movement.
const STEP_MS = 60_000;
const CODEX_SOURCES = 9211;

const REARM_ADVANCING_RE = /re-arming \(a large first launch is not a wedge\)/;
const GAVE_UP_RE = /the import did not settle/;

type Harness = {
  lifecycle: BootImportLifecycle;
  tracker: IngestProgressTracker;
  lines: string[];
  readonly timeouts: number;
  readonly completes: number;
  /**
   * ISS-6207's second degraded terminal. Counted rather than stubbed away so a
   * lifecycle that took THIS arm cannot read as "nothing fired" in a case
   * asserting `completes === 0` — the exact confusion this file's sibling
   * (`boot-import-retry-exhaustion.test.ts`) exists to prevent.
   */
  readonly retriesExhausted: number;
  /** Move the tracker's clock and the watchdog's timers together. */
  elapse(ms: number): void;
};

// Unconditional: a thrown assertion would otherwise strand every later test in
// this file on a frozen clock.
afterEach(() => {
  nodeTestTimers.reset();
});

/** Run `body` with a fake `setTimeout` installed; `afterEach` restores it. */
function withFakeTimers(body: () => void): void {
  nodeTestTimers.enable(["setTimeout"]);
  body();
}

/**
 * A lifecycle wired to a REAL `IngestProgressTracker`, so `isAdvancing` is
 * answered by the same ledger production reads rather than a stub that could
 * agree with the fix by construction.
 */
function createHarness(): Harness {
  const { tracker, clock, lines } = createTracker();
  const state = { timeouts: 0, completes: 0, retriesExhausted: 0 };
  const lifecycle = new BootImportLifecycle({
    timeoutMs: WATCHDOG_WINDOW_MS,
    isStopped: () => false,
    currentGeneration: () => 1,
    isPaused: () => false,
    isAdvancing: () => tracker.hasAdvancingPass(IMPORT_NO_MOVEMENT_GIVE_UP_MS),
    onComplete: () => {
      state.completes += 1;
    },
    onTimeout: () => {
      state.timeouts += 1;
    },
    onRetriesExhausted: () => {
      state.retriesExhausted += 1;
    },
    log: (message) => lines.push(message),
  });
  return {
    lifecycle,
    tracker,
    lines,
    get timeouts() {
      return state.timeouts;
    },
    get completes() {
      return state.completes;
    },
    get retriesExhausted() {
      return state.retriesExhausted;
    },
    elapse(ms) {
      clock.advanceTo(clock.now() + ms);
      nodeTestTimers.tick(ms);
    },
  };
}

test("a large first launch that keeps landing sources never reaches timedOut", () => {
  withFakeTimers(() => {
    const h = createHarness();
    h.tracker.beginPass("codex", CODEX_SOURCES);
    h.lifecycle.arm(1);

    // 90 minutes — three times the old fixed bound — of an import that is slow
    // but unmistakably moving.
    for (let elapsed = 0; elapsed < NINETY_MINUTES_MS; elapsed += STEP_MS) {
      h.elapse(STEP_MS);
      h.tracker.advance("codex", 72, 415);
    }

    assert.equal(
      h.timeouts,
      0,
      "a still-advancing import was reported as a failed one"
    );
    assert.equal(h.lifecycle.isTimedOut(), false);
    // The watchdog really did wake and really did take the advancing branch.
    // Without this, a watchdog that silently never armed would satisfy both
    // assertions above and prove nothing.
    const rearms = h.lines.filter((line) => REARM_ADVANCING_RE.test(line));
    assert.equal(
      rearms.length,
      3,
      `expected one re-arm per 30-minute window across 90 minutes: ${JSON.stringify(h.lines)}`
    );
  });
});

test("a harness that lands no source for the whole window still reaches timedOut", () => {
  withFakeTimers(() => {
    const h = createHarness();
    h.tracker.beginPass("codex", CODEX_SOURCES);
    h.lifecycle.arm(1);

    // The same clock and the same window as the case above — the ONLY
    // difference is that no source ever completes.
    for (let elapsed = 0; elapsed < WATCHDOG_WINDOW_MS; elapsed += STEP_MS) {
      h.elapse(STEP_MS);
    }

    assert.equal(h.timeouts, 1, "a genuinely wedged import must still surface");
    assert.equal(h.lifecycle.isTimedOut(), true);
    assert.ok(h.lines.some((line) => GAVE_UP_RE.test(line)));
    // FEA-4156's constraint, unchanged: a timeout is degraded, NOT complete, so
    // post-boot maintenance must not fire against an unsettled import.
    assert.equal(h.completes, 0, "a timeout must not imply completion");
    assert.equal(h.lifecycle.isComplete(), false);
  });
});

test("a source scan frozen before its first pass still reaches timedOut", () => {
  withFakeTimers(() => {
    const h = createHarness();
    // No beginPass: the scan froze before the harness ever registered a total,
    // so there is no progress entry to advance and nothing the aggregate can
    // see. ISS-5281's wedge — it must stay reachable now that movement gates
    // the fire.
    h.lifecycle.arm(1);

    h.elapse(WATCHDOG_WINDOW_MS);

    assert.equal(h.timeouts, 1);
    assert.equal(h.lifecycle.isTimedOut(), true);
  });
});

test("a source still inside its sanctioned budget is not yet a wedge", () => {
  withFakeTimers(() => {
    const h = createHarness();
    h.tracker.beginPass("codex", CODEX_SOURCES);
    h.lifecycle.arm(1);

    // Land a source, then go quiet for the FULL budget the main process grants
    // one source (90s bounded parse + 120s bounded write), with the watchdog
    // window closing inside that silence. Driven at the real boundary rather
    // than a token gap: a window mutated to anything at or below the sanctioned
    // budget has to fail here, which is the regression this arm exists for.
    h.elapse(WATCHDOG_WINDOW_MS - SANCTIONED_SOURCE_STALL_MS);
    h.tracker.advance("codex", 72, 415);
    h.elapse(SANCTIONED_SOURCE_STALL_MS);

    assert.equal(
      h.timeouts,
      0,
      "a source still inside its own sanctioned parse/write budget is not wedged"
    );
    // Proves the window actually closed during that silence rather than the
    // case simply stopping short of it.
    assert.ok(
      h.lines.some((line) => REARM_ADVANCING_RE.test(line)),
      `the watchdog never woke: ${JSON.stringify(h.lines)}`
    );
  });
});

test("a sibling still landing sources cannot mask a wedged harness", () => {
  withFakeTimers(() => {
    const h = createHarness();
    // The case FEA-4156 built this watchdog for, and the only control for it:
    // the renderer's backstop watches the AGGREGATE, which the healthy harness
    // keeps moving, so it can never see the wedged one.
    h.tracker.beginPass("codex", CODEX_SOURCES);
    h.tracker.beginPass("claude", 1154);
    h.lifecycle.arm(1);

    for (let elapsed = 0; elapsed < WATCHDOG_WINDOW_MS; elapsed += STEP_MS) {
      h.elapse(STEP_MS);
      // Only codex completes anything. Claude is in flight and wedged.
      h.tracker.advance("codex", 72, 415);
    }

    assert.equal(
      h.timeouts,
      1,
      "a wedged harness must surface even while a sibling keeps advancing"
    );
    assert.equal(h.lifecycle.isTimedOut(), true);
  });
});

test("a re-entry or resume without a completed source is not movement", () => {
  withFakeTimers(() => {
    const h = createHarness();
    h.tracker.beginPass("codex", CODEX_SOURCES);
    h.lifecycle.arm(1);

    // A cooperative yield re-enters through `beginPass`, and a pause resumes
    // through `noteResumed`. Both re-seed the tracker's WARN-line ledger, and
    // neither finishes a source — so neither may read as movement, or a wedge
    // that keeps yielding would excuse itself forever.
    for (let elapsed = 0; elapsed < WATCHDOG_WINDOW_MS; elapsed += STEP_MS) {
      h.elapse(STEP_MS);
      h.tracker.beginPass("codex", CODEX_SOURCES);
      h.tracker.noteResumed("codex");
    }

    assert.equal(
      h.timeouts,
      1,
      "re-entry and resume are not a completed source"
    );
    assert.equal(h.lifecycle.isTimedOut(), true);
  });
});
