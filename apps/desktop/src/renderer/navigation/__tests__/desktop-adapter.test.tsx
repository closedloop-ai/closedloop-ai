import { useTabParam } from "@repo/app/shared/hooks/use-tab-param";
import { Link } from "@repo/navigation/link";
import { NavigationProvider } from "@repo/navigation/provider";
import { useNavigation } from "@repo/navigation/use-navigation";
import { useOrgPath } from "@repo/navigation/use-org-path";
import { usePath } from "@repo/navigation/use-path";
import { useRouteParams } from "@repo/navigation/use-route-params";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import {
  createDesktopNavigation,
  type DesktopNavigation,
} from "../desktop-adapter";
import { createFakeHashHost, createQueuedHashHost } from "./hash-host-fixture";

function navigationWrapper(navigation: DesktopNavigation) {
  return ({ children }: { children: ReactNode }) => (
    <NavigationProvider adapter={navigation.adapter}>
      {children}
    </NavigationProvider>
  );
}

describe("createDesktopNavigation", () => {
  it("starts at the landing view for an empty hash and persists the canonical form", () => {
    const host = createFakeHashHost();
    const navigation = createDesktopNavigation(host);

    expect(navigation.getHref()).toBe("/dashboard");
    expect(navigation.initialHashWasEmpty).toBe(true);
    expect(host.getHash()).toBe("#/dashboard");
  });

  it("restores the view from a path-scheme hash", () => {
    const host = createFakeHashHost("#/sessions/s-1?tab=events");
    const navigation = createDesktopNavigation(host);

    expect(navigation.initialHashWasEmpty).toBe(false);
    const { result } = renderHook(
      () => ({ path: usePath(), params: useRouteParams() }),
      { wrapper: navigationWrapper(navigation) }
    );
    expect(result.current.path).toBe("/sessions/s-1");
    expect(result.current.params.id).toBe("s-1");
  });

  it("migrates a legacy tab+sessionId hash and back() returns to the tab (AC-021.5)", () => {
    const host = createFakeHashHost("#tab=settings&sessionId=s-9");
    const navigation = createDesktopNavigation(host);

    expect(navigation.getHref()).toBe("/sessions/s-9");
    expect(host.getHash()).toBe("#/sessions/s-9");
    expect(navigation.canGoBack()).toBe(true);

    const { result } = renderHook(
      () => ({ actions: useNavigation(), path: usePath() }),
      { wrapper: navigationWrapper(navigation) }
    );
    act(() => {
      result.current.actions.back();
    });
    expect(result.current.path).toBe("/settings");
    expect(host.getHash()).toBe("#/settings");

    act(() => {
      result.current.actions.forward();
    });
    expect(result.current.path).toBe("/sessions/s-9");
    expect(host.getHash()).toBe("#/sessions/s-9");
  });

  it("navigate updates path, params, and the persisted hash", () => {
    const host = createFakeHashHost("#/dashboard");
    const navigation = createDesktopNavigation(host);

    const { result } = renderHook(
      () => ({
        actions: useNavigation(),
        path: usePath(),
        params: useRouteParams(),
      }),
      { wrapper: navigationWrapper(navigation) }
    );

    act(() => {
      result.current.actions.navigate("/sessions/s-2");
    });
    expect(result.current.path).toBe("/sessions/s-2");
    expect(result.current.params).toEqual({ id: "s-2" });
    expect(host.getHash()).toBe("#/sessions/s-2");
  });

  it("adopts external hash changes as history entries", () => {
    const host = createFakeHashHost("#/dashboard");
    const navigation = createDesktopNavigation(host);

    const { result } = renderHook(
      () => ({ actions: useNavigation(), path: usePath() }),
      { wrapper: navigationWrapper(navigation) }
    );

    act(() => {
      host.externallySetHash("#/settings");
    });
    expect(result.current.path).toBe("/settings");

    act(() => {
      result.current.actions.back();
    });
    expect(result.current.path).toBe("/dashboard");
  });

  it("drops navigation to unmapped hrefs from actions and Links (AC-021.6)", () => {
    const host = createFakeHashHost("#/dashboard");
    const navigation = createDesktopNavigation(host);

    const { result } = renderHook(
      () => ({ actions: useNavigation(), path: usePath() }),
      { wrapper: navigationWrapper(navigation) }
    );
    act(() => {
      result.current.actions.navigate("/users/123");
    });
    expect(result.current.path).toBe("/dashboard");

    render(
      <NavigationProvider adapter={navigation.adapter}>
        <Link href="/users/123">user</Link>
      </NavigationProvider>
    );
    const anchor = screen.getByRole("link", { name: "user" });
    expect(anchor.getAttribute("href")).toBe("#/users/123");
    fireEvent.click(anchor);
    expect(navigation.getHref()).toBe("/dashboard");
  });

  // A Settings subpath has no route-table entry of its own, so without the
  // guard's normalization it is unmapped and the navigation is DROPPED. These
  // two cover navigate and replace independently: each fails on its own
  // normalization being removed, so neither action can be reverted silently.
  it("normalizes a Settings subpath passed to navigate, preserving non-tab query fields", () => {
    const host = createFakeHashHost("#/dashboard");
    const navigation = createDesktopNavigation(host);

    const { result } = renderHook(
      () => ({ actions: useNavigation(), path: usePath() }),
      { wrapper: navigationWrapper(navigation) }
    );

    act(() => {
      result.current.actions.navigate(
        "/settings/security?returnTo=/branches?owner=grace"
      );
    });

    expect(navigation.getHref()).toBe(
      "/settings?returnTo=%2Fbranches%3Fowner%3Dgrace&panel=desktop-app"
    );
    expect(result.current.path).toBe("/settings");
    expect(host.getHash()).toBe(
      "#/settings?returnTo=%2Fbranches%3Fowner%3Dgrace&panel=desktop-app"
    );
  });

  it("normalizes a Settings subpath passed to replace, preserving non-tab query fields", () => {
    const host = createFakeHashHost("#/dashboard");
    const navigation = createDesktopNavigation(host);

    const { result } = renderHook(
      () => ({ actions: useNavigation(), path: usePath() }),
      { wrapper: navigationWrapper(navigation) }
    );

    act(() => {
      result.current.actions.replace("/settings/cli-tools?from=command");
    });

    expect(navigation.getHref()).toBe(
      "/settings?from=command&panel=desktop-app"
    );
    expect(result.current.path).toBe("/settings");
    expect(host.getHash()).toBe("#/settings?from=command&panel=desktop-app");
    // replace swaps the current entry rather than pushing, so the landing
    // entry it replaced is gone and there is nothing to go back to.
    expect(navigation.canGoBack()).toBe(false);
  });

  it("renders port Link hrefs hash-prefixed so browser-deferred clicks stay in-app, while plain left-click navigates the internal path (FEA-4018)", () => {
    const host = createFakeHashHost("#/dashboard");
    const navigation = createDesktopNavigation(host);

    render(
      <NavigationProvider adapter={navigation.adapter}>
        <Link href="/agents/my-agent">agent</Link>
      </NavigationProvider>
    );
    const anchor = screen.getByRole("link", { name: "agent" });
    // A modifier/middle/right-click defers to the browser: the rendered href
    // is the hash form the desktop hash-store adapter resolves, not a bare
    // `/agents/…` document nav the Electron guard blocks.
    expect(anchor.getAttribute("href")).toBe("#/agents/my-agent");
    // A plain left-click still navigates the internal path through the adapter.
    fireEvent.click(anchor);
    expect(navigation.getHref()).toBe("/agents/my-agent");
    expect(host.getHash()).toBe("#/agents/my-agent");
  });

  it("rewrites an externally-set legacy hash to the canonical path form", () => {
    const host = createFakeHashHost("#/dashboard");
    const navigation = createDesktopNavigation(host);

    host.externallySetHash("#tab=settings&sessionId=s-3");
    expect(navigation.getHref()).toBe("/sessions/s-3");
    expect(host.getHash()).toBe("#/sessions/s-3");
  });

  it("correlates queued internal hashchange events by their event hash", () => {
    const host = createQueuedHashHost("#/dashboard");
    const navigation = createDesktopNavigation(host);
    const { result } = renderHook(
      () => ({ actions: useNavigation(), path: usePath() }),
      { wrapper: navigationWrapper(navigation) }
    );

    act(() => {
      result.current.actions.navigate("/settings");
      result.current.actions.navigate("/branches");
      host.flushHashChanges();
    });
    expect(result.current.path).toBe("/branches");

    act(() => {
      host.externallySetHash("#/settings");
      host.flushHashChanges();
    });
    expect(result.current.path).toBe("/settings");
  });

  it("ignores stale external hashchange events that no longer match the current hash", () => {
    const host = createQueuedHashHost("#/dashboard");
    const navigation = createDesktopNavigation(host);
    const { result } = renderHook(() => usePath(), {
      wrapper: navigationWrapper(navigation),
    });

    act(() => {
      host.externallySetHash("#/settings");
      host.externallySetHash("#/branches");
      host.flushHashChanges();
    });

    expect(result.current).toBe("/branches");
    expect(navigation.getHistory()).toEqual(["/dashboard", "/branches"]);
  });

  it("does not throw on malformed percent-encoded hashes (startup, external, navigate)", () => {
    // Startup: malformed persisted hash falls back to the default view.
    const host = createFakeHashHost("#/sessions/%");
    const navigation = createDesktopNavigation(host);
    expect(navigation.getHref()).toBe("/dashboard");

    // External hashchange: ignored, view stays put.
    host.externallySetHash("#/sessions/%");
    expect(navigation.getHref()).toBe("/dashboard");

    // Programmatic navigation: dropped by the unmapped guard.
    const { result } = renderHook(() => useNavigation(), {
      wrapper: navigationWrapper(navigation),
    });
    act(() => {
      result.current.navigate("/sessions/%");
    });
    expect(navigation.getHref()).toBe("/dashboard");
  });

  it("falls back to the landing view for an unmapped persisted hash", () => {
    const host = createFakeHashHost("#/users/123");
    const navigation = createDesktopNavigation(host);

    expect(navigation.getHref()).toBe("/dashboard");
    expect(host.getHash()).toBe("#/dashboard");
  });

  it("ignores external hash changes to unmapped paths", () => {
    const host = createFakeHashHost("#/settings");
    const navigation = createDesktopNavigation(host);

    host.externallySetHash("#/users/123");
    expect(navigation.getHref()).toBe("/settings");
  });

  it("returns org-relative paths unchanged from useOrgPath", () => {
    const navigation = createDesktopNavigation(createFakeHashHost());
    const { result } = renderHook(() => useOrgPath(), {
      wrapper: navigationWrapper(navigation),
    });
    expect(result.current("/sessions/s-1")).toBe("/sessions/s-1");
  });

  it("dispose detaches the hashchange listener", () => {
    const host = createFakeHashHost("#/dashboard");
    const navigation = createDesktopNavigation(host);

    navigation.dispose();
    host.externallySetHash("#/settings");
    expect(navigation.getHref()).toBe("/dashboard");
  });
});

