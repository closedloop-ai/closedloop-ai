import { GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  enableSessionsPageFeatureFlag,
  lastSessionsTableCallArgs,
  resetSessionsPageTestState,
  setSessionsFacetQuery,
} from "../../../__tests__/sessions-page-test-helpers";
import SessionsPage from "../page";
import { SessionsPageTestProviders } from "./sessions-page-test-providers";

/**
 * ISS-13035: the Sessions search term is a gridview-adoption feature. With the
 * flag off a `?search=` link narrows nothing, as before the shared toolbar.
 */
const SEARCH_PARAM = "search";

describe("Sessions page ?search= by gridview-adoption", () => {
  beforeEach(() => {
    resetSessionsPageTestState("organization");
    localStorage.clear();
    setSessionsFacetQuery(SEARCH_PARAM, ["feature"]);
  });

  it("SESSIONS-SEARCH-1 sends no search term to the list read while the flag is off", () => {
    render(<SessionsPage />, { wrapper: SessionsPageTestProviders });

    const args = lastSessionsTableCallArgs();
    expect(args?.search).toBeUndefined();
    expect(args?.listSearch).toBeUndefined();
  });

  it("SESSIONS-SEARCH-2 sends the trimmed term to the list read once the flag is on", () => {
    enableSessionsPageFeatureFlag(GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY);
    render(<SessionsPage />, { wrapper: SessionsPageTestProviders });

    expect(lastSessionsTableCallArgs()?.listSearch).toBe("feature");
  });
});
