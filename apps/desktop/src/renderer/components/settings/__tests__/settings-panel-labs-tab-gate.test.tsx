/**
 * ISS-5309 — the Settings → Labs TAB is behind the same "Enable Labs"
 * application-menu toggle that hides the sidebar Labs section.
 *
 * These cases mount the REAL {@link DesktopFeatureFlagProvider} rather than a
 * static adapter, because the contract under test is partly about the transport:
 * the tab has to appear and disappear off the live `desktop:flags-changed`
 * broadcast, with no relaunch. A static adapter would let a hard-coded
 * `labsNav` read pass every case here.
 *
 * Absence is asserted directly (`queryByRole(...)` is null), and every case that
 * asserts absence has a sibling that turns the SAME flag on and asserts
 * presence — so a regression that dropped the tab entirely fails, not just one
 * that leaks it.
 */
import type { ApiAdapter } from "@repo/app/shared/api/api-adapter";
import { ApiAdapterProvider } from "@repo/app/shared/api/provider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_AGENTS_NAV_FEATURE_FLAG_KEY,
  DESKTOP_LABS_NAV_FEATURE_FLAG_KEY,
} from "../../../../shared/feature-flags";
import { DesktopFeatureFlagProvider } from "../../../feature-flags/desktop-feature-flag-provider";
import { DesktopAuthProvider } from "../../../shared-agent-sessions/desktop-auth-provider";
import { SettingsPanel } from "../SettingsPanel";
import {
  DEFAULT_SETTINGS_TAB,
  LABS_SETTINGS_TAB,
  resolveVisibleSettingsTab,
  visibleSettingsTabs,
} from "../settings-tabs";

const LABS_TAB_LABEL = "Labs";
const ACCOUNT_TAB_LABEL = "Account";

const inertApiAdapter: ApiAdapter = {
  resolveApiOrigin: () => "http://test.local",
  fetch: () => Promise.reject(new Error("no remote REST API in tests")),
};

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

afterEach(() => {
  cleanup();
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
    return;
  }
  Reflect.deleteProperty(window, "desktopApi");
});

/**
 * Installs a desktopApi whose flag snapshot can be changed and re-broadcast, the
 * way `main/app-menu.ts` does when the user ticks "Enable Labs".
 */
function installDesktopApi(initialLabsNav: boolean) {
  let labsNav = initialLabsNav;
  const listeners: (() => void)[] = [];
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      getSettings: vi.fn(() => Promise.resolve({})),
      getRuntimeStatus: vi.fn(() => Promise.resolve({ isPackaged: true })),
      getCloudCommandsPaused: vi.fn(() => Promise.resolve(false)),
      getCloudConnectionEnabled: vi.fn(() => Promise.resolve(true)),
      getAgentMonitorHooksEnabled: vi.fn(() => Promise.resolve(false)),
      // Read by the Security tab, which one case below deep-links to.
      getDangerousAutoApprove: vi.fn(() => Promise.resolve(false)),
      getApiKeyStatus: vi.fn(() =>
        Promise.resolve({ hasApiKey: false, source: "none" })
      ),
      updateSettings: vi.fn(() => Promise.resolve(undefined)),
      getAllFlags: vi.fn(() =>
        Promise.resolve({
          flags: [
            { key: DESKTOP_LABS_NAV_FEATURE_FLAG_KEY, value: labsNav },
            { key: DESKTOP_AGENTS_NAV_FEATURE_FLAG_KEY, value: false },
          ],
        })
      ),
      onFlagsChanged: vi.fn((listener: () => void) => {
        listeners.push(listener);
      }),
    },
  });

  return {
    /** The `desktop:flags-changed` broadcast, as the provider actually sees it. */
    async broadcastLabsNav(next: boolean) {
      labsNav = next;
      await act(async () => {
        for (const listener of listeners) {
          listener();
        }
        await Promise.resolve();
        await Promise.resolve();
      });
    },
  };
}

function renderPanel(deepLinkTab?: string): void {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ApiAdapterProvider adapter={inertApiAdapter}>
        <DesktopFeatureFlagProvider>
          <DesktopAuthProvider>
            <SettingsPanel deepLinkTab={deepLinkTab} />
          </DesktopAuthProvider>
        </DesktopFeatureFlagProvider>
      </ApiAdapterProvider>
    </QueryClientProvider>
  );
}

function navigateToSettingsTab(tab: string): void {
  act(() => {
    window.dispatchEvent(
      new CustomEvent("desktop:navigate-settings-tab", { detail: tab })
    );
  });
}

