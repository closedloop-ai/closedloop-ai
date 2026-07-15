import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsPanel } from "../SettingsPanel";

// FEA-2842: the Settings toggles await a desktopApi IPC call with no try/catch,
// so a rejected IPC became an unhandled promise rejection and the toggle
// silently snapped back with no feedback. These tests mount the real
// SettingsPanel, reject the underlying IPC, and assert an inline error surfaces
// (and the toggle stays off) instead of failing silently.

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

type DesktopApiOverrides = Record<string, ReturnType<typeof vi.fn>>;

function installDesktopApi(overrides: DesktopApiOverrides = {}): void {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      // SettingsPanel + the default relay-gateway tab mount-time reads.
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
    render(<SettingsPanel />);

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
    render(<SettingsPanel />);
    await openSecurityTab();

    const toggle = screen.getByRole("switch", {
      name: "Dangerous Auto-Approve",
    });
    fireEvent.click(toggle);

    await screen.findByText("auto-approve IPC failed");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("clears a prior toggle error once the IPC succeeds", async () => {
    const setCloudConnectionEnabled = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection IPC failed"))
      .mockResolvedValueOnce(undefined);
    installDesktopApi({ setCloudConnectionEnabled });
    render(<SettingsPanel />);

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
