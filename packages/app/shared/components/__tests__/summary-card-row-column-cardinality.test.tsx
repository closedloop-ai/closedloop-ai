import { SummaryCardRow } from "@repo/app/shared/components/summary-card-row";
import { SUMMARY_CARD_MIN_PROPERTY } from "@repo/app/shared/hooks/use-summary-card-columns";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * ISS-4966: at the default desktop window the strip's `auto-fit` template
 * resolves to FOUR columns for a FIVE-card strip, so the fifth card sits alone
 * in a quarter-width final row with three dead cells beside it.
 *
 * jsdom lays nothing out, so the row's width is driven by stubbing
 * `clientWidth` — which is exactly the input the hook reads, so these exercise
 * the real measurement path rather than a mock of it. The arithmetic itself is
 * proven across every width in `use-summary-card-columns.test.ts`; these cover
 * the wiring: which flag state writes, which rows are eligible, and that the
 * card count comes from the rendered cells rather than `React.Children`.
 */

/**
 * The default desktop strip track: a 1400px window, less the 16rem nav rail, less
 * the inset gutter, less the host's `px-4` gutter.
 *
 * COMPUTED, no scrollbar — jsdom runs no layout engine and reserves none, and
 * jsdom is where this suite runs. The real renderer MEASURES 13px less (1099);
 * both numbers, and the chain they come from, are named in
 * `apps/desktop/src/shared/window-defaults.ts`, which is what stopped the repo
 * carrying two unattributable widths for the same strip (#4445 review). This
 * file cannot import that module — `packages/app` must not depend on
 * `apps/desktop` — so it carries the literal, and
 * `apps/desktop/test/window-default-size.test.ts` fails with this file's path
 * when the derivation moves.
 *
 * `auto-fit` picks 4 here, as it did at 1092 (the same track at the previous
 * 1380px default), so the widening moved the number without moving the answer.
 */
const DEFAULT_DESKTOP_CONTENT_WIDTH = 1112;
/**
 * The two floors `SummaryCardRow` publishes on `--summary-card-min`
 * (`DEFAULT_CARD_MIN_WIDTH` / `DENSE_CARD_MIN_WIDTH`). Named here because the
 * density crossing is asserted through the published value, not inferred from
 * the rank the derivation happened to pick.
 */
const COMFORTABLE_CARD_MIN_WIDTH_PX = 260;
const COMPACT_CARD_MIN_WIDTH_PX = 192;
/** Five 260px cards plus four 16px gutters. */
const FIVE_ACROSS_CONTENT_WIDTH = 1364;
/**
 * A track too narrow for five cards at EITHER floor, so the ISS-5149 tier hands
 * the roomier 260px card back and the rank closes 3 + 2.
 *
 * This is the width that keeps the 3 + 2 rank observable at all now that the
 * compact density ships unconditionally (ISS-5366): at the default desktop track
 * five dense cards fit outright, so the strip ranks five across there and the
 * stepdown never runs. The rank ARITHMETIC across every width — including the
 * "never more than one empty cell" cap that rejects a four-column rank for five
 * cards — is proven directly against the resolver in
 * `shared/hooks/__tests__/use-summary-card-columns.test.ts`; this file covers
 * the wiring.
 */
const THREE_PLUS_TWO_CONTENT_WIDTH = 800;
/** A 768 viewport's content box once the 16rem nav rail is subtracted. */
const NARROW_PANE_CONTENT_WIDTH = 512;

const CARD_LABELS = [
  "Sessions",
  "Total Tokens",
  "cost",
  "PRs Shipped",
  "LOC / $",
] as const;

let widthDescriptor: PropertyDescriptor | undefined;

/**
 * Re-measure callbacks registered by the component's `ResizeObserver`, so a test
 * can drive a resize. jsdom's shim never fires on its own, so without this the
 * only reachable path is the one-shot mount measurement.
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
      // The hook measures synchronously on mount, so an observe-time
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

/**
 * Media-query listeners the hook registered, so a test can drive a tier change.
 * jsdom's `matchMedia` always reports `matches: false` and never fires, so
 * without this the `md+` tier the derivation owns is unreachable here.
 */
const tierListeners = new Set<() => void>();
let previousMatchMedia: PropertyDescriptor | undefined;
let tierMatches = true;

/** Answer `tierMatches` for the `md+` query the hook asks about. */
function installMatchMedia() {
  previousMatchMedia = Object.getOwnPropertyDescriptor(
    globalThis.window,
    "matchMedia"
  );
  Object.defineProperty(globalThis.window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      addEventListener: (_event: string, listener: () => void) => {
        tierListeners.add(listener);
      },
      removeEventListener: (_event: string, listener: () => void) => {
        tierListeners.delete(listener);
      },
      get matches() {
        return tierMatches;
      },
      media: query,
    }),
  });
}

