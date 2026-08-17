import { SummaryCardRow } from "@repo/app/shared/components/summary-card-row";
import { SUMMARY_CARD_MIN_PROPERTY } from "@repo/app/shared/hooks/use-summary-card-columns";
import {
  CARD_COMPACT_SLOT_UTILITIES,
  CardDensity,
} from "@repo/design-system/components/ui/card-density";
import {
  METRIC_CARD_LABEL_JOIN_SLOT,
  METRIC_CARD_LABEL_TEXT_SLOT,
  MetricCard,
} from "@repo/design-system/components/ui/primitives/metric-card";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * ISS-5068: at the desktop launch width the five Sessions summary cards wrap
 * 3 + 2 instead of forming one rank. Five across at the shipped 260px floor
 * needs `5 * 260 + 4 * 16 = 1364px` of track, and the strip has roughly 1080
 * beside the 16rem rail and the page padding.
 *
 * The fix is NOT a bare shrink of the floor: below 260px the longest label the
 * strips shipped when this was measured ("Non-subscription Cost") took a third
 * line and dropped its value off the rank's shared baseline, which is ISS-4787.
 * So the lower floor is paid for on the INSIDE of the card, a tighter interior
 * that returns 16px of label width at any card width. The two are ONE decision,
 * and that is what these assert: the floor never moves without the interior
 * moving with it. That label has since been shortened, which BUYS slack against
 * both floors and does not license lowering either.
 *
 * The gate retired in ISS-5366; the density is now resolved by the ISS-5149
 * width tier, which reports COMPACT for any row it cannot measure. jsdom has no
 * layout, so every render here lands on that compact path. The COMFORTABLE side
 * of the tier — where the same rules must be present but inert — is asserted in
 * `summary-card-row-density-tier.test.tsx`, which stubs a real track width.
 *
 * jsdom has no layout engine, so what is reachable here is the CONTRACT the row
 * emits, the published floor and the density classes. That the emitted contract
 * actually produces one rank at the real launch width is measured in the built
 * Electron app by `apps/desktop/test/e2e/sessions-summary-strip-density.spec.ts`.
 */

const ONE_LINE_LABEL = "Sessions";
const WRAPPING_LABEL = "cost";

// The floor as shipped, and the floor the dense interior pays for. Written out
// rather than imported from the component's private constants so a change to
// either has to be made deliberately in two places instead of silently agreeing
// with itself.
const SHIPPED_MIN_WIDTH = "260px";
// 192 sits 11px under the 203 layout ceiling, the limit that reverts the fix
// SILENTLY when chrome widens, and is the value measured to hold the longest
// label on two lines on a BADGED card, which is the narrow case. See the full
// rationale on `DENSE_CARD_MIN_WIDTH`.
const DENSE_MIN_WIDTH = "192px";

// ISS-5070 item 1: the density is a NAMED VARIANT now, not a conditionally
// concatenated selector patch — the row publishes `data-density` and the rules
// self-gate on it. So the reachable contract these assert is the ATTRIBUTE, not
// the presence of a class string.
//
// That distinction is the whole point of the rewrite. The previous version
// asserted `"[&_[data-slot=card]]:gap-3"` appeared in `className`, which is
// satisfied by a string that happens to contain those characters and says
// nothing about whether the rule targets the slot `Card` actually ships. The
// step-down VALUES are asserted against `CARD_COMPACT_SLOT_UTILITIES`, and
// `packages/design-system/components/ui/__tests__/card-density.test.tsx` asserts
// the comfortable column of that same record against the real `Card` primitive
// — so `Card` going `px-6` → `px-5` fails a test instead of silently leaving a
// step-down that no longer steps down from anything.
const COMPACT_RULE_TARGETS = [
  `[data-slot=card]]:${CARD_COMPACT_SLOT_UTILITIES.cardGap}`,
  `[data-slot=card]]:${CARD_COMPACT_SLOT_UTILITIES.cardPaddingY}`,
  `[data-slot=card-content]]:${CARD_COMPACT_SLOT_UTILITIES.contentPaddingX}`,
  `[data-slot=card-header]]:${CARD_COMPACT_SLOT_UTILITIES.headerPaddingX}`,
  // ISS-5070 item 1a: the two slots the inline patch never covered. `MetricCard`
  // renders no footer today, but a rank accepts arbitrary children and a card
  // with one would have rendered 24px gutters beside 16px siblings.
  `[data-slot=card-footer]]:${CARD_COMPACT_SLOT_UTILITIES.footerPaddingX}`,
  `.border-b[data-slot=card-header]]:pb-${CARD_COMPACT_SLOT_UTILITIES.borderedSeamPadding}`,
  `.border-t[data-slot=card-footer]]:pt-${CARD_COMPACT_SLOT_UTILITIES.borderedSeamPadding}`,
];

