import { SESSION_DATE_RANGE_PARAM } from "@repo/app/agents/lib/session-date-range-param";
import { SessionSortDir } from "@repo/app/agents/lib/session-sort-group";
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetSessionsPageTestState,
  setSessionsFacetQuery,
} from "../../../__tests__/sessions-page-test-helpers";
import SessionsPage from "../page";
import { SessionsPageTestProviders } from "./sessions-page-test-providers";

const { setViewContextProperty } = vi.hoisted(() => ({
  setViewContextProperty: vi.fn(),
}));

vi.mock("@datadog/browser-rum", () => ({
  datadogRum: { setViewContextProperty },
}));

// The saved-view key `useSessionsViewState("sessions:web")` resolves to. Both
// halves are module-local to their owning hooks, so they are redeclared here;
// these page tests mount without an auth provider, which resolves to the
// signed-out (un-namespaced) key.
const SESSIONS_WEB_SAVED_VIEW_KEY = "sessions:saved-view:sessions:web";
// Deliberately NOT the 7d default: a saved view equal to the default cannot
// distinguish a gated tag from an ungated one.
const SAVED_VIEW_RANGE = "90d";

/**
 * ISS-7250. The hook's own suite proves the change path in isolation; this
 * proves THIS route is wired to it, driving the real toolbar control rather
 * than a mocked setter. Deleting the `useRumViewRange` call from the page, or
 * severing the toolbar from the range state, turns these red.
 */
describe("sessions page RUM range attribute (ISS-7250)", () => {
  beforeEach(() => {
    resetSessionsPageTestState("organization");
    setViewContextProperty.mockReset();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("tags the view with the default window on load", () => {
    render(<SessionsPage />, {
      wrapper: SessionsPageTestProviders,
    });

    expect(setViewContextProperty).toHaveBeenCalledWith("range_days", "7");
  });

  /**
   * The `?range=` override is the other way this page's window changes (an
   * inbound link naming the window it was counted over, ISS-5355). Tagging the
   * saved range while the URL narrows the list would attribute the load to a
   * window it never queried.
   */
  it("tags the view with the URL window rather than the saved one", () => {
    setSessionsFacetQuery(SESSION_DATE_RANGE_PARAM, ["90d"]);

    render(<SessionsPage />, {
      wrapper: SessionsPageTestProviders,
    });

    expect(setViewContextProperty).toHaveBeenCalledWith("range_days", "90");
    expect(setViewContextProperty).not.toHaveBeenCalledWith("range_days", "7");
  });

  /**
   * ISS-7250 (whitlockk review, the Branches finding applied to its sibling). This
   * route restores its window through the same post-mount effect, so a saved
   * 90d viewer's first commit holds the 7d default and an ungated tag buckets
   * that window under a range they never selected.
   *
   * The `?range=` case above is deliberately NOT gated on the restore: that
   * window is known during the first render, so waiting on a saved view the URL
   * overrides anyway would suppress a tag that was already correct.
   */
  it("writes no range at all until the saved 90d view has restored", () => {
    localStorage.setItem(
      SESSIONS_WEB_SAVED_VIEW_KEY,
      JSON.stringify({
        sortDir: SessionSortDir.Desc,
        dateRange: SAVED_VIEW_RANGE,
      })
    );

    render(<SessionsPage />, {
      wrapper: SessionsPageTestProviders,
    });

    expect(setViewContextProperty.mock.calls).toEqual([["range_days", "90"]]);
  });
});
