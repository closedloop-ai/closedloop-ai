import { describe, expect, it } from "vitest";
import {
  clampScrollRestoreTarget,
  computeMaxScrollTop,
  hasStoredScrollPosition,
  runSessionsScrollContractConformance,
  SESSIONS_SCROLL_RESTORE_MAX_ATTEMPTS,
  type SessionsScrollContractAdapter,
} from "../sessions-scroll-contract";

const conformantAdapter: SessionsScrollContractAdapter = {
  hostLabel: "reference",
  maxRestoreAttempts: SESSIONS_SCROLL_RESTORE_MAX_ATTEMPTS,
  computeMaxScrollTop,
  clampScrollRestoreTarget,
  hasStoredScrollPosition,
};

const RETRY_BOUND_MISMATCH = /retry bound/;
const GATE_MISMATCH = /nothing is remembered/;
const CLAMP_MISMATCH = /clamp mismatch/;

describe("computeMaxScrollTop", () => {
  it("reports the overflow, floored at zero when content fits the viewport", () => {
    expect(computeMaxScrollTop(1000, 600)).toBe(400);
    expect(computeMaxScrollTop(300, 600)).toBe(0);
  });
});

describe("clampScrollRestoreTarget", () => {
  it("clamps to the scrollable range, and passes a value through when nothing is scrollable yet", () => {
    expect(clampScrollRestoreTarget(900, 400)).toBe(400);
    expect(clampScrollRestoreTarget(200, 400)).toBe(200);
    expect(clampScrollRestoreTarget(80, 0)).toBe(80);
  });
});

describe("hasStoredScrollPosition", () => {
  it("is true only for a finite remembered number, including zero", () => {
    expect(hasStoredScrollPosition(undefined)).toBe(false);
    expect(hasStoredScrollPosition(null)).toBe(false);
    expect(hasStoredScrollPosition(Number.NaN)).toBe(false);
    expect(hasStoredScrollPosition(0)).toBe(true);
    expect(hasStoredScrollPosition(120)).toBe(true);
  });
});

describe("runSessionsScrollContractConformance", () => {
  it("passes a conformant adapter and fails a bound, gate, or clamp that has drifted", () => {
    expect(() =>
      runSessionsScrollContractConformance(conformantAdapter)
    ).not.toThrow();

    expect(() =>
      runSessionsScrollContractConformance({
        ...conformantAdapter,
        maxRestoreAttempts: 15,
      })
    ).toThrow(RETRY_BOUND_MISMATCH);

    expect(() =>
      runSessionsScrollContractConformance({
        ...conformantAdapter,
        hasStoredScrollPosition: () => true,
      })
    ).toThrow(GATE_MISMATCH);

    expect(() =>
      runSessionsScrollContractConformance({
        ...conformantAdapter,
        clampScrollRestoreTarget: (desired) => desired,
      })
    ).toThrow(CLAMP_MISMATCH);
  });
});