// The CAPTION RESERVATION, listed apart from the padding above because it fixes
// a different failure. `MetricCard`'s detail caption is an unclamped wrapping
// span with no floor of its own, so at the compact floor's ~171px content box a
// composed caption can take a second line where it took one at the shipped
// width. In a grid every card stretches to the tallest, so ONE reflowed caption
// makes the whole rank taller and leaves the short cards carrying dead space.
// Reserving two `text-sm` lines makes the rank's height stop turning on which
// caption happened to wrap, the same move ISS-4787 made for the label region —
// and it is ISS-5070 item 4's "reservation" option, already in place, which is
// why that item ships no product-copy change.
const CAPTION_RESERVATION_RULE = `[data-slot=card-content]]:${CARD_COMPACT_SLOT_UTILITIES.contentMinHeight}`;

// The LABEL REGION re-flow: `MetricCard` ships it as a flex row, which strands
// the info trigger in the card's top-right corner once the label wraps to two
// lines. The row re-flows it to ordinary inline text so the trigger trails the
// last word.
//
// ISS-5366: these are NOT density-gated any more, which is why they are asserted
// UNPREFIXED below while the interior step-downs above keep their
// `[&[data-density=compact]_` prefix. Gating them made the same control sit
// inline at one window width and in the corner at another; retiring the density
// Labs flag turned both of those into shipped behavior at once, so the re-flow
// now applies at both densities. Listed separately from the padding above so a
// failure names which half regressed.
//
// ISS-5366 (stage review), ISS-5070 item 5: the trigger's rules moved off
// `[data-slot=card-description]>button` because the trigger is no longer a DIRECT
// child of that region — `MetricCard` now wraps the label and the trigger in the
// nowrap island this row flips to `inline` (see the two `inline` rules), so the
// button hangs off the join slot. The two rules that follow it there are the same
// two, unchanged: 6px of separation via `InfoHint`'s uncancelled `px-1.5`, and
// `align-top` so the trigger's 16px margin box sits in the label's `leading-4`
// line box instead of growing it past the 32px reservation.
const LABEL_FLOW_RULES = [
  "[data-slot=card-description]]:block",
  `[data-slot=${METRIC_CARD_LABEL_JOIN_SLOT}]]:inline`,
  `[data-slot=${METRIC_CARD_LABEL_TEXT_SLOT}]]:inline`,
  `[data-slot=${METRIC_CARD_LABEL_JOIN_SLOT}]>button]:ml-0`,
  `[data-slot=${METRIC_CARD_LABEL_JOIN_SLOT}]>button]:align-top`,
];

describe("SummaryCardRow density (ISS-5068)", () => {
  it("lowers the floor and tightens the interior together", () => {
    renderStrip();

    const row = stripRow();
    expect(row.style.getPropertyValue(SUMMARY_CARD_MIN_PROPERTY)).toBe(
      DENSE_MIN_WIDTH
    );
    // Both halves, asserted in the same test on purpose: a lower floor WITHOUT
    // the interior that pays for it is exactly the ISS-4787 regression, so they
    // must never be able to pass independently.
    expect(row.dataset.density).toBe(CardDensity.Compact);
    for (const rule of COMPACT_RULE_TARGETS) {
      expect(row.className).toContain(
        `[&[data-density=${CardDensity.Compact}]_${rule}`
      );
    }
    // The label re-flow is applied to the row unconditionally (ISS-5366), so it
    // is asserted WITHOUT the density prefix. Asserting it with the prefix here
    // would pass on a row that had re-gated it to compact, which is the exact
    // regression the unprefixed form pins.
    for (const rule of LABEL_FLOW_RULES) {
      expect(row.className).toContain(`[&_${rule}`);
    }
  });

  it("reserves the caption region, so one wrapped caption cannot retitle the rank's height", () => {
    // Asserted on its own rather than folded into the padding list above,
    // because it answers a different failure: the padding classes buy label
    // WIDTH, this one stops the rank's HEIGHT turning on whether some card's
    // caption happened to reflow at the narrower width.
    renderStrip();

    const row = stripRow();
    expect(row.dataset.density).toBe(CardDensity.Compact);
    expect(row.className).toContain(
      `[&[data-density=${CardDensity.Compact}]_${CAPTION_RESERVATION_RULE}`
    );
  });

  it("does not charge the Card primitive, the density is scoped to the strip", () => {
    // The classes are descendant variants on the ROW, never utilities on the
    // card itself. That scoping is what keeps the Insights KPI tiles (pinned to
    // a fixed-height host that would push their trend footer into the gutter)
    // and every other `Card` in the product untouched.
    renderStrip();

    const card = screen
      .getByText(ONE_LINE_LABEL)
      .closest<HTMLElement>('[data-slot="card"]');
    expect(card).not.toBeNull();
    expect(card?.className).not.toContain("py-4");
    expect(card?.className).not.toContain("gap-3");
  });

  it("lets an explicit minWidth win over the resolved density", () => {
    // A caller that has measured its own surface owns its floor; the density
    // only supplies the row's DEFAULT. The interior still tightens, because
    // that is the other half of the same decision.
    renderStrip({ minWidth: 320 });

    const row = stripRow();
    expect(row.style.getPropertyValue(SUMMARY_CARD_MIN_PROPERTY)).toBe("320px");
    expect(row.dataset.density).toBe(CardDensity.Compact);
  });
});

