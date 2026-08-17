// Time is pinned (fake timers) because the search debounce is a clock
// boundary — `flush()` advances fake time inside `act`, whereas `waitFor`'s
// polling never advances against a frozen clock.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DocsHelpGetPageResult,
  DocsHelpNavResult,
  DocsHelpPage,
  DocsHelpSearchResult,
  DocsHelpStatus,
} from "../../../../shared/docs-help-contract";
import { DocsHelpMatchField } from "../../../../shared/docs-help-contract";
import { type DocsHelpInitialTarget, useDocsHelp } from "../use-docs-help";

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

const SETTINGS_PAGE: DocsHelpPage = {
  path: "essentials/settings",
  title: "Settings",
  headings: [{ level: 2, text: "Sandbox", slug: "sandbox" }],
  body: "Settings body",
};

const API_KEYS_PAGE: DocsHelpPage = {
  path: "getting-started/api-keys",
  title: "API keys",
  headings: [],
  body: "API keys body",
};

const READY_STATUS: DocsHelpStatus = {
  available: true,
  sourceCommit: "abc1234",
  generatedAt: "2026-08-13T00:00:00.000Z",
  pageCount: 2,
  docsSiteUrl: "https://closedloop.ai/docs",
};

/** The bundle failed to load (or is empty): every Help surface stays dark. */
const UNAVAILABLE_STATUS: DocsHelpStatus = {
  ...READY_STATUS,
  available: false,
  pageCount: 0,
};

/**
 * Stable target references, mirroring `help-view.tsx`, which memoizes the
 * target on the two query params. The hook's initial-target effect depends on
 * the object IDENTITY (that is what makes a repeat pick re-scroll), so a caller
 * that rebuilt it every render would re-select on every render — these are
 * hoisted so the tests exercise the real usage.
 */
const API_KEYS_TARGET = { path: "getting-started/api-keys" };
const API_KEYS_TARGET_WITH_HEADING = {
  path: "getting-started/api-keys",
  headingSlug: "rotate",
};
const SETTINGS_TARGET_FIRST_PICK = {
  path: "essentials/settings",
  headingSlug: "sandbox",
};
const SETTINGS_TARGET_REPEAT_PICK = {
  path: "essentials/settings",
  headingSlug: "sandbox",
};

const NAV: DocsHelpNavResult = {
  groups: [
    {
      group: "Essentials",
      pages: [
        { path: SETTINGS_PAGE.path, title: SETTINGS_PAGE.title },
        { path: API_KEYS_PAGE.path, title: API_KEYS_PAGE.title },
      ],
    },
  ],
};

type DocsHelpApiStub = {
  status: ReturnType<typeof vi.fn>;
  nav: ReturnType<typeof vi.fn>;
  getPage: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
};

function installDocsHelp(
  overrides: Partial<DocsHelpApiStub> = {}
): DocsHelpApiStub {
  const api: DocsHelpApiStub = {
    status: vi.fn(async () => READY_STATUS),
    nav: vi.fn(async () => NAV),
    getPage: vi.fn(
      async (path: string): Promise<DocsHelpGetPageResult> =>
        path === SETTINGS_PAGE.path
          ? { kind: "found", page: SETTINGS_PAGE }
          : { kind: "found", page: API_KEYS_PAGE }
    ),
    search: vi.fn(
      async (query: string): Promise<DocsHelpSearchResult> => ({
        query,
        hits: [
          {
            path: SETTINGS_PAGE.path,
            title: SETTINGS_PAGE.title,
            matchField: DocsHelpMatchField.Title,
            score: 10,
            excerpt: "Settings excerpt",
          },
        ],
      })
    ),
    ...overrides,
  };
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: { docsHelp: api },
  });
  return api;
}

/** Settle pending promise callbacks (and any timer due) inside `act`. */
async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
});

