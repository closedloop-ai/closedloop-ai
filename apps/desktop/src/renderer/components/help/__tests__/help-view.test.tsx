/**
 * @description Component tests for the desktop two-pane Help view (FEA-3844 /
 * PRD-555 M2). Drives the view off a mocked `window.desktopApi.docsHelp` bridge
 * and asserts:
 *   1. Flag ON → the nav tree (groups → pages) renders and the first page loads
 *      in the reader.
 *   2. Clicking a search hit that matched a heading jumps to that page and
 *      requests its body (search-jump).
 *   3. An unavailable bundle shows the dark "view online" state.
 *
 * ISS-9731 removed the destination-gate cases: this view no longer self-guards,
 * because the shell withdraws the ROUTE (see
 * `renderer/__tests__/labs-route-withdrawal.test.tsx`).
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";

// Feature-flag hook is mocked so each test controls the `docsHelp` gate.
vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: vi.fn(),
}));

// The view reads `?page=&heading=` (the command-palette Docs deep link, M3) via
// the navigation port; mock it so tests control the initial target without
// mounting a NavigationProvider. Defaults to no params (M2 auto-select path).
const searchParamsMock = { current: new URLSearchParams() };
vi.mock("@repo/navigation/use-search-params-value", () => ({
  useSearchParamsValue: () => searchParamsMock.current,
}));

// MarkdownContent pulls in react-markdown + syntax highlighter; render the body
// as plain text so the test stays fast and focused on the view's own behavior.
// A `## slug` line is rendered through the caller's heading `components` so the
// real slug `id` is stamped — the search-jump scroll test relies on that anchor.
const H2_LINE_RE = /^## (.+)$/m;

vi.mock(
  "@closedloop-ai/design-system/components/ui/primitives/markdown-content",
  () => ({
    MarkdownContent: ({
      text,
      components,
    }: {
      text: string;
      components?: { h2?: (props: { children: string }) => ReactElement };
    }) => {
      const heading = H2_LINE_RE.exec(text)?.[1];
      const H2 = components?.h2;
      return (
        <div data-testid="markdown-body">
          {heading && H2 ? <H2>{heading}</H2> : null}
          {text}
        </div>
      );
    },
  })
);

import { DOCS_HELP_SEARCH_FAILED_TITLE } from "@repo/app/help/lib/docs-help-labels";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { HELP_COMPLETE_SURFACE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import type {
  DocsHelpGetPageResult,
  DocsHelpNavResult,
  DocsHelpSearchResult,
  DocsHelpStatus,
} from "../../../../shared/docs-help-contract";
import { HelpView } from "../help-view";

const flagMock = vi.mocked(useFeatureFlagEnabled);

/**
 * PRD-555's destination gates ON, ISS-10005's `help-complete-surface` OFF — the
 * branch this file covers. Written as a key-aware implementation rather than a
 * blanket `true`: a blanket true now resolves the complete-surface key as well
 * and every case below would silently retarget onto `HelpSurfaceV2`, which has
 * its own suite and its own state ladder.
 */
function enableLegacyHelp(): void {
  flagMock.mockImplementation(
    (key: string) => key !== HELP_COMPLETE_SURFACE_FEATURE_FLAG_KEY
  );
}
const LOOPS_HIT_NAME_RE = /Loops/;
const VIEW_ONLINE_NAME_RE = /View online/;
const NO_RESULTS_RE = /No results for/;

const NAV: DocsHelpNavResult = {
  groups: [
    {
      group: "Getting Started",
      pages: [
        {
          path: "getting-started/overview",
          title: "Overview",
          group: "Getting Started",
        },
        {
          path: "getting-started/api-keys",
          title: "API keys",
          group: "Getting Started",
        },
      ],
    },
    {
      group: "Concepts",
      pages: [{ path: "concepts/loops", title: "Loops", group: "Concepts" }],
    },
  ],
};

const STATUS: DocsHelpStatus = {
  available: true,
  sourceCommit: "abc123",
  generatedAt: new Date(0).toISOString(),
  pageCount: 3,
  docsSiteUrl: "https://closedloop.ai/docs",
};

function pageResult(path: string, title: string): DocsHelpGetPageResult {
  return {
    kind: "found",
    page: {
      path,
      title,
      headings: [{ level: 2, text: "Lifecycle", slug: "lifecycle" }],
      body: `## Lifecycle\n\nBody of ${title}.`,
    },
  };
}

type DocsHelpApiMock = {
  status: ReturnType<typeof vi.fn>;
  nav: ReturnType<typeof vi.fn>;
  getPage: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
};