function restoreMatchMedia() {
  tierListeners.clear();
  tierMatches = true;
  if (previousMatchMedia) {
    Object.defineProperty(globalThis.window, "matchMedia", previousMatchMedia);
    previousMatchMedia = undefined;
    return;
  }
  Reflect.deleteProperty(globalThis.window, "matchMedia");
}

/** Cross the `md` breakpoint, as a browser does when the window narrows. */
function setGridTier(matches: boolean) {
  tierMatches = matches;
  act(() => {
    for (const notify of [...tierListeners]) {
      notify();
    }
  });
}

/**
 * Report `width` for every element's `clientWidth`, as a laid-out browser does
 * for the full-width strip row. jsdom's own value is a hard-coded 0.
 */
function stubClientWidth(width: number) {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => width,
  });
}

/**
 * Three cards behind ONE React child, exactly as the real `AlwaysAvailableCards`
 * delivers them. This is why the ISS-4966 spec rules out `React.Children.count`:
 * it reports 3 for the five-card Sessions strip.
 */
function AlwaysAvailableCardsStub() {
  return (
    <>
      <MetricCard label={CARD_LABELS[0]} value="1,284" />
      <MetricCard label={CARD_LABELS[1]} value="4.1M" />
      <MetricCard label={CARD_LABELS[2]} value="$19,608" />
    </>
  );
}

function renderStrip({ wrapBelow = true }: { wrapBelow?: boolean } = {}) {
  render(
    <SummaryCardRow wrapBelow={wrapBelow}>
      <AlwaysAvailableCardsStub />
      <MetricCard label={CARD_LABELS[3]} value="37" />
      <MetricCard label={CARD_LABELS[4]} value="12.4" />
    </SummaryCardRow>
  );
}

function stripRow(): HTMLElement {
  const row = screen
    .getByText(CARD_LABELS[0])
    .closest<HTMLElement>('[data-slot="card"]')?.parentElement;
  if (!row) {
    throw new Error("No summary strip rendered");
  }
  return row;
}

beforeEach(() => {
  installCapturingResizeObserver();
  installMatchMedia();
  widthDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "clientWidth"
  );
});

afterEach(() => {
  restoreResizeObserver();
  restoreMatchMedia();
  if (widthDescriptor) {
    Object.defineProperty(
      HTMLElement.prototype,
      "clientWidth",
      widthDescriptor
    );
    widthDescriptor = undefined;
    return;
  }
  Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
});

