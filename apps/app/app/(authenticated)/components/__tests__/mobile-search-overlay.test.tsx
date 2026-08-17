import type { SearchHit } from "@repo/api/src/types/search";
import { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { navigate, mockUseSearchPanelState } = vi.hoisted(() => ({
  navigate: vi.fn(),
  mockUseSearchPanelState: vi.fn(),
}));

vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ navigate, replace: vi.fn(), back: vi.fn() }),
}));

// useOrgPath builds the org-scoped href; the sheet uses it (not raw slug
// interpolation) so a pre-hydration empty slug can't produce a `//search` URL.
vi.mock("@repo/navigation/use-org-path", () => ({
  useOrgPath: () => (path: string) => `/acme${path}`,
}));

// The panel state (query + 400-filter classification) is the sheet's data seam;
// `MIN_UNIFIED_QUERY_LENGTH` stays the real 2-char floor the sheet gates on.
vi.mock("@repo/app/search/hooks/use-search", async () => {
  const actual = await vi.importActual<
    typeof import("@repo/app/search/hooks/use-search")
  >("@repo/app/search/hooks/use-search");
  return {
    MIN_UNIFIED_QUERY_LENGTH: actual.MIN_UNIFIED_QUERY_LENGTH,
    useSearchPanelState: (params: unknown) => mockUseSearchPanelState(params),
  };
});

// The intellisense-aware input is unit-tested in @repo/app; here it is a thin
// stub that drives the overlay's controlled query state (typing/submit), so
// the overlay's own wiring is what is under test. It records the props that
// carry the sheet's contract (suppressed FTS dropdown, selection callback).
vi.mock("@repo/app/search/components/search-typeahead", () => ({
  SearchTypeahead: ({
    value,
    onValueChange,
    onSubmit,
    onSelectHit,
    suppressFtsDropdown,
  }: {
    value: string;
    onValueChange: (v: string) => void;
    onSubmit: (v: string) => void;
    onSelectHit?: (hit: SearchHit) => void;
    suppressFtsDropdown?: boolean;
  }) => (
    <div>
      <input
        aria-label="Search"
        onChange={(event) => onValueChange(event.target.value)}
        value={value}
      />
      <span data-testid="suppress-fts">
        {String(Boolean(suppressFtsDropdown))}
      </span>
      <button onClick={() => onSubmit(value)} type="button">
        submit
      </button>
      <button onClick={() => onSelectHit?.(sampleHit())} type="button">
        pick-hit
      </button>
    </div>
  ),
}));

// The unified results list is unit-tested in @repo/app; stub it to echo the
// props the overlay hands it (states + facet toggle + selection close) so the
// overlay's data flow is observable without re-testing the list's own render.
vi.mock("@repo/app/search/components/unified-search-results", () => ({
  UnifiedSearchResults: ({
    results,
    isLoading,
    isError,
    filterErrorMessage,
    activeTypes,
    onToggleType,
    onSelectResult,
    hideActiveFacetChips,
  }: {
    results: SearchHit[];
    isLoading: boolean;
    isError: boolean;
    filterErrorMessage?: string;
    activeTypes: SearchEntityType[];
    onToggleType: (type: SearchEntityType) => void;
    onSelectResult?: () => void;
    hideActiveFacetChips?: boolean;
  }) => (
    <div data-testid="unified-results">
      <span data-testid="state">
        {isLoading ? "loading" : ""}
        {isError ? "error" : ""}
      </span>
      <span data-testid="filter-error">{filterErrorMessage ?? ""}</span>
      <span data-testid="result-count">{results.length}</span>
      <span data-testid="active-types">{activeTypes.join(",")}</span>
      <span data-testid="hide-active-facet-chips">
        {String(Boolean(hideActiveFacetChips))}
      </span>
      <button onClick={() => onToggleType(SearchEntityType.Loop)} type="button">
        toggle-loop
      </button>
      <button onClick={() => onSelectResult?.()} type="button">
        pick-result
      </button>
    </div>
  ),
}));

import { MobileSearchOverlay } from "../mobile-search-overlay";

// The pre-search syntax hint, matched loosely so a copy tweak to the leading
// clause doesn't break the assertion.
const SEARCH_PROMPT_PATTERN = /Type : to filter by field, @ to find a person\./;

