import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopAppPanel } from "../../../settings-v2/panels/desktop-app-panel";
import { DesktopAuthProvider } from "../../../shared-agent-sessions/desktop-auth-provider";
import { desktopAppPanelMountReads } from "./desktop-app-panel-mount-reads";

// FEA-2842: the Settings toggles await a desktopApi IPC call with no try/catch,
// so a rejected IPC became an unhandled promise rejection and the toggle
// silently snapped back with no feedback. These tests mount the real
// DesktopAppPanel, reject the underlying IPC, and assert an inline error
// surfaces (and the toggle stays off) instead of failing silently.
//
// The blocks read `useFeatureFlagEnabled` and the desktop auth context, so both
// ports must be present or the panel throws and nothing renders. The bare
// desktopApi stub omits the auth bridge, so auth settles signed-out.

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
      ...desktopAppPanelMountReads(),
      setCloudCommandsPaused: vi.fn(async () => undefined),
      setCloudConnectionEnabled: vi.fn(async () => undefined),
      setAgentMonitorHooksEnabled: vi.fn(async () => ({ enabled: true })),
      ...overrides,
    },
  });
}

async function awaitSecuritySection(): Promise<void> {
  await screen.findByText("Security Settings");
}

// ISS-10246: the panel renders every block at once, so both the Relay / Gateway
// toggles and the Security section mount on render with no tab to select.
function renderPanel(): void {
  render(
    <FeatureFlagAdapterProvider adapter={createStaticFeatureFlagAdapter()}>
      <DesktopAuthProvider>
        <DesktopAppPanel />
      </DesktopAuthProvider>
    </FeatureFlagAdapterProvider>
  );
}

afterEach(() => {
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
});

describe("Settings Desktop App toggle IPC error handling (FEA-2842)", () => {
  it("shows an inline error and keeps Pause off when the IPC rejects", async () => {
    const setCloudCommandsPaused = vi
      .fn()
      .mockRejectedValue(new Error("pause IPC failed"));
    installDesktopApi({ setCloudCommandsPaused });
    renderPanel();

    const toggle = await findEnabledSwitch("Pause Incoming Commands");
    fireEvent.click(toggle);
    expect(setCloudCommandsPaused).toHaveBeenCalledExactlyOnceWith(true);

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
    await awaitSecuritySection();

    const toggle = screen.getByRole("switch", {
      name: "Dangerous Auto-Approve",
    });
    fireEvent.click(toggle);

    await screen.findByText("auto-approve IPC failed");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("renders a clean message when the IPC rejection carries Electron's wrapper (FEA-3219)", async () => {
    const setCloudCommandsPaused = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "Error invoking remote method 'desktop:set-cloud-commands-paused': Error: pause is disabled"
        )
      );
    installDesktopApi({ setCloudCommandsPaused });
    renderPanel();

    const toggle = await findEnabledSwitch("Pause Incoming Commands");
    fireEvent.click(toggle);
    expect(setCloudCommandsPaused).toHaveBeenCalledExactlyOnceWith(true);

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

    const toggle = await findEnabledSwitch("Cloud Connection");

    fireEvent.click(toggle);
    expect(setCloudConnectionEnabled).toHaveBeenNthCalledWith(1, false);
    await screen.findByText("connection IPC failed");

    fireEvent.click(toggle);
    expect(setCloudConnectionEnabled).toHaveBeenNthCalledWith(2, false);
    await waitFor(() =>
      expect(screen.queryByText("connection IPC failed")).toBeNull()
    );
  });
});

// The Relay / Gateway switches stay disabled until the mount reads settle; a
// click before then is ignored.
async function findEnabledSwitch(name: string): Promise<HTMLElement> {
  const toggle = await screen.findByRole("switch", { name });
  await waitFor(() =>
    expect((toggle as HTMLButtonElement).disabled).toBe(false)
  );
  return toggle;
}
