import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SettingsPanel } from "../SettingsPanel";

const INVALID_PATH_ERROR = "Binary path for claude does not exist: /bad/path";

function installDesktopApi(
  patchBinaryPaths: ReturnType<typeof vi.fn>
): Record<string, string> {
  const binaries: Record<string, string> = { claude: "/usr/bin/claude" };
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      getSettings: vi.fn(async () => ({})),
      getRuntimeStatus: vi.fn(() => new Promise(() => undefined)),
      getCloudCommandsPaused: vi.fn(async () => false),
      getCloudConnectionEnabled: vi.fn(async () => true),
      getAgentMonitorHooksEnabled: vi.fn(async () => false),
      getBinaryPaths: vi.fn(async () => binaries),
      detectCliTools: vi.fn(async () => undefined),
      patchBinaryPaths,
    },
  });
  return binaries;
}

function navigateToBinaryPathsTab() {
  act(() => {
    window.dispatchEvent(
      new CustomEvent("desktop:navigate-settings-tab", {
        detail: "binary-paths",
      })
    );
  });
}

async function openClaudeEditor(badValue: string) {
  act(() => {
    window.dispatchEvent(
      new CustomEvent("desktop:navigate-settings-tab", {
        detail: "binary-paths",
      })
    );
  });
  // The claude row is the first listed tool; enter its edit mode.
  const editButtons = await screen.findAllByRole("button", { name: "Edit" });
  fireEvent.click(editButtons[0]);
  const input = await screen.findByLabelText("claude");
  fireEvent.change(input, { target: { value: badValue } });
  return input;
}

describe("SettingsPanel CLI Tools binary path loading", () => {
  it("stops loading when the initial getBinaryPaths IPC rejects on mount", async () => {
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {
        getSettings: vi.fn(async () => ({})),
        getRuntimeStatus: vi.fn(() => new Promise(() => undefined)),
        getCloudCommandsPaused: vi.fn(async () => false),
        getCloudConnectionEnabled: vi.fn(async () => true),
        getAgentMonitorHooksEnabled: vi.fn(async () => false),
        getBinaryPaths: vi.fn(() =>
          Promise.reject(new Error("IPC unavailable"))
        ),
        detectCliTools: vi.fn(async () => undefined),
        patchBinaryPaths: vi.fn(async () => undefined),
      },
    });
    render(<SettingsPanel />);

    navigateToBinaryPathsTab();

    // The loading placeholder must clear even though the IPC rejected, so the
    // tool rows (each with an Edit button) render instead of hanging forever.
    await waitFor(() => {
      expect(screen.queryByText("Detecting tools...")).toBeNull();
    });
    expect(
      (await screen.findAllByRole("button", { name: "Edit" })).length
    ).toBeGreaterThan(0);
  });

  it("stops loading when a Detect Tools retry rejects", async () => {
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {
        getSettings: vi.fn(async () => ({})),
        getRuntimeStatus: vi.fn(() => new Promise(() => undefined)),
        getCloudCommandsPaused: vi.fn(async () => false),
        getCloudConnectionEnabled: vi.fn(async () => true),
        getAgentMonitorHooksEnabled: vi.fn(async () => false),
        getBinaryPaths: vi.fn(async () => ({ claude: "/usr/bin/claude" })),
        detectCliTools: vi.fn(() =>
          Promise.reject(new Error("IPC unavailable"))
        ),
        patchBinaryPaths: vi.fn(async () => undefined),
      },
    });
    render(<SettingsPanel />);

    navigateToBinaryPathsTab();

    const detectButton = await screen.findByRole("button", {
      name: "Detect Tools",
    });
    fireEvent.click(detectButton);

    // The rejected retry must clear the loading state instead of stranding the
    // tab on the "Detecting tools..." placeholder with the button disabled.
    await waitFor(() => {
      expect(screen.queryByText("Detecting tools...")).toBeNull();
    });
    expect(
      (
        screen.getByRole("button", {
          name: "Detect Tools",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(false);
  });
});

describe("SettingsPanel CLI Tools binary path editing", () => {
  it("surfaces an inline error and keeps the row in edit mode when Save fails", async () => {
    const patchBinaryPaths = vi.fn(() =>
      Promise.reject(new Error(INVALID_PATH_ERROR))
    );
    installDesktopApi(patchBinaryPaths);
    render(<SettingsPanel />);

    await openClaudeEditor("/bad/path");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText(INVALID_PATH_ERROR)).toBeDefined();
    // Row stays in edit mode so the user can correct the value.
    expect(screen.getByLabelText("claude")).toBeDefined();
    expect(screen.getByRole("button", { name: "Save" })).toBeDefined();
  });

  it("clears the inline error and exits edit mode on a successful save", async () => {
    let attempt = 0;
    const patchBinaryPaths = vi.fn(() => {
      attempt += 1;
      return attempt === 1
        ? Promise.reject(new Error(INVALID_PATH_ERROR))
        : Promise.resolve();
    });
    installDesktopApi(patchBinaryPaths);
    render(<SettingsPanel />);

    await openClaudeEditor("/bad/path");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(INVALID_PATH_ERROR)).toBeDefined();

    fireEvent.change(screen.getByLabelText("claude"), {
      target: { value: "/usr/bin/claude" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.queryByText(INVALID_PATH_ERROR)).toBeNull();
      expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    });
  });
});
