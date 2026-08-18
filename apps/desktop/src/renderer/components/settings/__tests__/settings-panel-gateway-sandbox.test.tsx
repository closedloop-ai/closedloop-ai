import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthProvider } from "../../../shared-agent-sessions/desktop-auth-provider";
import { SettingsPanel } from "../SettingsPanel";

// FEA-4005: the gateway profile editor exposes a per-profile sandbox base
// directory — the gateway's allowed-directory scope root. These tests mount the
// real SettingsPanel with one saved profile and assert: the current sandbox
// renders for inspection, the native picker updates it, and saving threads
// sandboxBaseDirectory through the saveConfig IPC. The Relay/Gateway tab's
// content mounts alongside the default Account tab (FEA-4133), so its
// profile-sandbox editor is present without switching tabs.
//
// FEA-4133: the always-on Account tab is now selected by default, so
// DesktopAccountTab mounts on render and reads `useDesktopAuth()` +
// `useFeatureFlagEnabled` — both ports must be present or the whole panel throws
// and no tab renders. The bare desktopApi stub omits the auth bridge, so auth
// settles signed-out; the unified-auth-onboarding flag stays off (PRD-532
// dark-launch default).

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

const PROFILE_SANDBOX = "/workspace/projects";
const PICKED_SANDBOX = "/workspace/other-repos";
const RISKY_ROOT_RE = /home directory or a system root/i;

type DesktopApiOverrides = Record<string, ReturnType<typeof vi.fn>>;

const GLOBAL_SANDBOX = "/workspace/global";

function makeSettings(overrides: { profileSandbox?: string | undefined } = {}) {
  const hasOwnSandbox = "profileSandbox" in overrides;
  return {
    relayOrigin: "https://relay.test",
    apiOrigin: "https://api.test",
    webAppOrigin: "https://app.test",
    sandboxBaseDirectory: GLOBAL_SANDBOX,
    activeConfigId: "profile-1",
    savedConfigs: [
      {
        id: "profile-1",
        name: "Production",
        relayOrigin: "https://relay.test",
        apiOrigin: "https://api.test",
        webAppOrigin: "https://app.test",
        ...(hasOwnSandbox
          ? { sandboxBaseDirectory: overrides.profileSandbox }
          : { sandboxBaseDirectory: PROFILE_SANDBOX }),
        hasCloudApiKey: true,
      },
    ],
  };
}

function installDesktopApi(
  overrides: DesktopApiOverrides = {},
  settings: ReturnType<typeof makeSettings> = makeSettings()
): void {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      getSettings: vi.fn(async () => settings),
      getRuntimeStatus: vi.fn(() => new Promise(() => undefined)),
      getCloudCommandsPaused: vi.fn(async () => false),
      getCloudConnectionEnabled: vi.fn(async () => true),
      getAgentMonitorHooksEnabled: vi.fn(async () => false),
      getApiKeyStatus: vi.fn(async () => ({
        hasApiKey: false,
        source: "none",
      })),
      inspectSandboxPath: vi.fn(async (targetPath: string) => ({
        path: targetPath,
        isGitRepo: false,
        suggestedPath: undefined,
        isRisky: false,
      })),
      pickSandboxDirectory: vi.fn(async () => ({
        path: PICKED_SANDBOX,
        isGitRepo: false,
        suggestedPath: undefined,
        isRisky: false,
      })),
      saveConfig: vi.fn(async () => ({ id: "profile-1" })),
      applyConfig: vi.fn(async () => undefined),
      renameConfig: vi.fn(async () => undefined),
      deleteConfig: vi.fn(async () => undefined),
      ...overrides,
    },
  });
}

afterEach(() => {
  // Unmount the tree before restoring globals so any queued passive effect does
  // not fire against a torn-down desktopApi.
  cleanup();
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
});

async function findSelectedSandboxInput(): Promise<HTMLInputElement> {
  await screen.findByText("Selected Profile");
  // Only the selected-profile editor is mounted (the save dialog stays closed),
  // so there is exactly one "Sandbox Directory" field on screen.
  return screen.getByLabelText("Sandbox Directory") as HTMLInputElement;
}

// FEA-4133: Account is the default tab and Radix unmounts inactive TabsContent,
// so the Relay/Gateway profile editor only mounts once that tab is selected.
// Navigate there after render so the sandbox field is on screen.
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

