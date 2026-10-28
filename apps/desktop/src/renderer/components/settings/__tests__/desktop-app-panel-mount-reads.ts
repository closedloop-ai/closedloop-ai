import { vi } from "vitest";

/**
 * ISS-10246: the inert mount-time `window.desktopApi` reads every block of
 * Settings → Labs → Desktop App performs.
 *
 * The legacy `SettingsPanel` put each block behind a Radix tab, so a suite
 * aiming at one block only had to stub that block's reads — Radix unmounted the
 * rest. `DesktopAppPanel` has no tabs: Security, Relay / Gateway, Data & Sync
 * and CLI Tools are all on screen, and each reads on mount. A suite that omits
 * one of those reads throws inside that block's effect rather than failing on
 * its own assertion, so the whole set lives here and a suite overrides only the
 * reads it asserts against.
 *
 * The defaults deliberately PARK rather than resolve: a never-settling promise
 * leaves the unrelated block on its own loading state, contributing no controls
 * a suite would have to disambiguate its queries against.
 */
export function desktopAppPanelMountReads(): Record<
  string,
  ReturnType<typeof vi.fn>
> {
  return {
    getSettings: vi.fn(async () => ({})),
    // Relay / Gateway.
    getRuntimeStatus: vi.fn(() => new Promise(() => undefined)),
    getCloudCommandsPaused: vi.fn(async () => false),
    getCloudConnectionEnabled: vi.fn(async () => true),
    getAgentMonitorHooksEnabled: vi.fn(async () => false),
    // Security.
    getDangerousAutoApprove: vi.fn(async () => false),
    setDangerousAutoApprove: vi.fn(async () => undefined),
    getApiKeyStatus: vi.fn(async () => ({ hasApiKey: false, source: "none" })),
    // Data & Sync.
    getDataSyncLevel: vi.fn(() => new Promise(() => undefined)),
    // CLI Tools.
    getBinaryPaths: vi.fn(async () => ({})),
    detectCliTools: vi.fn(() => new Promise(() => undefined)),
    patchBinaryPaths: vi.fn(async () => undefined),
  };
}
