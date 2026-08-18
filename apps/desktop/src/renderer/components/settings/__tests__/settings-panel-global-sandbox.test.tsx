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

// ISS-4577: the GLOBAL sandbox base directory — the value onboarding writes via
// settingsStore.update({ sandboxBaseDirectory }) — is now viewable + editable in
// the Settings Security tab (GlobalSandboxCard). These tests mount the real
// SettingsPanel, navigate to the Security tab, and assert:
//   - the current global sandbox path renders in the editable field,
//   - saving an edited value threads sandboxBaseDirectory through the EXISTING
//     updateSettings IPC (the same save path onboarding uses) and re-reads
//     settings,
//   - a known-missing directory surfaces the inline validation error and
//     disables Save (never a lying UI).
// The card is distinct from the per-gateway-profile ProfileSandboxField
// (FEA-4005) covered by settings-panel-gateway-sandbox.test.tsx.

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

const GLOBAL_SANDBOX = "/workspace/current";
const EDITED_SANDBOX = "/workspace/edited";
const MISSING_SANDBOX = "/workspace/gone";
const MISSING_DIRECTORY_RE = /this folder does not exist/i;
const SAVE_FAILED_RE = /failed to update sandbox directory/i;
const SAVED_RE = /^Saved$/;
const NOT_SET_RE = /^Not set$/;

type DesktopApiOverrides = Record<string, ReturnType<typeof vi.fn>>;

function defaultInspect(targetPath: string) {
  return {
    path: targetPath,
    isGitRepo: false,
    suggestedPath: undefined,
    isRisky: false,
    exists: true,
  };
}

