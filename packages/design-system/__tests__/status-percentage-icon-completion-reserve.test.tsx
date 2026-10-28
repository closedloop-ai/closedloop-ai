import { StatusPercentageIcon } from "@closedloop-ai/design-system/components/ui/status-percentage-icon";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

/**
 * ISS-9922. The mark and the accessible name are two channels over one value,
 * and they used to be derived by two different rules — `Math.round` for the
 * name, `>= 100` for the mark. On `[99.5, 100)` they disagreed: a screen reader
 * heard "100% complete" beside a ring a sighted user could see was not full.
 *
 * `COMPLETE_CHECK_PATH` is the check glyph's own `d`, the one element only the
 * complete mark draws. Every assertion below uses that same locator in both
 * directions, so an absence proves the mark is gone rather than proving the
 * locator matches nothing.
 */
// Owned by `FilledCheckCircle` in
// `packages/design-system/components/ui/internal/status-icon-shared.tsx`.
const COMPLETE_CHECK_PATH = 'path[d="M6.5 10.5L9.5 13.5L14 7.5"]';

function markOf(value: number) {
  const { container } = render(
    <StatusPercentageIcon size={16} value={value} />
  );
  const svg = container.querySelector("svg");
  if (!svg) {
    throw new Error("expected an svg to render");
  }
  return {
    hasCompleteCheck: container.querySelector(COMPLETE_CHECK_PATH) !== null,
    name: svg.getAttribute("aria-label"),
  };
}

/**
 * The progress arc's own dash offset. `StatusRing` computes it from the
 * `percentage` it is handed, so this reads the geometry channel directly — the
 * one the component deliberately keeps on the unrounded value.
 */
function arcOffsetOf(value: number): string | null {
  const { container } = render(
    <StatusPercentageIcon size={16} value={value} />
  );
  const arcs = container.querySelectorAll("circle");
  return arcs[1]?.getAttribute("stroke-dashoffset") ?? null;
}

afterEach(cleanup);

describe("StatusPercentageIcon completeness reserve", () => {
  it("draws the complete check and names 100% only when the value is 100", () => {
    const complete = markOf(100);

    expect(complete.hasCompleteCheck).toBe(true);
    expect(complete.name).toBe("100% complete");
  });

  it("draws no complete check at 99.5 — the 199-of-200 ratio", () => {
    const partial = markOf(99.5);

    expect(partial.hasCompleteCheck).toBe(false);
    expect(partial.name).toBe("99% complete");
  });

  it("keeps the name and the mark in agreement at 99.6", () => {
    // The latent screen-reader defect, at the component itself: the name must
    // not claim a completeness the mark is not drawing.
    const partial = markOf(99.6);

    expect(partial.hasCompleteCheck).toBe(false);
    expect(partial.name).toBe("99% complete");
  });

  it("keeps them in agreement at 99.9 too", () => {
    const partial = markOf(99.9);

    expect(partial.hasCompleteCheck).toBe(false);
    expect(partial.name).toBe("99% complete");
  });

  it("states a sub-1% fraction as 0%, and draws its arc anyway", () => {
    // 1 of 250 documents is 0.4%. Per the 2026-09-18 ruling the STATED number
    // does not invent a 1% nobody measured; the ARC still separates it from a
    // genuine zero, which is where "work has begun" is carried.
    expect(markOf(0.4)).toEqual({
      hasCompleteCheck: false,
      name: "0% complete",
    });
    expect(markOf(0)).toEqual({ hasCompleteCheck: false, name: "0% complete" });
    expect(arcOffsetOf(0.4)).not.toBe(arcOffsetOf(0));
  });

  it("draws the arc from the unrounded value, not the stated integer", () => {
    // The stated number is an integer; the geometry must not be, or every
    // fractional ring that renders today shifts. 99.5 and 99 both say "99%
    // complete" — 99.5 because the reserve caps it — so only the arc can tell
    // them apart, and it has to.
    const fractional = arcOffsetOf(99.5);
    const whole = arcOffsetOf(99);

    expect(fractional).not.toBeNull();
    expect(markOf(99.5).name).toBe(markOf(99).name);
    expect(fractional).not.toBe(whole);
  });

  it("renders the integer bucket set unchanged", () => {
    // The prototype projects table passes exactly these; ISS-9922 must not
    // move what any of them draws or says.
    expect(markOf(0)).toEqual({ hasCompleteCheck: false, name: "0% complete" });
    expect(markOf(20)).toEqual({
      hasCompleteCheck: false,
      name: "20% complete",
    });
    expect(markOf(45)).toEqual({
      hasCompleteCheck: false,
      name: "45% complete",
    });
    expect(markOf(70)).toEqual({
      hasCompleteCheck: false,
      name: "70% complete",
    });
    expect(markOf(100)).toEqual({
      hasCompleteCheck: true,
      name: "100% complete",
    });
  });
});
