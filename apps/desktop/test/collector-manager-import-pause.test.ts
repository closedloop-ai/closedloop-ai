import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ImportPauseGate } from "../src/main/collectors/engine/collector-manager-import-pause";

/**
 * ISS-5115 (wongk review): the startup panel used to render a pause REQUEST as
 * an outcome, claiming history processing had stopped while the collector was
 * still mid-scan. `isParked()` is the acknowledgement channel that fixed it, so
 * its divergence from `isPaused()` is the contract under test here.
 */
describe("ImportPauseGate parked acknowledgement", () => {
  it("is not parked merely because a pause was requested", () => {
    const gate = new ImportPauseGate();
    gate.pause();

    assert.equal(gate.isPaused(), true);
    // The import loop has not reached its next pause gate. During first-launch
    // source discovery that gap is the whole scan.
    assert.equal(gate.isParked(), false);
  });

  it("reports parked once the loop actually waits, and clears on resume", async () => {
    const gate = new ImportPauseGate();
    gate.pause();

    const waited = gate.wait();
    assert.equal(gate.isParked(), true);

    gate.resume();
    await waited;

    assert.equal(gate.isPaused(), false);
    assert.equal(gate.isParked(), false);
  });

  it("stays unparked when the gate is open, since wait() never blocks", async () => {
    const gate = new ImportPauseGate();

    await gate.wait();

    assert.equal(gate.isParked(), false);
  });

  it("tracks every waiter, so one harness resuming does not unpark the rest", async () => {
    const gate = new ImportPauseGate();
    gate.pause();

    const first = gate.wait();
    const second = gate.wait();
    assert.equal(gate.isParked(), true);

    gate.resume();
    await first;
    await second;

    assert.equal(gate.isParked(), false);
  });
});