/**
 * ISS-5068 (wongk review): the per-card floor can move under an ALREADY MOUNTED
 * column derivation, without a remount, so `useSummaryCardColumns` takes the
 * resolved floor as a declared dependency (`minWidthPx`) and re-measures when it
 * moves. Nothing in the effect BODY reads that value — it is purely the caller's
 * declaration that the property `measure` reads out of the DOM has changed — so
 * it is the kind of dependency that is silently droppable and has to be pinned
 * by a test.
 *
 * Every other test here takes a fixed floor, which cannot see that: a derivation
 * that only ever measured once at mount would pass all of them. These drive the
 * SAME mounted row through a floor change in both directions and assert the
 * published `grid-template-columns` follows it each way and returns to where it
 * started.
 *
 * ISS-5366 note: this used to drive the floor by toggling `summary-strip-density`
 * in a live adapter. That flag is retired, so the driver is now the `minWidth`
 * prop, which is the same mechanism (the row republishes `--summary-card-min` on
 * a mounted node) reached through a control that still exists. The width tier
 * moves the same floor for the same reason when a real track resizes.
 *
 * The row is measured, so this stubs the one input jsdom cannot supply
 * (`clientWidth`) at the desktop launch track. Everything else is the real hook:
 * the floor is read back off the row's own inline custom property, exactly as it
 * is in a browser.
 */
