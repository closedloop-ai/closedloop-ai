import { describe, expect, it } from "vitest";
import {
  baselineP95Of,
  p95Of,
  SESSION_LIST_BENCH_BASELINE,
  SessionListBenchHost,
} from "./session-list-bench-baseline";
import { DESKTOP_STORE_SESSIONS } from "./session-list-parity-bench-scale";
import { SESSION_LIST_PARITY_CONFORM_SCENARIO } from "./session-list-parity-conform";
import {
  parityCasesOf,
  SessionListParityCaseKind,
} from "./session-list-parity-model";

describe("p95Of", () => {
  it("returns the nearest-rank 95th sample of 20 ascending samples", () => {
    const samples = Array.from({ length: 20 }, (_, index) => index + 1);
    expect(p95Of(samples)).toBe(19);
  });

  it("returns the 61st of 64 samples (ceil(0.95 * 64) = 61)", () => {
    const samples = Array.from({ length: 64 }, (_, index) => index + 1);
    expect(p95Of(samples)).toBe(61);
  });

  it("returns the only sample of a one-sample run", () => {
    expect(p95Of([7])).toBe(7);
  });

  it("refuses an empty sample set", () => {
    expect(() => p95Of([])).toThrow();
  });
});

describe("baselineP95Of", () => {
  it("returns undefined for a query with no recorded baseline", () => {
    expect(
      baselineP95Of(SessionListBenchHost.Cloud, "p50", "no such query")
    ).toBeUndefined();
  });

  it("records a baseline for every conform query, at every store size, on every host, and for nothing else", () => {
    const conformNames = parityCasesOf(
      SESSION_LIST_PARITY_CONFORM_SCENARIO,
      SessionListParityCaseKind.Conform
    ).map((parityCase) => parityCase.name);
    const storeSizes = Object.keys(DESKTOP_STORE_SESSIONS).sort();

    for (const host of Object.values(SessionListBenchHost)) {
      const recorded = SESSION_LIST_BENCH_BASELINE[host];
      expect(Object.keys(recorded).sort()).toEqual(storeSizes);
      for (const storeSize of storeSizes) {
        expect(Object.keys(recorded[storeSize]).sort()).toEqual(
          [...conformNames].sort()
        );
      }
    }
  });

  it("pins the store sizes the baseline was measured at, so a moved DESKTOP_STORE_SESSIONS constant fails this instead of silently comparing against a stale population", () => {
    expect(DESKTOP_STORE_SESSIONS).toEqual({ p50: 2293, p95: 7865 });
  });
});
