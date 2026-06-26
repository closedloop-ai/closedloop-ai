import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, test } from "vitest";
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
