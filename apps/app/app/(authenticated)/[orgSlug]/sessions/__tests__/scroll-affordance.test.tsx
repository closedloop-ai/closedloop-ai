import { SESSIONS_GRID_FOLD_LEGIBILITY_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  enableSessionsPageFeatureFlag,
  resetSessionsPageTestState,
} from "../../../__tests__/sessions-page-test-helpers";
import SessionsPage from "../page";

/**
 * ISS-4901 at the WEB host: the Sessions list's horizontal scroll region is the
 * page's own bounded `overflow-auto` container, so the affordance has to be
 * wired by the host — `GridTable` renders bare into it and owns no overflow
 * wrapper of its own.
 *
 * The cue is the `scrollbar-overlay` utility (`packages/design-system/styles/
 * globals.css`), which styles the thumb and thereby keeps it on screen where the
 * platform would otherwise auto-hide an overlay scrollbar. It is the same cue
 * the app sidebar and this table's other host (`synced-sessions-table.tsx`)
 * already carry, so these assert the two things only the host can get wrong:
 * that the gate is threaded through, and that the utility lands on the element
 * that actually scrolls (a scrollbar utility on a non-scrolling ancestor styles
 * nothing).
 */

const SCROLL_CONTAINER_TEST_ID = "sessions-scroll-container";
const SCROLLBAR_CUE_CLASS = "scrollbar-overlay";

beforeEach(() => {
  resetSessionsPageTestState("organization");
});

describe("Sessions page horizontal scroll affordance (ISS-4901)", () => {
  it("renders no scroll cue with the flag off", async () => {
    render(<SessionsPage />);

    // Closed-by-default: the shipped surface is untouched until the flag is on.
    const scroller = await screen.findByTestId(SCROLL_CONTAINER_TEST_ID);
    expect(scroller.className).toContain("overflow-auto");
    expect(scroller.className).not.toContain(SCROLLBAR_CUE_CLASS);
  });

  it("puts the scroll cue on the scroll container itself with the flag on", async () => {
    enableSessionsPageFeatureFlag(
      SESSIONS_GRID_FOLD_LEGIBILITY_FEATURE_FLAG_KEY
    );
    render(<SessionsPage />);

    const scroller = await screen.findByTestId(SCROLL_CONTAINER_TEST_ID);
    // The testid also stays put — the scroll-restoration e2e reads `scrollTop`
    // off this node.
    expect(scroller.className).toContain("overflow-auto");
    expect(scroller.className).toContain(SCROLLBAR_CUE_CLASS);
  });
});
