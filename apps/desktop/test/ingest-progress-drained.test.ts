import assert from "node:assert/strict";
import test from "node:test";
import { createTracker } from "./helpers/ingest-progress-fixture.js";

// ISS-5281 (wongk review). The import splash used to infer "the queue is empty"
// from the aggregate counters (`processed >= total && !preparing`). That is not
// the same claim, and the tracker is the only thing that can answer the real
// one: it knows which passes are in flight and what each one left behind. These
// pin the producer-owned `drained` signal against every way the inference lied.

test("nothing has been tracked yet, so drained asserts nothing", () => {
  const { tracker } = createTracker();

  assert.equal(tracker.snapshot().drained, false, "no pass has begun");

  tracker.markPreparing("claude");
  assert.equal(
    tracker.snapshot().drained,
    false,
    "a running source scan is not a drained queue"
  );
});

test("a finished pass with nothing left behind reports drained", () => {
  const { tracker } = createTracker();

  tracker.beginPass("claude", 3);
  assert.equal(
    tracker.snapshot().drained,
    false,
    "the pass is in flight, whatever the counters say"
  );
  for (let index = 0; index < 3; index += 1) {
    tracker.advance("claude", 0, 0);
  }
  // The counters now read 3/3 — the exact state the old renderer inference
  // settled on — but the pass has not ended.
  assert.deepEqual(tracker.snapshot().byHarness, [
    { harness: "claude", total: 3, processed: 3 },
  ]);
  assert.equal(tracker.snapshot().drained, false);

  tracker.settlePass("claude");
  assert.equal(tracker.snapshot().drained, true);
});

// The re-entry case the bot review pinned: `markPreparing` is gated on
// `!hasEntry`, so every cooperative yield/resume re-scans with `preparing` FALSE
// while `processed === total` — reaching the known total is exactly what sends
// the loop back for the next quantum — and `beginPass` then grows `total`.
test("a re-entrant plateau is never drained, even with preparing off", () => {
  const { tracker } = createTracker();

  tracker.beginPass("claude", 2);
  tracker.advance("claude", 0, 0);
  tracker.advance("claude", 0, 0);
  const plateau = tracker.snapshot();
  assert.equal(plateau.processed, plateau.total, "the counters plateau");
  assert.equal(plateau.preparing, false, "and the scan flag is off");
  assert.equal(plateau.drained, false, "but the pass is still running");

  // The re-scan discovers two more, exactly as ISS-4715/ISS-5028 describe: the
  // plateau the inference would have settled on was not the end of anything.
  tracker.beginPass("claude", 2);
  assert.deepEqual(tracker.snapshot().byHarness, [
    { harness: "claude", total: 4, processed: 2 },
  ]);
});

// wongk: `settlePass` overwrites `processed` with `total`, so a source left
// retryable by `completeSource(..., false)` would be invisible afterwards and the
// later stall could promote genuinely unfinished work to Ready.
test("a settled pass that left a source retryable is not drained", () => {
  const { tracker } = createTracker();

  tracker.beginPass("claude", 4);
  tracker.advance("claude", 0, 0);
  tracker.advance("claude", 0, 0);
  tracker.advance("claude", 0, 0);
  // A parse timeout that stayed retryable: terminal for the loop, not durable.
  tracker.advance("claude", 0, 0, false);
  tracker.settlePass("claude");

  const snapshot = tracker.snapshot();
  // The bar still settles — the pass DID end — so this cannot be re-derived from
  // the counters, which is the whole reason the shortfall is preserved.
  assert.deepEqual(snapshot.byHarness, [
    { harness: "claude", total: 4, processed: 4 },
  ]);
  assert.equal(snapshot.drained, false);
});

test("an abandoned pass is not drained, and one settled harness cannot cover another", () => {
  const { tracker } = createTracker();

  tracker.beginPass("claude", 2);
  tracker.advance("claude", 0, 0);
  tracker.advance("claude", 0, 0);
  tracker.settlePass("claude");
  assert.equal(tracker.snapshot().drained, true);

  tracker.beginPass("codex", 2);
  assert.equal(
    tracker.snapshot().drained,
    false,
    "a second harness's pass is in flight"
  );
  tracker.advance("codex", 0, 0);
  tracker.advance("codex", 0, 0);
  tracker.abandonPass("codex", "import rejected");
  assert.equal(
    tracker.snapshot().drained,
    false,
    "an abandon is never a drained outcome, whatever the counters reached"
  );
});

test("resetForStop clears the recorded shortfall with the rest of the pass state", () => {
  const { tracker } = createTracker();

  tracker.beginPass("claude", 2);
  tracker.advance("claude", 0, 0, false);
  tracker.advance("claude", 0, 0, false);
  tracker.settlePass("claude");
  assert.equal(tracker.snapshot().drained, false);

  tracker.resetForStop();
  assert.equal(
    tracker.snapshot().drained,
    false,
    "a cleared tracker has tracked nothing, so it asserts nothing"
  );

  // The first-pass gate survives resetForStop, but a fresh pass for a NEW
  // harness must not inherit the old shortfall.
  tracker.beginPass("codex", 1);
  tracker.advance("codex", 0, 0);
  tracker.settlePass("codex");
  assert.equal(tracker.snapshot().drained, true);
});
