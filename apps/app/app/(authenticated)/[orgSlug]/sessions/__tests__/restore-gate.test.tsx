import { TABLE_PAGE_SIZE_LADDER_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import {
  holdSessionsFeatureFlagResolution,
  holdSessionsViewRestore,
  mockSessionsPageGatedRead,
  navigationReplaceMock,
  resetSessionsPageTestState,
  sessionLinkName,
  sessionsEmptyTitle,
  setSessionsPageQuery,
  setSessionsTotal,
  useAgentSessionsMock,
  useAgentSessionUsageMock,
} from "../../../__tests__/sessions-page-test-helpers";
import SessionsPage from "../page";
import { SessionsPageTestProviders } from "./sessions-page-test-providers";
import {
  openSessionsOptionsMenu,
  sessionsExportRow,
  sessionsFacetOptionNames,
} from "./sessions-v2-toolbar-driver";

/** A facet value the DEFAULT usage fixture does not carry, so the toolbar
 * assertion below can only pass because the gate zeroed the read. */
const WARM_CACHE_HARNESS = "codex";

/**
 * ISS-6382 (follow-up to ISS-4655, which built the primitive and left Sessions
 * unwired). Both of this page's reads carry the window AND the sort in their
 * cache key, and both come from `usePersistedTableViewState`'s POST-MOUNT
 * restore — so a page that read on its first commit paginated the corpus under
 * the defaults and then again under the restored view, discarding the first run.
 *
 * These lock the two things typecheck cannot: that the page actually passes the
 * readiness signal as `enabled`, and that the closed window does not render as a
 * settled empty result.
 */
describe("sessions page restore gate (ISS-6382)", () => {
  beforeEach(() => {
    resetSessionsPageTestState("organization");
  });

  it("holds both reads closed on the first commit and opens them once the view restores", async () => {
    render(<SessionsPage />, {
      wrapper: SessionsPageTestProviders,
    });

    // The first commit is the one that mattered: `dateRange`/`sortKey` are still
    // the module defaults there, because the restore runs in an effect.
    expect(useAgentSessionsMock.mock.calls[0]?.[1]?.enabled).toBe(false);
    expect(useAgentSessionUsageMock.mock.calls[0]?.[1]?.enabled).toBe(false);

    // And it opens — a gate that never opened would satisfy the assertions above
    // just as well as the correct one.
    await waitFor(() =>
      expect(lastEnabled(useAgentSessionsMock.mock.calls)).toBe(true)
    );
    expect(lastEnabled(useAgentSessionUsageMock.mock.calls)).toBe(true);
  });

  it("shows the loading skeleton, not the empty state, while the reads are held closed", () => {
    mockSessionsPageGatedRead();

    render(<SessionsPage />, {
      wrapper: SessionsPageTestProviders,
    });

    // A disabled query reports `isLoading: false` with no rows. Keying the
    // skeleton on `isLoading` therefore dropped straight through to the
    // zero-row branch and told an org with sessions it had none.
    expect(screen.queryByText(sessionsEmptyTitle)).toBeNull();
    expect(
      screen
        .getByTestId("sessions-history-list")
        .querySelector('[data-slot="skeleton"]')
    ).not.toBeNull();
    // The summary strip is a SEPARATE flag on the same held-closed read, and it
    // is the half that would state a NUMBER: with `isLoading` false and no
    // usage, `SessionsSummaryCards` falls through to its `?? 0` slots and prints
    // "0 sessions / 0 tokens" the read never produced. `aria-busy` is set only
    // by its loading branch (`SummaryCardRow busy`), so it is the honest signal
    // that the cards know they have nothing yet.
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it("does not render the WARM default-view cache, or clamp the page from its total, while the gate holds", async () => {
    const user = userEvent.setup();
    // The revisit. `enabled: false` stops the FETCH and nothing else, so an
    // observer whose key is already in cache resolves to `success` on the
    // gate-closed commit — `isPending` false, carrying the page the PREVIOUS
    // (default-view) visit left there. The default fixture is exactly that
    // shape: data present, `isPending` absent.
    holdSessionsViewRestore();
    setSessionsTotal(1);
    setSessionsPageQuery("5");
    // A warm SUMMARY cache too, carrying a facet dimension. The default usage
    // fixture has no `byHarness`, so without this the toolbar assertion below
    // would read empty whether or not the gate were applied.
    useAgentSessionUsageMock.mockReturnValue({
      data: {
        totalSessions: 1,
        totalEstimatedCost: 0,
        byHarness: [{ harness: WARM_CACHE_HARNESS }],
      },
      isLoading: false,
    });

    render(<SessionsPage />, {
      wrapper: SessionsPageTestProviders,
    });

    // The cached rows must not reach the table, and the closed window must not
    // read as a settled empty result either.
    expect(screen.queryByText(sessionLinkName)).toBeNull();
    expect(screen.queryByText(sessionsEmptyTitle)).toBeNull();
    expect(
      screen
        .getByTestId("sessions-history-list")
        .querySelector('[data-slot="skeleton"]')
    ).not.toBeNull();
    // Same for the half that states NUMBERS — cached figures for the
    // pre-restore scope are as wrong as fabricated ones.
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    // And the clamp, which is not a render at all: `total: 1` against `?page=5`
    // clamps to page 0 and REWRITES the URL. Sourced from a cache the restore is
    // about to invalidate, that silently moves the viewer off the page their
    // saved view asked for, before any read has justified it.
    expect(navigationReplaceMock).not.toHaveBeenCalled();
    // tamsinb review: the TOOLBAR is a third consumer of the same read, and it
    // was still handed the raw query. Its facet OPTION lists are built from that
    // usage, so a warm cache offered the viewer the previous view's harnesses to
    // filter by while the table beside it was still a skeleton.
    //
    // ISS-10301: read off the REAL Harness submenu rather than the retired v1
    // toolbar stand-in's `toolbar-usage-harnesses` prop marker. Same contract,
    // and a stronger observation — the marker reported which usage object the
    // page HANDED the toolbar, this is what the toolbar OFFERS a reader.
    expect(await sessionsFacetOptionNames(user, "Harness")).not.toContain(
      WARM_CACHE_HARNESS
    );
  });

  it("offers no CSV export while the gate holds, and offers one once it opens", async () => {
    // FEA-4217 (whitlockk review). The export is scoped by `listFilters`, which
    // carries the module DEFAULT window and sort until the restore effect lands.
    // A click in that window produced a file for a range the table was never
    // showing, labelled as the reader's view — the export lying about its own
    // scope, which no failure state would ever surface.
    //
    // ISS-10301: both halves now open the REAL Options menu and look for the real
    // export row, because the v1 toolbar whose `toolbar-export-row` prop marker
    // this read is gone. The gate under test is unchanged.
    const user = userEvent.setup();
    holdSessionsViewRestore();

    const { unmount } = render(<SessionsPage />, {
      wrapper: SessionsPageTestProviders,
    });

    expect(sessionsExportRow(await openSessionsOptionsMenu(user))).toBeNull();
    unmount();

    // And it IS offered once the view restores — a row that never came back
    // would satisfy the assertion above just as well as the correct gate.
    resetSessionsPageTestState("organization");
    render(<SessionsPage />, {
      wrapper: SessionsPageTestProviders,
    });
    expect(
      sessionsExportRow(await openSessionsOptionsMenu(user))
    ).toBeInTheDocument();
  });

  /**
   * ISS-9692 (whitlockk review) — the same gate, for the page SIZE.
   *
   * An unresolved `table-page-size-ladder` reads as OFF, so a viewer holding a
   * saved 500 resolves to 100 — the largest rung of the CLOSED ladder — and a
   * read issued there fetches a page nobody asked for and refetches at 500 the
   * moment the flag lands. `limit` is in the query key, so that first run is
   * unrecoverable, which is the same reasoning the window and sort gates encode.
   *
   * The unmount-and-remount pair matters: the closed assertion alone would be
   * satisfied by a gate that never opened at all.
   */
  it("holds both reads closed while the page-size ladder is still resolving", async () => {
    holdSessionsFeatureFlagResolution(TABLE_PAGE_SIZE_LADDER_FEATURE_FLAG_KEY);

    const { unmount } = render(<SessionsPage />, {
      wrapper: SessionsPageTestProviders,
    });

    // The restore itself is NOT held here, so the view settles and every other
    // term of the gate opens; the ladder is the only one still closed. The
    // skeleton is the observable proof that the settle happened and the read is
    // still shut, rather than a bare assertion racing the effect.
    await waitFor(() =>
      expect(
        screen
          .getByTestId("sessions-history-list")
          .querySelector('[data-slot="skeleton"]')
      ).not.toBeNull()
    );
    expect(lastEnabled(useAgentSessionsMock.mock.calls)).toBe(false);
    expect(lastEnabled(useAgentSessionUsageMock.mock.calls)).toBe(false);
    unmount();

    resetSessionsPageTestState("organization");
    render(<SessionsPage />, {
      wrapper: SessionsPageTestProviders,
    });

    await waitFor(() =>
      expect(lastEnabled(useAgentSessionsMock.mock.calls)).toBe(true)
    );
    expect(lastEnabled(useAgentSessionUsageMock.mock.calls)).toBe(true);
  });
});

function lastEnabled(calls: unknown[][]): boolean | undefined {
  const options = calls.at(-1)?.[1] as { enabled?: boolean } | undefined;
  return options?.enabled;
}
