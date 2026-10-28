/**
 * @file sidebar-account-menu.test.tsx
 * @description Desktop-renderer interaction test for the sidebar footer
 * {@link Sidebar} account menu (ISS-4478). Diagnostics + Settings moved out of
 * the top-level sidebar nav into the bottom-left account menu, mirroring web's
 * AccountMenu. This mounts the Sidebar under the real app-core provider stack +
 * the in-memory navigation adapter and asserts: the account destinations are not
 * top-level sidebar links; they render as menu items (Settings before
 * Diagnostics); and the trigger reads as an account slot rather than product
 * branding.
 *
 * ISS-10195 retired the workspace-experience gate, so the legacy footer account
 * menu is gone and the shared `WorkspaceMenu` behind the same trigger is what
 * every desktop launch renders. It marks no active destination, so the
 * trailing-check case that pinned that treatment went with the component that
 * carried it.
 *
 * Extracted from the former monolithic `renderer/__tests__/app-shell.test.tsx`
 * rather than accumulating another responsibility there (ISS-4478 review); that
 * file has since been split into the `app-shell-*.test.tsx` siblings.
 */
import { SidebarProvider } from "@closedloop-ai/design-system/components/ui/sidebar";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { pageTitleForNav } from "../../../navigation/nav-config";
import { NavId } from "../../../navigation/route-table";
import { DesktopAppCoreProvider } from "../../../shared-agent-sessions/desktop-app-core-provider";
import { Sidebar } from "../Sidebar";

const guidedGettingStartedCardSpy = vi.hoisted(() => vi.fn());
const ACCOUNT_MENU_TRIGGER_NAME = "Open account menu";

vi.mock("@repo/app/onboarding/components/guided-getting-started-card", () => ({
  GuidedGettingStartedCard: (props: Record<string, unknown>) => {
    guidedGettingStartedCardSpy(props);
    return null;
  },
}));

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      addEventListener: vi.fn(),
      addListener: vi.fn(),
      dispatchEvent: vi.fn(),
      matches: false,
      media: "",
      onchange: null,
      removeEventListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
});

beforeEach(() => {
  guidedGettingStartedCardSpy.mockClear();
  // A partial stub: the sidebar reads session limits + auth/identity through the
  // bridge, all of which fail closed when absent. That leaves the account label
  // at its generic "Account" fallback and the session-limits footer hidden, which
  // is exactly the signed-out/bridge-absent contract under test.
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {},
  });
});

afterEach(() => {
  cleanup();
});

function renderSidebar(activeNav: NavId, initialPath = "/sessions") {
  const memoryNav = createMemoryNavigation({ initialPath });
  return render(
    <DesktopAppCoreProvider>
      <NavigationProvider adapter={memoryNav.adapter}>
        <SidebarProvider>
          <Sidebar activeNav={activeNav} />
        </SidebarProvider>
      </NavigationProvider>
    </DesktopAppCoreProvider>
  );
}

describe("Sidebar footer account menu (ISS-4478)", () => {
  it("hosts Settings and Diagnostics in the account menu, not the top-level nav", async () => {
    renderSidebar(NavId.Sessions);

    // Neither is a top-level sidebar nav link now — they live behind the menu.
    expect(
      screen.queryByRole("link", { name: pageTitleForNav(NavId.Settings) })
    ).toBeNull();
    expect(
      screen.queryByRole("link", { name: pageTitleForNav(NavId.Diagnostics) })
    ).toBeNull();

    const trigger = await screen.findByRole("button", {
      name: ACCOUNT_MENU_TRIGGER_NAME,
    });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });

    const menu = await screen.findByRole("menu");
    const settingsItem = within(menu).getByRole("menuitem", {
      name: "Settings",
    });
    const diagnosticsItem = within(menu).getByRole("menuitem", {
      name: "Diagnostics",
    });
    // Under the in-memory navigation adapter the port Link renders the plain
    // path (the production hash adapter is what hash-prefixes it, FEA-4018).
    expect(settingsItem.getAttribute("href")).toBe("/settings");
    expect(diagnosticsItem.getAttribute("href")).toBe("/diagnostics");

    // Settings is listed before Diagnostics — it is what people look for; a
    // troubleshooting page must not sit above it (ISS-4478 review). The account
    // links render before the Theme menuitem, so compare their DOM order.
    const accountItemNames = within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent);
    const settingsIndex = accountItemNames.findIndex((text) =>
      text?.includes("Settings")
    );
    const diagnosticsIndex = accountItemNames.findIndex((text) =>
      text?.includes("Diagnostics")
    );
    expect(settingsIndex).toBeGreaterThanOrEqual(0);
    expect(settingsIndex).toBeLessThan(diagnosticsIndex);

    // Theme controls stay in the same menu, below the account links.
    expect(within(menu).getByRole("menuitem", { name: "Theme" })).toBeDefined();
  });

  it("labels the trigger as an account slot, not product branding", async () => {
    renderSidebar(NavId.Sessions);

    // The trigger must read as "me and my stuff" so someone hunting for Settings
    // has a target — no longer the "Closedloop Gateway" product-branding label
    // (ISS-4478 review).
    //
    // This fixture is a settled signed-out device, and since ISS-7995 retired the
    // `guest-onboarding` flag that is unconditionally a GUEST: the slot says so
    // rather than falling back to the generic "Account", because "Account" claims
    // a thing a guest does not have (ISS-5112). Either way it is an account slot
    // and never a brand string, which is what this case exists to hold.
    const trigger = await screen.findByRole("button", {
      name: ACCOUNT_MENU_TRIGGER_NAME,
    });
    expect(trigger.textContent).toContain("Guest");
    expect(trigger.textContent).not.toContain("Closedloop Gateway");
  });

  // ISS-10942: "preserves the current desktop search params in the sync
  // Settings return target" MOVED to `sidebar-workspace-experience.test.tsx`.
  // This fixture is a settled signed-out device, and a guest now gets the local
  // Getting started module rather than the server-owned card that case asserts
  // on; the contract itself is unchanged and is pinned there against the
  // authenticated fixture it actually describes.
});
