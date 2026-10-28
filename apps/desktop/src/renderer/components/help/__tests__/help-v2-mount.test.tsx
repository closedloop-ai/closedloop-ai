/**
 * ISS-10005 AC1 — the desktop Help route reaches `HelpSurfaceV2`, and every deep
 * link and anchor PRD-555 shipped still lands.
 *
 * The superseded body composes the SAME `HelpNavPane` and `HelpReader`, so a
 * test that merely finds "Loops" on screen passes against the code this ticket
 * replaces. Every assertion is scoped INSIDE the surface's own root, and the
 * flag-OFF case pins that the root is absent for the shell's own composition.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, waitFor, within } from "@testing-library/react";
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

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: vi.fn(),
}));

const searchParamsMock = { current: new URLSearchParams() };
vi.mock("@repo/navigation/use-search-params-value", () => ({
  useSearchParamsValue: () => searchParamsMock.current,
}));

// Render the body as plain text, stamping the caller's heading `id` so the
// anchor assertions below exercise the real slug the reader computes.
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

import { HELP_SURFACE_V2_TEST_ID } from "@repo/app/help/lib/docs-help-test-ids";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { HELP_COMPLETE_SURFACE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { helpPageHref } from "../../../navigation/route-table";
import { HelpView } from "../help-view";

const flagMock = vi.mocked(useFeatureFlagEnabled);

const SURFACE_TEST_ID = HELP_SURFACE_V2_TEST_ID;
const SPEC_SURFACE_TEST_ID_RE = /const SURFACE_TEST_ID = "([^"]+)";/;

/**
 * THE ENUMERATION IS AC1. Written as literal hrefs, independent of
 * `HELP_PAGE_PARAM` / `HELP_HEADING_PARAM` and of `helpPageHref`'s own
 * construction: a test that built its expectation from those constants would
 * still pass after they were renamed, and every command-palette Docs pick and
 * every bookmarked `#/help?...` in the wild carries these exact spellings.
 */
const PRESERVED_DEEP_LINKS = [
  {
    expectedHref: "/help?page=concepts%2Floops",
    headingSlug: undefined,
    name: "a docs page",
    path: "concepts/loops",
    query: "page=concepts%2Floops",
  },
  {
    expectedHref: "/help?page=concepts%2Floops&heading=lifecycle",
    headingSlug: "lifecycle",
    name: "a docs page at a heading anchor",
    path: "concepts/loops",
    query: "page=concepts%2Floops&heading=lifecycle",
  },
] as const;

const NAV = {
  groups: [
    {
      group: "Getting Started",
      pages: [
        {
          group: "Getting Started",
          path: "getting-started/overview",
          title: "Overview",
        },
      ],
    },
    {
      group: "Concepts",
      pages: [{ group: "Concepts", path: "concepts/loops", title: "Loops" }],
    },
  ],
};

const STATUS = {
  available: true,
  docsSiteUrl: "https://closedloop.ai/docs",
  generatedAt: new Date(0).toISOString(),
  pageCount: 2,
  sourceCommit: "abc123",
};

const PAGE_TITLES: Record<string, string> = {
  "concepts/loops": "Loops",
  "getting-started/overview": "Overview",
};

function installDocsHelp(overrides: Record<string, unknown> = {}) {
  const api = {
    getPage: vi.fn(async (path: string) => ({
      kind: "found",
      page: {
        body: `## Lifecycle\n\nBody of ${PAGE_TITLES[path] ?? path}.`,
        headings: [{ level: 2, slug: "lifecycle", text: "Lifecycle" }],
        path,
        title: PAGE_TITLES[path] ?? path,
      },
    })),
    nav: vi.fn(async () => NAV),
    search: vi.fn(async () => ({ hits: [], query: "" })),
    status: vi.fn(async () => STATUS),
    ...overrides,
  };
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: { docsHelp: api },
  });
  return api;
}

/** Both PRD-555 destination gates ON; ISS-10005's own key per the argument. */
function setFlags({ completeSurface }: { completeSurface: boolean }): void {
  flagMock.mockImplementation((key: string) =>
    key === HELP_COMPLETE_SURFACE_FEATURE_FLAG_KEY ? completeSurface : true
  );
}

let originalDesktopApi: PropertyDescriptor | undefined;
let scrollIntoViewSpy: Mock<(id: string) => void>;
let originalScrollIntoView: PropertyDescriptor | undefined;

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