describe("SettingsPanel gateway profile sandbox (FEA-4005)", () => {
  it("renders the profile's current sandbox path for inspection", async () => {
    installDesktopApi();
    renderPanel();

    // Wait for the input's own value (not just "Selected Profile") so the
    // assertion cannot race the selectedForm effect that syncs the field from
    // the async-loaded profile — reading it too early saw the global fallback.
    await waitFor(async () => {
      const input = await findSelectedSandboxInput();
      expect(input.value).toBe(PROFILE_SANDBOX);
    });
  });

  it("updates the sandbox field via the native directory picker", async () => {
    installDesktopApi();
    renderPanel();

    await findSelectedSandboxInput();
    fireEvent.click(screen.getByRole("button", { name: "Browse" }));

    await waitFor(async () => {
      const input = await findSelectedSandboxInput();
      expect(input.value).toBe(PICKED_SANDBOX);
    });
  });

  it("threads the sandbox path through saveConfig on save", async () => {
    const saveConfig = vi.fn(async () => ({ id: "profile-1" }));
    installDesktopApi({ saveConfig });
    renderPanel();

    const input = await findSelectedSandboxInput();
    fireEvent.change(input, { target: { value: PICKED_SANDBOX } });

    const saveButton = screen.getByRole("button", { name: "Save" });
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(saveConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "profile-1",
          sandboxBaseDirectory: PICKED_SANDBOX,
        })
      );
    });
  });

  it("leaves a legacy profile's sandbox empty (inherit) instead of pinning the global one, and omits it on save", async () => {
    const saveConfig = vi.fn(async (_config: Record<string, unknown>) => ({
      id: "profile-1",
    }));
    // A profile with no own sandbox (predates the field).
    installDesktopApi(
      { saveConfig },
      makeSettings({ profileSandbox: undefined })
    );
    renderPanel();

    // The field shows empty (inherit), NOT the global sandbox — the placeholder
    // hints the global value without pinning it.
    const input = await findSelectedSandboxInput();
    await waitFor(() => {
      expect(input.value).toBe("");
    });
    expect(input.getAttribute("placeholder")).toBe(GLOBAL_SANDBOX);

    // Saving an unrelated change must not pin the profile to today's global path.
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(saveConfig).toHaveBeenCalled();
    });
    const payload = saveConfig.mock.calls[0]?.[0];
    expect(payload).toBeDefined();
    expect(payload).not.toHaveProperty("sandboxBaseDirectory");
  });

  it("surfaces an inline risky-root warning from inspectSandboxPath", async () => {
    installDesktopApi({
      inspectSandboxPath: vi.fn(async (targetPath: string) => ({
        path: targetPath,
        isGitRepo: false,
        suggestedPath: undefined,
        isRisky: true,
      })),
    });
    renderPanel();

    await findSelectedSandboxInput();
    await screen.findByText(RISKY_ROOT_RE);
  });

  it("disables Save and blocks saveConfig for a settled risky profile sandbox (wongk review)", async () => {
    // wongk: ProfileSandboxField showed the invalid state inline but never
    // reported it up, so both profile Save paths still persisted it. The field
    // now bubbles validity up and the Save button gates on it.
    const saveConfig = vi.fn(async () => ({ id: "profile-1" }));
    installDesktopApi({
      saveConfig,
      inspectSandboxPath: vi.fn(async (targetPath: string) => ({
        path: targetPath,
        isGitRepo: false,
        suggestedPath: undefined,
        isRisky: true,
      })),
    });
    renderPanel();

    const input = await findSelectedSandboxInput();
    fireEvent.change(input, { target: { value: PICKED_SANDBOX } });

    // Once the inspection settles onto the current value and reports risky, the
    // inline warning shows AND Save is disabled.
    await screen.findByText(RISKY_ROOT_RE);
    const saveButton = screen.getByRole("button", {
      name: "Save",
    }) as HTMLButtonElement;
    await waitFor(() => {
      expect(saveButton.disabled).toBe(true);
    });
    fireEvent.click(saveButton);
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it("disables Save and blocks saveConfig for a settled missing profile sandbox (wongk review)", async () => {
    const saveConfig = vi.fn(async () => ({ id: "profile-1" }));
    installDesktopApi({
      saveConfig,
      inspectSandboxPath: vi.fn(async (targetPath: string) => ({
        path: targetPath,
        isGitRepo: false,
        suggestedPath: undefined,
        isRisky: false,
        exists: false,
      })),
    });
    renderPanel();

    const input = await findSelectedSandboxInput();
    fireEvent.change(input, { target: { value: PICKED_SANDBOX } });

    const saveButton = screen.getByRole("button", {
      name: "Save",
    }) as HTMLButtonElement;
    await waitFor(() => {
      expect(saveButton.disabled).toBe(true);
    });
    fireEvent.click(saveButton);
    expect(saveConfig).not.toHaveBeenCalled();
  });
});
