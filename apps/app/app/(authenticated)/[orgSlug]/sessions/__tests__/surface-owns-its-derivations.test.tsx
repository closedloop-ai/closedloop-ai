import { sessionPriorWindowLabel } from "@repo/app/agents/lib/session-summary-deltas";
import { DEFAULT_DATE_RANGE } from "@repo/app/shared/lib/format-utils";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  resetSessionsPageTestState,
  useAgentSessionUsageMock,
} from "../../../__tests__/sessions-page-test-helpers";
import SessionsPage from "../page";
import { SessionsPageTestProviders } from "./sessions-page-test-providers";

/**
 * ISS-8221 — the listing surface owns its own derivations and cannot ask which
 * surface it is.
 *
 * The page used to read `grid-table-v2` once and thread the boolean into four
 * more places: the comparison gate on `buildSessionSummaryDeltas`, the
 * `gridTableV2Enabled` parameter on `buildSessionsPaginationFooter` (twice), and
 * the menu-availability argument to `resolveVisibleHiddenCardIds`.
 *
 * ISS-10301 retired that key ENABLED, so there is ONE surface. Three of this
 * file's four cases described the v1 half of a pair and went with it:
 *  - "captions the v1 strip with the prior-window wording" — the v1 caption has
 *    no surface left to render on. Its v2 twin below is now the only caption, and
 *    it still asserts the v1 wording is ABSENT, which is what keeps a regression
 *    that reintroduced the un-cadenced label loud.
 *  - "offers no rows-per-page control on the v1 surface" — the rows-per-page
 *    select is the v2 surface's own control, so its absence is no longer a
 *    contract; `page-v2-footer.test.tsx` pins its PRESENCE instead.
 *  - "renders no page controls on a single-page v1 list" — `totalPages > 1` was
 *    the v1 footer's guard. The v2 footer owns its own visibility rule
 *    (`shouldRenderListPagination`), pinned in its own suite.
 *
 * The captions are read from `sessionPriorWindowLabel`, the exported helper the
 * production code derives them with, rather than re-spelled here: what is under
 * test is WHICH argument the surface passes it, not the wording it maps to (that
 * is covered in the package's own suite).
 */

const V1_PRIOR_WINDOW_CAPTION = sessionPriorWindowLabel(DEFAULT_DATE_RANGE);
const V2_CADENCE_CAPTION = sessionPriorWindowLabel(DEFAULT_DATE_RANGE, true);

/** A settled comparison, so the caption is rendered rather than suppressed. */
function serveSettledComparison(): void {
  useAgentSessionUsageMock.mockImplementation(() => ({
    data: {
      comparison: {
        priorStartDate: "2026-07-01T00:00:00.000Z",
        priorEndDate: "2026-07-31T23:59:59.999Z",
        deltas: { sessions: 12.5 },
      },
    },
    isLoading: false,
    isLoadingError: false,
  }));
}

beforeEach(() => {
  resetSessionsPageTestState("organization");
  localStorage.clear();
});

describe("Sessions surfaces — the comparison gate (FEA-4202)", () => {
  it("captions the strip with the cadence word", async () => {
    serveSettledComparison();
    render(<SessionsPage />, { wrapper: SessionsPageTestProviders });

    expect(
      await screen.findByText(V2_CADENCE_CAPTION as string)
    ).toBeInTheDocument();
    // The un-cadenced v1 wording must not reach this surface: the two captions
    // are different arguments to one helper, and a regression that dropped the
    // `true` would render this instead of the line above.
    expect(screen.queryByText(V1_PRIOR_WINDOW_CAPTION as string)).toBeNull();
  });
});
