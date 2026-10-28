import { HELP_COMPLETE_SURFACE_FLAG_KEY } from "@repo/api/src/types/help-complete-surface-flag";
import { HELP_SURFACE_V2_PAGE_ERROR_TEST_ID } from "@repo/app/help/components/help-reader";
import {
  HELP_SURFACE_V2_NAV_INCOMPLETE_TEST_ID,
  HELP_SURFACE_V2_TEST_ID,
  HELP_SURFACE_V2_UNAVAILABLE_TEST_ID,
} from "@repo/app/help/lib/docs-help-test-ids";
import {
  DOCS_HELP_NAV_PATH,
  DOCS_HELP_PAGE_PATH,
  DOCS_HELP_SEARCH_PATH,
} from "@repo/app/help/lib/web-help-contract";
import { LABS_NAV_SECTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebFeatureFlagProvider } from "@/__tests__/helpers/web-feature-flag-provider";
import HelpPage from "../page";

/**
 * ISS-10006 — the web Help route, driven through the REAL
 * `FeatureFlagRouteGate` and the REAL `HelpSurfaceV2`.
 *
 * The transport is the only thing stubbed, because the transport is the only
 * thing web added. The assertion that matters is the one on a FAILED nav read:
 * `navGroups: []` and `bundleStatus: Unavailable` render two different pages,
 * and the first one tells a reader the documentation has no pages.
 */
const { notFoundMock, useFeatureFlagMock } = vi.hoisted(() => ({
  notFoundMock: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  useFeatureFlagMock: vi.fn(),
}));

const { useFeatureFlagsLoadedMock, usePostHogDistinctIdMock } = vi.hoisted(
  () => ({
    useFeatureFlagsLoadedMock: vi.fn(),
    usePostHogDistinctIdMock: vi.fn(),
  })
);

const { useUserMock } = vi.hoisted(() => ({ useUserMock: vi.fn() }));

vi.mock("next/navigation", () => ({ notFound: notFoundMock }));

vi.mock("@repo/analytics/client", () => ({
  postHogFeatureFlagsEnabled: true,
  useFeatureFlag: (flag: string) => useFeatureFlagMock(flag),
  useFeatureFlagsLoaded: () => useFeatureFlagsLoadedMock(),
  usePostHogDistinctId: () => usePostHogDistinctIdMock(),
}));

vi.mock("@repo/auth/client", () => ({ useUser: () => useUserMock() }));

vi.mock("../../../components/header", () => ({
  Header: () => <div>Header chrome</div>,
}));

// The reader pane is a Radix ScrollArea, which observes its own viewport. jsdom
// has no ResizeObserver, and `apps/app`'s setup file carries no shim for it, so
// one is installed here rather than widened into every suite in the app.
class ResizeObserverStub {
  observe() {
    return;
  }
  unobserve() {
    return;
  }
  disconnect() {
    return;
  }
}
globalThis.ResizeObserver ??=
  ResizeObserverStub as unknown as typeof ResizeObserver;

const IDENTIFIED_USER_ID = "user_identified_123";
const NAV_FIXTURE = {
  // Two groups and two pages, so "the corpus is shown" cannot be satisfied by a
  // host that rendered its only row, and the reader can be moved between them.
  navGroups: [
    {
      group: "Mechanisms",
      pages: [
        { group: "Mechanisms", path: "mechanisms/loops", title: "Loops" },
      ],
    },
    {
      group: "Concepts",
      pages: [{ group: "Concepts", path: "concepts/judges", title: "Judges" }],
    },
  ],
};

const PAGE_FIXTURE = {
  body: "Loops run until the work is correct.",
  group: "Mechanisms",
  headings: [
    { level: 2, slug: "ghost-loop-detection", text: "Ghost loop detection" },
  ],
  path: "mechanisms/loops",
  renderBody: "Loops run until the work is correct.\n\n## Ghost loop detection",
  title: "Loops",
};

const HEADING_HIT = {
  excerpt: PAGE_FIXTURE.body,
  group: PAGE_FIXTURE.group,
  headingSlug: "ghost-loop-detection",
  matchField: "heading",
  path: PAGE_FIXTURE.path,
  score: 3,
  title: PAGE_FIXTURE.title,
};

function settledIdentifiedState() {
  useUserMock.mockReturnValue({
    isLoaded: true,
    user: { id: IDENTIFIED_USER_ID },
  });
  useFeatureFlagsLoadedMock.mockReturnValue(true);
  usePostHogDistinctIdMock.mockReturnValue(IDENTIFIED_USER_ID);
}

/**
 * `retry: false` so a 503 settles as a failure in one tick. The production
 * queries already pin it; this keeps a future default change from turning these
 * failure assertions into timeouts.
 */
function renderHelp() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <HelpPage />
    </QueryClientProvider>,
    { wrapper: WebFeatureFlagProvider }
  );
}

function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  vi.stubGlobal("fetch", (input: RequestInfo | URL) =>
    Promise.resolve(handler(String(input)))
  );
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}

