import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsPanel } from "../SettingsPanel";

// Behavioral replacement for the old renderer-logs-static source-text guard:
// mount the real SettingsPanel, navigate to the Security tab, and assert the
// SecurityTab wires the desktop API-key IPC (getApiKeyStatus on mount,
// setApiKey / clearApiKey on the Set / Clear controls).

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

type SecurityApi = {
  getApiKeyStatus: ReturnType<typeof vi.fn>;
  setApiKey: ReturnType<typeof vi.fn>;
  clearApiKey: ReturnType<typeof vi.fn>;
};

function installDesktopApi(overrides: Partial<SecurityApi> = {}): SecurityApi {
  const api: SecurityApi = {
    getApiKeyStatus: vi.fn(async () => ({
      hasApiKey: true,
      source: "stored",
    })),
    setApiKey: vi.fn(async () => undefined),
    clearApiKey: vi.fn(async () => undefined),
    ...overrides,
  };
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      // SettingsPanel + the default relay-gateway tab mount-time reads.
      getSettings: vi.fn(async () => ({})),
      getRuntimeStatus: vi.fn(() => new Promise(() => undefined)),
      getCloudCommandsPaused: vi.fn(async () => false),
      getCloudConnectionEnabled: vi.fn(async () => true),
      getAgentMonitorHooksEnabled: vi.fn(async () => false),
      // SecurityTab mount-time reads.
      getDangerousAutoApprove: vi.fn(async () => false),
      setDangerousAutoApprove: vi.fn(async () => undefined),
      ...api,
    },
  });
  return api;
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

describe("SettingsPanel Security tab API-key controls", () => {
  it("reads the API key status on mount", async () => {
    const api = installDesktopApi();
    render(<SettingsPanel />);

    await openSecurityTab();

    await waitFor(() => expect(api.getApiKeyStatus).toHaveBeenCalled());
  });

  it("stores a typed key through setApiKey when Set is clicked", async () => {
    const api = installDesktopApi();
    render(<SettingsPanel />);
    await openSecurityTab();

    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: "sk_live_example" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set" }));

    await waitFor(() =>
      expect(api.setApiKey).toHaveBeenCalledWith("sk_live_example")
    );
  });

  it("removes the stored key through clearApiKey when Clear is clicked", async () => {
    const api = installDesktopApi();
    render(<SettingsPanel />);
    await openSecurityTab();

    const clearButton = screen.getByRole("button", { name: "Clear" });
    await waitFor(() =>
      expect((clearButton as HTMLButtonElement).disabled).toBe(false)
    );
    fireEvent.click(clearButton);

    await waitFor(() => expect(api.clearApiKey).toHaveBeenCalled());
  });
});
