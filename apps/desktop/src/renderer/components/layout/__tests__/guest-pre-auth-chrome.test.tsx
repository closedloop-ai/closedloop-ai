/**
 * ISS-5112 (PLN-1600 Step D): the app chrome a GUEST sees.
 *
 * Signed out, the sidebar footer trigger reads an organization name (falling
 * back to "Account") and the invite item opens a dialog that mints Clerk
 * invitations against an org id — both claim something a guest does not have.
 * The acceptance criterion is blunt about it: no pre-auth surface displays a
 * user name, org name, or workspace the app cannot know.
 *
 * Every case is asserted from the signed-out side, which since ISS-7995 is the
 * whole gate: guest chrome turns on auth alone, with no Labs flag above it.
 */

import { SidebarProvider } from "@closedloop-ai/design-system/components/ui/sidebar";
import {
  WORKSPACE_MENU_ENTRY_LABEL,
  WorkspaceMenuEntryId,
} from "@repo/api/src/types/workspace-menu";
import { GETTING_STARTED_CARD_LABEL } from "@repo/app/onboarding/components/getting-started-card-shell";
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
import { stubLocalStorage } from "../../../__tests__/local-storage-stub";
import { NavId } from "../../../navigation/route-table";
import { DesktopAppCoreProvider } from "../../../shared-agent-sessions/desktop-app-core-provider";
import {
  dashboardOnboardedStorageKey,
  writeFlag,
} from "../../dashboard/dashboard-storage-keys";
import { seedDashboardRecord } from "../../onboarding/__tests__/guest-guided-onboarding-handoff-fixtures";
import { Sidebar } from "../Sidebar";
import { Topbar } from "../Topbar";

const SIGN_UP_LABEL =
  WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.CreateAccount];
const ACCOUNT_MENU_TRIGGER_NAME = "Open account menu";

beforeAll(() => {
  // jsdom shims — the renderer vitest config has no global setup. Radix's popper
  // measures its trigger through `ResizeObserver`, so opening the account menu
  // throws without this and takes the whole tree down with it (same pattern as
  // agents-view-parity.test.tsx).
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: class {
      disconnect = vi.fn();
      observe = vi.fn();
      unobserve = vi.fn();
    },
  });
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
  // An empty bridge: auth fails closed to signed-out, which IS the guest case.
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {},
  });
  // A returning guest parked on the Dashboard, so the sidebar's onboarding host
  // publishes a guest run with its modal closed. Without a store the run cannot
  // be read, and every guest account entry point is withheld (ISS-11480).
  stubLocalStorage();
  writeFlag(dashboardOnboardedStorageKey);
  seedDashboardRecord();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// No feature-flag adapter of its own: `DesktopAppCoreProvider` installs a static
// all-flags-off one, which is what the sidebar's gated session-limits footer
// reads. No assertion below depends on a flag being on.
function renderChrome() {
  const memoryNav = createMemoryNavigation({ initialPath: "/sessions" });
  return render(
    <DesktopAppCoreProvider>
      <NavigationProvider adapter={memoryNav.adapter}>
        <SidebarProvider>
          <Sidebar activeNav={NavId.Sessions} />
          <Topbar breadcrumbs={[{ label: "Sessions" }]} />
        </SidebarProvider>
      </NavigationProvider>
    </DesktopAppCoreProvider>
  );
}

describe("guest pre-auth chrome (ISS-5112)", () => {
  it("reads the footer trigger as Guest, naming no account the guest does not have", async () => {
    renderChrome();

    const trigger = await screen.findByRole("button", {
      name: ACCOUNT_MENU_TRIGGER_NAME,
    });
    expect(trigger.textContent).toContain("Guest");
    // The signed-in trigger reads an organization name and falls back to the
    // generic "Account" — both claim something this device cannot know.
    expect(screen.queryByText("Account")).toBeNull();
  });

  it("keeps Settings and Diagnostics reachable in guest mode", async () => {
    // Regression guard (cr-44060). Settings and Diagnostics have no other link
    // site in the renderer and no Electron app-menu entry. A guest branch that
    // replaced the whole dropdown with a bare button stranded a signed-out user
    // with no route to either.
    renderChrome();

    const trigger = await screen.findByRole("button", {
      name: ACCOUNT_MENU_TRIGGER_NAME,
    });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });

    const menu = await screen.findByRole("menu");
    expect(
      within(menu)
        .getByRole("menuitem", { name: "Settings" })
        .getAttribute("href")
    ).toBe("/settings");
    expect(
      within(menu)
        .getByRole("menuitem", { name: "Diagnostics" })
        .getAttribute("href")
    ).toBe("/diagnostics");
    expect(within(menu).getByRole("menuitem", { name: "Theme" })).toBeDefined();
  });

  it("offers the account from inside that same menu", async () => {
    renderChrome();

    const trigger = await screen.findByRole("button", {
      name: ACCOUNT_MENU_TRIGGER_NAME,
    });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });

    const menu = await screen.findByRole("menu");
    // "Create account", not "Sign In": desktop auth is one loopback OAuth door,
    // so a second name here promises a path that does not exist — and this item
    // reopens the onboarding at its Account step (ISS-11480).
    fireEvent.click(
      within(menu).getByRole("menuitem", { name: SIGN_UP_LABEL })
    );

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("button", { name: "Continue with GitHub" })
    ).toBeDefined();
  });

  it("keeps the standing offer OFF the window chrome", async () => {
    renderChrome();

    // The offer used to live in the Topbar, which follows the guest onto
    // Sessions, Branches, Agents and Settings — screens an account changes
    // nothing about, where a filled primary was the loudest thing present.
    // ISS-10942 settled where it does live: the sidebar's Getting started
    // module. So exactly ONE standing offer is in guest chrome, and it is that
    // module's — not a second one floating in the window chrome above it.
    await screen.findByRole("button", { name: ACCOUNT_MENU_TRIGGER_NAME });

    const offers = screen.getAllByRole("button", { name: SIGN_UP_LABEL });
    expect(offers).toHaveLength(1);
    expect(offers[0]?.closest("section")?.getAttribute("aria-label")).toBe(
      GETTING_STARTED_CARD_LABEL
    );
  });

  // ISS-10942 retired the guest invite door. A guest has no organization to
  // invite anyone into, so that row was a signup door wearing an invite label;
  // the Getting started module asserted above replaced it. The two cases that
  // pinned its ask and its "Bring your team" copy are deleted with it.
});
