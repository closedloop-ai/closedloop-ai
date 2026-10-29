/**
 * @file ingest-pending-bytes.test.ts
 * @description ISS-8346 — the BYTE remainder `IngestProgressTracker` keeps
 * beside its source-file counters, and the four ways it must refuse to state a
 * number rather than state a wrong one.
 *
 * The defect this ledger exists to prevent is a FALSE COMPLETION: the onboarding
 * estimate reads this remainder, subtracts it from the measured corpus, and its
 * high-water mark holds whatever it is told. A zero invented here is therefore
 * not a small error — it says "already analyzed" for the life of the process, on
 * exactly the first launch the estimate was built for.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { createTracker } from "./helpers/ingest-progress-fixture.js";

const CLAUDE = "claude";
const CODEX = "codex";
const OPENCODE = "opencode";
const ALL = [CLAUDE, CODEX, OPENCODE];
const MIB = 1024 * 1024;

test("the remainder falls by the bytes each durably finished source carried", () => {
  const { tracker } = createTracker();

  tracker.beginPass(CLAUDE, 3, 30 * MIB);
  assert.equal(tracker.remainingPendingBytes([CLAUDE]), 30 * MIB);

  tracker.advance(CLAUDE, 0, 0, true, 10 * MIB);
  assert.equal(tracker.remainingPendingBytes([CLAUDE]), 20 * MIB);

  tracker.advance(CLAUDE, 0, 0, true, 20 * MIB);
  assert.equal(
    tracker.remainingPendingBytes([CLAUDE]),
    0,
    "a pass whose every source landed has nothing left to parse"
  );
});

test("a source left for retry keeps its bytes in the remainder", () => {
  // The mirror of the source COUNT rule, and load-bearing for the same reason:
  // the next `beginPass` re-sums the sources still pending, so subtracting a
  // retryable source here would make the remainder short by that file on every
  // attempt — a countdown that finishes while the import is still working.
  const { tracker } = createTracker();

  tracker.beginPass(CLAUDE, 2, 8 * MIB);
  tracker.advance(CLAUDE, 0, 0, false, 5 * MIB);

  assert.equal(tracker.remainingPendingBytes([CLAUDE]), 8 * MIB);
});

test("a re-entry SETS the remainder from the recomputed pending set", () => {
  // A cooperative yield re-enters with the sources still pending. That sum IS
  // the remainder, so it replaces rather than accumulating — and it is how a
  // file discovered mid-pass raises the remainder instead of being missed.
  const { tracker } = createTracker();

  tracker.beginPass(CLAUDE, 4, 40 * MIB);
  tracker.advance(CLAUDE, 0, 0, true, 10 * MIB);
  assert.equal(tracker.remainingPendingBytes([CLAUDE]), 30 * MIB);

  tracker.beginPass(CLAUDE, 5, 45 * MIB);

  assert.equal(
    tracker.remainingPendingBytes([CLAUDE]),
    45 * MIB,
    "newly discovered sources raise the remainder rather than being dropped"
  );
});

test("a remainder never goes negative when a source outgrows its measured size", () => {
  const { tracker } = createTracker();

  tracker.beginPass(CLAUDE, 1, 2 * MIB);
  tracker.advance(CLAUDE, 0, 0, true, 9 * MIB);

  assert.equal(tracker.remainingPendingBytes([CLAUDE]), 0);
});

test("an unmeasurable byte count is refused rather than summed", () => {
  // The whole impossible set, not the two everyone remembers. Each of these
  // renders as a confident figure once it reaches the estimate's arithmetic.
  for (const impossible of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const { tracker } = createTracker();
    tracker.beginPass(CLAUDE, 1, impossible);
    assert.equal(
      tracker.remainingPendingBytes([CLAUDE]),
      null,
      `an impossible pass total (${impossible}) states no remainder`
    );
  }

  const { tracker } = createTracker();
  tracker.beginPass(CLAUDE, 2, 10 * MIB);
  tracker.advance(CLAUDE, 0, 0, true, Number.NaN);
  assert.equal(
    tracker.remainingPendingBytes([CLAUDE]),
    10 * MIB,
    "an impossible source size subtracts nothing instead of poisoning the sum"
  );
});

test("a pass whose population could not be measured states no remainder", () => {
  // Every source of a batch collector: `collectPendingSources` reads no stat for
  // one, so its pass has an honest source count and no byte population at all.
  const { tracker } = createTracker();

  tracker.beginPass(OPENCODE, 1, null);

  assert.equal(tracker.remainingPendingBytes([OPENCODE]), null);
});

test("one unmeasured harness withdraws the whole sum, not just its own share", () => {
  // A partial sum here would be reported as the WHOLE remaining corpus, so the
  // unmeasured harness's bytes would read as already parsed.
  const { tracker } = createTracker();

  tracker.beginPass(CLAUDE, 2, 12 * MIB);
  tracker.beginPass(OPENCODE, 1, null);

  assert.equal(tracker.remainingPendingBytes([CLAUDE]), 12 * MIB);
  assert.equal(tracker.remainingPendingBytes([CLAUDE, OPENCODE]), null);
});

test("only the named harnesses are summed", () => {
  // The inventory never counts Cursor or Copilot, so their bytes must not be
  // subtracted from a total that never included them.
  const { tracker } = createTracker();

  tracker.beginPass(CLAUDE, 1, 4 * MIB);
  tracker.beginPass(CODEX, 1, 6 * MIB);

  assert.equal(tracker.remainingPendingBytes([CLAUDE]), 4 * MIB);
  assert.equal(tracker.remainingPendingBytes([CODEX]), 6 * MIB);
  assert.equal(tracker.remainingPendingBytes([CLAUDE, CODEX]), 10 * MIB);
});

test("no tracked pass states no remainder, so nobody reads it as nothing-to-do", () => {
  const { tracker } = createTracker();

  assert.equal(tracker.remainingPendingBytes(ALL), null);

  tracker.beginPass(CODEX, 1, 3 * MIB);
  assert.equal(
    tracker.remainingPendingBytes([CLAUDE]),
    null,
    "a sibling harness's pass says nothing about this one"
  );
});

test("a harness still scanning its sources states no remainder", () => {
  // The scan runs BEFORE the first `beginPass`, and on a large history it runs
  // for a while. Answering 0 through that window is the false completion this
  // whole ledger exists to prevent, and it latches.
  const { tracker } = createTracker();

  tracker.markPreparing(CLAUDE);
  assert.equal(tracker.remainingPendingBytes([CLAUDE]), null);

  tracker.beginPass(CLAUDE, 1, 7 * MIB);
  tracker.clearPreparing(CLAUDE);
  assert.equal(tracker.remainingPendingBytes([CLAUDE]), 7 * MIB);
});

test("a scanning harness withdraws a sibling's stated remainder too", () => {
  const { tracker } = createTracker();

  tracker.beginPass(CLAUDE, 1, 5 * MIB);
  tracker.markPreparing(CODEX);

  assert.equal(tracker.remainingPendingBytes([CLAUDE, CODEX]), null);
});

test("a settled pass keeps the shortfall it actually ended with", () => {
  // `settlePass` settles the source BAR to 100% whether or not sources were left
  // behind. The byte remainder deliberately does not follow it: a pass that left
  // work undone must not report the corpus as parsed.
  const { tracker } = createTracker();

  tracker.beginPass(CLAUDE, 2, 20 * MIB);
  tracker.advance(CLAUDE, 0, 0, true, 8 * MIB);
  tracker.advance(CLAUDE, 0, 0, false, 12 * MIB);
  tracker.settlePass(CLAUDE);

  assert.equal(tracker.remainingPendingBytes([CLAUDE]), 12 * MIB);
});

test("a clean settled pass reports nothing remaining", () => {
  const { tracker } = createTracker();

  tracker.beginPass(CLAUDE, 2, 20 * MIB);
  tracker.advance(CLAUDE, 0, 0, true, 8 * MIB);
  tracker.advance(CLAUDE, 0, 0, true, 12 * MIB);
  tracker.settlePass(CLAUDE);

  assert.equal(tracker.remainingPendingBytes([CLAUDE]), 0);
});

test("an abandoned pass leaves its remainder standing", () => {
  // The pass ended WITHOUT finishing, so those bytes are still to parse. The
  // source-progress entry is dropped, which is why the ledger has to keep this
  // itself — and a re-drive's `beginPass` resets it from the fresh scan.
  const { tracker } = createTracker();

  tracker.beginPass(CLAUDE, 3, 30 * MIB);
  tracker.advance(CLAUDE, 0, 0, true, 10 * MIB);
  tracker.abandonPass(CLAUDE, "db host exited");

  assert.equal(tracker.remainingPendingBytes([CLAUDE]), 20 * MIB);

  tracker.beginPass(CLAUDE, 2, 20 * MIB);
  assert.equal(tracker.remainingPendingBytes([CLAUDE]), 20 * MIB);
});

test("an advance after the pass entry is gone changes nothing", () => {
  const { tracker } = createTracker();

  tracker.beginPass(CLAUDE, 2, 20 * MIB);
  tracker.abandonPass(CLAUDE, "db host exited");
  tracker.advance(CLAUDE, 0, 0, true, 20 * MIB);

  assert.equal(
    tracker.remainingPendingBytes([CLAUDE]),
    20 * MIB,
    "a late advance for an ended pass must not drain the remainder"
  );
});

test("stop clears the ledger, so a restart states nothing until it re-measures", () => {
  const { tracker } = createTracker();

  tracker.beginPass(CLAUDE, 2, 20 * MIB);
  tracker.resetForStop();

  assert.equal(tracker.remainingPendingBytes([CLAUDE]), null);
});

test("the byte remainder is absent from the renderer snapshot", () => {
  // Main-only by design: the estimate divides these bytes by a throughput the
  // renderer never sees, so a second byte figure on the banner payload would be
  // a number nothing renders and everything could disagree with.
  const { tracker } = createTracker();

  tracker.beginPass(CLAUDE, 2, 20 * MIB);

  assert.deepEqual(Object.keys(tracker.snapshot()).sort(), [
    "byHarness",
    "drained",
    "preparing",
    "processed",
    "total",
  ]);
});
