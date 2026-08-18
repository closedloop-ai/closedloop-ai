import { SummaryCardRow } from "@repo/app/shared/components/summary-card-row";
import { SUMMARY_CARD_LABEL_MIN_PROPERTY } from "@repo/app/shared/hooks/use-summary-label-baseline";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ISS-4887: ISS-4787 fixed the strip's jagged baseline by reserving TWO lines of
 * label height. Two is right at today's five-across desktop width and a guess
 * everywhere else — at the `wrapBelow` width and in the desktop renderer's
 * narrower pane "cost" (today the only strip label long enough
 * to wrap at all) goes to three lines, so the row is jagged again AND every card
 * pays a taller floor. Deriving the reservation from the tallest label actually
 * rendered holds at any width, and at any future label set, with no magic line
 * count.
 *
 * ISS-5062: that rollout reached 100% of users, so the gate is gone and the
 * derivation is unconditional. What used to be the flag-OFF branch is not a
 * second implementation — it is the `2rem` CSS fallback baked into the derived
 * class, which the unmeasured-frame case at the bottom of this file still
 * covers.
 *
 * jsdom does not lay text out, so label heights are driven by stubbing
 * `getBoundingClientRect` on the label regions — which is exactly the input the
 * hook reads, so these exercise the real measurement path rather than a mock of
 * it.
 */

const ONE_LINE_LABEL = "Sessions";
const WRAPPING_LABEL = "cost";
const DERIVED_FLOOR_CLASS =
  "[&_[data-slot=card-description]]:min-h-[var(--summary-card-label-min,2rem)]";

/** Height each label region reports, keyed by the label text it contains. */
const labelHeightsPx = new Map<string, number>();
let rectSpy: ReturnType<typeof vi.spyOn> | null = null;

function stubLabelHeights(heights: Record<string, number>) {
  labelHeightsPx.clear();
  for (const [label, height] of Object.entries(heights)) {
    labelHeightsPx.set(label, height);
  }
  rectSpy ??= vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function boundingRect(this: HTMLElement) {
      // Only the label regions report a height; everything else measures zero,
      // as it already does in jsdom.
      const text = this.textContent ?? "";
      const match = [...labelHeightsPx.entries()].find(
        ([label]) =>
          this.matches('[data-slot="card-description"]') && text.includes(label)
      );
      return { height: match?.[1] ?? 0, width: 0 } as DOMRect;
    });
}

/**
 * Re-measure callbacks registered by the component's `ResizeObserver`, so a test
 * can drive a resize. jsdom's shim never fires on its own, so without this the
 * only reachable code path is the one-shot mount measurement — and the
 * anti-ratchet contract lives entirely in the RE-measure.
 */
const resizeCallbacks = new Set<() => void>();
let previousResizeObserver: PropertyDescriptor | undefined;

function installCapturingResizeObserver() {
  previousResizeObserver = Object.getOwnPropertyDescriptor(
    globalThis,
    "ResizeObserver"
  );
  class CapturingResizeObserver {
    private readonly notify: () => void;
    constructor(callback: ResizeObserverCallback) {
      this.notify = () => callback([], this as unknown as ResizeObserver);
      resizeCallbacks.add(this.notify);
    }
    observe() {
      // The component measures synchronously on mount, so an observe-time
      // notification would only duplicate that pass.
    }
    unobserve() {
      // No per-target bookkeeping: the hook observes exactly one element.
    }
    disconnect() {
      resizeCallbacks.delete(this.notify);
    }
  }
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: CapturingResizeObserver as unknown as typeof ResizeObserver,
  });
}

function restoreResizeObserver() {
  resizeCallbacks.clear();
  if (previousResizeObserver) {
    Object.defineProperty(globalThis, "ResizeObserver", previousResizeObserver);
    previousResizeObserver = undefined;
    return;
  }
  Reflect.deleteProperty(globalThis, "ResizeObserver");
}

/** Fire every live observer, as a browser does when the row's width changes. */
function triggerResize() {
  act(() => {
    for (const notify of [...resizeCallbacks]) {
      notify();
    }
  });
}

function renderStrip() {
  render(
    <AppCoreStoryProviders enabledFlags={[]}>
      <SummaryCardRow wrapBelow>
        <MetricCard label={ONE_LINE_LABEL} value="1,284" />
        <MetricCard label={WRAPPING_LABEL} value="$19,608" />
      </SummaryCardRow>
    </AppCoreStoryProviders>
  );
}

