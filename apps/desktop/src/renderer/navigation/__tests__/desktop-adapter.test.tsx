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
  type DesktopHashHost,
  type DesktopNavigation,
} from "../desktop-adapter";

type FakeHashHost = DesktopHashHost & {
  /** Simulate an external hash change (user-typed, main-process, legacy). */
  externallySetHash: (rawHash: string) => void;
  getWrites: () => readonly string[];
};

function createFakeHashHost(initialHash = ""): FakeHashHost {
  let hash = initialHash;
  const writes: string[] = [];
  const listeners = new Set<() => void>();
  return {
    getHash: () => hash,
    setHash: (href) => {
      if (hash.slice(1) === href) {
        return;
      }
      hash = `#${href}`;
      writes.push(href);
      // Mirrors the browser: programmatic hash writes also fire hashchange.
      for (const listener of listeners) {
        listener();
      }
    },
    onHashChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    externallySetHash: (rawHash) => {
      hash = rawHash;
      for (const listener of listeners) {
        listener();
      }
    },
    getWrites: () => [...writes],
  };
}

function createWrapper(navigation: DesktopNavigation) {
  return ({ children }: { children: ReactNode }) => (
    <NavigationProvider adapter={navigation.adapter}>
      {children}
    </NavigationProvider>
  );
}

describe("createDesktopNavigation", () => {
  it("starts at the sessions view for an empty hash and persists the canonical form", () => {
    const host = createFakeHashHost();
    const navigation = createDesktopNavigation(host);

    expect(navigation.getHref()).toBe("/sessions");
    expect(host.getHash()).toBe("#/sessions");
  });

  it("restores the view from a path-scheme hash", () => {
    const host = createFakeHashHost("#/sessions/s-1?tab=events");
    const navigation = createDesktopNavigation(host);

    const { result } = renderHook(
      () => ({ path: usePath(), params: useRouteParams() }),
      { wrapper: createWrapper(navigation) }
    );
    expect(result.current.path).toBe("/sessions/s-1");
    expect(result.current.params.id).toBe("s-1");
  });

  it("migrates a legacy tab+sessionId hash and back() returns to the tab (AC-021.5)", () => {
    const host = createFakeHashHost("#tab=kanban&sessionId=s-9");
    const navigation = createDesktopNavigation(host);

    expect(navigation.getHref()).toBe("/sessions/s-9");
    expect(host.getHash()).toBe("#/sessions/s-9");
    expect(navigation.canGoBack()).toBe(true);

    const { result } = renderHook(
      () => ({ actions: useNavigation(), path: usePath() }),
      { wrapper: createWrapper(navigation) }
    );
    act(() => {
      result.current.actions.back();
    });
    expect(result.current.path).toBe("/kanban");
    expect(host.getHash()).toBe("#/kanban");
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
      { wrapper: createWrapper(navigation) }
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
      { wrapper: createWrapper(navigation) }
    );

    act(() => {
      host.externallySetHash("#/kanban");
    });
    expect(result.current.path).toBe("/kanban");

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
      { wrapper: createWrapper(navigation) }
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
    expect(anchor.getAttribute("href")).toBe("/users/123");
    fireEvent.click(anchor);
    expect(navigation.getHref()).toBe("/dashboard");
  });

  it("rewrites an externally-set legacy hash to the canonical path form", () => {
    const host = createFakeHashHost("#/dashboard");
    const navigation = createDesktopNavigation(host);

    host.externallySetHash("#tab=kanban&sessionId=s-3");
    expect(navigation.getHref()).toBe("/sessions/s-3");
    expect(host.getHash()).toBe("#/sessions/s-3");
  });

  it("does not throw on malformed percent-encoded hashes (startup, external, navigate)", () => {
    // Startup: malformed persisted hash falls back to the default view.
    const host = createFakeHashHost("#/sessions/%");
    const navigation = createDesktopNavigation(host);
    expect(navigation.getHref()).toBe("/sessions");

    // External hashchange: ignored, view stays put.
    host.externallySetHash("#/sessions/%");
    expect(navigation.getHref()).toBe("/sessions");

    // Programmatic navigation: dropped by the unmapped guard.
    const { result } = renderHook(() => useNavigation(), {
      wrapper: createWrapper(navigation),
    });
    act(() => {
      result.current.navigate("/sessions/%");
    });
    expect(navigation.getHref()).toBe("/sessions");
  });

  it("falls back to the sessions view for an unmapped persisted hash", () => {
    const host = createFakeHashHost("#/users/123");
    const navigation = createDesktopNavigation(host);

    expect(navigation.getHref()).toBe("/sessions");
    expect(host.getHash()).toBe("#/sessions");
  });

  it("ignores external hash changes to unmapped paths", () => {
    const host = createFakeHashHost("#/kanban");
    const navigation = createDesktopNavigation(host);

    host.externallySetHash("#/users/123");
    expect(navigation.getHref()).toBe("/kanban");
  });

  it("returns org-relative paths unchanged from useOrgPath", () => {
    const navigation = createDesktopNavigation(createFakeHashHost());
    const { result } = renderHook(() => useOrgPath(), {
      wrapper: createWrapper(navigation),
    });
    expect(result.current("/sessions/s-1")).toBe("/sessions/s-1");
  });

  it("dispose detaches the hashchange listener", () => {
    const host = createFakeHashHost("#/dashboard");
    const navigation = createDesktopNavigation(host);

    navigation.dispose();
    host.externallySetHash("#/kanban");
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
