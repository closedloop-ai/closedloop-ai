import { resolveCompletionDisplay } from "@closedloop-ai/design-system/lib/completion-percentage";
import { describe, expect, it } from "vitest";

/**
 * ISS-9922. Every expected value below is written as a literal on purpose.
 * Deriving one from `Math.round`, `Math.floor` or the ratio itself would make
 * the fixture agree with whichever arithmetic the module happens to run, and
 * the defect this suite exists for was exactly a plausible arithmetic.
 */
describe("resolveCompletionDisplay", () => {
  it("reserves 100 for a genuinely exhausted population", () => {
    expect(resolveCompletionDisplay(100).percentage).toBe(100);
    expect(resolveCompletionDisplay(100).isComplete).toBe(true);
  });

  it("does not let a partial percentage round up into 100", () => {
    // 199/200, 249/250 and 999/1000 — the three ratios that reached a filled
    // complete check while a document was still outstanding.
    expect(resolveCompletionDisplay(99.5).percentage).toBe(99);
    expect(resolveCompletionDisplay(99.6).percentage).toBe(99);
    expect(resolveCompletionDisplay(99.9).percentage).toBe(99);
  });

  it("calls none of those partial values complete", () => {
    expect(resolveCompletionDisplay(99.5).isComplete).toBe(false);
    expect(resolveCompletionDisplay(99.6).isComplete).toBe(false);
    expect(resolveCompletionDisplay(99.9).isComplete).toBe(false);
  });

  it("reserves 0 for a population nothing has started on", () => {
    expect(resolveCompletionDisplay(0).percentage).toBe(0);
  });

  it("rounds the mid-range rather than flooring it", () => {
    // The 2026-09-18 ruling: only 100 is reserved. 2/3 and 7/9 keep the value
    // they have always rendered, which an earlier cut of this PR moved by one.
    expect(resolveCompletionDisplay(66.666).percentage).toBe(67);
    expect(resolveCompletionDisplay(77.777).percentage).toBe(78);
    expect(resolveCompletionDisplay(49.5).percentage).toBe(50);
  });

  it("reports a sub-1% fraction as 0 rather than inventing a 1", () => {
    // 1/250 is 0.4% and 1/1000 is 0.1%. Same ruling: a 1% nobody measured is
    // the overstatement this ticket is about, pointed the other way. The ring
    // still renders an arc for them — `clamped` is untouched — so "started" is
    // not lost, it is just not claimed as a whole percent.
    expect(resolveCompletionDisplay(0.4).percentage).toBe(0);
    expect(resolveCompletionDisplay(0.1).percentage).toBe(0);
    expect(resolveCompletionDisplay(0.4).clamped).toBe(0.4);
    expect(resolveCompletionDisplay(0.4).isComplete).toBe(false);
  });

  it("refuses a non-finite value instead of rendering it", () => {
    // whitlockk review. `NaN` used to survive the clamp and reach the DOM as a
    // "NaN% complete" label with `NaN` dash offsets; `Infinity` used to clamp
    // to 100 and earn the filled check — the terminal claim, over a value that
    // is not a measurement. Both resolve to a refusal now.
    for (const value of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      const display = resolveCompletionDisplay(value);
      expect(display.percentage).toBe(0);
      expect(display.clamped).toBe(0);
      expect(display.isComplete).toBe(false);
      // The half that catches a regression to the old clamp: every field has to
      // be a real number, not merely not-100.
      expect(Number.isFinite(display.clamped)).toBe(true);
      expect(Number.isFinite(display.percentage)).toBe(true);
    }
  });

  it("reads back whole percentages unchanged", () => {
    expect(resolveCompletionDisplay(0).percentage).toBe(0);
    expect(resolveCompletionDisplay(20).percentage).toBe(20);
    expect(resolveCompletionDisplay(45).percentage).toBe(45);
    expect(resolveCompletionDisplay(70).percentage).toBe(70);
    expect(resolveCompletionDisplay(99).percentage).toBe(99);
    expect(resolveCompletionDisplay(100).percentage).toBe(100);
  });

  it("keeps the completeness predicate and the number in agreement", () => {
    for (const value of [
      0,
      0.4,
      20,
      49.5,
      66.6,
      99,
      99.5,
      99.6,
      99.9,
      100,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      const { isComplete, percentage } = resolveCompletionDisplay(value);
      expect(percentage === 100).toBe(isComplete);
    }
  });

  it("resolves out-of-range input to the end it overshoots", () => {
    // Above 100 is not a partial state, so it resolves to complete rather than
    // to a number the mark would then contradict. Below 0 is not a claim at all.
    expect(resolveCompletionDisplay(140).percentage).toBe(100);
    expect(resolveCompletionDisplay(140).isComplete).toBe(true);
    expect(resolveCompletionDisplay(-20).percentage).toBe(0);
    expect(resolveCompletionDisplay(-20).isComplete).toBe(false);
  });
});