let originalDesktopApi: PropertyDescriptor | undefined;
// jsdom does not implement scrollIntoView; the reader calls it on a heading
// anchor after a search-jump. Stub it per-test so the reader can scroll, and
// record which element id it targeted (the cross-page-jump test asserts on it).
let scrollIntoViewSpy: Mock<(id: string) => void>;
let originalScrollIntoView: PropertyDescriptor | undefined;

function installDocsHelp(
  overrides: Partial<DocsHelpApiMock> = {}
): DocsHelpApiMock {
  const api: DocsHelpApiMock = {
    status: vi.fn(async () => STATUS),
    nav: vi.fn(async () => NAV),
    getPage: vi.fn(async (path: string) =>
      pageResult(path, path.split("/").at(-1) ?? path)
    ),
    search: vi.fn(
      async (): Promise<DocsHelpSearchResult> => ({ query: "", hits: [] })
    ),
    ...overrides,
  };
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: { docsHelp: api },
  });
  return api;
}

beforeEach(() => {
  originalDesktopApi = Object.getOwnPropertyDescriptor(window, "desktopApi");
  searchParamsMock.current = new URLSearchParams();
  originalScrollIntoView = Object.getOwnPropertyDescriptor(
    window.HTMLElement.prototype,
    "scrollIntoView"
  );
  scrollIntoViewSpy = vi.fn<(id: string) => void>();
  Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value(this: HTMLElement) {
      scrollIntoViewSpy(this.id);
    },
  });
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalScrollIntoView) {
    Object.defineProperty(
      window.HTMLElement.prototype,
      "scrollIntoView",
      originalScrollIntoView
    );
  } else {
    Reflect.deleteProperty(window.HTMLElement.prototype, "scrollIntoView");
  }
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
});

