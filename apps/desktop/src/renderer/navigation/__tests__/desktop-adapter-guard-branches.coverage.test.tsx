/**
 * ISS-11284 coverage — branches of `createDesktopNavigation`
 * (`desktop-adapter.tsx`) that `desktop-adapter.test.tsx` does not reach:
 * `replace()`'s unmapped-href else branch (mirroring the `navigate()` case
 * that file already covers), `back()`'s `canGoBack()` false branch (nothing
 * to go back to), and `toDesktopHashHref`'s already-hash-prefixed branch (the
 * existing Link test only exercises the bare-path branch).
 */

import { Link } from "@repo/navigation/link";
import { NavigationProvider } from "@repo/navigation/provider";
import { useNavigation } from "@repo/navigation/use-navigation";
import { usePath } from "@repo/navigation/use-path";
import { render, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { act } from "react";
import { describe, expect, it } from "vitest";
import {
  createDesktopNavigation,
  type DesktopNavigation,
} from "../desktop-adapter";
import { createFakeHashHost } from "./hash-host-fixture";

function navigationWrapper(navigation: DesktopNavigation) {
  return ({ children }: { children: ReactNode }) => (
    <NavigationProvider adapter={navigation.adapter}>
      {children}
    </NavigationProvider>
  );
}

describe("createDesktopNavigation — replace() with an unmapped href (L123 else)", () => {
  it("drops replace() to an href the route table does not map", () => {
    const host = createFakeHashHost("#/dashboard");
    const navigation = createDesktopNavigation(host);

    const { result } = renderHook(
      () => ({ actions: useNavigation(), path: usePath() }),
      { wrapper: navigationWrapper(navigation) }
    );

    act(() => {
      result.current.actions.replace("/users/123");
    });

    // AC-021.6's drop policy, mirrored for replace(): the current entry is
    // left exactly where it was, no history entry is swapped in.
    expect(result.current.path).toBe("/dashboard");
    expect(navigation.getHref()).toBe("/dashboard");
    expect(host.getHash()).toBe("#/dashboard");
  });
});

describe("createDesktopNavigation — back() with nothing to go back to (L128 false)", () => {
  it("does not claim post-startup navigation intent when canGoBack() is false", () => {
    const host = createFakeHashHost("#/dashboard");
    const navigation = createDesktopNavigation(host);
    expect(navigation.canGoBack()).toBe(false);

    const { result } = renderHook(() => useNavigation(), {
      wrapper: navigationWrapper(navigation),
    });

    act(() => {
      result.current.back();
    });

    // The `if (store.canGoBack())` guard's false branch: `back()` on a
    // single-entry stack is a no-op for intent-tracking, unlike the navigate()
    // path (also exercised elsewhere), which always claims it.
    expect(navigation.hasPostStartupNavigationIntent()).toBe(false);
    expect(navigation.getHref()).toBe("/dashboard");
  });
});

describe("createDesktopNavigation — toDesktopHashHref on an already-hash href (L216 true)", () => {
  it("renders an already-#-prefixed Link href unchanged", () => {
    const host = createFakeHashHost("#/dashboard");
    const navigation = createDesktopNavigation(host);

    render(
      <NavigationProvider adapter={navigation.adapter}>
        <Link href="#/agents/my-agent">agent</Link>
      </NavigationProvider>
    );
    const anchor = screen.getByRole("link", { name: "agent" });
    // Already hash-prefixed: `href.startsWith("#")` is true, so the ternary's
    // consequent branch returns the href as-is rather than prefixing again
    // (contrast the sibling `desktop-adapter.test.tsx` case with a bare
    // `/agents/my-agent` href, which exercises the alternate branch).
    expect(anchor.getAttribute("href")).toBe("#/agents/my-agent");
  });
});