describe("SummaryCardRow floor moved on a live row (ISS-5068)", () => {
  // The Sessions strip's MEASURED track at the desktop launch width (scrollbar
  // included; see apps/desktop/src/shared/window-defaults.ts for the chain). At
  // the shipped 260 floor five cards need 1364px, so the derivation closes them
  // 3 + 2; at the dense 192 floor they need 1024px and close as one rank of five.
  // The two floors therefore produce DIFFERENT column counts at this one width,
  // which is what makes a re-measure observable at all.
  const LAUNCH_TRACK_WIDTH_PX = 1099;
  // The floor the row would resolve on its own at this track (five cards clear
  // the compact one-rank width), and the roomier floor an explicit `minWidth`
  // imposes over it. Naming both makes the direction of each rerender explicit.
  const SHIPPED_FLOOR_PX = 260;
  const SHIPPED_TEMPLATE = "repeat(3, minmax(0, 1fr))";
  const DENSE_TEMPLATE = "repeat(5, minmax(0, 1fr))";

  let clientWidthDescriptor: PropertyDescriptor | undefined;
  let matchMediaDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    clientWidthDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "clientWidth"
    );
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get: () => LAUNCH_TRACK_WIDTH_PX,
    });
    // The shared setup stubs `matchMedia` as always NON-matching, which is right
    // for the responsive-dialog hook it exists for but puts this row below the
    // `md` tier the derivation owns, so it would clear its template and these
    // assertions would read an empty string whatever the floor did. Report the
    // desktop tier instead, which is the regime the launch width is in. The
    // setup file explicitly invites a test to override it.
    matchMediaDescriptor = Object.getOwnPropertyDescriptor(
      globalThis.window,
      "matchMedia"
    );
    Object.defineProperty(globalThis.window, "matchMedia", {
      configurable: true,
      // Shaped exactly like the stub in `vitest.setup.ts`, including the
      // deprecated `addListener`/`removeListener` pair, so the object satisfies
      // `MediaQueryList` structurally and needs no cast.
      value: (query: string): MediaQueryList => ({
        matches: true,
        media: query,
        onchange: null,
        addEventListener: () => {
          // No live tier changes here; the flag toggle drives the re-measure.
        },
        removeEventListener: () => {
          // Paired with the no-op above.
        },
        addListener: () => {
          // Deprecated MediaQueryList member, present for structural parity.
        },
        removeListener: () => {
          // Deprecated MediaQueryList member, present for structural parity.
        },
        dispatchEvent: () => false,
      }),
      writable: true,
    });
  });

  afterEach(() => {
    restoreOwnProperty(
      HTMLElement.prototype,
      "clientWidth",
      clientWidthDescriptor
    );
    restoreOwnProperty(globalThis.window, "matchMedia", matchMediaDescriptor);
  });

  it("re-derives the rank in both directions and returns to the starting count", () => {
    const { rerender } = render(<FloorHarness minWidth={SHIPPED_FLOOR_PX} />);
    const row = stripRow();
    // The starting rank, recorded before the floor moves so the return below is
    // measured against a real observation rather than a restated literal.
    expect(row.style.getPropertyValue("grid-template-columns")).toBe(
      SHIPPED_TEMPLATE
    );

    // The floor drops to the row's own 192 and the same five cards close flush
    // in one rank.
    rerender(<FloorHarness />);
    expect(row.style.getPropertyValue("grid-template-columns")).toBe(
      DENSE_TEMPLATE
    );

    // …and back again, which is the half a one-way test would miss: a derivation
    // that latched the dense rank would leave five 216px columns under a 260px
    // floor, below the width ISS-4787 exists to hold.
    rerender(<FloorHarness minWidth={SHIPPED_FLOOR_PX} />);
    expect(row.style.getPropertyValue("grid-template-columns")).toBe(
      SHIPPED_TEMPLATE
    );
  });

  it("republishes the floor on the same mounted row", () => {
    // The property the derivation above READS. Asserted on the same row instance
    // so a passing rank cannot be explained by a remount having re-run the whole
    // measurement from scratch.
    const { rerender } = render(<FloorHarness minWidth={SHIPPED_FLOOR_PX} />);
    const row = stripRow();

    rerender(<FloorHarness />);
    expect(row.style.getPropertyValue(SUMMARY_CARD_MIN_PROPERTY)).toBe(
      DENSE_MIN_WIDTH
    );

    rerender(<FloorHarness minWidth={SHIPPED_FLOOR_PX} />);
    expect(row.style.getPropertyValue(SUMMARY_CARD_MIN_PROPERTY)).toBe(
      SHIPPED_MIN_WIDTH
    );
  });
});

function renderStrip({ minWidth }: { minWidth?: number } = {}) {
  render(
    <SummaryCardRow minWidth={minWidth} wrapBelow>
      <MetricCard label={ONE_LINE_LABEL} value="1,284" />
      <MetricCard label={WRAPPING_LABEL} value="$19,608" />
    </SummaryCardRow>
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

/**
 * Put a stubbed property back exactly as it was: the captured descriptor when
 * the object owned one, and otherwise removed entirely. Assigning `undefined`
 * would leave the key present with a dead value rather than restoring the
 * prototype/host behaviour the stub shadowed.
 */
function restoreOwnProperty(
  target: object,
  key: string,
  descriptor: PropertyDescriptor | undefined
): void {
  if (descriptor) {
    Object.defineProperty(target, key, descriptor);
    return;
  }
  Reflect.deleteProperty(target, key);
}

/**
 * A five-card strip in the row's GRID mode, whose per-card floor is driven by
 * the `minWidth` prop so a rerender moves the floor on the SAME mounted node
 * rather than remounting the row. Omitting `minWidth` hands the floor back to
 * the row's own resolved density, which is compact for an unmeasured row.
 *
 * Five cards is not incidental: it is the cardinality where the two floors
 * disagree at the launch track (3 + 2 roomy against 5 across tight), which is
 * what makes a missed re-measure observable at all.
 */
function FloorHarness({ minWidth }: { minWidth?: number }) {
  return (
    <SummaryCardRow minWidth={minWidth} wrapBelow>
      <MetricCard detail="in range" label={ONE_LINE_LABEL} value="1,284" />
      <MetricCard detail="in range" label="PRs Shipped" value="42" />
      <MetricCard detail="in range" label="LOC / $" value="118" />
      <MetricCard detail="in range" label="Agents" value="7" />
      <MetricCard detail="in range" label={WRAPPING_LABEL} value="$19,608" />
    </SummaryCardRow>
  );
}
