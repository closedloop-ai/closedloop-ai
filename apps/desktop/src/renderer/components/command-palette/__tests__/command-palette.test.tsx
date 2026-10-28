/**
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
import { PORTABLE_SEARCH_SURFACE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { DESKTOP_DOCS_HELP_FEATURE_FLAG_KEY } from "../../../../shared/desktop-docs-help-flag";
import type { DocsHelpSearchResult } from "../../../../shared/docs-help-contract";
import { CommandPalette } from "../command-palette";
import { DOCS_SEARCH_RETRY_LABEL } from "../docs-command-group";

const flagMock = vi.mocked(useFeatureFlagEnabled);

/**
 * Every gate ON except `portable-search-surface` (ISS-9414), which is the key
 * that swaps this Docs group for the shared `SearchSurfaceV2`. A blanket
 * `mockReturnValue(true)` used to mean "docsHelp and Labs are on"; once a
 * second, default-OFF key started choosing the palette's body, it silently
 * meant "and render the other component" instead — so the cases below have to
 * name the branch they are about. The surface branch has its own suite,
 * `search-surface-mount.test.tsx`.
 */
function enableDocsCorpusOnly() {
  flagMock.mockImplementation(
    (key: string) => key !== PORTABLE_SEARCH_SURFACE_FEATURE_FLAG_KEY
  );
}
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

/*
 * ISS-7493. The palette binds a bare `window.addEventListener("keydown", …)`,
 * and `fireEvent.keyDown` cannot express this input: jsdom's `KeyboardEvent`
 * constructor coerces `key` to a string, so the EventInit route always yields
 * one. Overwriting the own property after construction is what a password
 * manager or extension shim actually does.
 */
function dispatchChordWithKey(key: unknown) {
  const event = new KeyboardEvent("keydown", { bubbles: true, metaKey: true });
  Object.defineProperty(event, "key", { configurable: true, value: key });
  window.dispatchEvent(event);
}

/*
 * jsdom does not let a listener's exception escape `dispatchEvent` — it reports
 * it as an uncaught error on `window` instead. A throw-only assertion around
 * the dispatch is therefore green either way, so the error event is what this
 * suite watches.
 */
function captureUncaughtErrors() {
  const seen: string[] = [];
  const onError = (event: ErrorEvent) => {
    seen.push(event.message);
  };
  window.addEventListener("error", onError);
  return { seen, stop: () => window.removeEventListener("error", onError) };
}

const UNUSABLE_CHORD_KEYS: ReadonlyArray<readonly [string, unknown]> = [
  ["absent", undefined],
  ["null", null],
  ["a non-string", 42],
];

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
    enableDocsCorpusOnly();
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
    enableDocsCorpusOnly();
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

  it("says the search failed rather than that no docs match, when it rejects (ISS-10044)", async () => {
    enableDocsCorpusOnly();
    installDocsHelp(vi.fn(() => Promise.reject(new Error("index unreadable"))));
    render(<CommandPalette />);

    openPalette();
    typeQuery("zzz");

    expect(await screen.findByText("Couldn't search the docs.")).toBeTruthy();
    // The defect: a rejected search rendered no Docs row at all, so cmdk fell
    // through to `CommandEmpty` and the palette answered for an index it never
    // reached. The sibling above pins that this sentence DOES render when the
    // search genuinely returns nothing.
    expect(screen.queryByText(NO_MATCHES_RE)).toBeNull();
    // The retry `useDocsCommandSearch` has returned since ISS-9414 and this
    // branch dropped. A `CommandItem`, not a button: `CommandList` is a listbox
    // whose arrow keys reach options only.
    expect(
      screen.getByRole("option", { name: DOCS_SEARCH_RETRY_LABEL })
    ).toBeTruthy();
  });

  it("re-issues the rejected query when the palette retry is chosen (ISS-10044)", async () => {
    enableDocsCorpusOnly();
    const search = installDocsHelp(
      vi.fn(() => Promise.reject(new Error("index unreadable")))
    );
    render(<CommandPalette />);

    openPalette();
    typeQuery("zzz");
    await screen.findByText("Couldn't search the docs.");
    const callsBeforeRetry = search.mock.calls.length;

    fireEvent.click(
      screen.getByRole("option", { name: DOCS_SEARCH_RETRY_LABEL })
    );

    // A retry that re-renders the settled failure without crossing IPC again is
    // the affordance's own version of this ticket's defect.
    await waitFor(() =>
      expect(search.mock.calls.length).toBeGreaterThan(callsBeforeRetry)
    );
  });

  // ISS-7493 (whitlockk review, PR #7424). Every other case here sends a well-formed
  // `key: "k"`, so `isPaletteChord`'s guard could be deleted without one of them
  // failing. The desktop shell mounts this listener on `window` for the whole
  // renderer lifetime, and a synthetic keydown carrying no usable `key` reached
  // `.toLowerCase()` and threw.
  it.each(UNUSABLE_CHORD_KEYS)(
    "a Meta chord with %s key neither opens the palette nor throws",
    (_label, key) => {
      enableDocsCorpusOnly();
      installDocsHelp();
      render(<CommandPalette />);
      const errors = captureUncaughtErrors();

      try {
        dispatchChordWithKey(key);

        expect(errors.seen).toEqual([]);
        expect(
          screen.queryByPlaceholderText("Search documentation…")
        ).toBeNull();
      } finally {
        errors.stop();
      }

      // The positive control, same render: a real ⌘K still opens. Without it the
      // assertions above would also pass for a palette that never mounted.
      openPalette();
      expect(screen.getByPlaceholderText("Search documentation…")).toBeTruthy();
    }
  );

  it("does not mount or bind ⌘K when the docsHelp flag is off", () => {
    flagMock.mockReturnValue(false);
    installDocsHelp();
    render(<CommandPalette />);

    openPalette();
    expect(screen.queryByPlaceholderText("Search documentation…")).toBeNull();
  });

  // ISS-5037 (whitlockk review on PR #4341): `docsHelp` stays TRUE here. With the
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