// AC-021.3 proof (PLN-866 T4.1): a shared @repo/app component using the
// port-based view-state hook works under the desktop adapter — tab state
// round-trips through the hash and back() restores it, with no web URL
// mechanism involved.
describe("shared view-state hooks under the desktop adapter (AC-021.3)", () => {
  function TabbedView() {
    const { activeTab, setActiveTab } = useTabParam({
      defaultTab: "overview",
      validTabs: ["overview", "events"] as const,
    });
    return (
      <div>
        <output>{activeTab}</output>
        <button onClick={() => setActiveTab("events")} type="button">
          events
        </button>
      </div>
    );
  }

  it("persists tab state to the hash and restores it via back()", () => {
    const host = createFakeHashHost("#/sessions/s-1");
    const navigation = createDesktopNavigation(host);

    render(
      <NavigationProvider adapter={navigation.adapter}>
        <TabbedView />
      </NavigationProvider>
    );
    expect(screen.getByRole("status")).toHaveProperty(
      "textContent",
      "overview"
    );

    fireEvent.click(screen.getByRole("button", { name: "events" }));
    expect(screen.getByRole("status")).toHaveProperty("textContent", "events");
    expect(host.getHash()).toBe("#/sessions/s-1?tab=events");

    // A fresh adapter over the persisted hash restores the tab (reload).
    const restored = createDesktopNavigation(
      createFakeHashHost(host.getHash())
    );
    expect(restored.getHref()).toBe("/sessions/s-1?tab=events");
  });
});
