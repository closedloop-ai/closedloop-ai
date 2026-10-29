import {
  SessionSortDir,
  SessionSortKey,
} from "@repo/app/agents/lib/session-sort-group";
import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resetSessionsPageTestState,
  useAgentSessionsMock,
} from "../../../__tests__/sessions-page-test-helpers";
import SessionsPage from "../page";
import { SessionsPageTestProviders } from "./sessions-page-test-providers";

// The signed-out saved-view key `useSessionsViewState("sessions:web")` resolves
// to (these page tests mount without an auth provider); redeclared because both
// halves are module-local to their owning hooks.
const SESSIONS_WEB_SAVED_VIEW_KEY = "sessions:saved-view:sessions:web";

/** Every distinct list scope the page opened its list read for. */
function enabledListScopes(): string[] {
  const scopes = new Set<string>();
  for (const [filters, options] of useAgentSessionsMock.mock.calls) {
    if (options?.enabled === true) {
      scopes.add(JSON.stringify(filters));
    }
  }
  return [...scopes];
}

/**
 * ISS-12286 done-when: a restored saved view issues exactly one list read on
 * mount, under the restored scope, never a default-view read first.
 */
describe("sessions page restored view (ISS-12286)", () => {
  beforeEach(() => {
    resetSessionsPageTestState("organization");
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("opens the list read for the restored scope only", async () => {
    localStorage.setItem(
      SESSIONS_WEB_SAVED_VIEW_KEY,
      JSON.stringify({
        dateRange: "90d",
        sortDir: SessionSortDir.Asc,
        sortKey: SessionSortKey.Cost,
      })
    );

    render(<SessionsPage />, { wrapper: SessionsPageTestProviders });

    await waitFor(() => expect(enabledListScopes()).toHaveLength(1));
    const [scope] = enabledListScopes();
    expect(JSON.parse(scope ?? "{}")).toMatchObject({
      sortBy: SessionSortKey.Cost,
      sortDir: SessionSortDir.Asc,
    });
  });
});