describe("desktop HelpView, help-complete-surface OFF (FEA-3844)", () => {
  it("renders the meta.json nav tree and loads the first page when the flag is on", async () => {
    enableLegacyHelp();
    installDocsHelp();
    render(<HelpView />);

    // Nav groups + pages from the mocked nav() IPC.
    await screen.findByText("Getting Started");
    expect(screen.getByRole("button", { name: "Overview" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "API keys" })).toBeTruthy();
    expect(screen.getByText("Concepts")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Loops" })).toBeTruthy();

    // First navigable page auto-loads in the reader.
    await waitFor(() =>
      expect(screen.getByTestId("markdown-body").textContent).toContain(
        "Body of overview"
      )
    );
  });

  it("jumps to a page + heading anchor from a search hit (search-jump)", async () => {
    enableLegacyHelp();
    const api = installDocsHelp({
      search: vi.fn(
        async (): Promise<DocsHelpSearchResult> => ({
          query: "lifecycle",
          hits: [
            {
              path: "concepts/loops",
              title: "Loops",
              group: "Concepts",
              matchField: "heading",
              score: 20,
              excerpt: "A loop lifecycle…",
              headingSlug: "lifecycle",
            },
          ],
        })
      ),
    });
    render(<HelpView />);
    await screen.findByText("Getting Started");

    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search documentation" }),
      { target: { value: "lifecycle" } }
    );

    // The ranked hit renders (after the debounced search); clicking it fetches
    // that page's body.
    const hit = await screen.findByRole("button", { name: LOOPS_HIT_NAME_RE });
    fireEvent.click(hit);

    await waitFor(() =>
      expect(api.getPage).toHaveBeenCalledWith("concepts/loops")
    );
    await waitFor(() =>
      expect(screen.getByTestId("markdown-body").textContent).toContain(
        "Body of loops"
      )
    );
  });

  it("opens the page from a ?page=&heading= deep link (command-palette Docs pick, M3)", async () => {
    enableLegacyHelp();
    searchParamsMock.current = new URLSearchParams({
      page: "concepts/loops",
      heading: "lifecycle",
    });
    const api = installDocsHelp();
    render(<HelpView />);

    await screen.findByText("Getting Started");

    // The deep-linked page is selected over the default first page.
    await waitFor(() =>
      expect(api.getPage).toHaveBeenCalledWith("concepts/loops")
    );
    await waitFor(() =>
      expect(screen.getByTestId("markdown-body").textContent).toContain(
        "Body of loops"
      )
    );
    // The heading anchor from the deep link is scrolled to once the page renders.
    await waitFor(() =>
      expect(scrollIntoViewSpy).toHaveBeenCalledWith("lifecycle")
    );
  });

  it("scrolls to the heading on the TARGET page after a cross-page search-jump (not the stale page)", async () => {
    enableLegacyHelp();
    installDocsHelp({
      // Page A carries a DIFFERENT heading ("overview") than the jump target's
      // "lifecycle", so a scroll against the stale page A would be observable as
      // the wrong id (and would consume the slug before page B renders).
      getPage: vi.fn(
        async (path: string): Promise<DocsHelpGetPageResult> => ({
          kind: "found",
          page: {
            path,
            title: path.split("/").at(-1) ?? path,
            headings: [],
            body:
              path === "concepts/loops"
                ? "## Lifecycle\n\nBody of loops."
                : "## Overview\n\nBody of overview.",
          },
        })
      ),
      search: vi.fn(
        async (): Promise<DocsHelpSearchResult> => ({
          query: "lifecycle",
          hits: [
            {
              path: "concepts/loops",
              title: "Loops",
              group: "Concepts",
              matchField: "heading",
              score: 20,
              excerpt: "A loop lifecycle…",
              headingSlug: "lifecycle",
            },
          ],
        })
      ),
    });
    render(<HelpView />);
    // Page A (overview) auto-loads first; its own anchor must not be scrolled to
    // just because a jump to a DIFFERENT page was requested.
    await waitFor(() =>
      expect(screen.getByTestId("markdown-body").textContent).toContain(
        "Body of overview"
      )
    );

    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search documentation" }),
      { target: { value: "lifecycle" } }
    );
    const hit = await screen.findByRole("button", { name: LOOPS_HIT_NAME_RE });
    fireEvent.click(hit);

    // Once the target page renders, the reader scrolls to its heading anchor.
    await waitFor(() =>
      expect(screen.getByTestId("markdown-body").textContent).toContain(
        "Body of loops"
      )
    );
    await waitFor(() =>
      expect(scrollIntoViewSpy).toHaveBeenCalledWith("lifecycle")
    );
    // The scroll fired exactly once — the pending slug was not consumed early
    // against page A while page B was still loading.
    expect(scrollIntoViewSpy).toHaveBeenCalledTimes(1);
  });

  it("shows the offline-unavailable state when the bundle isn't available", async () => {
    enableLegacyHelp();
    installDocsHelp({
      status: vi.fn(async () => ({ ...STATUS, available: false })),
      nav: vi.fn(async (): Promise<DocsHelpNavResult> => ({ groups: [] })),
    });
    render(<HelpView />);
    expect(
      await screen.findByText("Docs aren't available offline")
    ).toBeTruthy();
    // One shared "View online" label across every state (thread: label drift).
    expect(
      screen.getByRole("link", { name: VIEW_ONLINE_NAME_RE })
    ).toBeTruthy();
  });

  it("falls back to the unavailable state when an available bundle has no navigable pages", async () => {
    enableLegacyHelp();
    // `available: true` but an empty nav is a broken/empty snapshot: there is no
    // page to auto-select, so the view must not sit on an unreachable idle prompt.
    installDocsHelp({
      nav: vi.fn(async (): Promise<DocsHelpNavResult> => ({ groups: [] })),
    });
    render(<HelpView />);
    expect(
      await screen.findByText("Docs aren't available offline")
    ).toBeTruthy();
    expect(screen.queryByText("Select a page to start reading.")).toBeNull();
  });

  it("keeps the shipped body alive when the docs index arrives malformed", async () => {
    // AC2 on the branch EVERY user is on. Desktop's only error boundary is the
    // root one, so an unguarded `group.pages.map` replaces the whole application
    // rather than blanking the Help pane. First position reaches both readers.
    enableLegacyHelp();
    installDocsHelp({
      nav: vi.fn(
        async (): Promise<DocsHelpNavResult> =>
          ({
            groups: [{ group: "Corrupted" }, ...NAV.groups],
          }) as unknown as DocsHelpNavResult
      ),
    });

    render(<HelpView />);

    // The intact groups still reached the reader...
    expect(
      await screen.findByRole("button", { name: "Overview" })
    ).toBeTruthy();
    expect(screen.getByText("Concepts")).toBeTruthy();
    // ...the refused one did not...
    expect(screen.queryByText("Corrupted")).toBeNull();
    // ...and the bundle was not written off wholesale, which is what the
    // unguarded host did: it threw, caught, and reported the whole snapshot
    // unavailable while two readable groups sat in the payload.
    expect(screen.queryByText("Docs aren't available offline")).toBeNull();
  });

  /**
   * davetho review. This body used to hand `pageState.page` to `HelpReader`
   * unguarded, so `renderBody ?? body` reached the markdown pipeline raw — and a
   * non-nullish non-string throws there, taking down the Help route on the
   * DEFAULT branch, which is the one every flag-off user is on.
   */
  it("refuses a corrupt page instead of taking the route down with it", async () => {
    enableLegacyHelp();
    installDocsHelp({
      getPage: vi.fn(
        async (path: string): Promise<DocsHelpGetPageResult> =>
          ({
            kind: "found",
            page: {
              path,
              title: "Overview",
              headings: [],
              body: "readable",
              // A version-skewed producer: an object where markdown wants text.
              renderBody: { md: "## Lifecycle" },
            },
          }) as unknown as DocsHelpGetPageResult
      ),
    });

    render(<HelpView />);

    await waitFor(() =>
      expect(screen.getByText("This page can't be displayed")).toBeTruthy()
    );
    // The shell is still answering beside the refusal — "did not crash" is not
    // observable on its own.
    expect(screen.queryByTestId("markdown-body")).toBeNull();
  });

  it("renders the markdown-renderable body (renderBody) when present, not the flattened search body", async () => {
    enableLegacyHelp();
    installDocsHelp({
      getPage: vi.fn(
        async (path: string): Promise<DocsHelpGetPageResult> => ({
          kind: "found",
          page: {
            path,
            title: "Overview",
            headings: [{ level: 2, text: "Lifecycle", slug: "lifecycle" }],
            body: "Lifecycle Flattened prose for search.",
            renderBody: "## Lifecycle\n\n```ts\nconst x = 1;\n```",
          },
        })
      ),
    });
    render(<HelpView />);
    await waitFor(() =>
      expect(screen.getByTestId("markdown-body").textContent).toContain("```ts")
    );
    expect(screen.getByTestId("markdown-body").textContent).not.toContain(
      "Flattened prose for search"
    );
  });
});

