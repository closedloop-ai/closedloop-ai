/**
 * @file sidebar-account-menu.test.tsx
 * @description Desktop-renderer interaction test for the sidebar footer
 * {@link Sidebar} account menu (ISS-4478). Diagnostics + Settings moved out of
 * the top-level sidebar nav into the bottom-left account menu, mirroring web's
 * AccountMenu. This mounts the Sidebar under the real app-core provider stack +
 * the in-memory navigation adapter and asserts: the account destinations are not
 * top-level sidebar links; they render as menu items (Settings before
 * Diagnostics); the trigger reads as an account slot rather than product
 * branding; and the active destination carries a trailing check.
 *
 * Extracted from `renderer/__tests__/app-shell.test.tsx` so that grandfathered,
 * over-ceiling file shrinks rather than accumulating more responsibilities
 * (ISS-4478 review).
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
import { NavId } from "../../../navigation/route-table";
import { DesktopAppCoreProvider } from "../../../shared-agent-sessions/desktop-app-core-provider";
import { Sidebar } from "../Sidebar";

const ACCOUNT_MENU_TRIGGER_NAME = "Open account menu";

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

function renderSidebar(activeNav: NavId) {
  const memoryNav = createMemoryNavigation({ initialPath: "/sessions" });
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
    expect(screen.queryByRole("link", { name: "Settings" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Diagnostics" })).toBeNull();

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
    // (ISS-4478 review). With the identity bridge absent it falls back to the
    // generic "Account" account slot rather than a brand string.
    const trigger = await screen.findByRole("button", {
      name: ACCOUNT_MENU_TRIGGER_NAME,
    });
    expect(trigger.textContent).toContain("Account");
    expect(trigger.textContent).not.toContain("Closedloop Gateway");
  });

  it("marks the active account destination with a trailing check", async () => {
    renderSidebar(NavId.Settings);

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
    // aria-current drives the active treatment; a trailing check renders off it
    // (mirrors web's active-org CheckIcon) so the open menu shows you are here.
    expect(settingsItem.getAttribute("aria-current")).toBe("page");
    expect(diagnosticsItem.getAttribute("aria-current")).toBeNull();
    // The active item carries its leading nav icon PLUS the trailing check svg;
    // the inactive item carries only its leading icon.
    expect(settingsItem.querySelectorAll("svg")).toHaveLength(2);
    expect(diagnosticsItem.querySelectorAll("svg")).toHaveLength(1);
  });
});