describe("the spellings the desktop E2E hard-codes", () => {
  it("matches the test id the surface actually emits", () => {
    // The spec cannot import `@repo/app` (Playwright's loader), so it hard-codes
    // the id. This reads that literal back OUT of the spec rather than retyping
    // it — a third hand-typed copy would drift from the other two in silence.
    // Resolved from the vitest root (`apps/desktop`), because this file is
    // transformed rather than loaded from disk and has no usable `import.meta.url`.
    const spec = readFileSync(
      resolve(process.cwd(), "test/e2e/help-surface-v2.spec.ts"),
      "utf8"
    );
    const specLiteral = SPEC_SURFACE_TEST_ID_RE.exec(spec)?.[1];

    expect(specLiteral).toBe(HELP_SURFACE_V2_TEST_ID);
  });
});

describe("desktop Help deep links survive the move to HelpSurfaceV2 (AC1)", () => {
  it("still builds the exact hrefs the command palette and bookmarks carry", () => {
    for (const link of PRESERVED_DEEP_LINKS) {
      expect(helpPageHref(link.path, link.headingSlug)).toBe(link.expectedHref);
    }
  });

  it.each(PRESERVED_DEEP_LINKS.map((link) => [link.name, link] as const))(
    "opens %s inside the shared surface",
    async (_name, link) => {
      setFlags({ completeSurface: true });
      const api = installDocsHelp();
      searchParamsMock.current = new URLSearchParams(link.query);

      render(<HelpView />);

      const surface = await screen.findByTestId(SURFACE_TEST_ID);
      // Scoped to the surface root — this is the assertion the superseded body
      // cannot satisfy, and the only reason this test is about ISS-10005.
      await waitFor(() =>
        expect(
          within(surface).getByRole("heading", { level: 1, name: "Loops" })
        ).toBeTruthy()
      );
      expect(api.getPage).toHaveBeenCalledWith(link.path);
    }
  );

  it("scrolls to the heading anchor the deep link names, and only then", async () => {
    setFlags({ completeSurface: true });
    installDocsHelp();
    searchParamsMock.current = new URLSearchParams(
      "page=concepts%2Floops&heading=lifecycle"
    );

    render(<HelpView />);

    await screen.findByTestId(SURFACE_TEST_ID);
    await waitFor(() =>
      expect(scrollIntoViewSpy).toHaveBeenCalledWith("lifecycle")
    );
  });

  it("does not scroll when the deep link names no anchor", async () => {
    // The positive sibling's counterpart: without it, a reader that scrolled to
    // the first heading on every page would satisfy the assertion above.
    setFlags({ completeSurface: true });
    installDocsHelp();
    searchParamsMock.current = new URLSearchParams("page=concepts%2Floops");

    render(<HelpView />);

    const surface = await screen.findByTestId(SURFACE_TEST_ID);
    await waitFor(() =>
      expect(
        within(surface).getByRole("heading", { level: 1, name: "Loops" })
      ).toBeTruthy()
    );
    expect(scrollIntoViewSpy).not.toHaveBeenCalled();
  });

  it("auto-selects the first navigable page when no deep link is given", async () => {
    setFlags({ completeSurface: true });
    const api = installDocsHelp();

    render(<HelpView />);

    const surface = await screen.findByTestId(SURFACE_TEST_ID);
    await waitFor(() =>
      expect(
        within(surface).getByRole("heading", { level: 1, name: "Overview" })
      ).toBeTruthy()
    );
    expect(api.getPage).toHaveBeenCalledWith("getting-started/overview");
  });
});

describe("the help-complete-surface gate picks the body (AC1)", () => {
  it("renders the shell's own composition, with no surface root, when the key is off", async () => {
    setFlags({ completeSurface: false });
    installDocsHelp();
    searchParamsMock.current = new URLSearchParams("page=concepts%2Floops");

    render(<HelpView />);

    // The deep link still works — that is what "default OFF changes nothing"
    // means — but it is NOT the shared surface serving it.
    expect(
      await screen.findByRole("heading", { level: 1, name: "Loops" })
    ).toBeTruthy();
    expect(screen.queryByTestId(SURFACE_TEST_ID)).toBeNull();
  });

  // ISS-9731: the PRD-555 DESTINATION gate is no longer read here — the shell
  // withdraws the route instead, so a direct #/help hash never mounts this view
  // while the gate is closed. Asserted in
  // `renderer/__tests__/labs-route-withdrawal.test.tsx`.
});