describe("SummaryCardRow column cardinality (ISS-4966)", () => {
  it("ranks the five-card strip FIVE across at the default desktop window", () => {
    // ISS-5068 + ISS-4966 together, which is the outcome both issues wanted and
    // what ISS-5366 shipped to everyone: the compact floor makes five cards fit
    // the default track, so the derived rank closes them flush with no trailing
    // cells — not the 4 + 1 orphan `auto-fit` picks, and no longer the 3 + 2 the
    // roomier floor could only manage.
    stubClientWidth(DEFAULT_DESKTOP_CONTENT_WIDTH);
    renderStrip();

    expect(stripRow().style.getPropertyValue("grid-template-columns")).toBe(
      "repeat(5, minmax(0, 1fr))"
    );
  });

  it("still closes 3 + 2 at a track too narrow for five at either floor", () => {
    // The tier hands the roomy card back below the compact band, and the rank
    // derivation has to follow the floor it publishes rather than latching the
    // dense answer. A strip that ranked five across here would be laying out
    // 160px cards under a 260px floor.
    stubClientWidth(THREE_PLUS_TWO_CONTENT_WIDTH);
    renderStrip();

    expect(stripRow().style.getPropertyValue("grid-template-columns")).toBe(
      "repeat(3, minmax(0, 1fr))"
    );
  });

  it("counts the RENDERED cells, not React children", () => {
    // Three of the five cards arrive inside one fragment, so
    // `React.Children.count` reports 3 — which would rank the strip 3-across at
    // every width and read as correct here by accident. Widening to the true
    // five-across width separates the two: five cells go five across, three
    // would stay at three.
    stubClientWidth(FIVE_ACROSS_CONTENT_WIDTH);
    renderStrip();

    expect(stripRow().style.getPropertyValue("grid-template-columns")).toBe(
      "repeat(5, minmax(0, 1fr))"
    );
  });

  it("leaves a non-grid row alone — a flex line has no columns", () => {
    stubClientWidth(DEFAULT_DESKTOP_CONTENT_WIDTH);
    renderStrip({ wrapBelow: false });

    const row = stripRow();
    expect(row.style.getPropertyValue("grid-template-columns")).toBe("");
    expect(row.className).toContain("flex");
  });

  it("falls back to the class when the row cannot be measured", () => {
    // A collapsed pane, SSR's first paint, or a bare jsdom render. Committing to
    // a rank derived from a width nobody measured would be a guess.
    stubClientWidth(0);
    renderStrip();

    const row = stripRow();
    expect(row.style.getPropertyValue("grid-template-columns")).toBe("");
    // …and the row's own `auto-fit` template is what governs in its place, so an
    // unmeasurable strip still lays out rather than collapsing to one column.
    expect(row.className).toContain(
      "md:grid-cols-[repeat(auto-fit,minmax(var(--summary-card-min),1fr))]"
    );
  });

  it("falls to ONE column in a narrow pane rather than squeezing two", () => {
    // A 768 viewport behind the 16rem nav rail: only one 260px card fits. An
    // earlier revision clamped to a two-column floor and handed back ~248px
    // cards, under the floor ISS-4787 exists to hold — `auto-fit` gives one
    // full-width column here, and so must this (stage review).
    stubClientWidth(NARROW_PANE_CONTENT_WIDTH);
    renderStrip();

    expect(stripRow().style.getPropertyValue("grid-template-columns")).toBe(
      "repeat(1, minmax(0, 1fr))"
    );
  });

  it("hands the layout back to grid-cols-2 below md", () => {
    // The below-`md` tier is FEA-3865's phone pairing, owned by the row's
    // static class. An inline template beats a class at every width, so the
    // derivation has to stand down there rather than clamp to a floor.
    stubClientWidth(DEFAULT_DESKTOP_CONTENT_WIDTH);
    renderStrip();
    const row = stripRow();
    expect(row.style.getPropertyValue("grid-template-columns")).toBe(
      "repeat(5, minmax(0, 1fr))"
    );

    setGridTier(false);

    expect(row.style.getPropertyValue("grid-template-columns")).toBe("");
    expect(row.className).toContain("grid-cols-2");

    // …and crossing back up re-publishes the rank.
    setGridTier(true);
    expect(row.style.getPropertyValue("grid-template-columns")).toBe(
      "repeat(5, minmax(0, 1fr))"
    );
  });

  it("re-ranks AND re-floors when the row is resized across the density tier", () => {
    // ISS-5366 (wongk review). This used to widen 800 -> 1364 and claim it
    // proved the rank follows "BOTH the new width and the new floor". It did
    // not: 1364 is exactly where five 260px cards fit, so BOTH endpoints resolve
    // comfortable and the floor never moves. The rank changed, the floor was
    // constant, and the test would have stayed green with the density tier
    // wired to nothing.
    //
    // The desktop track is the endpoint that actually crosses it: at 1112 five
    // comfortable cards still need 1364, but five compact ones need only 1024,
    // so the tier steps down and republishes the floor. Both the template and
    // the floor are asserted at each end, because the rank derivation reads the
    // floor — a rank that followed the width while the floor stayed at 260 is
    // precisely the half-applied tier this pins.
    stubClientWidth(THREE_PLUS_TWO_CONTENT_WIDTH);
    renderStrip();
    const row = stripRow();
    expect(row.style.getPropertyValue("grid-template-columns")).toBe(
      "repeat(3, minmax(0, 1fr))"
    );
    expect(row.style.getPropertyValue(SUMMARY_CARD_MIN_PROPERTY)).toBe(
      `${COMFORTABLE_CARD_MIN_WIDTH_PX}px`
    );

    stubClientWidth(DEFAULT_DESKTOP_CONTENT_WIDTH);
    triggerResize();

    expect(row.style.getPropertyValue("grid-template-columns")).toBe(
      "repeat(5, minmax(0, 1fr))"
    );
    expect(row.style.getPropertyValue(SUMMARY_CARD_MIN_PROPERTY)).toBe(
      `${COMPACT_CARD_MIN_WIDTH_PX}px`
    );
  });

  it("keeps the roomy floor where five cards already fit at it", () => {
    // The other side of the crossing, so the pair brackets the tier rather than
    // asserting one direction: at 1364 the comfortable floor closes five across
    // on its own, and the tier must NOT step down to a tighter card that buys
    // nothing. This is the endpoint the old resize test was using, restored as
    // what it actually proves.
    stubClientWidth(FIVE_ACROSS_CONTENT_WIDTH);
    renderStrip();
    const row = stripRow();

    expect(row.style.getPropertyValue("grid-template-columns")).toBe(
      "repeat(5, minmax(0, 1fr))"
    );
    expect(row.style.getPropertyValue(SUMMARY_CARD_MIN_PROPERTY)).toBe(
      `${COMFORTABLE_CARD_MIN_WIDTH_PX}px`
    );
  });
});
