import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DesktopAuthProvider } from "../../../shared-agent-sessions/desktop-auth-provider";
import { SettingsPanel } from "../SettingsPanel";

function installDesktopApi(settings: Record<string, unknown>) {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      getSettings: vi.fn(() => Promise.resolve(settings)),
      // The default relay-gateway tab mounts on render and reads runtime state.
      getRuntimeStatus: vi.fn(() => new Promise(() => undefined)),
      getCloudCommandsPaused: vi.fn(() => Promise.resolve(false)),
      getCloudConnectionEnabled: vi.fn(() => Promise.resolve(true)),
      getAgentMonitorHooksEnabled: vi.fn(() => Promise.resolve(false)),
    },
  });
}

// When the flag is on the Account tab is selected by default, so its
// DesktopAccountTab mounts and reads `useDesktopAuth()` — wrap in the provider.
// The bare desktopApi stub above omits the auth bridge, so it settles signed-out.
function renderPanel(): void {
  render(
    <DesktopAuthProvider>
      <SettingsPanel />
    </DesktopAuthProvider>
  );
}

describe("SettingsPanel account-tab gating (FEA-2219)", () => {
  it("hides the Account tab when the first-party-auth flag is off", async () => {
    installDesktopApi({ desktopFirstPartyAuthEnabled: false });
    renderPanel();

    // Wait for the panel's async settings load to settle.
    await screen.findByRole("tab", { name: "Relay / Gateway" });
    expect(screen.queryByRole("tab", { name: "Account" })).toBeNull();
  });

  it("shows the Account tab, selected by default, when the flag is on", async () => {
    installDesktopApi({ desktopFirstPartyAuthEnabled: true });
    renderPanel();

    const accountTab = await screen.findByRole("tab", { name: "Account" });
    // The default lands on Account (the first visible tab), not Relay / Gateway.
    await waitFor(() =>
      expect(accountTab.getAttribute("aria-selected")).toBe("true")
    );
  });
});