function installDesktopApi(overrides: DesktopApiOverrides = {}): void {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      getSettings: vi.fn(async () => ({
        sandboxBaseDirectory: GLOBAL_SANDBOX,
        savedConfigs: [],
      })),
      getRuntimeStatus: vi.fn(() => new Promise(() => undefined)),
      getCloudCommandsPaused: vi.fn(async () => false),
      getCloudConnectionEnabled: vi.fn(async () => true),
      getAgentMonitorHooksEnabled: vi.fn(async () => false),
      getDangerousAutoApprove: vi.fn(async () => false),
      setDangerousAutoApprove: vi.fn(async () => undefined),
      getApiKeyStatus: vi.fn(async () => ({
        hasApiKey: false,
        source: "none",
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

async function openSecurityTab(): Promise<void> {
  act(() => {
    window.dispatchEvent(
      new CustomEvent("desktop:navigate-settings-tab", { detail: "security" })
    );
  });
  await screen.findByText("Security Settings");
}

function getSandboxInput(): HTMLInputElement {
  // The section heading names the field; the input carries an sr-only label of
  // the same name so the visible name is said once (wongk review, ISS-4577).
  // Target the textbox by role so the same-text section heading is not matched.
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

describe("SettingsPanel global sandbox card (ISS-4577)", () => {
  it("renders the current global sandbox path from settings", async () => {
    installDesktopApi();
    render(<SettingsPanel />);
    await openSecurityTab();

    await waitFor(() => {
      expect(getSandboxInput().value).toBe(GLOBAL_SANDBOX);
    });
  });

  it("saves an edited value through the existing updateSettings IPC", async () => {
    const updateSettings = vi.fn(async () => ({
      sandboxBaseDirectory: EDITED_SANDBOX,
      savedConfigs: [],
    }));
    installDesktopApi({ updateSettings });
    render(<SettingsPanel />);
    await openSecurityTab();

    // Wait for the field to hydrate from the async-loaded settings first, so the
    // save assertion cannot race the seed effect.
    await waitFor(() => {
      expect(getSandboxInput().value).toBe(GLOBAL_SANDBOX);
    });
    fireEvent.change(getSandboxInput(), {
      target: { value: EDITED_SANDBOX },
    });
    // Save is gated on the debounced inspection settling for the current value,
    // so wait until it enables before clicking (a click while disabled is a
    // no-op). This mirrors the real UX: the user can only save a validated path.
    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
          .disabled
      ).toBe(false);
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith({
        sandboxBaseDirectory: EDITED_SANDBOX,
      });
    });
  });

  it("treats the updateSettings response as authoritative and does not re-read via getSettings (shafty review)", async () => {
    // shafty: a committed write must not be reported as failed by a transient
    // failure of a *separate* readback. The save now consumes the updateSettings
    // response directly — there is no post-write getSettings round-trip that
    // could fail after the filesystem boundary already changed. We prove this by
    // making getSettings throw on any call after the initial hydration: a save
    // must still succeed with no error surfaced.
    let hydrated = false;
    const getSettings = vi.fn(() => {
      if (hydrated) {
        return Promise.reject(new Error("transient readback failure"));
      }
      hydrated = true;
      return Promise.resolve({
        sandboxBaseDirectory: GLOBAL_SANDBOX,
        savedConfigs: [],
      });
    });
    const updateSettings = vi.fn(async () => ({
      sandboxBaseDirectory: EDITED_SANDBOX,
      savedConfigs: [],
    }));
    installDesktopApi({ getSettings, updateSettings });
    render(<SettingsPanel />);
    await openSecurityTab();

    await waitFor(() => {
      expect(getSandboxInput().value).toBe(GLOBAL_SANDBOX);
    });
    const getSettingsCallsAfterHydration = getSettings.mock.calls.length;
    fireEvent.change(getSandboxInput(), {
      target: { value: EDITED_SANDBOX },
    });
    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
          .disabled
      ).toBe(false);
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith({
        sandboxBaseDirectory: EDITED_SANDBOX,
      });
    });
    // The write committed; no readback fired, so the (rejecting) getSettings was
    // never called again and no save error surfaced.
    expect(getSettings.mock.calls.length).toBe(getSettingsCallsAfterHydration);
    expect(screen.queryByText(SAVE_FAILED_RE)).toBeNull();
  });

  it("blocks save while the inspection for the current value has not settled", async () => {
    // wongk + codex: the inspection is debounced + an async IPC round trip, so
    // immediately after an edit the previous value's inspection (or null) is
    // still in effect. Saving in that window would persist an unvalidated path.
    const updateSettings = vi.fn(async () => undefined);
    // Inspect for the newly-typed MISSING path resolves exists:false, but only
    // after we let the debounce fire; before that, Save must be disabled because
    // the current inspection does not describe the current value.
    installDesktopApi({
      updateSettings,
      inspectSandboxPath: vi.fn(async (targetPath: string) => ({
        path: targetPath,
        isGitRepo: false,
        suggestedPath: undefined,
        isRisky: false,
        exists: targetPath !== MISSING_SANDBOX,
      })),
    });
    render(<SettingsPanel />);
    await openSecurityTab();

    await waitFor(() => {
      expect(getSandboxInput().value).toBe(GLOBAL_SANDBOX);
    });
    fireEvent.change(getSandboxInput(), {
      target: { value: MISSING_SANDBOX },
    });

    // Synchronously (before the 300 ms debounce fires and IPC resolves) the
    // inspection still describes the previous value, so Save is disabled and an
    // immediate click cannot reach the IPC.
    const saveButton = screen.getByRole("button", {
      name: "Save",
    }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);
    fireEvent.click(saveButton);
    expect(updateSettings).not.toHaveBeenCalled();

    // Once the inspection for the current (missing) value settles, the
    // known-invalid error surfaces and Save stays disabled.
    await screen.findByText(MISSING_DIRECTORY_RE);
    expect(
      (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("shows the missing-directory error and blocks save for a non-existent path", async () => {
    const updateSettings = vi.fn(async () => undefined);
    installDesktopApi({
      updateSettings,
      inspectSandboxPath: vi.fn(async (targetPath: string) => ({
        path: targetPath,
        isGitRepo: false,
        suggestedPath: undefined,
        isRisky: false,
        exists: false,
      })),
    });
    render(<SettingsPanel />);
    await openSecurityTab();

    await waitFor(() => {
      expect(getSandboxInput().value).toBe(GLOBAL_SANDBOX);
    });
    fireEvent.change(getSandboxInput(), {
      target: { value: MISSING_SANDBOX },
    });

    await screen.findByText(MISSING_DIRECTORY_RE);
    const saveButton = screen.getByRole("button", {
      name: "Save",
    }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);

    // The user can still click a disabled-intent Save; assert it never reaches
    // the IPC for a known-invalid path.
    fireEvent.click(saveButton);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("does not clobber the edited value while an in-flight save resolves (shafty review)", async () => {
    // shafty: while a save of A is in flight, the re-seed effect must not reset
    // the field and the input must be disabled so no divergent edit can be typed.
    // We hold updateSettings open with a deferred promise to pin the in-flight
    // window and assert the field/input state inside it. On resolve, the save
    // consumes the updateSettings response (the just-persisted A = EDITED).
    let resolveUpdate: (() => void) | undefined;
    const updateSettings = vi.fn(
      () =>
        new Promise<{
          sandboxBaseDirectory: string;
          savedConfigs: never[];
        }>((resolve) => {
          resolveUpdate = () =>
            resolve({
              sandboxBaseDirectory: EDITED_SANDBOX,
              savedConfigs: [],
            });
        })
    );
    installDesktopApi({ updateSettings });
    render(<SettingsPanel />);
    await openSecurityTab();

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
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // Save is in flight (deferred promise unresolved): the input is disabled so
    // no divergent B can be typed, and the field keeps the submitted A — the
    // readback re-seed is suppressed while saving.
    await waitFor(() => {
      expect(getSandboxInput().disabled).toBe(true);
    });
    expect(getSandboxInput().value).toBe(EDITED_SANDBOX);
    expect(updateSettings).toHaveBeenCalledWith({
      sandboxBaseDirectory: EDITED_SANDBOX,
    });

    // Let the save complete; the input re-enables and the value stands.
    await act(async () => {
      resolveUpdate?.();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(getSandboxInput().disabled).toBe(false);
    });
    expect(getSandboxInput().value).toBe(EDITED_SANDBOX);
  });

  it("shows a Saved confirmation after a successful save (wongk review)", async () => {
    const updateSettings = vi.fn(async () => ({
      sandboxBaseDirectory: EDITED_SANDBOX,
      savedConfigs: [],
    }));
    installDesktopApi({ updateSettings });
    render(<SettingsPanel />);
    await openSecurityTab();

    await waitFor(() => {
      expect(getSandboxInput().value).toBe(GLOBAL_SANDBOX);
    });
    // No confirmation before any save.
    expect(screen.queryByText(SAVED_RE)).toBeNull();
    fireEvent.change(getSandboxInput(), {
      target: { value: EDITED_SANDBOX },
    });
    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
          .disabled
      ).toBe(false);
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // The weighty save is confirmed inline once the persisted settings return.
    await screen.findByText(SAVED_RE);

    // A subsequent edit clears the stale confirmation so it can't imply the new
    // (unsaved) value was persisted.
    fireEvent.change(getSandboxInput(), {
      target: { value: GLOBAL_SANDBOX },
    });
    await waitFor(() => {
      expect(screen.queryByText(SAVED_RE)).toBeNull();
    });
  });

  it("shows Not set (never a placeholder path) when the stored value is empty", async () => {
    // wongk (blocking): the field must not render a plausible-looking placeholder
    // path as if it were the confined folder. For an unset sandbox the field is
    // empty and the helper line says "Not set".
    installDesktopApi({
      getSettings: vi.fn(async () => ({
        sandboxBaseDirectory: "",
        savedConfigs: [],
      })),
    });
    render(<SettingsPanel />);
    await openSecurityTab();

    await screen.findByText(NOT_SET_RE);
    await waitFor(() => {
      expect(getSandboxInput().value).toBe("");
    });
    // No misleading grey placeholder path stands in for the real value.
    expect(getSandboxInput().getAttribute("placeholder")).toBeNull();
  });
});