describe("useDocsHelp — bundle readiness", () => {
  it("loads status + nav and auto-selects the first navigable page", async () => {
    const api = installDocsHelp();

    const { result } = renderHook(() => useDocsHelp());
    await flush();

    expect(result.current.bundleState).toBe("ready");
    expect(result.current.status).toEqual(READY_STATUS);
    expect(result.current.navGroups).toEqual(NAV.groups);
    expect(result.current.selectedPath).toBe(SETTINGS_PAGE.path);
    expect(api.getPage).toHaveBeenCalledWith(SETTINGS_PAGE.path);
  });

  it("is unavailable when the preload bridge exposes no docsHelp", async () => {
    Reflect.deleteProperty(window, "desktopApi");

    const { result } = renderHook(() => useDocsHelp());
    await flush();

    expect(result.current.bundleState).toBe("unavailable");
    expect(result.current.navGroups).toEqual([]);
  });

  it("drops the nav tree when the bundle reports itself unavailable", async () => {
    installDocsHelp({
      status: vi.fn(async () => UNAVAILABLE_STATUS),
    });

    const { result } = renderHook(() => useDocsHelp());
    await flush();

    expect(result.current.bundleState).toBe("unavailable");
    expect(result.current.navGroups).toEqual([]);
    expect(result.current.selectedPath).toBeNull();
  });

  it("treats an available-but-empty snapshot as unavailable, not an idle prompt", async () => {
    // A bundle that claims available yet exposes no navigable page is broken:
    // there is nothing to select, so the reader must get the "view online"
    // escape hatch rather than a prompt the user can never satisfy.
    installDocsHelp({ nav: vi.fn(async () => ({ groups: [] })) });

    const { result } = renderHook(() => useDocsHelp());
    await flush();

    expect(result.current.bundleState).toBe("unavailable");
    expect(result.current.selectedPath).toBeNull();
  });

  it("degrades to unavailable when the status read rejects", async () => {
    installDocsHelp({
      status: vi.fn(() => Promise.reject(new Error("ipc down"))),
    });

    const { result } = renderHook(() => useDocsHelp());
    await flush();

    expect(result.current.bundleState).toBe("unavailable");
  });
});

describe("useDocsHelp — the reader", () => {
  it("reports a page the bundle does not have as missing", async () => {
    installDocsHelp({
      getPage: vi.fn(
        async (): Promise<DocsHelpGetPageResult> => ({
          kind: "missing",
        })
      ),
    });

    const { result } = renderHook(() => useDocsHelp());
    await flush();

    expect(result.current.pageState).toEqual({ kind: "missing" });
  });

  it("reports missing when the page read rejects", async () => {
    installDocsHelp({
      getPage: vi.fn(() => Promise.reject(new Error("ipc down"))),
    });

    const { result } = renderHook(() => useDocsHelp());
    await flush();

    expect(result.current.pageState).toEqual({ kind: "missing" });
  });

  it("serves a revisited page from cache instead of crossing IPC again", async () => {
    const api = installDocsHelp();
    const { result } = renderHook(() => useDocsHelp());
    await flush();
    expect(api.getPage).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.selectPage(API_KEYS_PAGE.path);
    });
    await flush();
    expect(api.getPage).toHaveBeenCalledTimes(2);

    act(() => {
      result.current.selectPage(SETTINGS_PAGE.path);
    });
    await flush();

    // Third selection, still two round trips: the first page came from cache.
    expect(api.getPage).toHaveBeenCalledTimes(2);
    expect(result.current.pageState).toEqual({
      kind: "found",
      page: SETTINGS_PAGE,
    });
  });
});

