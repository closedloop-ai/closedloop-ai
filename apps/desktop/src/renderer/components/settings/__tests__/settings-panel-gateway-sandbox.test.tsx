import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopAppPanel } from "../../../settings-v2/panels/desktop-app-panel";
import { DesktopAuthProvider } from "../../../shared-agent-sessions/desktop-auth-provider";
import { GATEWAY_PROFILE_EDITOR_TEST_ID } from "../gateway-profiles-card";
import { desktopAppPanelMountReads } from "./desktop-app-panel-mount-reads";

// FEA-4005: the gateway profile editor exposes a per-profile sandbox base
// directory — the gateway's allowed-directory scope root. These tests mount the
// real DesktopAppPanel with one saved profile and assert: the current sandbox
// renders for inspection, the native picker updates it, and saving threads
// sandboxBaseDirectory through the saveConfig IPC.
//
// ISS-10246: the panel renders Security beside Relay / Gateway, and the global
// sandbox card there carries its own "Sandbox Directory" field and "Save"
// button. Every query below is therefore scoped to the profile editor, so a
// passing assertion is a statement about the PROFILE field rather than whichever
// of the two the document happened to match first.
//
// The blocks read `useDesktopAuth()` and `useFeatureFlagEnabled`, so both ports
// must be present or the panel throws and nothing renders. The bare desktopApi
// stub omits the auth bridge, so auth settles signed-out.

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
      ...desktopAppPanelMountReads(),
      getSettings: vi.fn(async () => settings),
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

/** The profile editor subtree, so sibling blocks cannot answer a query. */
async function findProfileEditor(): Promise<ReturnType<typeof within>> {
  return within(await screen.findByTestId(GATEWAY_PROFILE_EDITOR_TEST_ID));
}

async function findSelectedSandboxInput(): Promise<HTMLInputElement> {
  const editor = await findProfileEditor();
  await editor.findByText("Selected Profile");
  // Only the selected-profile editor is mounted (the save dialog stays closed),
  // so there is exactly one "Sandbox Directory" field inside it.
  return editor.getByLabelText("Sandbox Directory") as HTMLInputElement;
}

async function findProfileSaveButton(): Promise<HTMLButtonElement> {
  const editor = await findProfileEditor();
  return editor.getByRole("button", { name: "Save" }) as HTMLButtonElement;
}

function renderPanel(): void {
  render(
    <FeatureFlagAdapterProvider adapter={createStaticFeatureFlagAdapter()}>
      <DesktopAuthProvider>
        <DesktopAppPanel />
      </DesktopAuthProvider>
    </FeatureFlagAdapterProvider>
  );
}

describe("Settings gateway profile sandbox (FEA-4005)", () => {
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

    const pickerEditor = await findProfileEditor();
    fireEvent.click(pickerEditor.getByRole("button", { name: "Browse" }));

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

    fireEvent.click(await findProfileSaveButton());

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
    fireEvent.click(await findProfileSaveButton());
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

    const riskyEditor = await findProfileEditor();
    await riskyEditor.findByText(RISKY_ROOT_RE);
  });

  it("disables Save and blocks saveConfig for a settled risky profile sandbox (whitlockk review)", async () => {
    // whitlockk: ProfileSandboxField showed the invalid state inline but never
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
    await (await findProfileEditor()).findByText(RISKY_ROOT_RE);
    const saveButton = await findProfileSaveButton();
    await waitFor(() => {
      expect(saveButton.disabled).toBe(true);
    });
    fireEvent.click(saveButton);
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it("disables Save and blocks saveConfig for a settled missing profile sandbox (whitlockk review)", async () => {
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

    const saveButton = await findProfileSaveButton();
    await waitFor(() => {
      expect(saveButton.disabled).toBe(true);
    });
    fireEvent.click(saveButton);
    expect(saveConfig).not.toHaveBeenCalled();
  });
});
