/**
 * @file settings-panel-data-collection.test.tsx
 * @description FEA-3741 (slice 1) — the CLI Tools tab renders a "Data
 * Collection" card with a per-tool ON/OFF switch for each collectable agent
 * tool (Claude/Cursor/Copilot), defaulting ON and persisting a toggle through
 * the updateSettings IPC.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsPanel } from "../SettingsPanel";

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

type SettingsRecord = Record<string, unknown>;

function installDesktopApi(initial: SettingsRecord = {}): {
  updateSettings: ReturnType<typeof vi.fn>;
  settings: SettingsRecord;
} {
  const settings: SettingsRecord = { ...initial };
  const updateSettings = vi.fn((patch: SettingsRecord) => {
    Object.assign(settings, patch);
    return Promise.resolve(settings);
  });
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      getSettings: vi.fn(async () => ({ ...settings })),
      getRuntimeStatus: vi.fn(() => new Promise(() => undefined)),
      getCloudCommandsPaused: vi.fn(async () => false),
      getCloudConnectionEnabled: vi.fn(async () => true),
      getAgentMonitorHooksEnabled: vi.fn(async () => false),
      getBinaryPaths: vi.fn(async () => ({ claude: "/usr/bin/claude" })),
      detectCliTools: vi.fn(async () => undefined),
      patchBinaryPaths: vi.fn(async () => undefined),
      updateSettings,
    },
  });
  return { updateSettings, settings };
}

function openCliToolsTab() {
  act(() => {
    window.dispatchEvent(
      new CustomEvent("desktop:navigate-settings-tab", {
        detail: "binary-paths",
      })
    );
  });
}

describe("SettingsPanel Data Collection toggles (FEA-3741)", () => {
  it("renders a per-tool collection switch, defaulting ON when the setting is absent", async () => {
    // Settings record does not carry the collect* keys → registry default (ON).
    installDesktopApi({});
    render(<SettingsPanel />);
    openCliToolsTab();

    expect(await screen.findByText("Data Collection")).toBeDefined();

    const claudeSwitch = await screen.findByRole("switch", {
      name: "Toggle Collect Claude Code sessions",
    });
    // Default ON even though the key is absent from the loaded settings.
    await waitFor(() =>
      expect(claudeSwitch.getAttribute("aria-checked")).toBe("true")
    );

    // All three tools have a toggle.
    expect(
      screen.getByRole("switch", { name: "Toggle Collect Cursor sessions" })
    ).toBeDefined();
    expect(
      screen.getByRole("switch", {
        name: "Toggle Collect GitHub Copilot sessions",
      })
    ).toBeDefined();
  });

  it("reflects a persisted OFF value", async () => {
    installDesktopApi({ collectCursorEnabled: false });
    render(<SettingsPanel />);
    openCliToolsTab();

    const cursorSwitch = await screen.findByRole("switch", {
      name: "Toggle Collect Cursor sessions",
    });
    await waitFor(() =>
      expect(cursorSwitch.getAttribute("aria-checked")).toBe("false")
    );
  });

  it("persists a toggle-off through the updateSettings IPC", async () => {
    const { updateSettings } = installDesktopApi({});
    render(<SettingsPanel />);
    openCliToolsTab();

    const copilotSwitch = await screen.findByRole("switch", {
      name: "Toggle Collect GitHub Copilot sessions",
    });
    await waitFor(() =>
      expect(copilotSwitch.getAttribute("aria-checked")).toBe("true")
    );

    fireEvent.click(copilotSwitch);

    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        collectCopilotEnabled: false,
      })
    );
    await waitFor(() =>
      expect(copilotSwitch.getAttribute("aria-checked")).toBe("false")
    );
  });

  it("surfaces an inline error and keeps the value when a toggle IPC rejects (privacy control)", async () => {
    const { settings } = installDesktopApi({});
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {
        ...window.desktopApi,
        getSettings: vi.fn(async () => ({ ...settings })),
        updateSettings: vi
          .fn()
          .mockRejectedValue(new Error("collection IPC failed")),
      },
    });
    render(<SettingsPanel />);
    openCliToolsTab();

    const claudeSwitch = await screen.findByRole("switch", {
      name: "Toggle Collect Claude Code sessions",
    });
    await waitFor(() =>
      expect(claudeSwitch.getAttribute("aria-checked")).toBe("true")
    );

    fireEvent.click(claudeSwitch);

    // A failed privacy change is NOT silent: an inline error shows and the
    // switch stays at its last-known (ON) value rather than a false OFF.
    await screen.findByText("collection IPC failed");
    expect(claudeSwitch.getAttribute("aria-checked")).toBe("true");
  });

  it("shows an error instead of a permanent skeleton when the initial read fails", async () => {
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {
        getSettings: vi.fn().mockRejectedValue(new Error("read failed")),
        getRuntimeStatus: vi.fn(() => new Promise(() => undefined)),
        getCloudCommandsPaused: vi.fn(async () => false),
        getCloudConnectionEnabled: vi.fn(async () => true),
        getAgentMonitorHooksEnabled: vi.fn(async () => false),
        getBinaryPaths: vi.fn(async () => ({})),
        detectCliTools: vi.fn(async () => undefined),
        patchBinaryPaths: vi.fn(async () => undefined),
        updateSettings: vi.fn(async () => ({})),
      },
    });
    render(<SettingsPanel />);
    openCliToolsTab();

    // The card renders an honest failure message and no collection switches
    // (a failed read must never assert an ON default it did not read).
    await screen.findByText(
      "Couldn't read your collection settings. Reopen Settings to try again."
    );
    expect(
      screen.queryByRole("switch", {
        name: "Toggle Collect Claude Code sessions",
      })
    ).toBeNull();
  });
});
