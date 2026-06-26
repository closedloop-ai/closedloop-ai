import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { Link } from "../link";
import { createMemoryNavigation } from "../memory-adapter";
import type { NavigationAdapter } from "../navigation-adapter";
import { NavigationProvider } from "../provider";
import { useNavigation } from "../use-navigation";
import { useOrgPath } from "../use-org-path";
import { usePath } from "../use-path";
import { useRouteParams } from "../use-route-params";
import { useSearchParamsValue } from "../use-search-params-value";

const MISSING_PROVIDER_PATTERN = /NavigationProvider/;

describe("navigation port", () => {
  it("throws a descriptive error when hooks are used outside a provider", () => {
    expect(() => renderHook(() => usePath())).toThrow(MISSING_PROVIDER_PATTERN);
  });

  it("exposes path, params, and search params from the adapter", () => {
    const memory = createMemoryNavigation({
      initialPath: "/org/projects?tab=active",
      routeParams: { orgSlug: "acme" },
    });
    const { result } = renderHook(
      () => ({
        path: usePath(),
        params: useRouteParams(),
        search: useSearchParamsValue(),
      }),
      { wrapper: createWrapper(memory.adapter) }
    );

    expect(result.current.path).toBe("/org/projects");
    expect(result.current.params.orgSlug).toBe("acme");
    expect(result.current.search.get("tab")).toBe("active");
  });

  it("navigate, replace, and back update the current location", () => {
    const memory = createMemoryNavigation({ initialPath: "/start" });
    const { result } = renderHook(
      () => ({ actions: useNavigation(), path: usePath() }),
      { wrapper: createWrapper(memory.adapter) }
    );

    act(() => {
      result.current.actions.navigate("/first?x=1");
    });
    expect(result.current.path).toBe("/first");

    act(() => {
      result.current.actions.replace("/second");
    });
    expect(result.current.path).toBe("/second");
    expect(memory.getHistory()).toEqual(["/start", "/first?x=1", "/second"]);

    act(() => {
      result.current.actions.back();
    });
    expect(result.current.path).toBe("/start");
  });

  it("counts refresh calls", () => {
    const memory = createMemoryNavigation();
    const { result } = renderHook(() => useNavigation(), {
      wrapper: createWrapper(memory.adapter),
    });

    act(() => {
      result.current.refresh();
    });
    expect(memory.getRefreshCount()).toBe(1);
  });

  it("Link renders a real anchor and navigates on plain left click", () => {
    const memory = createMemoryNavigation({ initialPath: "/" });
    render(
      <NavigationProvider adapter={memory.adapter}>
        <Link className="styled" href="/dest?from=link">
          go
        </Link>
      </NavigationProvider>
    );

    const anchor = screen.getByRole("link", { name: "go" });
    expect(anchor).toHaveProperty("tagName", "A");
    expect(anchor.getAttribute("href")).toBe("/dest?from=link");
    expect(anchor.getAttribute("class")).toBe("styled");

    fireEvent.click(anchor);
    expect(memory.getCurrentHref()).toBe("/dest?from=link");
  });

  it.each([
    ["metaKey (macOS new tab)", { metaKey: true }],
    ["ctrlKey (Windows/Linux new tab)", { ctrlKey: true }],
    ["shiftKey (new window)", { shiftKey: true }],
  ])("Link defers to the browser for %s clicks", (_label, eventInit) => {
    const memory = createMemoryNavigation({ initialPath: "/" });
    render(
      <NavigationProvider adapter={memory.adapter}>
        <Link href="/dest">go</Link>
      </NavigationProvider>
    );

    fireEvent.click(screen.getByRole("link", { name: "go" }), eventInit);
    expect(memory.getCurrentHref()).toBe("/");
  });

  it("Link defers to the browser for plain clicks on target=_blank", () => {
    const memory = createMemoryNavigation({ initialPath: "/" });
    render(
      <NavigationProvider adapter={memory.adapter}>
        <Link href="/dest" target="_blank">
          go
        </Link>
      </NavigationProvider>
    );

    fireEvent.click(screen.getByRole("link", { name: "go" }));
    expect(memory.getCurrentHref()).toBe("/");
  });

  it("search params reflect the restored entry after back()", () => {
    const memory = createMemoryNavigation({ initialPath: "/a?from=start" });
    const { result } = renderHook(
      () => ({ actions: useNavigation(), search: useSearchParamsValue() }),
      { wrapper: createWrapper(memory.adapter) }
    );

    act(() => {
      result.current.actions.navigate("/b?from=next");
    });
    expect(result.current.search.get("from")).toBe("next");

    act(() => {
      result.current.actions.back();
    });
    expect(result.current.search.get("from")).toBe("start");
  });

  it("replace after back rewrites the current entry in place", () => {
    const memory = createMemoryNavigation({ initialPath: "/a" });
    const { result } = renderHook(
      () => ({ actions: useNavigation(), path: usePath() }),
      { wrapper: createWrapper(memory.adapter) }
    );

    act(() => {
      result.current.actions.navigate("/b");
    });
    act(() => {
      result.current.actions.back();
    });
    expect(result.current.path).toBe("/a");

    act(() => {
      result.current.actions.replace("/c");
    });
    expect(result.current.path).toBe("/c");

    // The replaced entry is current; going back from it is a no-op at the
    // stack root rather than resurrecting "/a".
    act(() => {
      result.current.actions.back();
    });
    expect(result.current.path).toBe("/c");
  });

  it("Link with replace replaces instead of pushing", () => {
    const memory = createMemoryNavigation({ initialPath: "/" });
    render(
      <NavigationProvider adapter={memory.adapter}>
        <Link href="/dest" replace>
          go
        </Link>
      </NavigationProvider>
    );

    fireEvent.click(screen.getByRole("link", { name: "go" }));
    expect(memory.getCurrentHref()).toBe("/dest");
    expect(memory.getHistory()).toEqual(["/", "/dest"]);
  });

  it("useOrgPath prefixes the active org slug", () => {
    const memory = createMemoryNavigation({ orgSlug: "acme" });
    const { result } = renderHook(() => useOrgPath(), {
      wrapper: createWrapper(memory.adapter),
    });

    expect(result.current("/users/123")).toBe("/acme/users/123");
  });

  it("useOrgPath returns the org-relative path unchanged when no slug is set", () => {
    const memory = createMemoryNavigation();
    const { result } = renderHook(() => useOrgPath(), {
      wrapper: createWrapper(memory.adapter),
    });

    // No "//users/123" — that would be a protocol-relative URL.
    expect(result.current("/users/123")).toBe("/users/123");
  });
});

function createWrapper(adapter: NavigationAdapter) {
  return ({ children }: { children: ReactNode }) => (
    <NavigationProvider adapter={adapter}>{children}</NavigationProvider>
  );
}
