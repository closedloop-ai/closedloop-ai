import {
  SUMMARY_CARD_CLASS,
  SummaryCardRow,
  summaryCardClass,
} from "@repo/app/shared/components/summary-card-row";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

/**
 * Any responsive tier that pins a COUNT of columns (`lg:grid-cols-3`,
 * `xl:grid-cols-5`, …). The unprefixed `grid-cols-1` stacked tier is fine — it can
 * never squeeze a card — so the pattern requires a breakpoint prefix.
 */
const FIXED_COLUMN_TIER_PATTERN = /(?:^|\s)\w+:grid-cols-\d/;
/**
 * The auto-fit track template both grid layouts share: fit as many whole
 * `--summary-card-min` cards as the width holds, wrap the rest. Written out here
 * rather than read off the constant so a change to the template has to be made
 * deliberately in two places instead of silently agreeing with itself.
 */
const AUTO_FIT_TRACKS_CLASS =
  "md:grid-cols-[repeat(auto-fit,minmax(var(--summary-card-min),1fr))]";

/**
 * The floor an UNMEASURED row publishes: the ISS-5068 compact one.
 *
 * jsdom runs no layout, so the ISS-5149 width tier cannot describe a track and
 * returns `null` — which the row reads as "unknown", not "comfortable", and
 * resolves COMPACT so a real strip never paints the roomier card and then snaps
 * tighter a frame later. Before ISS-5366 retired `summary-strip-density` these
 * renders got the 260px floor instead, because the gate resolved OFF with no
 * provider mounted. The layout contracts these tests own are unchanged; only the
 * number the row publishes moved. Which floor is resolved at which track width
 * is owned by `summary-card-row-density-tier.test.tsx`.
 */
const UNMEASURED_CARD_MIN_WIDTH = "192px";

// FEA-3865: SummaryCardRow trades the fixed `w-[260px]` card for a `minWidth`
// prop (published as `--summary-card-min`) and a `wrapBelow` flag that swaps the
// non-wrapping flex row for a two-column grid below `md` (768px — the same width
// the table beneath the strip flips to a card list, so the surface migrates to
// the narrow layout at one breakpoint instead of a half-migrated 480–768 band).

describe("SummaryCardRow (FEA-3865)", () => {
  it("keeps the single-row flex layout and publishes a min-width when wrapBelow is off", () => {
    render(
      <SummaryCardRow data-testid="row">
        <div>card</div>
      </SummaryCardRow>
    );
    const row = screen.getByText("card").parentElement as HTMLElement;
    expect(row.className).toContain("flex");
    expect(row.className).not.toContain("grid-cols-2");
    expect(row.style.getPropertyValue("--summary-card-min")).toBe(
      UNMEASURED_CARD_MIN_WIDTH
    );
  });

  it("switches from a two-column grid below md to an auto-fit min-width grid at md+ when wrapBelow is on", () => {
    // FEA-3574 review: at `md+` the row is an AUTO-FIT min-width grid that wraps
    // six cards onto multiple rows when the width can't hold them — not the old
    // non-wrapping `md:flex` row that pushed the last cards off-screen behind
    // horizontal scroll.
    render(
      <SummaryCardRow wrapBelow>
        <div>card</div>
      </SummaryCardRow>
    );
    const row = screen.getByText("card").parentElement as HTMLElement;
    expect(row.className).toContain("grid-cols-2");
    expect(row.className).toContain(AUTO_FIT_TRACKS_CLASS);
    // No longer a non-wrapping flex row at md+ (that overflowed six cards).
    expect(row.className).not.toContain("md:flex");
    // The strip flips at `md` (768px), the same width GridTable flips the table
    // beneath it — not `xs` (480px), which would leave a half-migrated band.
    expect(row.className).not.toContain("xs:flex");
  });

  it("spans an odd last card across both columns below md so it never orphans half-width", () => {
    // FEA-4126: with an odd card count (five) the below-`md` two-column grid
    // would land the last card at half width beside dead space (2 + 2 + 1).
    // The `max-md:` odd-last-child span closes the row out flush, scoped so the
    // `md+` auto-fit grid is untouched.
    render(
      <SummaryCardRow wrapBelow>
        <div>card</div>
      </SummaryCardRow>
    );
    const row = screen.getByText("card").parentElement as HTMLElement;
    expect(row.className).toContain(
      "max-md:[&>*:last-child:nth-child(odd)]:col-span-2"
    );
  });

  it("publishes a custom min-width for the card class to consume", () => {
    render(
      <SummaryCardRow minWidth={200}>
        <div>card</div>
      </SummaryCardRow>
    );
    const row = screen.getByText("card").parentElement as HTMLElement;
    expect(row.style.getPropertyValue("--summary-card-min")).toBe("200px");
  });

  it("gives the card class a full-width variant when wrapBelow is requested", () => {
    // FEA-3574 review: the wrapBelow card always fills its grid cell (`w-full`)
    // at every width — below `md` the two-column mobile grid, at `md+` the
    // auto-fit min-width grid sizes the cell, so the card no longer pins itself
    // to a fixed min-width (which forced a non-wrapping row that overflowed six
    // cards). The non-wrap card keeps the fixed-width, scrolling row.
    expect(summaryCardClass(false)).toBe(SUMMARY_CARD_CLASS);
    expect(summaryCardClass(false)).not.toContain("w-full");
    expect(summaryCardClass(true)).toBe("w-full");
  });
});

