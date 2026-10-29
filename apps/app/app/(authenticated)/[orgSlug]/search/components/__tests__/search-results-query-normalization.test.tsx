import type { SearchPanelState } from "@repo/app/search/hooks/use-search";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { SearchResults } from "../search-results";

// This file covers three `UnifiedSearchPanel` URL-normalization edges that the
// sibling `search-results.test.tsx` does not: an absent (not merely empty) `q`
// param, reseeding the query bar from an EXTERNAL URL change (browser
// back/forward) while the panel stays mounted, and folding a legacy `?types=`
// value that the parser rejects outright. Kept as its own file rather than
// edits to that existing suite (ISS-9169: one worker per file).

const routerReplaceMock = vi.fn();
const useSearchPanelStateMock = vi.fn();

let searchParams = new URLSearchParams("q=alpha");

// ISS-9414: the panel now reads `portable-search-surface` at its mount site, and
// these cases are the flag-OFF (`UnifiedSearchResults`) branch. Mocked rather
// than provider-wrapped so the branch under test is NAMED — without it the hook
// throws for want of a `FeatureFlagAdapterProvider`, and with a blanket `true`
// every case below would silently move to the other surface.
vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: () => false,
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ orgSlug: "acme" }),
  usePathname: () => "/acme/search",
  useRouter: () => ({
    back: vi.fn(),
    push: vi.fn(),
    refresh: vi.fn(),
    replace: routerReplaceMock,
  }),
  useSearchParams: () => searchParams,
}));

vi.mock("@/hooks/use-org-slug", () => ({
  useOrgSlug: () => "acme",
}));

// Same seam the sibling suite uses: a controlled input standing in for the
// intellisense-aware bar, whose own wiring is tested elsewhere.
vi.mock("@repo/app/search/components/search-typeahead", () => ({
  SearchTypeahead: ({
    value,
    onValueChange,
    onSubmit,
  }: {
    value: string;
    onValueChange: (next: string) => void;
    onSubmit: (next: string) => void;
  }) => (
    <input
      aria-label="Search query"
      onChange={(event) => onValueChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          onSubmit(value);
        }
      }}
      value={value}
    />
  ),
}));

vi.mock("@repo/app/search/hooks/use-search", async () => {
  const actual = await vi.importActual<
    typeof import("@repo/app/search/hooks/use-search")
  >("@repo/app/search/hooks/use-search");
  return {
    ...actual,
    useSearchPanelState: (...args: unknown[]) =>
      useSearchPanelStateMock(...args),
  };
});

describe("SearchResults unified panel — URL/query normalization edges", () => {
  beforeEach(() => {
    searchParams = new URLSearchParams("q=alpha");
    routerReplaceMock.mockClear();
    useSearchPanelStateMock.mockReset();
    useSearchPanelStateMock.mockReturnValue(panelState());
  });

  test("falls back to an empty query when the URL carries neither q nor tagId", () => {
    searchParams = new URLSearchParams("");

    render(<SearchResults />);

    expect(screen.getByText("Search everything")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Search query" })).toHaveValue(
      ""
    );
    expect(routerReplaceMock).not.toHaveBeenCalled();
  });

  test("reseeds the query bar when the URL query changes externally (e.g. back/forward navigation)", async () => {
    const { rerender } = render(<SearchResults />);
    expect(screen.getByRole("textbox", { name: "Search query" })).toHaveValue(
      "alpha"
    );

    searchParams = new URLSearchParams("q=beta");
    rerender(<SearchResults />);

    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: "Search query" })).toHaveValue(
        "beta"
      );
    });
    // The reseed only updates local state; it must not itself write the URL
    // (that would fight the navigation that just happened).
    expect(routerReplaceMock).not.toHaveBeenCalled();
  });

  test("folds an invalid legacy ?types= value to an empty query and still normalizes the URL", () => {
    searchParams = new URLSearchParams("types=bogus");

    render(<SearchResults />);

    // "bogus" is not a supported search entity kind, so it is dropped rather
    // than spliced in as a `type:` token — the query stays empty and the
    // on-ramp shows, not a filtered (and still empty) result list.
    expect(screen.getByText("Search everything")).toBeInTheDocument();
    expect(routerReplaceMock).toHaveBeenCalledWith("/acme/search", {
      scroll: false,
    });
  });
});

function panelState(
  overrides: Partial<SearchPanelState> = {}
): SearchPanelState {
  return {
    results: [],
    isLoading: false,
    isRetrying: false,
    isError: false,
    filterErrorMessage: undefined,
    nextCursor: null,
    refetch: vi.fn(),
    ...overrides,
  };
}
