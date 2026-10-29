import { screen } from "@testing-library/react";
import { vi } from "vitest";
import type { ApiKeyStatusView } from "../security-tab";
import { desktopAppPanelMountReads } from "./desktop-app-panel-mount-reads";

/**
 * ISS-7043: the shared mount scaffold for the Security-tab suites.
 *
 * Mounting the Desktop App panel to reach SecurityTab needs the sibling blocks'
 * own mount-time IPC reads stubbed as well as the tab's, and every Security
 * suite was carrying its own byte-identical copy of that object. One copy per
 * suite means a new `window.desktopApi` read added to a sibling block breaks
 * each of them separately, so the scaffold lives here and the suites keep only
 * what they actually assert.
 *
 * ISS-10246: the mount is `DesktopAppPanel`, not the deleted legacy
 * `SettingsPanel`. There are no tabs there — every block is on screen at once —
 * so the scaffold takes every block's reads from `desktopAppPanelMountReads`
 * and {@link awaitSecuritySection} only waits for the section instead of
 * deep-linking to a tab.
 */

/**
 * The Security-tab IPC surface the suites assert against, returned by
 * `installSecurityTabDesktopApi` so a test can read call args off the mocks.
 */
export type SecurityTabApiMocks = {
  getApiKeyStatus: ReturnType<typeof vi.fn>;
  setApiKey: ReturnType<typeof vi.fn>;
  clearApiKey: ReturnType<typeof vi.fn>;
};

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

/**
 * A `getApiKeyStatus` stub for one status, or for an IPC that never settles —
 * which is how the not-yet-read arm of the API Key label is reached.
 *
 * Typed against the component's own `ApiKeyStatusView` so a fixture cannot
 * describe a status the production contract does not allow.
 */
export function apiKeyStatusMock(
  status: ApiKeyStatusView | "pending"
): ReturnType<typeof vi.fn> {
  if (status === "pending") {
    return vi.fn(() => new Promise(() => undefined));
  }
  return vi.fn(async () => status);
}

/**
 * Installs `window.desktopApi` with the panel's and every block's mount-time
 * reads, overriding only the Security reads the suites assert against.
 */
export function installSecurityTabDesktopApi(
  overrides: Partial<SecurityTabApiMocks> = {}
): SecurityTabApiMocks {
  const api: SecurityTabApiMocks = {
    getApiKeyStatus: apiKeyStatusMock({
      hasApiKey: true,
      source: "safeStorage",
    }),
    setApiKey: vi.fn(async () => undefined),
    clearApiKey: vi.fn(async () => undefined),
    ...overrides,
  };
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      ...desktopAppPanelMountReads(),
      ...api,
    },
  });
  return api;
}

/**
 * Restores the descriptor captured before any install. A suite that was running
 * without a `desktopApi` gets the property removed rather than set to
 * `undefined`, so the absent case stays absent.
 */
export function restoreDesktopApi(): void {
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
    return;
  }
  Reflect.deleteProperty(window, "desktopApi");
}

/** Waits for the mounted panel's Security section to render. */
export async function awaitSecuritySection(): Promise<void> {
  await screen.findByText("Security Settings");
}