// ISS-4787 follow-up: the two-line label reservation the row applies only holds
// while a card is at least `--summary-card-min` wide. A grid host that pins a
// COUNT of columns instead of deriving them from that floor squeezes the cards
// under it — the desktop Sessions strip's hard `lg:3 → xl:5` tiers left each card
// at roughly 206px beside the 16rem rail on the 1380px window the defect was
// reported at, and still under the floor at today's wider desktop default, so
// "cost" broke onto a THIRD line and its value fell a whole
// line-height below the rest of its rank.
//
// Stage review: the desktop hosts used to get those derived tracks from a
// `SUMMARY_CARD_GRID_CLASS` export, which had to override the row's own `display`
// to work — and had drifted from the row on the two things it also declared
// (one-per-row vs paired below `md`, `gap-3` vs `gap-4`). It is gone; the desktop
// hosts pass `wrapBelow` like every other grid caller, so there is exactly one
// layout owner and the drift is unrepresentable.
describe("the wrapBelow grid host (ISS-4787 follow-up)", () => {
  it("derives its md+ columns from the published per-card minimum, never a fixed count", () => {
    render(
      <SummaryCardRow wrapBelow>
        <div>card</div>
      </SummaryCardRow>
    );
    const row = screen.getByText("card").parentElement as HTMLElement;
    // The tracks read the SAME custom property the row publishes on the SAME
    // element, so the `var()` always resolves and a card can never be laid out
    // narrower than the width the reservation assumes.
    expect(row.classList.contains(AUTO_FIT_TRACKS_CLASS)).toBe(true);
    expect(row.style.getPropertyValue("--summary-card-min")).toBe(
      UNMEASURED_CARD_MIN_WIDTH
    );
    // No responsive tier may pin a column count — that is exactly what let the
    // cards fall under the floor.
    expect(row.className).not.toMatch(FIXED_COLUMN_TIER_PATTERN);
  });

  it("gives every grid host ONE narrow layout and ONE gutter", () => {
    // The divergences the removed export introduced, pinned so they cannot come
    // back through a second layout owner: below `md` the cards pair two-up (with
    // an odd last card spanning both columns) rather than stacking one per row,
    // and the gutter is the row's `gap-4` rather than a host-local `gap-3`.
    render(
      <SummaryCardRow wrapBelow>
        <div>card</div>
      </SummaryCardRow>
    );
    const row = screen.getByText("card").parentElement as HTMLElement;
    expect(row.classList.contains("grid-cols-2")).toBe(true);
    expect(row.classList.contains("grid-cols-1")).toBe(false);
    expect(row.classList.contains("gap-4")).toBe(true);
    expect(row.classList.contains("gap-3")).toBe(false);
    expect(
      row.classList.contains(
        "max-md:[&>*:last-child:nth-child(odd)]:col-span-2"
      )
    ).toBe(true);
    // The grid host replaces the default flex line rather than stacking on it.
    expect(row.classList.contains("flex")).toBe(false);
  });
});
