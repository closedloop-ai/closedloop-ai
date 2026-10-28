/**
 * @description FEA-4201: "Clear filters" has to strip the explicit `?from=`/
 * `?to=` window, not only the facets and the search term.
 *
 * The window is URL-owned and it counts toward `hasActiveSessionFilters`, which
 * is what OFFERS this control — so a clear that leaves it behind hands the user
 * back the same narrowed rows they just tried to clear, with the same control
 * still offered. The web page strips it as part of its own clear; this hook is
 * the desktop half of the same contract.
 */
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useSessionsListRecovery } from "../use-sessions-list-recovery";

const SEARCH_PARAM = "search";

function renderRecovery() {
  const replaceListParams = vi.fn();
  let clearFilters: () => void = () => undefined;

  function Harness() {
    const recovery = useSessionsListRecovery({
      cancelPageDataRead: vi.fn(),
      isBlockingLoad: false,
      isListScopeDefault: false,
      isPageDataFetching: false,
      recheckLocalSource: () => undefined,
      refetchPageData: () => Promise.resolve(),
      replaceListParams,
      searchParam: SEARCH_PARAM,
      setDateRange: vi.fn(),
      setFacetFilters: vi.fn(),
    });
    clearFilters = recovery.handleClearFilters;
    return null;
  }

  render(<Harness />);
  return { clearFilters: () => clearFilters(), replaceListParams };
}

describe("useSessionsListRecovery — Clear filters (FEA-4201)", () => {
  it("strips BOTH explicit window bounds alongside the search term", () => {
    const { clearFilters, replaceListParams } = renderRecovery();

    clearFilters();

    // Pinned literals, not the module's own param constants: this test exists to
    // catch the pair being half-cleared, and reading the names from the same
    // module the hook reads them from cannot see that.
    const stripped = replaceListParams.mock.calls.at(-1)?.[2] as string[];
    expect(stripped).toEqual(expect.arrayContaining(["from", "to"]));
    expect(stripped).toContain(SEARCH_PARAM);
  });

  /**
   * FEA-4201 (whitlockk review). The clear stripped only `from`/`to`, so a shared
   * link carrying `?range=90d` kept it: this shell never READS `?range=`, so
   * nothing looked wrong here — desktop fell back to its saved range and the
   * clear appeared to work — while the URL it went on to hand out still narrowed
   * the listing to 90 days for whoever opened it on web.
   *
   * That is why the param is pinned as a literal rather than read from
   * `SESSION_URL_OWNED_WINDOW_PARAMS`: asserting against the same constant the
   * hook strips from would go green on an empty set.
   */
  it("strips the rolling preset too, which this shell never reads itself", () => {
    const { clearFilters, replaceListParams } = renderRecovery();

    clearFilters();

    const stripped = replaceListParams.mock.calls.at(-1)?.[2] as string[];
    expect(stripped).toContain("range");
  });
});