function labsTabTrigger(): HTMLElement | null {
  return screen.queryByRole("tab", { name: LABS_TAB_LABEL });
}

describe("ISS-5309 Settings → Labs tab, container gate", () => {
  it("renders neither the Labs tab trigger nor its content while Labs is off", async () => {
    installDesktopApi(false);
    renderPanel();

    // Wait on a tab that is ALWAYS present, so the absence assertion below runs
    // against a settled tab list rather than an empty first frame.
    await screen.findByRole("tab", { name: ACCOUNT_TAB_LABEL });
    await waitFor(() => expect(labsTabTrigger()).toBeNull());
    // The card the tab hosts is gone too, not merely unselected.
    expect(screen.queryByText("Gateway Health")).toBeNull();
    expect(
      screen.queryByText(
        "Early access to experimental features and advanced controls."
      )
    ).toBeNull();
  });

  it("renders the Labs tab once Labs is on", async () => {
    // The mirror of the case above: same mount, same assertions, opposite flag.
    // Without it, deleting the tab outright would still pass the absence case.
    installDesktopApi(true);
    renderPanel();

    expect(
      await screen.findByRole("tab", { name: LABS_TAB_LABEL })
    ).not.toBeNull();
  });

  it("adds and removes the tab live on desktop:flags-changed, with no remount", async () => {
    const api = installDesktopApi(false);
    renderPanel();

    await screen.findByRole("tab", { name: ACCOUNT_TAB_LABEL });
    await waitFor(() => expect(labsTabTrigger()).toBeNull());

    await api.broadcastLabsNav(true);
    await waitFor(() => expect(labsTabTrigger()).not.toBeNull());

    // …and back off again on the same signal, in the same mount.
    await api.broadcastLabsNav(false);
    await waitFor(() => expect(labsTabTrigger()).toBeNull());
  });

  it("falls back to Account when Labs is turned off while the user is on the Labs tab", async () => {
    const api = installDesktopApi(true);
    renderPanel();

    const labsTab = await screen.findByRole("tab", { name: LABS_TAB_LABEL });
    navigateToSettingsTab(LABS_SETTINGS_TAB);
    await waitFor(() =>
      expect(labsTab.getAttribute("aria-selected")).toBe("true")
    );

    await api.broadcastLabsNav(false);

    // No selected-but-empty tab: the trigger is gone AND some other tab owns the
    // selection.
    await waitFor(() => expect(labsTabTrigger()).toBeNull());
    const accountTab = await screen.findByRole("tab", {
      name: ACCOUNT_TAB_LABEL,
    });
    await waitFor(() =>
      expect(accountTab.getAttribute("aria-selected")).toBe("true")
    );
  });

  it("recovers keyboard focus orphaned by the withdrawn Labs trigger", async () => {
    // Radix's roving tabindex means the focused trigger unmounts with the tab,
    // dropping focus to <body>. The panel must hand it to the trigger that took
    // over the selection instead of stranding the user at the top of the page.
    const api = installDesktopApi(true);
    renderPanel();

    const labsTab = await screen.findByRole("tab", { name: LABS_TAB_LABEL });
    navigateToSettingsTab(LABS_SETTINGS_TAB);
    await waitFor(() =>
      expect(labsTab.getAttribute("aria-selected")).toBe("true")
    );
    act(() => labsTab.focus());
    expect(document.activeElement).toBe(labsTab);

    await api.broadcastLabsNav(false);

    const accountTab = await screen.findByRole("tab", {
      name: ACCOUNT_TAB_LABEL,
    });
    await waitFor(() => expect(document.activeElement).toBe(accountTab));
  });

  it("leaves focus alone when it was never on the withdrawn tab", async () => {
    // The mirror of the case above: recovery is for ORPHANED focus only. Moving
    // focus nobody asked to move is its own bug, so a user typing in the search
    // box elsewhere on screen must not get yanked to the tab strip.
    const api = installDesktopApi(true);
    renderPanel();

    await screen.findByRole("tab", { name: LABS_TAB_LABEL });
    navigateToSettingsTab(LABS_SETTINGS_TAB);
    const securityTab = await screen.findByRole("tab", { name: "Security" });
    act(() => securityTab.focus());

    await api.broadcastLabsNav(false);

    await waitFor(() => expect(labsTabTrigger()).toBeNull());
    expect(document.activeElement).toBe(securityTab);
  });

  it("ignores a deep link to the Labs tab while Labs is off", async () => {
    installDesktopApi(false);
    renderPanel();

    const accountTab = await screen.findByRole("tab", {
      name: ACCOUNT_TAB_LABEL,
    });
    await waitFor(() =>
      expect(accountTab.getAttribute("aria-selected")).toBe("true")
    );

    navigateToSettingsTab(LABS_SETTINGS_TAB);

    await waitFor(() => expect(labsTabTrigger()).toBeNull());
    expect(accountTab.getAttribute("aria-selected")).toBe("true");
  });

  it("honours a deep link to the Labs tab once Labs is on", async () => {
    // Proves the case above rejects the link because of the FLAG, not because
    // the deep-link path is broken.
    installDesktopApi(true);
    renderPanel();

    const labsTab = await screen.findByRole("tab", { name: LABS_TAB_LABEL });
    navigateToSettingsTab(LABS_SETTINGS_TAB);

    await waitFor(() =>
      expect(labsTab.getAttribute("aria-selected")).toBe("true")
    );
  });

  it("still routes a deep link to a NON-Labs tab while Labs is off", async () => {
    // The gate must withdraw one tab, not break tab navigation.
    installDesktopApi(false);
    renderPanel();

    const securityTab = await screen.findByRole("tab", { name: "Security" });
    navigateToSettingsTab("security");

    await waitFor(() =>
      expect(securityTab.getAttribute("aria-selected")).toBe("true")
    );
  });
});

