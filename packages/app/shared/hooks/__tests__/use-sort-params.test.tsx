import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { useSortParams } from "../use-sort-params";

/**
 * Navigation-port coverage for the migrated app-core hook (FEA-1510). Unlike
 * the web-shell test in apps/app (which mocks next/navigation), this exercises
 * the surface-agnostic memory adapter path that the desktop renderer uses.
 */
const VALID_COLUMNS = ["title", "updatedAt", "type"] as const;
type TestColumn = (typeof VALID_COLUMNS)[number];

function renderSortParams(initialPath: string) {
  const nav = createMemoryNavigation({ initialPath });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <NavigationProvider adapter={nav.adapter}>{children}</NavigationProvider>
  );
  const view = renderHook(
    () =>
      useSortParams<TestColumn>({
        defaultColumn: "updatedAt",
        defaultDirection: "desc",
        validColumns: VALID_COLUMNS,
      }),
    { wrapper }
  );
  return { nav, ...view };
}

function queryOf(href: string): URLSearchParams {
  const queryStart = href.indexOf("?");
  return new URLSearchParams(
    queryStart === -1 ? "" : href.slice(queryStart + 1)
  );
}

describe("useSortParams (navigation port)", () => {
  test("restores sort state from the URL on mount", () => {
    const { result } = renderSortParams("/loops?sortBy=title&sortDir=asc");

    expect(result.current.sortBy).toBe("title");
    expect(result.current.sortDir).toBe("asc");
  });

  test("falls back to defaults when no sort params are present", () => {
    const { result } = renderSortParams("/loops");

    expect(result.current.sortBy).toBe("updatedAt");
    expect(result.current.sortDir).toBe("desc");
  });

  test("sanitizes an invalid sortBy value to the default column", () => {
    const { result } = renderSortParams("/loops?sortBy=notAColumn&sortDir=asc");

    expect(result.current.sortBy).toBe("updatedAt");
  });

  test("setSort replaces the URL, preserving unrelated params", () => {
    const { result, nav } = renderSortParams("/loops?filter=active");

    act(() => {
      result.current.setSort("title", "asc");
    });

    const params = queryOf(nav.getCurrentHref());
    expect(params.get("filter")).toBe("active");
    expect(params.get("sortBy")).toBe("title");
    expect(params.get("sortDir")).toBe("asc");
    // Re-derives from the live navigation snapshot, not stale closure state.
    expect(result.current.sortBy).toBe("title");
    expect(result.current.sortDir).toBe("asc");
  });

  test("clearSort removes sort params but keeps unrelated ones", () => {
    const { result, nav } = renderSortParams(
      "/loops?sortBy=title&sortDir=asc&filter=active"
    );

    act(() => {
      result.current.clearSort();
    });

    const params = queryOf(nav.getCurrentHref());
    expect(params.get("sortBy")).toBeNull();
    expect(params.get("sortDir")).toBeNull();
    expect(params.get("filter")).toBe("active");
    expect(result.current.sortBy).toBe("updatedAt");
  });
});

const PERSISTENCE_KEY = "use-sort-params-test";

type PersistedRenderOptions = {
  defaultColumn?: TestColumn | null;
  defaultDirection?: "asc" | "desc";
  paramPrefix?: string;
};

function seedSavedSort(data: unknown): void {
  localStorage.setItem(
    PERSISTENCE_KEY,
    JSON.stringify({ savedAt: Date.now(), data })
  );
}

function renderPersistedSortParams(
  initialPath: string,
  options: PersistedRenderOptions = {}
) {
  const nav = createMemoryNavigation({ initialPath });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <NavigationProvider adapter={nav.adapter}>{children}</NavigationProvider>
  );
  const view = renderHook(
    () =>
      useSortParams<TestColumn>({
        defaultColumn:
          options.defaultColumn === undefined
            ? "updatedAt"
            : options.defaultColumn,
        defaultDirection: options.defaultDirection,
        paramPrefix: options.paramPrefix,
        persistenceKey: PERSISTENCE_KEY,
        validColumns: VALID_COLUMNS,
      }),
    { wrapper }
  );
  return { nav, ...view };
}

describe("useSortParams (persistence)", () => {
  afterEach(() => {
    localStorage.clear();
  });

  test("restores the saved column and direction when the URL has none", () => {
    seedSavedSort({ column: "type", direction: "asc" });

    const { result } = renderPersistedSortParams("/loops");

    expect(result.current.sortBy).toBe("type");
    expect(result.current.sortDir).toBe("asc");
  });

  test("ignores the saved direction when the URL names a column", () => {
    seedSavedSort({ column: "type", direction: "asc" });

    const { result } = renderPersistedSortParams("/loops?sortBy=title", {
      defaultDirection: "desc",
    });

    expect(result.current.sortBy).toBe("title");
    expect(result.current.sortDir).toBe("desc");
  });

  test.each([
    ["an unknown column", { column: "bogus", direction: "asc" }],
    ["an unknown direction", { column: "type", direction: "sideways" }],
    ["a null payload", null],
  ])("falls back to defaults when the saved sort has %s", (_label, data) => {
    seedSavedSort(data);

    const { result } = renderPersistedSortParams("/loops", {
      defaultDirection: "asc",
    });

    expect(result.current.sortBy).toBe("updatedAt");
    expect(result.current.sortDir).toBe("asc");
  });

  test("defaults to a null column and a descending direction when neither is configured", () => {
    const { result } = renderPersistedSortParams("/loops", {
      defaultColumn: null,
    });

    expect(result.current.sortBy).toBeNull();
    expect(result.current.sortDir).toBe("desc");
  });

  test("reads and writes prefixed params and saves the chosen sort", () => {
    const { result, nav } = renderPersistedSortParams(
      "/loops?docsortBy=title&docsortDir=asc",
      { paramPrefix: "doc" }
    );

    expect(result.current.sortBy).toBe("title");
    expect(result.current.sortDir).toBe("asc");

    act(() => {
      result.current.setSort("type", "desc");
    });

    const params = queryOf(nav.getCurrentHref());
    expect(params.get("docsortBy")).toBe("type");
    expect(params.get("docsortDir")).toBe("desc");
    expect(params.get("sortBy")).toBeNull();
    expect(
      JSON.parse(localStorage.getItem(PERSISTENCE_KEY) ?? "null").data
    ).toEqual({ column: "type", direction: "desc" });
  });

  test("clearSort leaves a bare path and drops the saved sort", () => {
    seedSavedSort({ column: "type", direction: "asc" });
    const { result, nav } = renderPersistedSortParams(
      "/loops?sortBy=title&sortDir=asc"
    );

    act(() => {
      result.current.clearSort();
    });

    expect(nav.getCurrentHref()).toBe("/loops");
    expect(result.current.sortBy).toBe("updatedAt");
    expect(result.current.sortDir).toBe("desc");
  });
});
