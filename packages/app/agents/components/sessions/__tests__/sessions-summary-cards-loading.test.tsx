import { LOC_PER_DOLLAR_MERGED_LABEL } from "@repo/api/src/utils/loc-per-dollar";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SESSIONS_COST_METRIC_CARD_LABEL } from "../cost-metric-card";
import {
  PRS_SHIPPED_METRIC_CARD_LABEL,
  SESSIONS_METRIC_CARD_LABEL,
  TOTAL_TOKENS_METRIC_CARD_LABEL,
} from "../sessions-summary-card-labels";
import { SessionsSummaryCards } from "../sessions-summary-cards";

/**
 * ISS-5070 item 3, closed by ISS-5366 (stage review).
 *
 * The strip's loading state used to be five bare `Skeleton` slabs at a
 * hardcoded `h-[124px]`. That literal predated the dense strip and was never
 * re-measured against a live compact card, so at every width the density tier
 * resolves compact — which includes the desktop launch width, and therefore
 * every first load — the slab was taller than the card that replaced it and the
 * strip, plus the whole table under it, jumped when the data landed.
 *
 * Driven through `SessionsSummaryCards` rather than the loading component
 * directly, so these assert the PRODUCTION wiring: deleting the call site would
 * fail here rather than leave a green suite around an orphaned component.
 */
const HARDCODED_SKELETON_HEIGHT_CLASS = "h-[124px]";

describe("SessionsSummaryCards loading state (ISS-5366)", () => {
  it("loads as real card shells, not fixed-height slabs", () => {
    const { container } = render(
      <SessionsSummaryCards isLoading usage={undefined} />
    );

    // All five metrics announce themselves before their values arrive, so the
    // reader can already tell which numbers are coming.
    for (const label of [
      SESSIONS_METRIC_CARD_LABEL,
      TOTAL_TOKENS_METRIC_CARD_LABEL,
      SESSIONS_COST_METRIC_CARD_LABEL,
      PRS_SHIPPED_METRIC_CARD_LABEL,
      LOC_PER_DOLLAR_MERGED_LABEL,
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    // ...and none of them states a value. The em-dash sentinel is the ERROR
    // state's honest "we tried and failed"; a pending read must not borrow it,
    // and must certainly not paint a zero it has not read.
    expect(screen.queryByText("—")).toBeNull();
    expect(screen.queryByText("0")).toBeNull();
    // The row says it is updating, so assistive tech does not read the empty
    // value slots as settled content.
    expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument();
    // The regression itself: no hardcoded card height left in the loading strip.
    // This is what fails if someone reintroduces a literal instead of letting
    // the card size itself at the resolved density.
    expect(container.innerHTML).not.toContain(HARDCODED_SKELETON_HEIGHT_CLASS);
  });

  it("reserves the delta slot only on a surface that actually compares", () => {
    // A comparing surface's settled cards carry an extra row inside
    // `CardContent` (the delta chip, or the "No prior period" placeholder in the
    // same slot). A shell without that row would be shorter than the card that
    // replaces it and would reintroduce the settle — so the slot is reserved
    // when, and only when, it is going to be filled.
    const { container: comparing } = render(
      <SessionsSummaryCards
        deltas={{ label: "vs. prior 30 days" }}
        isLoading
        usage={undefined}
      />
    );
    const comparingSlots = comparing.querySelectorAll('[data-slot="skeleton"]');

    const { container: notComparing } = render(
      <SessionsSummaryCards isLoading usage={undefined} />
    );
    const notComparingSlots = notComparing.querySelectorAll(
      '[data-slot="skeleton"]'
    );

    // Five value skeletons either way; the comparing surface adds one delta-slot
    // skeleton per card that will carry a comparison.
    expect(notComparingSlots).toHaveLength(5);
    expect(comparingSlots.length).toBeGreaterThan(notComparingSlots.length);
  });

  it("never prints a comparison verdict it has not read", () => {
    // The delta slot reserves with a skeleton, NOT with the settled card's "No
    // prior period" line. While the read is pending the row genuinely does not
    // know whether a prior period exists, and printing that line would be a
    // claim — the same reason the value slot shimmers rather than showing a zero.
    render(
      <SessionsSummaryCards
        deltas={{ label: "vs. prior 30 days" }}
        isLoading
        usage={undefined}
      />
    );

    expect(screen.queryByText("No prior period")).toBeNull();
    expect(screen.queryByText("vs. prior 30 days")).toBeNull();
  });
});