/**
 * ISS-5310 (stage cid 3726701529) — the `?tab=` deep link the Labs "turned off"
 * panel's "Open settings" button now carries. It is state the panel reads on
 * mount, not an event it has to be listening for in time, which is the whole
 * reason the button can finally land where its copy says it will.
 */
describe("ISS-5310 Settings deep-link tab", () => {
  it("opens on the Labs tab when the shell hands down ?tab=labs", async () => {
    installDesktopApi(true);
    renderPanel(LABS_SETTINGS_TAB);

    // The settings read resolves AFTER mount and would otherwise reset the panel
    // to Account; waiting on the Account trigger proves that read landed, so a
    // selected Labs tab is the deep link surviving it rather than racing it.
    await screen.findByRole("tab", { name: ACCOUNT_TAB_LABEL });
    await waitFor(() =>
      expect(labsTabTrigger()?.getAttribute("aria-selected")).toBe("true")
    );
  });

  it("still lands on the default tab when no deep link is passed", async () => {
    installDesktopApi(true);
    renderPanel();

    const accountTab = await screen.findByRole("tab", {
      name: ACCOUNT_TAB_LABEL,
    });
    await waitFor(() =>
      expect(accountTab.getAttribute("aria-selected")).toBe("true")
    );
    expect(labsTabTrigger()?.getAttribute("aria-selected")).toBe("false");
  });

  it("ignores a ?tab=labs deep link while the Labs gate is closed", async () => {
    installDesktopApi(false);
    renderPanel(LABS_SETTINGS_TAB);

    const accountTab = await screen.findByRole("tab", {
      name: ACCOUNT_TAB_LABEL,
    });
    await waitFor(() =>
      expect(accountTab.getAttribute("aria-selected")).toBe("true")
    );
    expect(labsTabTrigger()).toBeNull();
  });
});

describe("ISS-5309 settings tab model", () => {
  it("drops only the Labs tab when the gate is closed", () => {
    const on = visibleSettingsTabs(true).map((t) => t.id);
    const off = visibleSettingsTabs(false).map((t) => t.id);

    expect(on).toContain(LABS_SETTINGS_TAB);
    expect(off).not.toContain(LABS_SETTINGS_TAB);
    // Set difference, not a count: a future tab must not turn this red, and a
    // gate that dropped a second tab must.
    expect(on.filter((id) => id !== LABS_SETTINGS_TAB)).toEqual(off);
  });

  it("resolves a restored or deep-linked 'labs' selection to the default while off", () => {
    // A relaunch cannot bring the tab back: whatever selection reaches the panel,
    // `"labs"` resolves to Account while the gate is closed.
    expect(resolveVisibleSettingsTab(LABS_SETTINGS_TAB, false)).toBe(
      DEFAULT_SETTINGS_TAB
    );
    expect(resolveVisibleSettingsTab(LABS_SETTINGS_TAB, true)).toBe(
      LABS_SETTINGS_TAB
    );
  });

  it("leaves every other selection alone, gate open or closed", () => {
    for (const tab of visibleSettingsTabs(false)) {
      expect(resolveVisibleSettingsTab(tab.id, false)).toBe(tab.id);
      expect(resolveVisibleSettingsTab(tab.id, true)).toBe(tab.id);
    }
  });
});