function sampleHit(): SearchHit {
  return {
    entityType: SearchEntityType.Loop,
    entityId: "loop-1",
    title: "Alpha loop",
    snippet: "run the alpha loop",
    rank: 0.5,
    updatedAt: new Date("2026-01-01"),
    deepLink: "/loops/loop-1",
  };
}

function panelState(overrides: Partial<PanelState> = {}): PanelState {
  return {
    results: [],
    isLoading: false,
    isError: false,
    filterErrorMessage: undefined,
    nextCursor: null,
    ...overrides,
  };
}

type PanelState = {
  results: SearchHit[];
  isLoading: boolean;
  isError: boolean;
  filterErrorMessage: string | undefined;
  nextCursor: string | null;
};

async function openOverlay() {
  const user = userEvent.setup();
  render(<MobileSearchOverlay />);
  await user.click(screen.getByRole("button", { name: "Search" }));
  return user;
}

describe("MobileSearchOverlay", () => {
  beforeEach(() => {
    navigate.mockReset();
    mockUseSearchPanelState.mockReset();
    mockUseSearchPanelState.mockReturnValue(panelState());
  });

  afterEach(cleanup);

  it("opens a titled search sheet from the header button", async () => {
    await openOverlay();

    const dialog = screen.getByRole("dialog");
    // The Radix Dialog under the sheet carries the accessible name; the results
    // list is not shown until the user types.
    expect(within(dialog).getByText("Search")).toBeInTheDocument();
    expect(screen.queryByTestId("unified-results")).toBeNull();
    // The syntax hint shows twice: the visible pre-search prompt and the
    // sr-only SheetDescription (kept in sync from one source).
    expect(screen.getAllByText(SEARCH_PROMPT_PATTERN)).toHaveLength(2);
  });

  it("suppresses the Sheet's built-in close-X to avoid a double dismiss", async () => {
    // Finding #1: the pill carries its own clear-X, so the Sheet must not also
    // render its top-right close-X a thumb-width away. Escape still dismisses
    // (see the reopen test), so no accessible dismiss is lost.
    await openOverlay();

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });

  it("renders the unified results once the query clears the 2-char floor", async () => {
    mockUseSearchPanelState.mockReturnValue(
      panelState({ results: [sampleHit()] })
    );

    const user = await openOverlay();
    await user.type(screen.getByRole("textbox", { name: "Search" }), "alpha");

    expect(screen.getByTestId("unified-results")).toBeInTheDocument();
    expect(screen.getByTestId("result-count")).toHaveTextContent("1");
  });

  it("keeps the idle prompt for a single-character query (hook still idle)", async () => {
    // The hook does not fire below 2 chars, so a 1-char query must keep the
    // prompt, never a false "No results" state for a request that never ran.
    mockUseSearchPanelState.mockReturnValue(panelState());

    const user = await openOverlay();
    await user.type(screen.getByRole("textbox", { name: "Search" }), "a");

    expect(screen.queryByTestId("unified-results")).toBeNull();
    expect(screen.getAllByText(SEARCH_PROMPT_PATTERN)).toHaveLength(2);
  });

  it("suppresses the typeahead's own FTS dropdown (one result surface)", async () => {
    // The sheet renders its own inline results list, so the floating dropdown is
    // turned off to avoid two stacked result surfaces.
    await openOverlay();

    expect(screen.getByTestId("suppress-fts")).toHaveTextContent("true");
  });

  it("drops the redundant active-facet chip row on the narrow sheet", async () => {
    mockUseSearchPanelState.mockReturnValue(
      panelState({ results: [sampleHit()] })
    );

    const user = await openOverlay();
    await user.type(screen.getByRole("textbox", { name: "Search" }), "alpha");

    expect(screen.getByTestId("hide-active-facet-chips")).toHaveTextContent(
      "true"
    );
  });

  it("passes the loading state through to the results list", async () => {
    mockUseSearchPanelState.mockReturnValue(panelState({ isLoading: true }));

    const user = await openOverlay();
    await user.type(screen.getByRole("textbox", { name: "Search" }), "al");

    expect(screen.getByTestId("state")).toHaveTextContent("loading");
  });

  it("passes the error state through to the results list", async () => {
    mockUseSearchPanelState.mockReturnValue(panelState({ isError: true }));

    const user = await openOverlay();
    await user.type(screen.getByRole("textbox", { name: "Search" }), "al");

    expect(screen.getByTestId("state")).toHaveTextContent("error");
    // A generic (non-filter) error must NOT leak into the inline filter banner.
    expect(screen.getByTestId("filter-error")).toHaveTextContent("");
  });

  it("surfaces a malformed-filter 400 as the inline filter message", async () => {
    mockUseSearchPanelState.mockReturnValue(
      panelState({
        isError: true,
        filterErrorMessage: "Unknown priority value: huge",
      })
    );

    const user = await openOverlay();
    await user.type(
      screen.getByRole("textbox", { name: "Search" }),
      "priority:huge"
    );

    expect(screen.getByTestId("filter-error")).toHaveTextContent(
      "Unknown priority value: huge"
    );
  });

  it("toggles a type facet and feeds it back into the query", async () => {
    mockUseSearchPanelState.mockReturnValue(
      panelState({ results: [sampleHit()] })
    );

    const user = await openOverlay();
    await user.type(screen.getByRole("textbox", { name: "Search" }), "alpha");
    await user.click(screen.getByRole("button", { name: "toggle-loop" }));

    expect(screen.getByTestId("active-types")).toHaveTextContent(
      SearchEntityType.Loop
    );
    // The active facet is passed to the hook on the next render.
    const lastCall = mockUseSearchPanelState.mock.calls.at(-1)?.[0] as {
      types: SearchEntityType[];
    };
    expect(lastCall.types).toContain(SearchEntityType.Loop);
  });

  it("carries active facets into the full-search URL on submit and closes", async () => {
    mockUseSearchPanelState.mockReturnValue(
      panelState({ results: [sampleHit()] })
    );

    const user = await openOverlay();
    await user.type(screen.getByRole("textbox", { name: "Search" }), "alpha");
    // Select a facet, then submit — the destination must keep the filter.
    await user.click(screen.getByRole("button", { name: "toggle-loop" }));
    await user.click(screen.getByRole("button", { name: "submit" }));

    expect(navigate).toHaveBeenCalledWith(
      `/acme/search?q=alpha&types=${SearchEntityType.Loop}`
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("navigates to the full search page and closes on submit", async () => {
    const user = await openOverlay();
    await user.type(screen.getByRole("textbox", { name: "Search" }), "alpha");
    await user.click(screen.getByRole("button", { name: "submit" }));

    expect(navigate).toHaveBeenCalledWith("/acme/search?q=alpha");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not navigate on submit of a blank query", async () => {
    const user = await openOverlay();
    await user.type(screen.getByRole("textbox", { name: "Search" }), "   ");
    await user.click(screen.getByRole("button", { name: "submit" }));

    expect(navigate).not.toHaveBeenCalled();
    // A whitespace-only query keeps the pre-search prompt, never a lying empty
    // results state. (Present twice: visible prompt + sr-only description.)
    expect(screen.getAllByText(SEARCH_PROMPT_PATTERN)).toHaveLength(2);
  });

  it("closes the sheet when a typeahead hit is chosen", async () => {
    mockUseSearchPanelState.mockReturnValue(
      panelState({ results: [sampleHit()] })
    );

    const user = await openOverlay();
    await user.type(screen.getByRole("textbox", { name: "Search" }), "alpha");
    await user.click(screen.getByRole("button", { name: "pick-hit" }));

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes the sheet when a result link is activated", async () => {
    // A result whose route is already current wouldn't navigate, so the sheet
    // must close itself on result selection to not sit open over the page.
    mockUseSearchPanelState.mockReturnValue(
      panelState({ results: [sampleHit()] })
    );

    const user = await openOverlay();
    await user.type(screen.getByRole("textbox", { name: "Search" }), "alpha");
    await user.click(screen.getByRole("button", { name: "pick-result" }));

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("resets the query when the sheet is reopened", async () => {
    const user = await openOverlay();
    await user.type(screen.getByRole("textbox", { name: "Search" }), "alpha");
    expect(screen.getByRole("textbox", { name: "Search" })).toHaveValue(
      "alpha"
    );

    // Close via Escape, then reopen — the remount clears the prior query.
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(screen.getByRole("textbox", { name: "Search" })).toHaveValue("");
  });
});
