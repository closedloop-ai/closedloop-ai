// ISS-11284 branch coverage: the stale-async-resolution guards in
// useDocsHelp. Each effect tracks a local `cancelled` flag and checks it
// before applying a resolved/rejected promise's result — these tests race a
// slower first request against a faster second one (rather than unmounting,
// which is unobservable through this hook's public surface in React 18) to
// prove the stale result never overwrites the newer one.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DocsHelpGetPageResult,
  DocsHelpPage,
  DocsHelpSearchResult,
} from "../../../../shared/docs-help-contract";
import { DocsHelpMatchField } from "../../../../shared/docs-help-contract";
import { useDocsHelp } from "../use-docs-help";

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

const SETTINGS_PAGE: DocsHelpPage = {
  path: "essentials/settings",
  title: "Settings",
  headings: [],
  body: "Settings body",
};

const API_KEYS_PAGE: DocsHelpPage = {
  path: "getting-started/api-keys",
  title: "API keys",
  headings: [],
  body: "API keys body",
};

const READY_STATUS = {
  available: true,
  sourceCommit: "abc1234",
  generatedAt: "2026-08-13T00:00:00.000Z",
  pageCount: 2,
  docsSiteUrl: "https://closedloop.ai/docs",
};

const NAV = {
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

const SEARCH_DEBOUNCE_MS = 150;

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
      async (): Promise<DocsHelpGetPageResult> => ({
        kind: "found",
        page: SETTINGS_PAGE,
      })
    ),
    search: vi.fn(
      async (query: string): Promise<DocsHelpSearchResult> => ({
        query,
        hits: [],
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

describe("useDocsHelp — stale getPage resolution/rejection guards", () => {
  it("ignores a stale getPage resolution once a newer selection has resolved", async () => {
    let resolveFirst: (value: DocsHelpGetPageResult) => void = () => {
      // assigned synchronously below
    };
    const firstPromise = new Promise<DocsHelpGetPageResult>((resolve) => {
      resolveFirst = resolve;
    });
    installDocsHelp({
      getPage: vi.fn((path: string) =>
        path === SETTINGS_PAGE.path
          ? firstPromise
          : Promise.resolve<DocsHelpGetPageResult>({
              kind: "found",
              page: API_KEYS_PAGE,
            })
      ),
    });

    const { result } = renderHook(() => useDocsHelp());
    await flush();
    expect(result.current.pageState).toEqual({ kind: "loading" });

    act(() => {
      result.current.selectPage(API_KEYS_PAGE.path);
    });
    await flush();
    expect(result.current.pageState).toEqual({
      kind: "found",
      page: API_KEYS_PAGE,
    });

    await act(async () => {
      resolveFirst({ kind: "found", page: SETTINGS_PAGE });
      await firstPromise;
    });

    // The stale SETTINGS_PAGE resolution must not clobber the newer selection.
    expect(result.current.pageState).toEqual({
      kind: "found",
      page: API_KEYS_PAGE,
    });
  });

  it("ignores a stale getPage rejection once a newer selection has resolved", async () => {
    let rejectFirst: (reason: Error) => void = () => {
      // assigned synchronously below
    };
    const firstPromise = new Promise<DocsHelpGetPageResult>(
      (_resolve, reject) => {
        rejectFirst = reject;
      }
    );
    installDocsHelp({
      getPage: vi.fn((path: string) =>
        path === SETTINGS_PAGE.path
          ? firstPromise
          : Promise.resolve<DocsHelpGetPageResult>({
              kind: "found",
              page: API_KEYS_PAGE,
            })
      ),
    });

    const { result } = renderHook(() => useDocsHelp());
    await flush();

    act(() => {
      result.current.selectPage(API_KEYS_PAGE.path);
    });
    await flush();
    expect(result.current.pageState).toEqual({
      kind: "found",
      page: API_KEYS_PAGE,
    });

    await act(async () => {
      rejectFirst(new Error("stale ipc failure"));
      await firstPromise.catch(() => {
        // expected: the stale rejection is swallowed by the cancelled guard
      });
    });

    // A late rejection for the abandoned selection must not downgrade the
    // current, already-resolved page state to `error`.
    expect(result.current.pageState).toEqual({
      kind: "found",
      page: API_KEYS_PAGE,
    });
  });
});

describe("useDocsHelp — search bridge unavailable and stale-result guards", () => {
  it("clears search state without ever entering the searching state when the bridge is unavailable", async () => {
    Reflect.deleteProperty(window, "desktopApi");

    const { result } = renderHook(() => useDocsHelp());
    await flush();
    expect(result.current.bundleState).toBe("unavailable");

    act(() => {
      result.current.setSearchQuery("anything");
    });
    await flush();

    expect(result.current.searchHits).toEqual([]);
    expect(result.current.isSearching).toBe(false);
  });

  it("ignores a stale search resolution once a newer query has resolved", async () => {
    let resolveFirst: (value: DocsHelpSearchResult) => void = () => {
      // assigned synchronously below
    };
    const firstPromise = new Promise<DocsHelpSearchResult>((resolve) => {
      resolveFirst = resolve;
    });
    installDocsHelp({
      search: vi.fn((query: string) =>
        query === "abc"
          ? firstPromise
          : Promise.resolve<DocsHelpSearchResult>({
              query,
              hits: [
                {
                  path: API_KEYS_PAGE.path,
                  title: API_KEYS_PAGE.title,
                  matchField: DocsHelpMatchField.Title,
                  score: 5,
                  excerpt: "excerpt",
                },
              ],
            })
      ),
    });

    const { result } = renderHook(() => useDocsHelp());
    await flush();

    act(() => {
      result.current.setSearchQuery("abc");
    });
    await flush(SEARCH_DEBOUNCE_MS);
    expect(result.current.isSearching).toBe(true);

    act(() => {
      result.current.setSearchQuery("xyz");
    });
    await flush(SEARCH_DEBOUNCE_MS);
    expect(result.current.searchHits).toEqual([
      expect.objectContaining({ path: API_KEYS_PAGE.path }),
    ]);
    expect(result.current.isSearching).toBe(false);

    await act(async () => {
      resolveFirst({ query: "abc", hits: [] });
      await firstPromise;
    });

    // The stale "abc" resolution (empty hits) must not overwrite the newer,
    // already-settled "xyz" result.
    expect(result.current.searchHits).toEqual([
      expect.objectContaining({ path: API_KEYS_PAGE.path }),
    ]);
  });

  it("ignores a stale search rejection once a newer query has resolved", async () => {
    let rejectFirst: (reason: Error) => void = () => {
      // assigned synchronously below
    };
    const firstPromise = new Promise<DocsHelpSearchResult>(
      (_resolve, reject) => {
        rejectFirst = reject;
      }
    );
    installDocsHelp({
      search: vi.fn((query: string) =>
        query === "abc"
          ? firstPromise
          : Promise.resolve<DocsHelpSearchResult>({ query, hits: [] })
      ),
    });

    const { result } = renderHook(() => useDocsHelp());
    await flush();

    act(() => {
      result.current.setSearchQuery("abc");
    });
    await flush(SEARCH_DEBOUNCE_MS);

    act(() => {
      result.current.setSearchQuery("xyz");
    });
    await flush(SEARCH_DEBOUNCE_MS);
    expect(result.current.searchFailed).toBe(false);
    expect(result.current.isSearching).toBe(false);

    await act(async () => {
      rejectFirst(new Error("stale index failure"));
      await firstPromise.catch(() => {
        // expected: the stale rejection is swallowed by the cancelled guard
      });
    });

    // The stale rejection for the abandoned "abc" query must not flip
    // `searchFailed` for the already-settled "xyz" query.
    expect(result.current.searchFailed).toBe(false);
  });
});
