import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthProvider } from "../../../shared-agent-sessions/desktop-auth-provider";
import { SettingsPanel } from "../SettingsPanel";

// FEA-2842: the Settings toggles await a desktopApi IPC call with no try/catch,
// so a rejected IPC became an unhandled promise rejection and the toggle
// silently snapped back with no feedback. These tests mount the real
// SettingsPanel, reject the underlying IPC, and assert an inline error surfaces
// (and the toggle stays off) instead of failing silently.
//
// FEA-4133: the always-on Account tab is now selected by default, so
// DesktopAccountTab mounts on render and reads `useDesktopAuth()` +
// `useFeatureFlagEnabled` — both ports must be present or the whole panel throws
// and no tab renders. The Relay/Gateway tab's toggles mount alongside the
// default Account tab, so its switches are reachable without switching tabs. The
// bare desktopApi stub omits the auth bridge, so auth settles signed-out; the
// unified-auth-onboarding flag stays off (PRD-532 dark-launch default).

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

// FEA-3219: assert the cleaned message never leaks Electron's IPC wrapper.
const IPC_CHANNEL_NAME_RE = /desktop:set-cloud-commands-paused/;
const IPC_WRAPPER_RE = /invoking remote method/;

type DesktopApiOverrides = Record<string, ReturnType<typeof vi.fn>>;

function installDesktopApi(overrides: DesktopApiOverrides = {}): void {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      // SettingsPanel + the Relay/Gateway tab mount-time reads.
      getSettings: vi.fn(async () => ({})),
      getRuntimeStatus: vi.fn(() => new Promise(() => undefined)),
      getCloudCommandsPaused: vi.fn(async () => false),
      getCloudConnectionEnabled: vi.fn(async () => true),
      getAgentMonitorHooksEnabled: vi.fn(async () => false),
      setCloudCommandsPaused: vi.fn(async () => undefined),
      setCloudConnectionEnabled: vi.fn(async () => undefined),
      setAgentMonitorHooksEnabled: vi.fn(async () => ({ enabled: true })),
      // SecurityTab mount-time reads.
      getDangerousAutoApprove: vi.fn(async () => false),
      setDangerousAutoApprove: vi.fn(async () => undefined),
      getApiKeyStatus: vi.fn(async () => ({
        hasApiKey: false,
        source: "none",
      })),
      ...overrides,
    },
  });
}

async function openSecurityTab(): Promise<void> {
  act(() => {
    window.dispatchEvent(
      new CustomEvent("desktop:navigate-settings-tab", { detail: "security" })
    );
  });
  await screen.findByText("Security Settings");
}

// FEA-4133: Account is the default tab and Radix unmounts inactive TabsContent,
// so the Relay/Gateway toggles (Pause, Cloud Connection) only mount once that
// tab is selected. Navigate there after render; the Security-tab test then
// re-navigates to Security via openSecurityTab().
function renderPanel(): void {
  render(
    <FeatureFlagAdapterProvider adapter={createStaticFeatureFlagAdapter()}>
      <DesktopAuthProvider>
        <SettingsPanel />
      </DesktopAuthProvider>
    </FeatureFlagAdapterProvider>
  );
  act(() => {
    window.dispatchEvent(
      new CustomEvent("desktop:navigate-settings-tab", {
        detail: "relay-gateway",
      })
    );
  });
}

afterEach(() => {
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
});

describe("SettingsPanel toggle IPC error handling (FEA-2842)", () => {
  it("shows an inline error and keeps Pause off when the IPC rejects", async () => {
    installDesktopApi({
      setCloudCommandsPaused: vi
        .fn()
        .mockRejectedValue(new Error("pause IPC failed")),
    });
    renderPanel();

    const toggle = await screen.findByRole("switch", {
      name: "Pause Incoming Commands",
    });
    fireEvent.click(toggle);

    await screen.findByText("pause IPC failed");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("shows an inline error and keeps Dangerous Auto-Approve off when the IPC rejects", async () => {
    installDesktopApi({
      setDangerousAutoApprove: vi
        .fn()
        .mockRejectedValue(new Error("auto-approve IPC failed")),
    });
    renderPanel();
    await openSecurityTab();

    const toggle = screen.getByRole("switch", {
      name: "Dangerous Auto-Approve",
    });
    fireEvent.click(toggle);

    await screen.findByText("auto-approve IPC failed");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("renders a clean message when the IPC rejection carries Electron's wrapper (FEA-3219)", async () => {
    installDesktopApi({
      setCloudCommandsPaused: vi
        .fn()
        .mockRejectedValue(
          new Error(
            "Error invoking remote method 'desktop:set-cloud-commands-paused': Error: pause is disabled"
          )
        ),
    });
    renderPanel();

    const toggle = await screen.findByRole("switch", {
      name: "Pause Incoming Commands",
    });
    fireEvent.click(toggle);

    // The underlying human message surfaces without the IPC channel name or a
    // doubled `Error:` prefix.
    await screen.findByText("pause is disabled");
    expect(screen.queryByText(IPC_CHANNEL_NAME_RE)).toBeNull();
    expect(screen.queryByText(IPC_WRAPPER_RE)).toBeNull();
  });

  it("clears a prior toggle error once the IPC succeeds", async () => {
    const setCloudConnectionEnabled = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection IPC failed"))
      .mockResolvedValueOnce(undefined);
    installDesktopApi({ setCloudConnectionEnabled });
    renderPanel();

    const toggle = await screen.findByRole("switch", {
      name: "Cloud Connection",
    });

    fireEvent.click(toggle);
    await screen.findByText("connection IPC failed");

    fireEvent.click(toggle);
    await waitFor(() =>
      expect(screen.queryByText("connection IPC failed")).toBeNull()
    );
  });
});
