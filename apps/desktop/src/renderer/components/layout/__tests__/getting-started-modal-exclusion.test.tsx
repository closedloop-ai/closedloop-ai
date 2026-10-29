/**
 * ISS-11751 — the sidebar's Getting started module does not stand under the
 * guided-onboarding takeover.
 *
 * The takeover mounts as a SIBLING of the shell, so the footer keeps painting
 * underneath it. What the reader got was the module restating the very step the
 * modal was asking, carrying a press that opens a second signup door over the
 * first. ISS-10570 settled how every other party in this position answers "is
 * the takeover up?" — `blocking-onboarding-modal-store`, written by the dialog
 * host's `onOpenChange` — and the footer was the one that never asked.
 *
 * Driven through the real `Sidebar` rather than the footer alone, because the
 * store's whole reason to exist is that the two parties are in different trees:
 * a fixture that mounts only the footer proves the gate reads a boolean, not
 * that the boolean reaches it from where the modal writes it.
 *
 * Every SUPPRESSION here pairs with the release on the SAME fixture. "The
 * module is absent" is also what a guest who cannot be offered an account, a
 * broken bridge and an unmounted tree all look like, so the release is what
 * proves this fixture could have rendered it.
 */

import { SidebarProvider } from "@closedloop-ai/design-system/components/ui/sidebar";
import { PendingOnboardingStep } from "@repo/api/src/types/onboarding-phase";
import {
  GETTING_STARTED_CARD_LABEL,
  GETTING_STARTED_STEP_CONTENT,
} from "@repo/app/onboarding/components/getting-started-card-shell";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { act, cleanup, render, screen } from "@testing-library/react";
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
import { setBlockingOnboardingModalOpen } from "../../onboarding/blocking-onboarding-modal-store";
import { Sidebar } from "../Sidebar";

/** The guest's leading step, named from the canonical map the card renders. */
const CREATE_ACCOUNT_LABEL =
  GETTING_STARTED_STEP_CONTENT[PendingOnboardingStep.CreateAccount].label;

beforeAll(() => {
  // jsdom shims — the renderer vitest config has no global setup, and the
  // sidebar's Radix popper measures its trigger through `ResizeObserver`.
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
  // An empty bridge: auth fails closed to signed-out, which IS the guest whose
  // module this is — its context is settled rather than measured, so nothing
  // here has to resolve for the card to paint.
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {},
  });
  stubLocalStorage();
  writeFlag(dashboardOnboardedStorageKey);
  seedDashboardRecord();
  setBlockingOnboardingModalOpen(false);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setBlockingOnboardingModalOpen(false);
});

function renderSidebar() {
  const memoryNav = createMemoryNavigation({ initialPath: "/sessions" });
  return render(
    <DesktopAppCoreProvider>
      <NavigationProvider adapter={memoryNav.adapter}>
        <SidebarProvider>
          <Sidebar activeNav={NavId.Sessions} />
        </SidebarProvider>
      </NavigationProvider>
    </DesktopAppCoreProvider>
  );
}

function gettingStartedModule(): HTMLElement | null {
  return screen.queryByRole("region", { name: GETTING_STARTED_CARD_LABEL });
}

describe("Getting started module vs the guided-onboarding takeover (ISS-11751)", () => {
  it("withholds the module while the takeover is open, and restores it on close", async () => {
    renderSidebar();
    await screen.findByRole("button", { name: "Open account menu" });
    expect(gettingStartedModule()).not.toBeNull();

    act(() => {
      setBlockingOnboardingModalOpen(true);
    });
    expect(gettingStartedModule()).toBeNull();

    // The release. A takeover covers this control; it does not retire it.
    act(() => {
      setBlockingOnboardingModalOpen(false);
    });
    expect(gettingStartedModule()).not.toBeNull();
  });

  it("withholds the module's account offer too, not just its frame", async () => {
    // The press is the half that actually collides: it opens
    // `GuestSignupDialogHost` over a takeover that is already asking for the
    // account. A gate that hid the card's chrome and left a reachable control
    // behind would pass the case above.
    renderSidebar();
    const offer = await screen.findByRole("button", {
      name: CREATE_ACCOUNT_LABEL,
    });
    expect(offer.closest("section")?.getAttribute("aria-label")).toBe(
      GETTING_STARTED_CARD_LABEL
    );

    act(() => {
      setBlockingOnboardingModalOpen(true);
    });
    expect(
      screen.queryByRole("button", { name: CREATE_ACCOUNT_LABEL })
    ).toBeNull();

    act(() => {
      setBlockingOnboardingModalOpen(false);
    });
    expect(
      screen.queryByRole("button", { name: CREATE_ACCOUNT_LABEL })
    ).not.toBeNull();
  });
});