describe("useDocsHelp — the pending heading anchor", () => {
  it("hands over the slug only once its own page is the one on screen", async () => {
    const api = installDocsHelp();
    // Hold the API-keys read open so the selection lands before its page does.
    let resolveApiKeys: ((value: DocsHelpGetPageResult) => void) | null = null;
    api.getPage.mockImplementation((path: string) => {
      if (path === SETTINGS_PAGE.path) {
        return Promise.resolve({ kind: "found", page: SETTINGS_PAGE });
      }
      return new Promise<DocsHelpGetPageResult>((resolve) => {
        resolveApiKeys = resolve;
      });
    });

    const { result } = renderHook(() => useDocsHelp());
    await flush();

    act(() => {
      result.current.selectPage(API_KEYS_PAGE.path, "usage");
    });
    await flush();

    // The target page is still loading, so the scroll effect must not fire (and
    // consume the slug) against the page still rendered behind it.
    expect(result.current.pendingHeadingSlug).toBeNull();

    await act(async () => {
      resolveApiKeys?.({ kind: "found", page: API_KEYS_PAGE });
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.pendingHeadingSlug).toBe("usage");
  });

  it("carries no slug for a selection made without one", async () => {
    installDocsHelp();
    const { result } = renderHook(() => useDocsHelp());
    await flush();

    act(() => {
      result.current.selectPage(API_KEYS_PAGE.path);
    });
    await flush();

    expect(result.current.pendingHeadingSlug).toBeNull();
  });

  it("clears the slug once the reader has consumed it", async () => {
    installDocsHelp();
    const { result } = renderHook(() => useDocsHelp());
    await flush();

    act(() => {
      result.current.selectPage(SETTINGS_PAGE.path, "sandbox");
    });
    await flush();
    expect(result.current.pendingHeadingSlug).toBe("sandbox");

    act(() => {
      result.current.clearPendingHeadingSlug();
    });

    expect(result.current.pendingHeadingSlug).toBeNull();
  });
});

describe("useDocsHelp — an externally requested page", () => {
  it("opens the command-palette target instead of the default first page", async () => {
    installDocsHelp();

    const { result } = renderHook(() =>
      useDocsHelp({ initialTarget: API_KEYS_TARGET_WITH_HEADING })
    );
    await flush();

    expect(result.current.bundleState).toBe("ready");
    expect(result.current.selectedPath).toBe(API_KEYS_PAGE.path);
    expect(result.current.pendingHeadingSlug).toBe("rotate");
  });

  it("still resolves readiness for a target against an unavailable bundle", async () => {
    installDocsHelp({
      status: vi.fn(async () => UNAVAILABLE_STATUS),
    });

    const { result } = renderHook(() =>
      useDocsHelp({ initialTarget: API_KEYS_TARGET })
    );
    await flush();

    expect(result.current.bundleState).toBe("unavailable");
  });

  it("re-selects and re-scrolls when the same hit is picked again", async () => {
    installDocsHelp();
    const { result, rerender } = renderHook(
      (props: { target: DocsHelpInitialTarget }) =>
        useDocsHelp({ initialTarget: props.target }),
      { initialProps: { target: SETTINGS_TARGET_FIRST_PICK } }
    );
    await flush();
    act(() => {
      result.current.clearPendingHeadingSlug();
    });
    expect(result.current.pendingHeadingSlug).toBeNull();

    // A repeat pick carries a distinct query string → a fresh target object, so
    // the effect re-fires even though the page is already open.
    rerender({ target: SETTINGS_TARGET_REPEAT_PICK });
    await flush();

    expect(result.current.pendingHeadingSlug).toBe("sandbox");
  });
});

describe("useDocsHelp — search", () => {
  it("debounces before crossing IPC and then publishes the hits", async () => {
    const api = installDocsHelp();
    const { result } = renderHook(() => useDocsHelp());
    await flush();

    act(() => {
      result.current.setSearchQuery("sett");
    });
    await flush();
    // Still inside the debounce window.
    expect(api.search).not.toHaveBeenCalled();
    expect(result.current.isSearching).toBe(true);

    await flush(150);

    expect(api.search).toHaveBeenCalledWith("sett");
    expect(result.current.searchHits).toHaveLength(1);
    expect(result.current.isSearching).toBe(false);
  });

  it("issues one search for a query typed across several keystrokes", async () => {
    const api = installDocsHelp();
    const { result } = renderHook(() => useDocsHelp());
    await flush();

    act(() => {
      result.current.setSearchQuery("s");
    });
    await flush(50);
    act(() => {
      result.current.setSearchQuery("se");
    });
    await flush(50);
    act(() => {
      result.current.setSearchQuery("set");
    });
    await flush(150);

    expect(api.search).toHaveBeenCalledTimes(1);
    expect(api.search).toHaveBeenCalledWith("set");
  });

  it("clears hits for a blank query without crossing IPC", async () => {
    const api = installDocsHelp();
    const { result } = renderHook(() => useDocsHelp());
    await flush();

    act(() => {
      result.current.setSearchQuery("sett");
    });
    await flush(150);
    expect(result.current.searchHits).toHaveLength(1);

    act(() => {
      result.current.setSearchQuery("   ");
    });
    await flush(150);

    expect(result.current.searchHits).toEqual([]);
    expect(result.current.isSearching).toBe(false);
    expect(api.search).toHaveBeenCalledTimes(1);
  });

  it("empties the results and stops the spinner when the search rejects", async () => {
    installDocsHelp({
      search: vi.fn(() => Promise.reject(new Error("index unreadable"))),
    });
    const { result } = renderHook(() => useDocsHelp());
    await flush();

    act(() => {
      result.current.setSearchQuery("sett");
    });
    await flush(150);

    expect(result.current.searchHits).toEqual([]);
    expect(result.current.isSearching).toBe(false);
  });
});
