import { describe, expect, it } from "vitest";
import {
  isBootImportDegraded,
  isBootImportGiveUpVisible,
  isBootImportSettled,
} from "../ingest-progress-terminal";
import type { IngestProgress } from "../use-ingest-progress";

// The boot import SETTLED with source files left behind after their bounded
// automatic re-drive budget was spent (ISS-6207's degraded terminal). `processed`
// stays below `total` forever, and nothing is still running.
const RETRIES_EXHAUSTED: IngestProgress = {
  byHarness: [],
  total: 7,
  processed: 3,
  preparing: false,
  complete: false,
  retriesExhausted: true,
};

// FEA-4156's degraded terminal: the watchdog gave up on an import still running.
// Predates ISS-6207, so it is NOT behind the Labs gate.
const TIMED_OUT: IngestProgress = {
  byHarness: [],
  total: 7,
  processed: 3,
  preparing: false,
  complete: false,
  timedOut: true,
};

const COMPLETE: IngestProgress = {
  byHarness: [],
  total: 7,
  processed: 7,
  preparing: false,
  complete: true,
};

/**
 * ISS-6207 behind the ISS-4779 closed-by-default UI policy. The gate stops at
 * COPY: the only surface that reads it is the first-launch splash's give-up
 * decision. It deliberately does NOT gate the terminal FACT — an earlier
 * revision dropped `retriesExhausted` from the snapshot itself, which left a
 * stopped import reading as still running and stopped
 * `useSessionsImportProgress` from ever latching its 1s poll off.
 */
describe("isBootImportGiveUpVisible", () => {
  it("is false while the Labs gate is closed, even on a spent budget", () => {
    expect(isBootImportGiveUpVisible(RETRIES_EXHAUSTED, false)).toBe(false);
  });

  it("is true once the gate is open", () => {
    expect(isBootImportGiveUpVisible(RETRIES_EXHAUSTED, true)).toBe(true);
  });

  it("never gates FEA-4156's watchdog timeout, which predates this flag", () => {
    // Regression guard: gating `timedOut` here silently reverted FEA-4156's
    // partial-import state for every user, since the flag ships closed.
    expect(isBootImportGiveUpVisible(TIMED_OUT, false)).toBe(true);
    expect(isBootImportGiveUpVisible(TIMED_OUT, true)).toBe(true);
  });

  it("is false for a completed import on either side of the gate", () => {
    expect(isBootImportGiveUpVisible(COMPLETE, false)).toBe(false);
    expect(isBootImportGiveUpVisible(COMPLETE, true)).toBe(false);
  });

  it("is false before the runtime reports anything", () => {
    expect(isBootImportGiveUpVisible(null, false)).toBe(false);
    expect(isBootImportGiveUpVisible(null, true)).toBe(false);
  });

  it("leaves the terminal FACT ungated for the surfaces that must not hang", () => {
    // The regression this replaced: `isBootImportDegraded` is what
    // `isImportSettled` (Sessions summary cards) and the startup-readiness phase
    // read. It must answer true on a spent budget no matter what the Labs flag
    // says, or the 1s poll never terminates and the skeletons never clear.
    expect(isBootImportDegraded(RETRIES_EXHAUSTED)).toBe(true);
    expect(isBootImportDegraded(TIMED_OUT)).toBe(true);
    expect(isBootImportDegraded(COMPLETE)).toBe(false);
  });
});

/**
 * The Sessions/Dashboard read gate. It takes no flag: this ticket's
 * main-process half is unconditional, so on a retry-exhausted boot import the
 * producer now sends `complete: false` where it once sent `complete: true`.
 * Latching on `complete` alone would therefore not restore the pre-ticket
 * answer — it would never latch at all, leaving the page-data query disabled
 * for the whole session (whitlockk, #5917).
 */
describe("isBootImportSettled", () => {
  it("latches on a spent re-drive budget with no flag in play", () => {
    // The regression guard: this is the exact input an older main process
    // reported as `complete: true`, and the read gate opened on it. It must
    // still open on it now that the producer states the honest terminal.
    expect(isBootImportSettled(RETRIES_EXHAUSTED)).toBe(true);
  });

  it("latches on the other two terminals", () => {
    expect(isBootImportSettled(COMPLETE)).toBe(true);
    expect(isBootImportSettled(TIMED_OUT)).toBe(true);
  });

  it("is false before the runtime reports anything", () => {
    expect(isBootImportSettled(null)).toBe(false);
  });

  it("is false for an import still running", () => {
    const importing: IngestProgress = {
      byHarness: [],
      total: 7,
      processed: 3,
      preparing: false,
      complete: false,
    };

    expect(isBootImportSettled(importing)).toBe(false);
  });
});
