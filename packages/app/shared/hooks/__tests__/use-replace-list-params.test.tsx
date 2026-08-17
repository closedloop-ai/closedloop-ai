import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, test } from "vitest";
import { useReplaceListParams } from "../use-replace-list-params";

/**
 * Navigation-port coverage for the shared list-URL writer (FEA-3560/FEA-4181).
 * Exercises the surface-agnostic memory adapter both surfaces run on, focusing on
 * the `clearParamKeys` strip that "Clear filters" relies on to drop a URL-owned
 * `?search=` term the facet writer does not manage.
 */
type TestFilters = { readonly q: string };

function writeTestFilters(params: URLSearchParams, filters: TestFilters): void {
  if (filters.q) {
    params.set("q", filters.q);
  } else {
    params.delete("q");
  }
}

function writeTestPage(params: URLSearchParams, pageIndex: number): void {
  if (pageIndex <= 0) {
    params.delete("page");
    return;
  }
  params.set("page", String(pageIndex + 1));
}

function renderReplaceListParams(initialPath: string) {
  const nav = createMemoryNavigation({ initialPath });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <NavigationProvider adapter={nav.adapter}>{children}</NavigationProvider>
  );
  const view = renderHook(
    () => useReplaceListParams<TestFilters>(writeTestFilters, writeTestPage),
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

describe("useReplaceListParams (navigation port)", () => {
  test("writes the given filters and preserves unrelated params", () => {
    const { result, nav } = renderReplaceListParams(
      "/sessions?search=foo&other=keep"
    );

    act(() => {
      result.current({ q: "active" }, 0);
    });

    const params = queryOf(nav.getCurrentHref());
    expect(params.get("q")).toBe("active");
    // No clear list, so an unmanaged param survives — the copy contract.
    expect(params.get("search")).toBe("foo");
    expect(params.get("other")).toBe("keep");
  });

  test("clearParamKeys strips the URL-owned search term on clear", () => {
    const { result, nav } = renderReplaceListParams(
      "/sessions?search=foo&other=keep&page=3"
    );

    act(() => {
      result.current({ q: "" }, 0, ["search"]);
    });

    const params = queryOf(nav.getCurrentHref());
    // The exact bug: without the strip, the copied snapshot re-runs `search=foo`.
    expect(params.get("search")).toBeNull();
    // The page writer still runs after the delete and resets to page 1.
    expect(params.get("page")).toBeNull();
    // A param outside the clear list and outside the writers is untouched.
    expect(params.get("other")).toBe("keep");
  });
});
