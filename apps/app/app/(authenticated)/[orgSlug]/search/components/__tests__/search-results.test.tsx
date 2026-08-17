import type {
  GlobalSearchResponse,
  SearchHit,
} from "@repo/api/src/types/search";
import { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import type { SearchPanelState } from "@repo/app/search/hooks/use-search";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { SearchResults } from "../search-results";

const RE_ALPHA_LOOP = /Alpha loop/;
const RE_SEARCH_ERROR = /Couldn't load results/;
// Matches the count strip in BOTH the singular and plural forms. `/result for/`
// alone silently missed every plural line ("0 results for …"), which let the
// count-suppression guard below pass with the guard deleted (ISS-4665).
const RE_RESULT_FOR = /results? for/;
const RE_TRY_AGAIN = /Try again/i;
// The "no results" empty state, matched by BOTH its title and its description so
// renaming either one still trips the assertion rather than passing vacuously.
const RE_NO_RESULTS = /No results|Nothing matched your query/;

const routerReplaceMock = vi.fn();
const useGlobalSearchMock = vi.fn();
const useSearchPanelStateMock = vi.fn();

let searchParams = new URLSearchParams("q=alpha");

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

// The redesigned panel hosts the shared intellisense-aware SearchTypeahead
// (FEA-4134), which needs auth/query providers not mounted in this unit test —
// it has its own coverage. Mock it to a plain controlled input that surfaces
// the value + onSubmit/onValueChange so the panel's query wiring is testable.
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

// The panel consumes the shared `useSearchPanelState` (which internally runs the
// unified query and classifies the 400 filter error); mock that seam and keep
// the legacy `useGlobalSearch` for tag search. The 400-vs-other classification
// is covered directly in `use-search`'s is-search-filter-error test.
vi.mock("@repo/app/search/hooks/use-search", async () => {
  const actual = await vi.importActual<
    typeof import("@repo/app/search/hooks/use-search")
  >("@repo/app/search/hooks/use-search");
  return {
    ...actual,
    useGlobalSearch: (...args: unknown[]) => useGlobalSearchMock(...args),
    useSearchPanelState: (...args: unknown[]) =>
      useSearchPanelStateMock(...args),
  };
});

describe("SearchResults", () => {
  beforeEach(() => {
    searchParams = new URLSearchParams("q=alpha");
    routerReplaceMock.mockClear();
    useGlobalSearchMock.mockReset();
    useSearchPanelStateMock.mockReset();
    useSearchPanelStateMock.mockReturnValue(panelState());
  });

  test("runs unified FTS search off the URL query and renders the count strip", () => {
    useSearchPanelStateMock.mockReturnValue(panelState({ results: [hit()] }));

    render(<SearchResults />);

    // FEA-4134: the query string (including any inline type: tokens) is the sole
    // input — no separate types[] param is passed.
    expect(useSearchPanelStateMock).toHaveBeenCalledWith({ query: "alpha" });
    // The strip renders the count twice: the visible line + an sr-only aria-live
    // region announcing the change.
    expect(screen.getAllByText('1 result for "alpha"').length).toBe(2);
    expect(useGlobalSearchMock).not.toHaveBeenCalled();
  });

  test("shows an N+ count when the response carries a nextCursor (more pages)", () => {
    useSearchPanelStateMock.mockReturnValue(
      panelState({ results: [hit()], nextCursor: "cursor-2" })
    );

    render(<SearchResults />);

    // Only one hit is on screen, but nextCursor means more exist — the headline
    // must not claim "1 result" is the full total. (Rendered twice: visible +
    // sr-only aria-live.)
    expect(screen.getAllByText('1+ results for "alpha"').length).toBe(2);
    expect(screen.queryByText('1 result for "alpha"')).toBeNull();
  });

  test("renders a cross-entity hit with its type, snippet, and deep link", () => {
    useSearchPanelStateMock.mockReturnValue(
      panelState({
        results: [
          hit({
            title: "Alpha loop",
            snippet: "run the <b>alpha</b> loop",
            entityType: SearchEntityType.Loop,
            // The Loop route is built from `entityId` (id-keyed), so the id must
            // match the asserted `/loops/loop-1` route, not the default doc id.
            entityId: "loop-1",
            deepLink: "/loops/loop-1",
          }),
        ],
      })
    );

    render(<SearchResults />);

    // The hit's meta line names its type; the in-list type-facet strip is hidden
    // on this surface (the query bar's Type control owns kind filtering).
    expect(screen.getByText("Loop")).toBeInTheDocument();
    expect(screen.getByText("alpha")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: RE_ALPHA_LOOP })).toHaveAttribute(
      "href",
      "/acme/loops/loop-1"
    );
  });

  test("submitting the query bar commits the raw query to the URL q param", async () => {
    const user = userEvent.setup();

    render(<SearchResults />);

    const input = screen.getByRole("textbox", { name: "Search query" });
    await user.clear(input);
    await user.type(input, "beta type:loop{Enter}");

    expect(routerReplaceMock).toHaveBeenLastCalledWith(
      "/acme/search?q=beta+type%3Aloop",
      { scroll: false }
    );
  });

  test("lands the empty on-ramp (not a request) when the query is below the floor", () => {
    searchParams = new URLSearchParams("q=");

    render(<SearchResults />);

    expect(screen.getByText("Search everything")).toBeInTheDocument();
    // The count strip only renders once the query clears the 2-char floor.
    expect(screen.queryByText(RE_RESULT_FOR)).toBeNull();
  });

  test("renders an error state without leaving a spinner", () => {
    useSearchPanelStateMock.mockReturnValue(panelState({ isError: true }));

    render(<SearchResults />);

    expect(screen.getByText(RE_SEARCH_ERROR)).toBeInTheDocument();
  });

  test("surfaces a malformed-filter 400 message inline for the user to fix", () => {
    // The shared hook classifies a 400 and hands the panel its safe-to-show
    // message; the panel renders it verbatim so the user can correct the query.
    useSearchPanelStateMock.mockReturnValue(
      panelState({
        isError: true,
        filterErrorMessage: "Unknown priority value: huge",
      })
    );

    render(<SearchResults />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Unknown priority value: huge"
    );
    // The generic error copy is suppressed when the specific reason is shown.
    expect(screen.queryByText(RE_SEARCH_ERROR)).toBeNull();
  });

  test("shows the generic error copy for a non-filter failure", () => {
    // A non-400 (auth/5xx) failure yields no filter message, so the panel shows
    // only the generic error copy — never a leaked auth/500 message as a banner.
    useSearchPanelStateMock.mockReturnValue(
      panelState({ isError: true, filterErrorMessage: undefined })
    );

    render(<SearchResults />);

    expect(screen.getByText(RE_SEARCH_ERROR)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("retries the failed query via refetch, not a same-URL replace", async () => {
    const user = userEvent.setup();
    const refetch = vi.fn();
    useSearchPanelStateMock.mockReturnValue(
      panelState({ isError: true, refetch })
    );

    render(<SearchResults />);

    await user.click(screen.getByRole("button", { name: RE_TRY_AGAIN }));

    // A same-URL router.replace would not re-invoke the query (the key is
    // unchanged); the retry must call the hook's refetch instead.
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(routerReplaceMock).not.toHaveBeenCalled();
  });

  test("suppresses the result-count strip while an error is active", () => {
    // A failed query returned no set, so a "0 results" line beside the error
    // banner would lie about state — the strip must not render.
    useSearchPanelStateMock.mockReturnValue(panelState({ isError: true }));

    render(<SearchResults />);

    expect(screen.getByText(RE_SEARCH_ERROR)).toBeInTheDocument();
    expect(screen.queryAllByText(RE_RESULT_FOR)).toHaveLength(0);
  });

  test("makes no result claim beside a filter error — no count, no empty state", () => {
    // ISS-4665 in its PRODUCTION shape. A malformed filter 400s, and
    // `useUnifiedSearch` keys the query by its string, so the rejected query
    // gets a fresh key that never resolves to data: `results` is EMPTY every
    // time this state is reached (no placeholderData/previous-data retention on
    // that query). So the panel is asserted against an empty producer, and must
    // make no claim about a set it never received — neither a count (visible
    // line AND aria-live, hence every matching node) nor "No results", which
    // blames the corpus for a query the server refused to run.
    useSearchPanelStateMock.mockReturnValue(
      panelState({
        isError: true,
        filterErrorMessage: "Unknown priority value: huge",
      })
    );

    render(<SearchResults />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Unknown priority value: huge"
    );
    expect(screen.queryAllByText(RE_RESULT_FOR)).toHaveLength(0);
    expect(screen.queryAllByText(RE_NO_RESULTS)).toHaveLength(0);
  });

  test("forwards a legacy ?types= param as an inline type: token and normalizes the URL", () => {
    // A bookmark/shared link from the previous UI carried the entity filter as
    // `?types=loop`; the panel must fold it into the query so the filter is not
    // silently dropped, and rewrite the URL to the new `type:`-token grammar.
    searchParams = new URLSearchParams("q=alpha&types=loop");
    useSearchPanelStateMock.mockReturnValue(panelState({ results: [hit()] }));

    render(<SearchResults />);

    expect(useSearchPanelStateMock).toHaveBeenCalledWith({
      query: "alpha type:loop",
    });
    expect(routerReplaceMock).toHaveBeenCalledWith(
      "/acme/search?q=alpha+type%3Aloop",
      { scroll: false }
    );
  });

  test("renders the tag search summary using the legacy hook", () => {
    searchParams = new URLSearchParams("tagId=tag-123");
    useGlobalSearchMock.mockReturnValue({
      data: globalResponse({
        query: "",
        tagId: "tag-123",
        tagName: "Urgent",
      }),
      isLoading: false,
    });

    render(<SearchResults />);

    expect(useGlobalSearchMock).toHaveBeenCalledWith({ tagId: "tag-123" });
    expect(useSearchPanelStateMock).not.toHaveBeenCalled();
    expect(
      screen.getByText('0 results tagged with "Urgent"')
    ).toBeInTheDocument();
  });

  test("clears text results to the empty on-ramp (not away to my tasks)", async () => {
    const user = userEvent.setup();
    useSearchPanelStateMock.mockReturnValue(panelState({ results: [hit()] }));

    render(<SearchResults />);

    await user.click(screen.getByRole("button", { name: "Clear search" }));

    // The count-strip Clear empties the query and drops `q`, landing the empty
    // on-ramp — the same destination as the query bar's own clear, so the two
    // clears on this screen do one thing (they no longer navigate to my-tasks).
    expect(routerReplaceMock).toHaveBeenCalledWith("/acme/search", {
      scroll: false,
    });
    expect(routerReplaceMock).not.toHaveBeenCalledWith("/acme/my-tasks", {
      scroll: false,
    });
  });

  test("clears tag results back to my tasks", async () => {
    searchParams = new URLSearchParams("tagId=tag-123");
    useGlobalSearchMock.mockReturnValue({
      data: globalResponse({ query: "", tagId: "tag-123", tagName: "Urgent" }),
      isLoading: false,
    });
    const user = userEvent.setup();

    render(<SearchResults />);

    await user.click(screen.getByRole("button", { name: "Clear search" }));

    expect(routerReplaceMock).toHaveBeenCalledWith("/acme/my-tasks", {
      scroll: false,
    });
  });
});

function globalResponse(
  overrides: Partial<GlobalSearchResponse>
): GlobalSearchResponse {
  return {
    documents: [],
    projects: [],
    query: "",
    ...overrides,
  };
}

function panelState(
  overrides: Partial<SearchPanelState> = {}
): SearchPanelState {
  return {
    results: [],
    isLoading: false,
    isError: false,
    filterErrorMessage: undefined,
    nextCursor: null,
    refetch: vi.fn(),
    ...overrides,
  };
}

function hit(overrides: Partial<SearchHit> = {}): SearchHit {
  return {
    entityType: SearchEntityType.Document,
    entityId: "doc-1",
    title: "Alpha doc",
    snippet: "the <b>alpha</b> doc",
    rank: 0.5,
    updatedAt: new Date("2026-01-01"),
    deepLink: "/documents/doc-1",
    ...overrides,
  };
}