describe("web Help route", () => {
  beforeEach(() => {
    notFoundMock.mockClear();
    useFeatureFlagMock.mockReset();
    useFeatureFlagsLoadedMock.mockReset();
    usePostHogDistinctIdMock.mockReset();
    useUserMock.mockReset();
    settledIdentifiedState();
  });

  afterEach(() => {
    // Unconditional, and not the last line of the case that installed them: an
    // assertion that throws in between would otherwise leak a frozen clock into
    // every later test in this worker.
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("404s when the Labs container flag is OFF, whatever the surface key says", () => {
    // Help is a Labs destination on web, so the route carries the container
    // gate as well (tamsinb review). Leaving this URL reachable while the Labs
    // nav is hidden would defeat that gate.
    useFeatureFlagMock.mockImplementation((flag: string) => ({
      enabled: flag === HELP_COMPLETE_SURFACE_FLAG_KEY,
    }));
    stubFetch(() => jsonResponse(NAV_FIXTURE));

    expect(() => renderHelp()).toThrow("NEXT_NOT_FOUND");

    expect(useFeatureFlagMock).toHaveBeenCalledWith(
      LABS_NAV_SECTION_FEATURE_FLAG_KEY
    );
    expect(
      screen.queryByTestId(HELP_SURFACE_V2_TEST_ID)
    ).not.toBeInTheDocument();
  });

  it("404s when help-complete-surface is OFF", () => {
    // The ISOLATING permutation: Labs ON so the outer gate renders its
    // children, and the inner gate is the one committing the 404. With both off
    // the outer gate throws first and this case proves nothing about the key it
    // is named for.
    useFeatureFlagMock.mockImplementation((flag: string) => ({
      enabled: flag === LABS_NAV_SECTION_FEATURE_FLAG_KEY,
    }));
    stubFetch(() => jsonResponse(NAV_FIXTURE));

    expect(() => renderHelp()).toThrow("NEXT_NOT_FOUND");

    expect(useFeatureFlagMock).toHaveBeenCalledWith(
      HELP_COMPLETE_SURFACE_FLAG_KEY
    );
    expect(
      screen.queryByTestId(HELP_SURFACE_V2_TEST_ID)
    ).not.toBeInTheDocument();
  });

  it("mounts the shared surface and shows the corpus when the flag is ON", async () => {
    useFeatureFlagMock.mockReturnValue({ enabled: true });
    const seen: string[] = [];
    stubFetch((url) => {
      seen.push(url);
      return jsonResponse(NAV_FIXTURE);
    });

    renderHelp();

    expect(
      await screen.findByRole("button", { name: "Loops" })
    ).toBeInTheDocument();
    // The read was actually issued: without this the absence assertions below
    // would be satisfied by a host that never asked for anything.
    expect(seen).toContain(DOCS_HELP_NAV_PATH);
    expect(
      screen.queryByTestId(HELP_SURFACE_V2_UNAVAILABLE_TEST_ID)
    ).not.toBeInTheDocument();
  });

  it("reads a 200 that carried no navGroups as an unreadable index, not as an empty one", async () => {
    // whitlockk review: `?? []` here turned a reply nothing could read into a REAL
    // empty tree, which renders "Nothing to browse" — a claim about the corpus
    // that a payload-less reply supports in no way.
    useFeatureFlagMock.mockReturnValue({ enabled: true });
    stubFetch(() => jsonResponse({}));

    renderHelp();

    expect(
      await screen.findByTestId(HELP_SURFACE_V2_NAV_INCOMPLETE_TEST_ID)
    ).toHaveTextContent("The docs index couldn't be read");
  });

  it("still reads a 200 carrying an EMPTY navGroups array as an empty index", async () => {
    // The paired positive on the same locator: an index that genuinely lists
    // nothing must NOT borrow the unreadable sentence, or the fix above would
    // just move the false claim to the other side.
    useFeatureFlagMock.mockReturnValue({ enabled: true });
    stubFetch(() => jsonResponse({ navGroups: [] }));

    renderHelp();

    expect(
      await screen.findByText(
        "No documentation sections came back with this response."
      )
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId(HELP_SURFACE_V2_NAV_INCOMPLETE_TEST_ID)
    ).not.toBeInTheDocument();
  });

  it("does not answer a query nothing has searched yet with 'No results'", async () => {
    // tamsinb review: `isFetching` is FALSE for the whole debounce window —
    // the old key has settled and the new one does not exist yet — so the pane
    // used to render `No results for "<the new query>"`, a claim about a corpus
    // nothing searched for that string. Exactly what `searchFailed` exists to
    // stop, one state over.
    useFeatureFlagMock.mockReturnValue({ enabled: true });
    stubFetch((url) =>
      url.startsWith(DOCS_HELP_SEARCH_PATH)
        ? jsonResponse({ hits: [] })
        : jsonResponse(NAV_FIXTURE)
    );

    renderHelp();
    const box = await screen.findByLabelText("Search documentation");

    // Phase one on the REAL clock, so the query genuinely settles. The settled
    // answer for a query that DID run is the paired positive: without it the
    // assertion below would pass on a pane that never says this at all.
    fireEvent.change(box, { target: { value: "aaa" } });
    expect(
      await screen.findByText('No results for "aaa".')
    ).toBeInTheDocument();

    // Phase two on a FROZEN clock, which is what holds the render inside the
    // debounce window: the new key has not been created, so `isFetching` is
    // false and nothing but the window itself can report the searching state.
    vi.useFakeTimers();
    fireEvent.change(box, { target: { value: "aaab" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByText("Searching…")).toBeInTheDocument();
    expect(
      screen.queryByText('No results for "aaab".')
    ).not.toBeInTheDocument();
  });

  it("reports a failed nav read as unavailable, not as a docs set with no pages", async () => {
    useFeatureFlagMock.mockReturnValue({ enabled: true });
    stubFetch(() => new Response("nope", { status: 503 }));

    renderHelp();

    await waitFor(() => {
      expect(
        screen.getByTestId(HELP_SURFACE_V2_UNAVAILABLE_TEST_ID)
      ).toBeInTheDocument();
    });
    // The paired positive is the test above: the SAME locator is absent when
    // the read succeeds, so this is not an assertion that passes on any render.
    expect(
      screen.queryByRole("button", { name: "Loops" })
    ).not.toBeInTheDocument();
  });

  it("adds no second page heading around the reader's own h1", async () => {
    useFeatureFlagMock.mockReturnValue({ enabled: true });
    stubFetch((url) =>
      url.startsWith(DOCS_HELP_PAGE_PATH)
        ? jsonResponse({ page: PAGE_FIXTURE })
        : jsonResponse(NAV_FIXTURE)
    );

    renderHelp();

    // The reader's `h1` is the page title. The host opens on the first navigable
    // page, so this is the loaded state a second page heading would show up in —
    // not the idle pane, where neither heading exists and the count is vacuous.
    const headings = await screen.findAllByRole("heading", { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent("Loops");
  });

  it("shows every group it was given, not only the first", async () => {
    useFeatureFlagMock.mockReturnValue({ enabled: true });
    stubFetch((url) =>
      url.startsWith(DOCS_HELP_PAGE_PATH)
        ? jsonResponse({ page: PAGE_FIXTURE })
        : jsonResponse(NAV_FIXTURE)
    );

    renderHelp();

    expect(await screen.findByRole("button", { name: "Loops" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Judges" })).toBeVisible();
  });

  it("keeps 'no such page' apart from 'the read failed'", async () => {
    useFeatureFlagMock.mockReturnValue({ enabled: true });
    stubFetch((url) =>
      url.startsWith(DOCS_HELP_PAGE_PATH)
        ? new Response("gone", { status: 404 })
        : jsonResponse(NAV_FIXTURE)
    );

    const { unmount } = renderHelp();
    expect(
      await screen.findByRole("heading", { name: "Page not found" })
    ).toBeVisible();
    expect(
      screen.queryByTestId(HELP_SURFACE_V2_PAGE_ERROR_TEST_ID)
    ).not.toBeInTheDocument();
    unmount();

    // Same route, same click, a different status — and a different page. The
    // paired positive is above: each locator is present in exactly one of them.
    stubFetch((url) =>
      url.startsWith(DOCS_HELP_PAGE_PATH)
        ? new Response("nope", { status: 503 })
        : jsonResponse(NAV_FIXTURE)
    );
    renderHelp();
    expect(
      await screen.findByTestId(HELP_SURFACE_V2_PAGE_ERROR_TEST_ID)
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "Page not found" })
    ).not.toBeInTheDocument();
  });

  it("scrolls the heading a search hit promised into view", async () => {
    useFeatureFlagMock.mockReturnValue({ enabled: true });
    stubFetch((url) => {
      if (url.startsWith(DOCS_HELP_SEARCH_PATH)) {
        return jsonResponse({ hits: [HEADING_HIT] });
      }
      return url.startsWith(DOCS_HELP_PAGE_PATH)
        ? jsonResponse({ page: PAGE_FIXTURE })
        : jsonResponse(NAV_FIXTURE);
    });
    const scrollIntoView = vi.fn();
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(
      scrollIntoView
    );

    renderHelp();
    await userEvent.type(
      await screen.findByLabelText("Search documentation"),
      "ghost"
    );
    const results = await screen.findByRole("list", {
      name: "Search results",
    });
    await userEvent.click(within(results).getByText(PAGE_FIXTURE.title));

    // The ANCHOR is stamped on every heading whether or not a hit named one, so
    // asserting it exists proves nothing about the deep link. What only the
    // deep link produces is the reader scrolling to it.
    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalled();
    });
    expect(
      (scrollIntoView.mock.instances[0] as HTMLElement | undefined)?.id
    ).toBe("ghost-loop-detection");
  });
});
