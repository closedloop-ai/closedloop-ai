import { GRID_TABLE_SCROLL_BAND_TEST_ID } from "@repo/design-system/components/ui/grid-table-list-surface";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { resetSessionsPageTestState } from "../../../__tests__/sessions-page-test-helpers";
import SessionsPage from "../page";
import { SessionsPageTestProviders } from "./sessions-page-test-providers";

/**
 * ISS-4901 at the WEB host: the Sessions list's horizontal scroll region is a
 * bounded `overflow-auto` container, so the affordance has to be wired where that
 * container is built — `GridTable` renders bare into it and owns no overflow
 * wrapper of its own.
 *
 * ISS-10301 moved which element that is. The `sessions-scroll-container` this
 * asserted on belonged to the retired v1 host; the live v2 listing scrolls
 * `GridTableListSurface`'s own band, so the cue has to be there instead. Read
 * from the canonical constant rather than restated, so the band this asserts on
 * is the band the surface renders.
 *
 * The cue is the `scrollbar-overlay` utility (`packages/design-system/styles/
 * globals.css`), which styles the thumb and thereby keeps it on screen where the
 * platform would otherwise auto-hide an overlay scrollbar. It is the same cue
 * the app sidebar and this table's other host (`synced-sessions-table.tsx`)
 * already carry, so these assert the two things only the host can get wrong:
 * that the utility lands on the element that actually scrolls (a scrollbar
 * utility on a non-scrolling ancestor styles nothing).
 */

const SCROLLBAR_CUE_CLASS = "scrollbar-overlay";

beforeEach(() => {
  resetSessionsPageTestState("organization");
});

describe("Sessions page horizontal scroll affordance (ISS-4901)", () => {
  it("puts the scroll cue on the scroll container itself", async () => {
    render(<SessionsPage />, {
      wrapper: SessionsPageTestProviders,
    });

    const scroller = await screen.findByTestId(GRID_TABLE_SCROLL_BAND_TEST_ID);
    // The testid also stays put — the scroll-restoration e2e reads `scrollTop`
    // off this node.
    expect(scroller.className).toContain("overflow-auto");
    expect(scroller.className).toContain(SCROLLBAR_CUE_CLASS);
  });
});
