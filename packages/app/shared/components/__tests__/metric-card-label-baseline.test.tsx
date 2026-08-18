import { SummaryCardRow } from "@repo/app/shared/components/summary-card-row";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

// ISS-4787: the Sessions and Branches summary strips render the shared
// `MetricCard` side by side. One card's label ("cost") wraps to
// two lines at the strip's card width while its siblings ("Sessions", "PRs
// Shipped", …) stay on one, so the wrapped card's value started a whole
// line-height lower and the row read as a jagged baseline instead of one aligned
// rank of numbers.
//
// The reservation lives on `SummaryCardRow`, NOT on the `MetricCard` primitive
// (review, wongk): a floor inside the card would charge every consumer — notably
// the Insights KPI tiles, which are pinned to a fixed-height grid host and would
// push their trend footer into the gutter. jsdom does not lay text out, so these
// assert the reservation where it now lives (the strip) and, just as importantly,
// its ABSENCE from a card rendered outside a strip.

// ISS-5062: the reservation is derived from the row's own tallest label at every
// mount now that `summary-strip-label-baseline` has been un-gated. The fixed
// `min-h-8` it replaced survives as the derived rule's own CSS fallback (`2rem`,
// byte-for-byte), so an unmeasured frame still reserves exactly what ISS-4787
// shipped — which is what this constant pins.
const RESERVED_LABEL_HEIGHT_CLASS =
  "[&_[data-slot=card-description]]:min-h-[var(--summary-card-label-min,2rem)]";
const RESERVED_LABEL_LEADING_CLASS =
  "[&_[data-slot=card-description]]:leading-4";
// ISS-5366: the row used to top-align the label region with `items-start`, a
// rule that only did work while the region was a flex row. The row now re-flows
// that region to `block` at BOTH densities (it used to be compact-only), which
// starts every label at the top of its reserved box by construction and makes
// `align-items` inert, so `items-start` was removed rather than left as a rule
// that cannot fire. This pins the rule that took over the job.
const RESERVED_LABEL_REFLOW_CLASS = "[&_[data-slot=card-description]]:block";
const WRAPPING_LABEL = "cost";
const ONE_LINE_LABEL = "Sessions";
/** Any fixed `h-<n>` on the label region, which would clip a third line. */
const FIXED_HEIGHT_CLASS_PATTERN = /(?:^|\s)h-\d/;

function labelRegionFor(label: string): HTMLElement {
  const labelNode = screen.getByText(label);
  const region = labelNode.closest<HTMLElement>(
    '[data-slot="card-description"]'
  );
  if (!region) {
    throw new Error(`No MetricCard label region rendered for "${label}"`);
  }
  return region;
}

/** The `SummaryCardRow` container that lays out the card carrying `label`. */
function stripRowFor(label: string): HTMLElement {
  const row =
    labelRegionFor(label).closest<HTMLElement>(
      '[data-slot="card"]'
    )?.parentElement;
  if (!row) {
    throw new Error(`No summary strip rendered around "${label}"`);
  }
  return row;
}

describe("MetricCard label baseline (ISS-4787)", () => {
  it("reserves a two-line label region on the summary strip that renders the cards", () => {
    render(
      <SummaryCardRow>
        <MetricCard
          detail="in the selected range"
          label={ONE_LINE_LABEL}
          value="1,284"
        />
        <MetricCard
          detail="+$412 if billed to API"
          info={{ what: "What the matched sessions cost." }}
          label={WRAPPING_LABEL}
          value="$19,608"
        />
      </SummaryCardRow>
    );

    const row = stripRowFor(ONE_LINE_LABEL);
    // Two lines of reserved height…
    expect(row.className).toContain(RESERVED_LABEL_HEIGHT_CLASS);
    // …a pinned leading so two lines fill that box exactly rather than
    // overshooting it and reintroducing a sub-pixel stagger…
    expect(row.className).toContain(RESERVED_LABEL_LEADING_CLASS);
    // …and a block-flowed region so every card's FIRST label line starts level
    // at the top of that box, at either density.
    expect(row.className).toContain(RESERVED_LABEL_REFLOW_CLASS);
    // The strip still renders both cards' labels in full — including the info
    // trigger variant the Cost card actually uses.
    for (const label of [ONE_LINE_LABEL, WRAPPING_LABEL]) {
      expect(labelRegionFor(label).textContent).toContain(label);
    }
    // The info trigger trails the label text inline, so it needs its own line
    // box or it would grow the reserved region. `h-6 -my-1` is a 24px hit target
    // (FEA-3819) that collapses back into the label's 16px `leading-4` line box,
    // and `items-center` centres the glyph inside it, so the icon sits on the
    // label's baseline at any label length.
    const infoTrigger = screen.getByRole("button", {
      name: `About ${WRAPPING_LABEL}`,
    });
    expect(infoTrigger.className).toContain("h-6");
    expect(infoTrigger.className).toContain("-my-1");
    expect(infoTrigger.className).toContain("items-center");
  });

  it("leaves a card rendered outside a summary strip unreserved", () => {
    // The Insights KPI tiles render `MetricCard` directly into a fixed-height
    // grid host (`className="h-full"`, persisted `h:2` ≈ 156px). A label floor
    // inside the primitive raised the card's minimum stack past that host and
    // dropped the trend footer into the grid gutter (wongk review), so the
    // primitive must stay neutral for every non-strip consumer.
    render(
      <MetricCard
        className="h-full"
        label={ONE_LINE_LABEL}
        trend="+12%"
        value="1,284"
      />
    );

    const region = labelRegionFor(ONE_LINE_LABEL);
    expect(region.className).not.toContain("min-h-");
    expect(region.className).not.toMatch(FIXED_HEIGHT_CLASS_PATTERN);
  });

  it("keeps the reservation a floor, never a fixed height that would clip a longer label", () => {
    render(
      <SummaryCardRow>
        <MetricCard label={WRAPPING_LABEL} value="$19,608" />
      </SummaryCardRow>
    );

    // A `h-8`/`max-h-8` would truncate a label that genuinely needs a third line;
    // the region only ever grows past the reserved two.
    const row = stripRowFor(WRAPPING_LABEL);
    expect(row.className).not.toContain("max-h-");
    expect(labelRegionFor(WRAPPING_LABEL).className).not.toMatch(
      FIXED_HEIGHT_CLASS_PATTERN
    );
    // The label itself is never clamped away — the full string stays readable.
    expect(labelRegionFor(WRAPPING_LABEL).textContent).toContain(
      WRAPPING_LABEL
    );
  });
});