function stripRow(): HTMLElement {
  const region = screen
    .getByText(ONE_LINE_LABEL)
    .closest<HTMLElement>('[data-slot="card-description"]');
  const row = region?.closest<HTMLElement>('[data-slot="card"]')?.parentElement;
  if (!row) {
    throw new Error("No summary strip rendered");
  }
  return row;
}

beforeEach(() => {
  installCapturingResizeObserver();
});

afterEach(() => {
  restoreResizeObserver();
  rectSpy?.mockRestore();
  rectSpy = null;
  labelHeightsPx.clear();
});

describe("SummaryCardRow label baseline (ISS-4887, un-gated by ISS-5062)", () => {
  it("derives the reservation with NO flag provider seeding it (ISS-5062)", () => {
    // The fail-open assertion, and the one that fails if anyone re-gates this:
    // `enabledFlags` is EMPTY, so a `useFeatureFlagEnabledOptional` read would
    // resolve OFF. The derivation still runs and still publishes.
    stubLabelHeights({ [ONE_LINE_LABEL]: 16, [WRAPPING_LABEL]: 48 });
    renderStrip();

    const row = stripRow();
    expect(row.className).toContain(DERIVED_FLOOR_CLASS);
    // The removed off branch's class must not come back alongside it — two
    // `min-h` rules on one region is how a "fail open" quietly fails closed.
    expect(row.className).not.toContain(
      "[&_[data-slot=card-description]]:min-h-8"
    );
    expect(row.style.getPropertyValue(SUMMARY_CARD_LABEL_MIN_PROPERTY)).toBe(
      "48px"
    );
  });

  it("reserves the TALLEST label actually rendered, not a line count", () => {
    // The three-line case the fixed two-line floor gets wrong.
    stubLabelHeights({ [ONE_LINE_LABEL]: 16, [WRAPPING_LABEL]: 48 });
    renderStrip();

    expect(
      stripRow().style.getPropertyValue(SUMMARY_CARD_LABEL_MIN_PROPERTY)
    ).toBe("48px");
  });

  it("reserves LESS than two lines when every label fits on one", () => {
    // The fixed floor charged every card 2rem here for an alignment none of
    // them needs. A derived reservation gives that space back.
    stubLabelHeights({ [ONE_LINE_LABEL]: 16, [WRAPPING_LABEL]: 16 });
    renderStrip();

    expect(
      stripRow().style.getPropertyValue(SUMMARY_CARD_LABEL_MIN_PROPERTY)
    ).toBe("16px");
  });

  it("SHRINKS the reservation when a label unwraps — it does not ratchet", () => {
    stubLabelHeights({ [ONE_LINE_LABEL]: 16, [WRAPPING_LABEL]: 48 });
    renderStrip();
    const row = stripRow();
    expect(row.style.getPropertyValue(SUMMARY_CARD_LABEL_MIN_PROPERTY)).toBe(
      "48px"
    );

    // Widen the row so the long label unwraps to one line, then let the
    // ResizeObserver re-measure. The naive implementation reads its OWN
    // published floor back off the boxes and can only ever grow.
    stubLabelHeights({ [ONE_LINE_LABEL]: 16, [WRAPPING_LABEL]: 16 });
    triggerResize();

    expect(row.style.getPropertyValue(SUMMARY_CARD_LABEL_MIN_PROPERTY)).toBe(
      "16px"
    );
  });

  it("falls back to the shipped two-line floor when nothing measures", () => {
    // An environment with no layout at all (a bare jsdom render, SSR's first
    // paint): publishing `0px` would collapse every label region. This IS the
    // branch the removed flag's OFF path used to be — ISS-5062 did not delete
    // the two-line reservation, it made it the fallback rather than a mode.
    stubLabelHeights({});
    renderStrip();

    const row = stripRow();
    expect(row.style.getPropertyValue(SUMMARY_CARD_LABEL_MIN_PROPERTY)).toBe(
      ""
    );
    // The class carries `2rem` — the fixed floor, byte-for-byte — as its own
    // fallback, so the unmeasured frame reserves exactly what ISS-4787 shipped.
    expect(row.className).toContain("2rem");
  });
});
