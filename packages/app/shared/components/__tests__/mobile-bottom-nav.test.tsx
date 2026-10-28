import { AGENTS_NAV_FLAG_KEY } from "@repo/api/src/types/agents-nav-flag";
import { SidebarProvider } from "@repo/design-system/components/ui/sidebar";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FeatureFlagAdapterProvider } from "../../feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "../../feature-flags/static-feature-flag-adapter";
import { ArtifactFlag } from "../../lib/artifact-flags";
import {
  ISSUES_NAV_TITLE,
  MOBILE_NAV_MAX_DESTINATIONS,
  MOBILE_NAV_PHONE_DESTINATION_PATHS,
} from "../../lib/primary-nav-destinations";
import { MobileBottomNav } from "../mobile-bottom-nav";

const ORG = "org-test";

// The explicit phone destinations FEA-4155 pins the bar to (bot review #3789).
// ISS-5041 gated Agents, so the MEMBERSHIP of this list is still fixed but its
// fourth entry now resolves through the flag port like any other gated
// destination — `withAgents()` is what fills the bar.
const AGENTS_LINK_NAME = "Agents";
const PHONE_LINK_NAMES = [
  "Dashboard",
  "Sessions",
  "Branches",
  AGENTS_LINK_NAME,
];

// The always-on remainder: what the bar renders once Agents is gated off. Pinned
// as a literal rather than derived from the registry the component reads, so
// dropping a destination from that registry fails here instead of quietly
// agreeing with itself.
const ALWAYS_ON_PHONE_LINK_NAMES = ["Dashboard", "Sessions", "Branches"];

/** Flags that open the full four-slot bar (ISS-5041 gated the fourth). */
const withAgents = (...flags: readonly string[]) => [
  AGENTS_NAV_FLAG_KEY,
  ...flags,
];

// jsdom does not implement matchMedia; SidebarProvider's useIsMobile() reads it.
// Stub a desktop (non-matching) media query so the provider mounts.
beforeEach(() => {
  globalThis.window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }) as unknown as typeof globalThis.window.matchMedia;
});

function renderNav({
  initialPath = "/",
  enabledFlags = [],
}: {
  initialPath?: string;
  enabledFlags?: readonly string[];
} = {}) {
  const memory = createMemoryNavigation({ orgSlug: ORG, initialPath });
  const flagAdapter = createStaticFeatureFlagAdapter({ enabledFlags });

  const wrapper = (children: ReactNode) => (
    <NavigationProvider adapter={memory.adapter}>
      <FeatureFlagAdapterProvider adapter={flagAdapter}>
        <SidebarProvider>{children}</SidebarProvider>
      </FeatureFlagAdapterProvider>
    </NavigationProvider>
  );

  return { memory, ...render(wrapper(<MobileBottomNav />)) };
}