/**
 * ISS-10044 on the DEFAULT branch. `help-complete-surface` is OFF, so this body
 * is the one every reader is actually on — and the collapse the ticket exists to
 * remove was only ever visible here. The v2 surface's own suite injects the new
 * states straight into a `DocsHelpSource`; these two drive them through the real
 * hook and the real IPC, which is the only way a regression in either direction
 * reddens.
 */
describe("desktop HelpView, help-complete-surface OFF, a transport that failed (ISS-10044)", () => {
  it("says the page read failed rather than that the snapshot lacks the page", async () => {
    enableLegacyHelp();
    installDocsHelp({
      getPage: vi.fn(() => Promise.reject(new Error("ipc down"))),
    });
    render(<HelpView />);

    expect(await screen.findByText("Couldn't load this page")).toBeTruthy();
    expect(screen.queryByText("Page not found")).toBeNull();
  });

  it("still says a genuinely absent page is not in the snapshot", async () => {
    // The positive sibling. Without it the assertion above is satisfied by a
    // body that had simply stopped rendering not-found at all.
    enableLegacyHelp();
    installDocsHelp({
      getPage: vi.fn(
        async (): Promise<DocsHelpGetPageResult> => ({ kind: "missing" })
      ),
    });
    render(<HelpView />);

    expect(await screen.findByText("Page not found")).toBeTruthy();
    expect(screen.queryByText("Couldn't load this page")).toBeNull();
  });

  it("says the search failed rather than that the query matched nothing", async () => {
    enableLegacyHelp();
    installDocsHelp({
      search: vi.fn(() => Promise.reject(new Error("index unreadable"))),
    });
    render(<HelpView />);
    await screen.findByText("Getting Started");

    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search documentation" }),
      { target: { value: "kubernetes" } }
    );

    expect(await screen.findByText(DOCS_HELP_SEARCH_FAILED_TITLE)).toBeTruthy();
    expect(screen.queryByText(NO_RESULTS_RE)).toBeNull();
  });

  it("still says a search that ran and matched nothing matched nothing", async () => {
    // The positive sibling for the search half.
    enableLegacyHelp();
    installDocsHelp({
      search: vi.fn(
        async (): Promise<DocsHelpSearchResult> => ({
          query: "kubernetes",
          hits: [],
        })
      ),
    });
    render(<HelpView />);
    await screen.findByText("Getting Started");

    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search documentation" }),
      { target: { value: "kubernetes" } }
    );

    expect(await screen.findByText(NO_RESULTS_RE)).toBeTruthy();
    expect(screen.queryByText(DOCS_HELP_SEARCH_FAILED_TITLE)).toBeNull();
  });
});
