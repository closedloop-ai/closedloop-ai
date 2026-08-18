/**
 * @file topbar-breadcrumb-navigation.test.tsx
 * @description Desktop-renderer interaction test for the shared {@link Topbar}
 * header chrome (FEA-4260). The session / branch / component detail pages all
 * converge on this one header contract — a breadcrumb whose parent segment is
 * the "back" affordance and whose trailing segment is the current page. This
 * mounts the Topbar under the in-memory navigation adapter (built on the same
 * href store as the desktop production adapter) and asserts the parent "back"
 * crumb routes through the `@repo/navigation` Link port and actually navigates
 * on click — a raw `<a href>` would dead-click under Electron's will-navigate
 * guard. Uses the component (agent) breadcrumb shape, complementing the
 * app-shell coverage of the session and branch crumbs.
 */

import { SidebarProvider } from "@closedloop-ai/design-system/components/ui/sidebar";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Topbar } from "../Topbar";

// ISS-5112: the Topbar now carries a guest-mode "Create account" button, whose
// state comes from `useGuestOnboarding` (auth + the Labs flag). This suite is
// about the breadcrumb, so pin a settled SIGNED-IN device — the button renders
// null and the header chrome under test is exactly what it was.
vi.mock("../../onboarding/use-guest-onboarding", () => ({
  useGuestOnboarding: () => ({
    enabled: false,
    authStatus: "authenticated",
    resolved: true,
  }),
  canOfferAccount: () => false,
}));

const AGENTS_HREF = "/agents";
const SESSIONS_HREF = "/sessions";
const SESSIONS_NAME_RE = /sessions/i;
const flagAdapter = createStaticFeatureFlagAdapter();

describe("Topbar breadcrumb back affordance (FEA-4260)", () => {
  // SidebarProvider reads matchMedia to derive the mobile breakpoint; jsdom has
  // no implementation, so stub it (restored in afterEach).
  beforeEach(() => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("navigates to the parent list through the navigation port on click", () => {
    const memoryNav = createMemoryNavigation({
      initialPath: "/agents/skill::rtk",
    });

    render(
      <FeatureFlagAdapterProvider adapter={flagAdapter}>
        <NavigationProvider adapter={memoryNav.adapter}>
          <SidebarProvider>
            <Topbar
              breadcrumbs={[
                { href: AGENTS_HREF, label: "Agents" },
                { label: "RTK Optimizer" },
              ]}
            />
          </SidebarProvider>
        </NavigationProvider>
      </FeatureFlagAdapterProvider>
    );

    // Trailing crumb is the current page — marked aria-current, not a link.
    const current = screen.getByText("RTK Optimizer");
    expect(current.getAttribute("aria-current")).toBe("page");
    expect(current.tagName).not.toBe("A");

    // The parent "Agents" crumb is a real anchor that drives the store on click
    // (the port navigates instead of the browser attempting a dead file:// nav).
    const nav = screen.getByRole("navigation", { name: "breadcrumb" });
    const parentCrumb = within(nav).getByRole("link", { name: "Agents" });
    expect(parentCrumb.tagName).toBe("A");

    fireEvent.click(parentCrumb);
    expect(memoryNav.getCurrentHref()).toBe(AGENTS_HREF);
  });

  // FEA-4260 regression: the current-page crumb must not be exposed as a link.
  // The DS BreadcrumbPage previously rendered `role="link"`, so a detail title
  // that contains its parent's label (here "fea-2939 sessions bravo" on a
  // Sessions detail page) was matched as a *second* "Sessions" link — Playwright
  // accessible-name matching is a case-insensitive substring — and the desktop
  // e2e's `getByRole('link', { name: 'Sessions' })` in the breadcrumb hit a
  // strict-mode duplicate. Only the real parent anchor may be a link.
  it("does not expose the current-page crumb as a link even when its title contains a parent label", () => {
    const memoryNav = createMemoryNavigation({
      initialPath: "/sessions/fea-2939-sessions-bravo",
    });

    render(
      <FeatureFlagAdapterProvider adapter={flagAdapter}>
        <NavigationProvider adapter={memoryNav.adapter}>
          <SidebarProvider>
            <Topbar
              breadcrumbs={[
                { href: SESSIONS_HREF, label: "Sessions" },
                { label: "fea-2939 sessions bravo" },
              ]}
            />
          </SidebarProvider>
        </NavigationProvider>
      </FeatureFlagAdapterProvider>
    );

    const nav = screen.getByRole("navigation", { name: "breadcrumb" });

    // The trailing crumb is the current page: marked aria-current and NOT a link.
    const current = screen.getByText("fea-2939 sessions bravo");
    expect(current.getAttribute("aria-current")).toBe("page");
    expect(current.getAttribute("role")).not.toBe("link");

    // Substring "sessions" appears in both crumbs, but only the parent is a
    // link, so this resolves to exactly one element (no strict-mode duplicate).
    expect(
      within(nav).getAllByRole("link", { name: SESSIONS_NAME_RE })
    ).toHaveLength(1);
    const parentCrumb = within(nav).getByRole("link", { name: "Sessions" });
    expect(parentCrumb.tagName).toBe("A");
    expect(parentCrumb.getAttribute("href")).toBe(SESSIONS_HREF);
  });
  it("renders a pending trailing crumb as a skeleton that keeps the parent a link (ISS-4839)", () => {
    const memoryNav = createMemoryNavigation({
      initialPath: "/sessions/s-1",
    });

    render(
      <FeatureFlagAdapterProvider adapter={flagAdapter}>
        <NavigationProvider adapter={memoryNav.adapter}>
          <SidebarProvider>
            <Topbar
              breadcrumbs={[
                { href: SESSIONS_HREF, label: "Sessions" },
                { label: "Loading session", pending: true },
              ]}
            />
          </SidebarProvider>
        </NavigationProvider>
      </FeatureFlagAdapterProvider>
    );

    const nav = screen.getByRole("navigation", { name: "breadcrumb" });

    // The name slot is HELD and named for assistive tech, so the pending state
    // is announced rather than rendered as a placeholder noun or left blank.
    const pending = within(nav).getByLabelText("Loading session");
    expect(pending.getAttribute("aria-current")).toBe("page");
    // No placeholder noun leaked into the visible trail.
    expect(within(nav).queryByText("Session")).toBeNull();

    // The regression this exists for: the PARENT must stay a real link, so a
    // loading detail keeps its back affordance and never presents as its list.
    const parentCrumb = within(nav).getByRole("link", { name: "Sessions" });
    expect(parentCrumb.tagName).toBe("A");
    expect(parentCrumb.getAttribute("href")).toBe(SESSIONS_HREF);
    expect(parentCrumb.getAttribute("aria-current")).not.toBe("page");
  });
});
