/**
 * @file settings-panel-security-flags.test.tsx
 * @description FEA-4130 — the "Trusted Browser Enforcement" opt-in
 * (`commandSigningEnforcementEnabled`) was relocated from the Labs/Experimental
 * panel to the Security tab, rendered as a bordered section inside the Security
 * Settings card right under Dangerous Auto-Approve — the same grammar as its
 * closest sibling. The settings record is read once by the parent tab and
 * threaded down. These tests pin: it renders inside the Security Settings card,
 * holds behind a skeleton until the parent read resolves, reflects a persisted
 * value, persists a toggle through the updateSettings IPC, surfaces a failed
 * toggle inline, and — critically — is NOT double-rendered on the Labs tab.
 */
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
import {
  DESKTOP_COMMAND_SIGNING_ENFORCEMENT_FEATURE_FLAG_KEY,
  DESKTOP_LABS_NAV_FEATURE_FLAG_KEY,
} from "../../../../shared/feature-flags";
import { SettingsPanel } from "../SettingsPanel";

const TRUSTED_BROWSER_FLAG_KEY =
  DESKTOP_COMMAND_SIGNING_ENFORCEMENT_FEATURE_FLAG_KEY;
const TRUSTED_BROWSER_TOGGLE_NAME = "Toggle Trusted Browser Enforcement";

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
      getDangerousAutoApprove: vi.fn(async () => false),
      getApiKeyStatus: vi.fn(async () => ({
        hasApiKey: false,
        source: "none",
      })),
      getBinaryPaths: vi.fn(async () => ({})),
      detectCliTools: vi.fn(async () => ({})),
      patchBinaryPaths: vi.fn(async () => undefined),
      updateSettings,
    },
  });
  return { updateSettings, settings };
}

function navigateToTab(detail: string) {
  act(() => {
    window.dispatchEvent(
      new CustomEvent("desktop:navigate-settings-tab", { detail })
    );
  });
}

describe("SettingsPanel Security Trusted Browser flag (FEA-4130)", () => {
  it("renders the 'Trusted Browser Enforcement' toggle on the Security tab, defaulting OFF", async () => {
    installDesktopApi({});
    render(<SettingsPanel />);
    navigateToTab("security");

    const toggle = await screen.findByRole("switch", {
      name: TRUSTED_BROWSER_TOGGLE_NAME,
    });
    // Dark launch: absent key reads OFF.
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("false")
    );
  });

  it("reflects a persisted ON value", async () => {
    installDesktopApi({ [TRUSTED_BROWSER_FLAG_KEY]: true });
    render(<SettingsPanel />);
    navigateToTab("security");

    const toggle = await screen.findByRole("switch", {
      name: TRUSTED_BROWSER_TOGGLE_NAME,
    });
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("true")
    );
  });

  it("persists a toggle-on through the updateSettings IPC", async () => {
    const { updateSettings } = installDesktopApi({});
    render(<SettingsPanel />);
    navigateToTab("security");

    const toggle = await screen.findByRole("switch", {
      name: TRUSTED_BROWSER_TOGGLE_NAME,
    });
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("false")
    );

    fireEvent.click(toggle);

    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        [TRUSTED_BROWSER_FLAG_KEY]: true,
      })
    );
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("true")
    );
  });

  it("surfaces an inline error and keeps the value when a toggle IPC rejects", async () => {
    const { settings } = installDesktopApi({});
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {
        ...window.desktopApi,
        getSettings: vi.fn(async () => ({ ...settings })),
        updateSettings: vi
          .fn()
          .mockRejectedValue(new Error("signing IPC failed")),
      },
    });
    render(<SettingsPanel />);
    navigateToTab("security");

    const toggle = await screen.findByRole("switch", {
      name: TRUSTED_BROWSER_TOGGLE_NAME,
    });
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("false")
    );

    fireEvent.click(toggle);

    await screen.findByText("signing IPC failed");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("holds the switch behind a skeleton until the parent settings read resolves", async () => {
    // The section takes the settings record from the parent tab's single read
    // (no second getSettings of its own). While that read is in flight the row
    // must not render a confidently-OFF switch — a quick click on a persisted-ON
    // install would flip it to a wrong write — so it holds behind a skeleton.
    let resolveRead: ((value: SettingsRecord) => void) | undefined;
    installDesktopApi({});
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {
        ...window.desktopApi,
        getSettings: vi.fn(
          () =>
            new Promise<SettingsRecord>((resolve) => {
              resolveRead = resolve;
            })
        ),
      },
    });
    render(<SettingsPanel />);
    navigateToTab("security");

    // Read still pending: no switch is rendered (the skeleton stands in).
    await waitFor(() =>
      expect(screen.getByText("Dangerous Auto-Approve")).toBeTruthy()
    );
    expect(
      screen.queryByRole("switch", { name: TRUSTED_BROWSER_TOGGLE_NAME })
    ).toBeNull();

    // Once the read resolves, the switch appears reflecting the persisted value.
    act(() => {
      resolveRead?.({ [TRUSTED_BROWSER_FLAG_KEY]: true });
    });
    const toggle = await screen.findByRole("switch", {
      name: TRUSTED_BROWSER_TOGGLE_NAME,
    });
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("true")
    );
  });

  it("renders the Trusted Browser toggle inside the Security Settings card, under Dangerous Auto-Approve", async () => {
    installDesktopApi({});
    render(<SettingsPanel />);
    navigateToTab("security");

    const toggle = await screen.findByRole("switch", {
      name: TRUSTED_BROWSER_TOGGLE_NAME,
    });
    // The relocated control is a sibling of Dangerous Auto-Approve inside the
    // one Security Settings card — not a second card with its own grammar.
    const securityCard = screen
      .getByText("Security Settings")
      .closest("[data-slot='card']");
    expect(securityCard).not.toBeNull();
    expect(securityCard?.contains(toggle)).toBe(true);
    expect(
      securityCard?.contains(screen.getByText("Dangerous Auto-Approve"))
    ).toBe(true);
  });

  it("does NOT render the Trusted Browser toggle on the Labs tab (no double-render)", async () => {
    installDesktopApi({});
    // ISS-5309: the Labs TAB is now behind the `labsNav` container gate, default
    // OFF — and this case's whole premise is that the Labs tab is reachable, so
    // it has to seed the gate open. The other cases in this file target the
    // Security tab and need no adapter (a missing provider resolves the gate
    // closed, which is the correct closed-by-default degradation).
    render(
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({
          enabledFlags: [DESKTOP_LABS_NAV_FEATURE_FLAG_KEY],
        })}
      >
        <SettingsPanel />
      </FeatureFlagAdapterProvider>
    );
    navigateToTab("labs");

    // The Labs tab is up (its Labs card renders — asserted via the card's
    // unique blurb), but the relocated flag must not appear there anymore — it
    // lives only on the Security tab.
    await screen.findByText(
      "Early access to experimental features and advanced controls."
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("switch", { name: TRUSTED_BROWSER_TOGGLE_NAME })
      ).toBeNull()
    );
  });
});
