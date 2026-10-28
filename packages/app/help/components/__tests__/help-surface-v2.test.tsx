/**
 * ISS-10005 — `HelpSurfaceV2` owns the nav tree, search within the docs, the
 * reader, and the state ladder, and refuses a payload that would unwind it.
 *
 * Every query is scoped to the surface's OWN root: the superseded desktop body
 * composes the very same `HelpNavPane` and `HelpReader`, so an unscoped
 * `getByText("Overview")` passes against the code this ticket replaces.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type {
  DocsHelpNavGroup,
  DocsHelpPage,
} from "../../lib/docs-help-payload";
import {
  DocsHelpBundleStatus,
  type DocsHelpPageState,
  type DocsHelpSource,
} from "../../lib/docs-help-source";
import { HELP_SURFACE_V2_SEARCH_FAILED_TEST_ID } from "../../lib/docs-help-test-ids";
import { HELP_SURFACE_V2_PAGE_ERROR_TEST_ID } from "../help-reader";
import { HelpSurfaceV2 } from "../help-surface-v2";

// react-markdown + the syntax highlighter are slow and are not what this suite
// is about; render the body as plain text.
vi.mock(
  "@repo/design-system/components/ui/primitives/markdown-content",
  () => ({
    MarkdownContent: ({ text }: { text: string }) => (
      <div data-testid="markdown-body">{text}</div>
    ),
  })
);

// ISS-10006 — the corpus sentences are host-supplied, so this suite picks a
// host. Deliberately NOT the real desktop strings: every assertion here is on a
// state, a title or a locator the SURFACE owns, so a test that matched on a
// host's sentence would be asserting the host.
const TEST_CORPUS_COPY = {
  corpusUnavailableDetail: "The corpus did not load.",
  corpusUnavailableTitle: "Docs aren't available",
  navEmptyDetail: "No sections came back.",
  pageMissingDetail: "That page is not in this corpus.",
};
const LOOPS_HIT_NAME = /Loops/;
const VIEW_ONLINE_NAME = /View online/;

const NAV_GROUPS: readonly DocsHelpNavGroup[] = [
  {
    group: "Getting Started",
    pages: [
      { path: "getting-started/overview", title: "Overview" },
      { path: "getting-started/api-keys", title: "API keys" },
    ],
  },
  { group: "Concepts", pages: [{ path: "concepts/loops", title: "Loops" }] },
];

const LOOPS_PAGE: DocsHelpPage = {
  path: "concepts/loops",
  title: "Loops",
  headings: [{ level: 2, text: "Lifecycle", slug: "lifecycle" }],
  body: "## Lifecycle\n\nHow a loop runs.",
};

function makeSource(overrides: Partial<DocsHelpSource> = {}): DocsHelpSource {
  return {
    bundleStatus: DocsHelpBundleStatus.Ready,
    docsSiteUrl: "https://closedloop.ai/docs",
    isSearching: false,
    navGroups: NAV_GROUPS,
    onHeadingHandled: vi.fn(),
    onSearchQueryChange: vi.fn(),
    page: { kind: "found", page: LOOPS_PAGE } satisfies DocsHelpPageState,
    pendingHeadingSlug: null,
    searchFailed: false,
    searchHits: [],
    searchQuery: "",
    selectPage: vi.fn(),
    selectedPath: "concepts/loops",
    ...overrides,
  };
}

function renderSurface(overrides: Partial<DocsHelpSource> = {}) {
  const source = makeSource(overrides);
  render(
    <HelpSurfaceV2
      corpusCopy={TEST_CORPUS_COPY}
      slugifyHeading={(text) => text}
      source={source}
    />
  );
  return { source, surface: screen.getByTestId("help-surface-v2") };
}

describe("HelpSurfaceV2 body ownership", () => {
  it("renders the nav tree and the selected page inside its own root", () => {
    const { surface } = renderSurface();

    // Scoped to `surface`: the superseded desktop body emits these same rows.
    // The group HEADING: the malformed cases assert a group name is ABSENT, and
    // without this their locator class is never shown to match anything.
    expect(within(surface).getByText("Getting Started")).toBeInTheDocument();
    expect(
      within(surface).getByRole("button", { name: "Overview" })
    ).toBeInTheDocument();
    expect(
      within(surface).getByRole("button", { name: "Loops" })
    ).toBeInTheDocument();
    expect(
      within(surface).getByRole("heading", { level: 1, name: "Loops" })
    ).toBeInTheDocument();
    expect(within(surface).getByTestId("markdown-body")).toHaveTextContent(
      "How a loop runs."
    );
  });

  it("asks the host to open the page a nav row names", async () => {
    const user = userEvent.setup();
    const { source, surface } = renderSurface();

    await user.click(within(surface).getByRole("button", { name: "API keys" }));

    expect(source.selectPage).toHaveBeenCalledWith("getting-started/api-keys");
  });

  it("swaps the tree for ranked results while a query is typed, and carries a heading hit's anchor", async () => {
    const user = userEvent.setup();
    const { source, surface } = renderSurface({
      searchQuery: "lifecycle",
      searchHits: [
        {
          path: "concepts/loops",
          title: "Loops",
          matchField: "heading",
          score: 9,
          excerpt: "Lifecycle of a loop",
          headingSlug: "lifecycle",
        },
      ],
    });

    // Search MODE is the assertion, not merely "a result exists": the nav tree
    // must be gone, or results and tree would both be on screen.
    expect(within(surface).queryByRole("navigation")).not.toBeInTheDocument();
    const results = within(surface).getByRole("list", {
      name: "Search results",
    });
    expect(within(results).getByText("Section")).toBeInTheDocument();

    await user.click(
      within(results).getByRole("button", { name: LOOPS_HIT_NAME })
    );

    expect(source.selectPage).toHaveBeenCalledWith(
      "concepts/loops",
      "lifecycle"
    );
  });

  it("shows the nav tree, not results, when the query is empty", () => {
    // The positive sibling of the assertion above: without it, a `queryByRole`
    // that matched nothing would satisfy the search-mode test on its own.
    const { surface } = renderSurface();

    expect(
      within(surface).getByRole("navigation", { name: "Documentation" })
    ).toBeInTheDocument();
    expect(
      within(surface).queryByRole("list", { name: "Search results" })
    ).not.toBeInTheDocument();
  });
});

describe("HelpSurfaceV2 state ladder", () => {
  it("distinguishes an unavailable bundle from a bundle with no pages", () => {
    renderSurface({
      bundleStatus: DocsHelpBundleStatus.Unavailable,
      navGroups: [],
    });

    const surface = screen.getByTestId("help-surface-v2");
    expect(
      within(surface).getByTestId("help-surface-v2-unavailable")
    ).toBeInTheDocument();
    expect(
      within(surface).getByRole("link", { name: VIEW_ONLINE_NAME })
    ).toHaveAttribute("href", "https://closedloop.ai/docs");
  });

  it("says a page is not in the bundle without saying the bundle failed", () => {
    const { surface } = renderSurface({ page: { kind: "missing" } });

    expect(within(surface).getByText("Page not found")).toBeInTheDocument();
    // Not-found is not unavailable: the nav is still usable beside it.
    expect(
      within(surface).getByRole("button", { name: "Overview" })
    ).toBeInTheDocument();
    expect(
      within(surface).queryByTestId("help-surface-v2-unavailable")
    ).not.toBeInTheDocument();
    // ISS-10044's positive sibling, and the reason the error assertion below
    // cannot be satisfied by the wrong state: a genuinely absent page keeps its
    // OWN copy and is never dressed as a read that failed.
    expect(
      within(surface).queryByTestId(HELP_SURFACE_V2_PAGE_ERROR_TEST_ID)
    ).not.toBeInTheDocument();
  });

  it("says a page read failed without claiming the bundle lacks the page (ISS-10044)", () => {
    const { surface } = renderSurface({ page: { kind: "error" } });

    expect(
      within(surface).getByTestId(HELP_SURFACE_V2_PAGE_ERROR_TEST_ID)
    ).toBeInTheDocument();
    expect(
      within(surface).getByText("Couldn't load this page")
    ).toBeInTheDocument();
    // The defect verbatim: this sentence is a claim about what the snapshot
    // CONTAINS, and a request that never returned cannot support it.
    expect(
      within(surface).queryByText("Page not found")
    ).not.toBeInTheDocument();
    // A failed page read is not a failed bundle — the tree beside it still works.
    expect(
      within(surface).getByRole("button", { name: "Overview" })
    ).toBeInTheDocument();
    expect(
      within(surface).queryByTestId("help-surface-v2-unavailable")
    ).not.toBeInTheDocument();
  });
});

describe("HelpSurfaceV2 search that could not run (ISS-10044)", () => {
  it("tells a reader their query matched nothing only when it was actually run", () => {
    const { surface } = renderSurface({ searchQuery: "kubernetes" });

    // The positive sibling. Pinned as an independent literal rather than built
    // from the component's own template, and it is what makes the absence
    // assertion below mean something.
    expect(
      within(surface).getByText('No results for "kubernetes".')
    ).toBeInTheDocument();
    expect(
      within(surface).queryByTestId(HELP_SURFACE_V2_SEARCH_FAILED_TEST_ID)
    ).not.toBeInTheDocument();
  });

  it("says the search failed rather than that the docs hold nothing", () => {
    // `isSearching` is ALSO true, so this pins the precedence the nav pane
    // relies on. With `isSearching: false` the "Searching…" assertion below is
    // unreachable copy and passes however the two branches are ordered.
    const { surface } = renderSurface({
      isSearching: true,
      searchFailed: true,
      searchQuery: "kubernetes",
    });

    const failure = within(surface).getByTestId(
      HELP_SURFACE_V2_SEARCH_FAILED_TEST_ID
    );
    expect(
      within(failure).getByText("Couldn't search the docs.")
    ).toBeInTheDocument();
    expect(
      within(surface).queryByText('No results for "kubernetes".')
    ).not.toBeInTheDocument();
    // A settled failure outranks an in-flight read: the search is not still
    // running, and saying so would promise an answer that is not coming.
    expect(within(surface).queryByText("Searching…")).not.toBeInTheDocument();
    // The escape hatch every other dead end on this surface offers. Scoped to
    // the failure body: the reader pane beside it renders one of its own, so an
    // unscoped query passes against a pane that offers nothing.
    expect(
      within(failure).getByRole("link", { name: VIEW_ONLINE_NAME })
    ).toBeInTheDocument();
  });
});

describe("HelpSurfaceV2 loading and idle", () => {
  it("shows a loading bundle as a wait, never as a docs set with no pages", () => {
    renderSurface({
      bundleStatus: DocsHelpBundleStatus.Loading,
      navGroups: [],
      page: { kind: "loading" },
    });

    const surface = screen.getByTestId("help-surface-v2");
    expect(surface).toHaveAttribute("aria-busy");
    // The three claims a still-loading bundle must NOT make, each of which is
    // what this branch collapses into if it is deleted.
    expect(
      within(surface).queryByTestId("help-surface-v2-unavailable")
    ).not.toBeInTheDocument();
    expect(
      within(surface).queryByText("Page not found")
    ).not.toBeInTheDocument();
    expect(
      within(surface).queryByText("Nothing to browse")
    ).not.toBeInTheDocument();
  });

  it("leaves the reader pane blank while nothing has been asked for, and keeps the nav usable", () => {
    const { surface } = renderSurface({ page: { kind: "idle" } });

    // `idle` is not `missing`: nothing has been requested, so claiming the page
    // is absent from the snapshot would send the reader looking for nothing.
    expect(
      within(surface).queryByText("Page not found")
    ).not.toBeInTheDocument();
    expect(
      within(surface).queryByTestId("help-surface-v2-page-malformed")
    ).not.toBeInTheDocument();
    expect(
      within(surface).getByRole("button", { name: "Overview" })
    ).toBeInTheDocument();
  });
});

describe("HelpSurfaceV2 malformed payloads (AC2)", () => {
  it("drops an unreadable nav group and keeps the rest of the tree", () => {
    // A group that predates `pages`: `HelpNavTree` calls `group.pages.map(...)`
    // during render, so unguarded this throws and unwinds the shell.
    const withBrokenGroup = [
      { group: "Reference" },
      ...NAV_GROUPS,
    ] as unknown as readonly DocsHelpNavGroup[];

    const { surface } = renderSurface({ navGroups: withBrokenGroup });

    expect(
      within(surface).getByRole("button", { name: "Overview" })
    ).toBeInTheDocument();
    expect(
      within(surface).getByRole("button", { name: "Loops" })
    ).toBeInTheDocument();
    expect(within(surface).queryByText("Reference")).not.toBeInTheDocument();
    // Degrading is only "without crashing" if the reader survived beside it.
    expect(
      within(surface).getByRole("heading", { level: 1, name: "Loops" })
    ).toBeInTheDocument();
    // A shortened tree is `Partial`: without the claim, a reader who cannot find
    // a page reads the gap as "the docs do not cover it".
    expect(
      within(surface).getByTestId("help-surface-v2-nav-incomplete")
    ).toHaveTextContent("1 section");
  });

  /**
   * marisolashgrove review: an unreadable TREE used to arrive as
   * `refusedGroups: 1` and print "1 section of the docs index couldn't be
   * read" — the most reassuring sentence available for the case where nothing
   * at all could be read. It says what happened now, and says it without a
   * count, because no group survived long enough to be refused.
   */
  it("says the whole index was unreadable, not that one section was", () => {
    const notATree = null as unknown as readonly DocsHelpNavGroup[];

    const { surface } = renderSurface({ navGroups: notATree });

    const notice = within(surface).getByTestId(
      "help-surface-v2-nav-incomplete"
    );
    expect(notice).toHaveTextContent("The docs index couldn't be read");
    expect(notice).not.toHaveTextContent("1 section");
  });

  it("says nothing about refusals when the whole tree was readable", () => {
    // The positive sibling for the notice: it must not appear on a clean tree,
    // or "1 section couldn't be read" becomes wallpaper.
    const { surface } = renderSurface();

    expect(
      within(surface).queryByTestId("help-surface-v2-nav-incomplete")
    ).not.toBeInTheDocument();
  });

  it("offers a way out when no group survives, instead of an empty pane", () => {
    const allRefused = [
      { group: "Reference" },
    ] as unknown as readonly DocsHelpNavGroup[];

    const { surface } = renderSurface({ navGroups: allRefused });

    expect(within(surface).getByText("Nothing to browse")).toBeInTheDocument();
    expect(
      within(surface).getByTestId("help-surface-v2-nav-incomplete")
    ).toBeInTheDocument();
    // The dead end that previously had no escape hatch at all.
    expect(
      within(surface).getAllByRole("link", { name: VIEW_ONLINE_NAME }).length
    ).toBeGreaterThan(0);
  });

  it("refuses a page whose body the markdown pipeline cannot be given", () => {
    const brokenPage = {
      path: "concepts/loops",
      title: "Loops",
      headings: [],
    } as unknown as DocsHelpPage;

    const { surface } = renderSurface({
      page: { kind: "found", page: brokenPage },
    });

    expect(
      within(surface).getByTestId("help-surface-v2-page-malformed")
    ).toBeInTheDocument();
    // Distinct from "Page not found" — the bundle HAS this page.
    expect(
      within(surface).queryByText("Page not found")
    ).not.toBeInTheDocument();
    // The nav beside it is untouched, which is what "degrade" means here.
    expect(
      within(surface).getByRole("button", { name: "Overview" })
    ).toBeInTheDocument();
  });

  it("renders the body, not the malformed notice, for a well-formed page", () => {
    // The positive sibling: without it, a malformed branch that fired on every
    // page would satisfy each assertion above.
    const { surface } = renderSurface();

    expect(
      within(surface).queryByTestId("help-surface-v2-page-malformed")
    ).not.toBeInTheDocument();
    expect(within(surface).getByTestId("markdown-body")).toBeInTheDocument();
  });
});
