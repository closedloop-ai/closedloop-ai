import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import { summaryBandRankProbe } from "../../../../shared/testing/summary-band-rank-probe";
import { renderSummaryMetricBand } from "../sessions-list-summary-band";

/**
 * ISS-10314 — the Sessions v2 metric band may not stack at phone width.
 *
 * `GridTableListSurface`'s table band is `flex-1` (`flex: 1 1 0%`), so its
 * scaled flex-shrink factor is ZERO: it is the one child of the band column
 * that cannot absorb negative free space. Its sibling bands are floored at
 * min-content, so a metric band that grows without bound drives the scroller to
 * 0px with its rows still in the DOM — visible to a `toBeVisible` check, and
 * unclickable.
 *
 * `wrapBelow` is what made it grow: below `md` it stacks the cards into a
 * two-column grid, measured at ~530px for five cards at 390px. Branches already
 * turns it off on this surface (`wrapBelow={!listSurfaceLayout}`); Sessions
 * passed `true` on both shells, which is the defect.
 *
 * This unit suite checks strip composition. Real 390px geometry and pointer
 * navigation are covered by desktop responsive-pages.spec.ts and web
 * sessions-v2-filters.spec.ts; restoring wrapBelow makes the desktop band 0px.
 */

function renderBand() {
  const band = renderSummaryMetricBand({
    allHidden: false,
    hiddenSummaryCards: undefined,
    isLoading: false,
    summaryCards: {},
    usage: undefined,
  });
  return render(<AppCoreStoryProviders>{band}</AppCoreStoryProviders>);
}

describe("Sessions v2 metric band starvation (ISS-10314)", () => {
  it("keeps the cards on one horizontally scrollable line instead of stacking", () => {
    // The band helper is the single seam both shells pass through, so this one
    // assertion covers web and desktop. `overflow-x-auto` is what keeps every
    // card reachable once the row stops wrapping.
    const { container } = renderBand();
    const strip = container.querySelector(".overflow-x-auto");
    expect(strip).not.toBeNull();
    expect(strip?.className).toContain("max-w-full");
    expect(strip?.className).toContain("min-w-0");
  });

  it("still drops the band entirely when every card is hidden", () => {
    // FEA-4217: the fix must not make the band unconditional — an empty band
    // keeps its padding around nothing.
    expect(
      renderSummaryMetricBand({
        allHidden: true,
        hiddenSummaryCards: undefined,
        isLoading: false,
        summaryCards: {},
        usage: undefined,
      })
    ).toBeUndefined();
  });

  it("renders the cards themselves, so the strip is not an empty wrapper", () => {
    // Without this the two assertions above would pass on a band that rendered
    // its container and no content.
    const { container } = renderBand();
    const strip = container.querySelector(".overflow-x-auto");
    expect(screen.getByText("Total Tokens")).toBeDefined();
    expect(strip?.contains(screen.getByText("Total Tokens"))).toBe(true);
  });

  it("lays ONE strip whose every card spans the band (ISS-11472)", () => {
    // The gutter half of the deliverable, at the seam both shells pass through.
    // Counted, not probed for absence: `strips` is an equality against 1 so a
    // band that rendered none cannot pass, and `cards` is asserted above zero
    // beside the stretch equality so "every card stretches" cannot be vacuous.
    const { container } = renderBand();
    const probe = summaryBandRankProbe(container);

    expect(probe.strips).toBe(1);
    expect(probe.cards).toBeGreaterThan(0);
    expect(probe.stretchingCards).toBe(probe.cards);
  });
});
