/**
 * @file command-palette.test.tsx
 * @description Component tests for the desktop command-palette Docs group
 * (FEA-3845 / PRD-555 M3). Drives the palette off a mocked
 * `window.desktopApi.docsHelp.search` bridge and a mocked navigation port, and
 * asserts:
 *   1. Flag ON → ⌘K opens the palette; typing surfaces the Docs group with
 *      ranked hits (title + facet); Enter navigates to the Help view at the
 *      picked page + heading anchor.
 *   2. A query with no hits shows the empty state (no Docs group rows).
 *   3. Flag OFF → nothing mounts and ⌘K does not open a palette.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// cmdk (via the design-system Command) observes list size with ResizeObserver,
// and the Radix Dialog it renders in calls scrollIntoView — neither exists in
// jsdom. Stubbed per-test in beforeEach and restored in afterEach (below) so
// these globals don't leak into other tests in the shared jsdom worker
// (AGENTS.md: restore the original property descriptor for mutated globals).
class ResizeObserverStub {
  observe() {
    // no-op
  }
  unobserve() {
    // no-op
  }
  disconnect() {
    // no-op
  }
}

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: vi.fn(),
}));

const navigateMock = vi.fn();
vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ navigate: navigateMock }),
}));

import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { DESKTOP_DOCS_HELP_FEATURE_FLAG_KEY } from "../../../../shared/desktop-docs-help-flag";
import type { DocsHelpSearchResult } from "../../../../shared/docs-help-contract";
import { CommandPalette } from "../command-palette";

const flagMock = vi.mocked(useFeatureFlagEnabled);
const NO_MATCHES_RE = /No documentation matches/;

const HIT_RESULT: DocsHelpSearchResult = {
  query: "api key",
  hits: [
    {
      path: "getting-started/api-keys",
      title: "API keys",
      group: "Getting Started",
      matchField: "heading",
      score: 30,
      excerpt: "Create an API key to authenticate…",
      headingSlug: "create-a-key",
    },
    {
      path: "concepts/loops",
      title: "Loops",
      group: "Concepts",
      matchField: "title",
      score: 10,
      excerpt: "A loop runs your agents…",
    },
  ],
};

let originalDesktopApi: PropertyDescriptor | undefined;
let originalResizeObserver: PropertyDescriptor | undefined;
let originalScrollIntoView: PropertyDescriptor | undefined;

function installDocsHelp(
  search: ReturnType<typeof vi.fn> = vi.fn(
    async (): Promise<DocsHelpSearchResult> => HIT_RESULT
  )
) {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: { docsHelp: { search } },
  });
  return search;
}

function openPalette() {
  fireEvent.keyDown(window, { key: "k", metaKey: true });
}

function typeQuery(value: string) {
  fireEvent.change(screen.getByPlaceholderText("Search documentation…"), {
    target: { value },
  });
}

beforeEach(() => {
  originalDesktopApi = Object.getOwnPropertyDescriptor(window, "desktopApi");
  // Install the jsdom-missing globals cmdk/Radix need, capturing whatever was
  // there so afterEach can put it back (or delete our stub).
  originalResizeObserver = Object.getOwnPropertyDescriptor(
    globalThis,
    "ResizeObserver"
  );
  originalScrollIntoView = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "scrollIntoView"
  );
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: ResizeObserverStub as unknown as typeof ResizeObserver,
  });
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value: () => {
      // no-op
    },
  });
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  restoreGlobal(globalThis, "ResizeObserver", originalResizeObserver);
  restoreGlobal(Element.prototype, "scrollIntoView", originalScrollIntoView);
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
});

describe("desktop CommandPalette Docs group (FEA-3845)", () => {
  it("opens on ⌘K, surfaces docs hits, and Enter opens the Help view at the page + heading", async () => {
    flagMock.mockReturnValue(true);
    const search = installDocsHelp();
    render(<CommandPalette />);

    openPalette();
    typeQuery("api key");

    // Debounced query reaches the search IPC with the trimmed value.
    await waitFor(() => expect(search).toHaveBeenCalled());
    expect(search.mock.calls[0][0]).toBe("api key");

    // The ranked hits render under the Docs group heading.
    await screen.findByText("Docs");
    const hit = await screen.findByText("API keys");
    expect(screen.getByText("Loops")).toBeTruthy();
    // The matched-field facet renders (heading → "Section").
    expect(screen.getByText("Section")).toBeTruthy();

    fireEvent.click(hit);

    // Enter/click opens the Help view at that page + heading anchor.
    expect(navigateMock).toHaveBeenCalledWith(
      "/help?page=getting-started%2Fapi-keys&heading=create-a-key"
    );
  });

  it("shows the empty state when the query has no docs matches", async () => {
    flagMock.mockReturnValue(true);
    installDocsHelp(
      vi.fn(
        async (): Promise<DocsHelpSearchResult> => ({
          query: "zzz",
          hits: [],
        })
      )
    );
    render(<CommandPalette />);

    openPalette();
    typeQuery("zzz");

    expect(await screen.findByText(NO_MATCHES_RE)).toBeTruthy();
    expect(screen.queryByText("Docs")).toBeNull();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("does not mount or bind ⌘K when the docsHelp flag is off", () => {
    flagMock.mockReturnValue(false);
    installDocsHelp();
    render(<CommandPalette />);

    openPalette();
    expect(screen.queryByPlaceholderText("Search documentation…")).toBeNull();
  });

  // ISS-5037 (wongk review on PR #4341): `docsHelp` stays TRUE here. With the
  // Labs container gate off, ⌘K would otherwise still be a keyboard jump into a
  // destination the shell has withdrawn.
  it("does not mount or bind ⌘K when docsHelp is on but the Labs container gate is off", () => {
    flagMock.mockImplementation(
      (key: string) => key === DESKTOP_DOCS_HELP_FEATURE_FLAG_KEY
    );
    const search = installDocsHelp();
    render(<CommandPalette />);

    openPalette();
    expect(screen.queryByPlaceholderText("Search documentation…")).toBeNull();
    expect(search).not.toHaveBeenCalled();
  });
});

/** Put a mutated global back to its captured descriptor, or delete our stub. */
function restoreGlobal(
  target: object,
  key: string,
  original: PropertyDescriptor | undefined
) {
  if (original) {
    Object.defineProperty(target, key, original);
  } else {
    Reflect.deleteProperty(target, key);
  }
}