describe("MobileBottomNav", () => {
  it("renders exactly the named phone destination set plus a menu affordance", () => {
    renderNav({ enabledFlags: withAgents() });

    const nav = screen.getByRole("navigation", { name: "Primary" });
    // FEA-4155: the bar renders the explicit phone set (Dashboard, Sessions,
    // Branches, Agents), NOT a prefix slice of the sidebar list — so both
    // surfaces this change unblanks reach the bar.
    for (const name of PHONE_LINK_NAMES) {
      expect(within(nav).getByRole("link", { name })).toBeInTheDocument();
    }
    expect(within(nav).getAllByRole("link")).toHaveLength(
      MOBILE_NAV_MAX_DESTINATIONS
    );
    expect(
      within(nav).getByRole("button", { name: "Menu" })
    ).toBeInTheDocument();
  });

  it("keeps the phone set fixed regardless of the Issues flag (bot review #3789)", () => {
    // The earlier prefix slice flipped slot four between Issues (flag on) and
    // Sessions (flag off). The explicit set must be identical either way, and
    // Issues (not a phone destination) never appears on the bar.
    const off = renderNav({ enabledFlags: withAgents() });
    const offNav = within(off.getByRole("navigation", { name: "Primary" }));
    const offLinks = offNav
      .getAllByRole("link")
      .map((link) => link.textContent);
    off.unmount();

    const on = renderNav({
      enabledFlags: withAgents(ArtifactFlag.Issues, ArtifactFlag.Branches),
    });
    const onNav = within(on.getByRole("navigation", { name: "Primary" }));
    const onLinks = onNav.getAllByRole("link").map((link) => link.textContent);

    expect(onLinks).toEqual(offLinks);
    expect(
      onNav.queryByRole("link", { name: ISSUES_NAV_TITLE })
    ).not.toBeInTheDocument();
    for (const name of PHONE_LINK_NAMES) {
      expect(onNav.getByRole("link", { name })).toBeInTheDocument();
    }
  });

  it("puts both surfaces FEA-4155 unblanks (Sessions, Branches) on the bar", () => {
    renderNav();

    const nav = within(screen.getByRole("navigation", { name: "Primary" }));
    expect(nav.getByRole("link", { name: "Sessions" })).toHaveAttribute(
      "href",
      `/${ORG}/sessions`
    );
    expect(nav.getByRole("link", { name: "Branches" })).toHaveAttribute(
      "href",
      `/${ORG}/branches`
    );
  });

  it("org-scopes the destination hrefs through the navigation port", () => {
    renderNav({ enabledFlags: withAgents() });

    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(
      within(nav).getByRole("link", { name: "Dashboard" })
    ).toHaveAttribute("href", `/${ORG}/dashboard`);
    expect(
      within(nav).getByRole("link", { name: AGENTS_LINK_NAME })
    ).toHaveAttribute("href", `/${ORG}/agents`);
  });

  it("never surfaces a non-phone destination inline, even with every artifact flag on", () => {
    // Documents / Issues / My Tasks / Inbox are not phone destinations, so no
    // flag combination can push them onto the capped inline row.
    renderNav({
      enabledFlags: withAgents(
        ArtifactFlag.Documents,
        ArtifactFlag.Issues,
        ArtifactFlag.Branches
      ),
    });

    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(within(nav).getAllByRole("link")).toHaveLength(
      MOBILE_NAV_MAX_DESTINATIONS
    );
    for (const name of ["Documents", "Issues", "My Tasks", "Inbox"]) {
      expect(within(nav).queryByRole("link", { name })).not.toBeInTheDocument();
    }
  });

  it("caps inline destinations at the phone-set size", () => {
    // The phone set is exactly MOBILE_NAV_MAX_DESTINATIONS long, so with every
    // member enabled the inline row is full and the menu is the final slot.
    expect(MOBILE_NAV_PHONE_DESTINATION_PATHS).toHaveLength(
      MOBILE_NAV_MAX_DESTINATIONS
    );

    renderNav({ enabledFlags: withAgents() });

    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(within(nav).getAllByRole("link")).toHaveLength(
      MOBILE_NAV_MAX_DESTINATIONS
    );
    expect(
      within(nav).getByRole("button", { name: "Menu" })
    ).toBeInTheDocument();
  });

  it("drops to three slots with the Agents gate off, promoting nothing (ISS-5041)", () => {
    // The deliberate answer to "what fills slot four". Nothing does: which
    // destination earns a phone-bar slot is a product call nobody has made, and
    // inventing one would change the bar for every user, including those who
    // never had Agents. Everything off the bar stays in the menu.
    renderNav();

    const nav = within(screen.getByRole("navigation", { name: "Primary" }));
    expect(
      nav.queryByRole("link", { name: AGENTS_LINK_NAME })
    ).not.toBeInTheDocument();
    for (const name of ALWAYS_ON_PHONE_LINK_NAMES) {
      expect(nav.getByRole("link", { name })).toBeInTheDocument();
    }
    // Exactly three — not four with a substitute quietly promoted in.
    expect(nav.getAllByRole("link")).toHaveLength(
      ALWAYS_ON_PHONE_LINK_NAMES.length
    );
    // The bar still works: the menu keeps everything else reachable.
    expect(nav.getByRole("button", { name: "Menu" })).toBeInTheDocument();
  });

  it("marks the destination that matches the current route as current", () => {
    renderNav({ initialPath: `/${ORG}/sessions` });

    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(within(nav).getByRole("link", { name: "Sessions" })).toHaveAttribute(
      "aria-current",
      "page"
    );
    expect(
      within(nav).getByRole("link", { name: "Dashboard" })
    ).not.toHaveAttribute("aria-current");
  });

  it("keeps a destination current on a descendant route", () => {
    renderNav({ initialPath: `/${ORG}/branches/some-branch-id` });

    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(within(nav).getByRole("link", { name: "Branches" })).toHaveAttribute(
      "aria-current",
      "page"
    );
  });
});
