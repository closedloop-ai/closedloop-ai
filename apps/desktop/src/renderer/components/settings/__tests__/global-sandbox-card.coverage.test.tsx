import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopAppPanel } from "../../../settings-v2/panels/desktop-app-panel";
import { desktopAppPanelMountReads } from "./desktop-app-panel-mount-reads";

// Targets the GlobalSandboxSection branches not exercised by the sibling
// settings-panel-global-sandbox.test.tsx suite: the isUnchanged early return in
// handleSave, the Enter-key submit path, and the (absent) inline feedback
// rendering for a clean, unmodified value.

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

const MISSING_DIRECTORY_RE = /this folder does not exist/i;
const RISKY_ROOT_RE = /outside a project or home folder/i;

const GLOBAL_SANDBOX = "/workspace/current";
const EDITED_SANDBOX = "/workspace/edited";

function defaultInspect(targetPath: string) {
  return {
    path: targetPath,
    isGitRepo: false,
    suggestedPath: undefined,
    isRisky: false,
    exists: true,
  };
}

function installDesktopApi(
  overrides: Record<string, ReturnType<typeof vi.fn>> = {}
): void {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      ...desktopAppPanelMountReads(),
      getSettings: vi.fn(async () => ({
        sandboxBaseDirectory: GLOBAL_SANDBOX,
        savedConfigs: [],
      })),
      inspectSandboxPath: vi.fn(async (targetPath: string) =>
        defaultInspect(targetPath)
      ),
      pickSandboxDirectory: vi.fn(async () => defaultInspect(EDITED_SANDBOX)),
      updateSettings: vi.fn(async () => undefined),
      ...overrides,
    },
  });
}

async function awaitSecuritySection(): Promise<void> {
  await screen.findByText("Security Settings");
}

function getSandboxInput(): HTMLInputElement {
  return screen.getByRole("textbox", {
    name: "Sandbox Directory",
  }) as HTMLInputElement;
}

afterEach(() => {
  cleanup();
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
});

describe("GlobalSandboxSection — unchanged-value guard, Enter submit, feedback", () => {
  it("does not call updateSettings when Enter is pressed on an unchanged value", async () => {
    const updateSettings = vi.fn(async () => undefined);
    const inspectSandboxPath = vi.fn(async (targetPath: string) =>
      defaultInspect(targetPath)
    );
    installDesktopApi({ updateSettings, inspectSandboxPath });
    render(<DesktopAppPanel />);
    await awaitSecuritySection();

    await waitFor(() => {
      expect(getSandboxInput().value).toBe(GLOBAL_SANDBOX);
    });
    // Let the debounced inspection settle, so knownInvalid is false and only
    // isUnchanged can stop the save.
    await waitFor(() =>
      expect(inspectSandboxPath).toHaveBeenCalledWith(GLOBAL_SANDBOX)
    );
    await act(async () => {
      await Promise.resolve();
    });
    const saveButton = screen.getByRole("button", {
      name: "Save",
    }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);
    // A disabled button never fires onClick; Enter reaches handleSave directly.
    fireEvent.keyDown(getSandboxInput(), { key: "Enter" });

    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("saves the edited value on Enter in the sandbox field", async () => {
    const updateSettings = vi.fn(async () => ({
      sandboxBaseDirectory: EDITED_SANDBOX,
      savedConfigs: [],
    }));
    installDesktopApi({ updateSettings });
    render(<DesktopAppPanel />);
    await awaitSecuritySection();

    await waitFor(() => {
      expect(getSandboxInput().value).toBe(GLOBAL_SANDBOX);
    });
    fireEvent.change(getSandboxInput(), {
      target: { value: EDITED_SANDBOX },
    });
    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
          .disabled
      ).toBe(false);
    });
    fireEvent.keyDown(getSandboxInput(), { key: "Enter" });

    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        sandboxBaseDirectory: EDITED_SANDBOX,
      })
    );
  });

  it("does not save on a non-Enter key in the sandbox field", async () => {
    const updateSettings = vi.fn(async () => undefined);
    installDesktopApi({ updateSettings });
    render(<DesktopAppPanel />);
    await awaitSecuritySection();

    await waitFor(() => {
      expect(getSandboxInput().value).toBe(GLOBAL_SANDBOX);
    });
    fireEvent.change(getSandboxInput(), {
      target: { value: EDITED_SANDBOX },
    });
    fireEvent.keyDown(getSandboxInput(), { key: "Tab" });

    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("renders no inline feedback message for a settled, valid, unmodified value", async () => {
    installDesktopApi();
    render(<DesktopAppPanel />);
    await awaitSecuritySection();

    await waitFor(() => {
      expect(getSandboxInput().value).toBe(GLOBAL_SANDBOX);
    });
    expect(screen.queryByText(MISSING_DIRECTORY_RE)).toBeNull();
    expect(screen.queryByText(RISKY_ROOT_RE)).toBeNull();
  });
});
