import { DOCUMENT_ROUTE_PREFIX } from "@repo/api/src/types/document";
import {
  OFFERED_SEARCH_ENTITY_TYPES,
  SearchEntityType,
} from "@repo/api/src/types/search-entity-kind";
import {
  type OfferedSearchHit,
  SEARCH_ENTITY_TYPE_LABELS,
} from "@repo/app/search/lib/search-display";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

// Mock the navigation port's Link to avoid a NavigationProvider in the test.
vi.mock("@repo/navigation/link", () => ({
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("@repo/navigation/use-org-path", () => ({
  useOrgPath: () => (orgRelativePath: string) => `/acme${orgRelativePath}`,
}));

import { UnifiedSearchResults } from "../unified-search-results";

const RE_ALPHA_DOC = /Alpha doc/;
const RE_ALPHA_PROJECT = /Alpha project/;
const RE_SEARCH_ERROR = /Couldn't load results/;
const RE_REMOVE_FILTER = /Remove .* filter/;
const ACTIVE_TYPE_FILTERS = "Active type filters";
// The "no results" empty state, matched by BOTH its title and its description so
// renaming either one still trips the assertion rather than passing vacuously.
const RE_NO_RESULTS = /No results|Nothing matched your query/;

function hit(overrides: Partial<OfferedSearchHit> = {}): OfferedSearchHit {
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

function renderResults(
  overrides: Partial<Parameters<typeof UnifiedSearchResults>[0]> = {}
) {
  const onToggleType = vi.fn();
  render(
    <UnifiedSearchResults
      activeTypes={[]}
      isError={false}
      isLoading={false}
      onToggleType={onToggleType}
      results={[hit()]}
      {...overrides}
    />
  );
  return { onToggleType };
}

describe("UnifiedSearchResults", () => {
  it("renders each hit with an org-scoped deep link, type chip and highlighted snippet", () => {
    renderResults({
      results: [
        hit({
          title: "Alpha project",
          entityType: SearchEntityType.Project,
          entityId: "proj-1",
          teamId: "team-1",
          snippet: "run the <b>alpha</b> project",
        }),
      ],
    });

    const link = screen.getByRole("link", { name: RE_ALPHA_PROJECT });
    expect(link).toHaveAttribute("href", "/acme/teams/team-1/projects/proj-1");

    // The highlighted token is wrapped in a <mark>.
    const mark = screen.getByText("alpha");
    expect(mark.tagName).toBe("MARK");
  });

  it("renders a facet chip per offered type and toggles on click", async () => {
    const user = userEvent.setup();
    const { onToggleType } = renderResults();

    await user.click(screen.getByRole("button", { name: "Document" }));

    expect(onToggleType).toHaveBeenCalledWith(SearchEntityType.Document);
  });

  it("marks the active facet as pressed", () => {
    renderResults({ activeTypes: [SearchEntityType.Project] });

    expect(screen.getByRole("button", { name: "Project" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.getByRole("button", { name: "Document" })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
  });

  it("renders every facet as pressed when no filter is active (empty means all)", () => {
    renderResults({ activeTypes: [] });

    for (const label of ["Document", "Project"]) {
      expect(screen.getByRole("button", { name: label })).toHaveAttribute(
        "aria-pressed",
        "true"
      );
    }
  });

  // PRD-795: the retired Loop kind is accepted by the API but never offered.
  it("offers no facet chip for a kind that is not offered", () => {
    renderResults();

    const facets = screen.getByRole("group", {
      name: "Filter results by type",
    });
    expect(facets.querySelectorAll("button")).toHaveLength(
      OFFERED_SEARCH_ENTITY_TYPES.length
    );
  });

  it("renders no active filter group when only a retired kind is active", () => {
    renderResults({ activeTypes: [SearchEntityType.Project] });
    expect(
      screen.getByRole("group", { name: ACTIVE_TYPE_FILTERS })
    ).toBeInTheDocument();
    cleanup();

    renderResults({ activeTypes: [SearchEntityType.Loop] });

    expect(
      screen.queryByRole("group", { name: ACTIVE_TYPE_FILTERS })
    ).not.toBeInTheDocument();
  });
  it("renders a document hit with slug + subtype as a type-and-slug link", () => {
    renderResults({
      results: [
        hit({
          title: "Alpha doc",
          entityType: SearchEntityType.Document,
          entitySubtype: "PRD",
          slug: "alpha-doc",
        }),
      ],
    });

    expect(screen.getByRole("link", { name: RE_ALPHA_DOC })).toHaveAttribute(
      "href",
      `/acme/${DOCUMENT_ROUTE_PREFIX}/alpha-doc`
    );
  });

  it("renders a project hit with an owning team as a team-scoped link", () => {
    renderResults({
      results: [
        hit({
          title: "Alpha project",
          entityType: SearchEntityType.Project,
          entityId: "proj-1",
          teamId: "team-1",
        }),
      ],
    });

    expect(
      screen.getByRole("link", { name: RE_ALPHA_PROJECT })
    ).toHaveAttribute("href", "/acme/teams/team-1/projects/proj-1");
  });

  it("renders a hit missing route data (document without slug) as a plain non-link row", () => {
    renderResults({
      results: [
        hit({
          title: "Orphan doc",
          entityType: SearchEntityType.Document,
          entitySubtype: "PRD",
          // No slug → cannot build a safe route.
        }),
      ],
    });

    // The title still renders, but there is no link that would 404.
    expect(screen.getByText("Orphan doc")).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("renders an empty state when there are no results", () => {
    renderResults({ results: [] });

    expect(screen.getByText("No results")).toBeInTheDocument();
  });

  it("renders an error state instead of a spinner", () => {
    renderResults({ results: [], isError: true });

    expect(screen.getByText(RE_SEARCH_ERROR)).toBeInTheDocument();
  });

  it("renders a retry affordance and calls onRetry when provided (FEA-4134)", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    renderResults({ results: [], isError: true, onRetry });

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("omits the retry button in the error state when no onRetry is wired", () => {
    renderResults({ results: [], isError: true });

    expect(screen.getByText(RE_SEARCH_ERROR)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("hides the type-facet strip and active-facet chips when hideTypeFacets is set (FEA-4134)", () => {
    renderResults({
      activeTypes: [SearchEntityType.Project],
      hideTypeFacets: true,
    });

    // Neither the picker chip nor the removable active-facet chip renders.
    expect(
      screen.queryByRole("button", {
        name: SEARCH_ENTITY_TYPE_LABELS[SearchEntityType.Document],
      })
    ).toBeNull();
    expect(screen.queryByRole("button", { name: RE_REMOVE_FILTER })).toBeNull();
  });

  it("renders a loading spinner while fetching", () => {
    renderResults({ results: [], isLoading: true });

    expect(screen.getByLabelText("Loading search results")).toBeInTheDocument();
  });

  it("renders active facets as removable chips and removes on click", async () => {
    const user = userEvent.setup();
    const { onToggleType } = renderResults({
      activeTypes: [SearchEntityType.Project],
    });

    // The removable chip carries the accessible "Remove <label> filter" name.
    await user.click(
      screen.getByRole("button", { name: "Remove Project filter" })
    );
    expect(onToggleType).toHaveBeenCalledWith(SearchEntityType.Project);
  });

  it("does not render the removable-chip row when no facet is active", () => {
    renderResults({ activeTypes: [] });

    expect(screen.queryByRole("button", { name: RE_REMOVE_FILTER })).toBeNull();
  });

  it("surfaces a malformed-filter message inline instead of the generic error", () => {
    renderResults({
      results: [],
      isError: true,
      filterErrorMessage: "Unknown priority value: huge",
    });

    // The specific, safe-to-show reason is shown as an alert.
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Unknown priority value: huge"
    );
    // The generic error copy is suppressed when the specific message is shown.
    expect(screen.queryByText(RE_SEARCH_ERROR)).toBeNull();
    // ...and so is the empty state (ISS-4665). An empty `results` beside a
    // filter message is the ONLY shape the hook produces for a 400 — the
    // rejected query gets a fresh key that never resolves to data — so this is
    // the branch a real user lands on, and "No results" there blames the corpus
    // for a query the server refused to run.
    expect(screen.queryAllByText(RE_NO_RESULTS)).toHaveLength(0);
  });
});
