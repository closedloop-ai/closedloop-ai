import {
  DATA_SYNC_LEVELS,
  DataSyncLevel,
} from "@repo/api/src/types/data-sync-level";
import { SHOW_REDACTED_SYNC_LEVEL_FLAG_KEY } from "@repo/api/src/types/show-redacted-sync-level-flag";
import { ThisDeviceSyncSection } from "@repo/app/settings/v2/panels/connected-devices/this-device-sync-section";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { SettingsHostAdapterProvider } from "@repo/app/shared/settings-host/provider";
import { webSettingsHostAdapter } from "@repo/app/shared/settings-host/settings-host-adapter";
import { render, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SyncObservabilityTier } from "../../../../shared/contracts";
import { DESKTOP_SHOW_REDACTED_SYNC_LEVEL_FEATURE_FLAG_KEY } from "../../../../shared/feature-flags-labs-detail";
import { createDesktopSettingsHostAdapter } from "../../../settings-host/desktop-settings-host-adapter";
import { DataSyncTab } from "../data-sync-tab";

/**
 * PLN-1915 Step 4 — the two surfaces that offer THIS machine's sync level must
 * offer the same options.
 *
 * Both are mounted here against ONE stubbed bridge and ONE flag state, and the
 * expected set is read off each RENDER rather than written down: hardcoding one
 * surface's labels as the oracle would turn a parity claim into a snapshot of
 * whichever side was written first.
 */

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

function installDesktopApi(level: DataSyncLevel): void {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      getDataSyncLevel: vi.fn(() => Promise.resolve({ level })),
      setDataSyncLevel: vi.fn((next: DataSyncLevel) =>
        Promise.resolve({ level: next })
      ),
      getSyncConsentRecord: vi.fn(() =>
        Promise.resolve({
          bound: false,
          organizationId: null,
          tier: SyncObservabilityTier.Metadata,
        })
      ),
      recordSyncConsent: vi.fn((payload: { level: DataSyncLevel }) =>
        Promise.resolve({ level: payload.level, organizationId: null })
      ),
    },
  });
}

function flagAdapterFor(enabled: boolean) {
  return {
    useFeatureFlagEnabled: (key: string) =>
      key === SHOW_REDACTED_SYNC_LEVEL_FLAG_KEY && enabled,
  };
}

/**
 * Mounts BOTH surfaces — the desktop Data & Sync tab, which reads
 * `window.desktopApi` directly, and the Settings v2 panel section, which reaches
 * the same bridge through the host port — under one flag state.
 */
function renderBothSurfaces(flagEnabled: boolean): {
  tab: HTMLElement;
  panel: HTMLElement;
} {
  const flagAdapter = flagAdapterFor(flagEnabled);
  const hostAdapter = createDesktopSettingsHostAdapter(window.desktopApi);
  const wrap = (node: ReactNode) => (
    <FeatureFlagAdapterProvider adapter={flagAdapter}>
      <SettingsHostAdapterProvider adapter={hostAdapter}>
        {node}
      </SettingsHostAdapterProvider>
    </FeatureFlagAdapterProvider>
  );
  return {
    tab: render(wrap(<DataSyncTab />)).container,
    panel: render(wrap(<ThisDeviceSyncSection />)).container,
  };
}

/**
 * The option labels a screen reader announces, in rendered order. `aria-label`
 * on the radio IS its accessible name here — the shared picker sets it so the
 * name is the level title rather than the whole card body.
 */
async function renderedOptionAccessibleNames(
  container: HTMLElement
): Promise<string[]> {
  const radios = await within(container).findAllByRole("radio");
  return radios.map((radio) => radio.getAttribute("aria-label") ?? "");
}

afterEach(() => {
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
  vi.restoreAllMocks();
});

describe("data-sync option parity across the two surfaces", () => {
  it("both surfaces read one shared flag key", () => {
    // The one place the key literal is pinned: a rename that reaches only one
    // reader cannot pass silently, and the parity cases below would then be
    // comparing two different flag states.
    expect(SHOW_REDACTED_SYNC_LEVEL_FLAG_KEY).toBe("showRedactedSyncLevel");
    expect(DESKTOP_SHOW_REDACTED_SYNC_LEVEL_FEATURE_FLAG_KEY).toBe(
      SHOW_REDACTED_SYNC_LEVEL_FLAG_KEY
    );
  });

  it("offers the identical option set on both surfaces with the flag off", async () => {
    installDesktopApi(DataSyncLevel.Metadata);
    const { tab, panel } = renderBothSurfaces(false);

    const tabNames = await renderedOptionAccessibleNames(tab);
    const panelNames = await renderedOptionAccessibleNames(panel);

    expect(panelNames).toEqual(tabNames);
    // Exactly one canonical level is withheld, so the equality above is between
    // two real option sets rather than two empty ones.
    expect(tabNames).toHaveLength(DATA_SYNC_LEVELS.length - 1);
    expect(tabNames.every((name) => name.length > 0)).toBe(true);
  });

  it("offers the identical option set on both surfaces with the flag on", async () => {
    installDesktopApi(DataSyncLevel.Metadata);
    const { tab, panel } = renderBothSurfaces(true);

    const tabNames = await renderedOptionAccessibleNames(tab);
    const panelNames = await renderedOptionAccessibleNames(panel);

    expect(panelNames).toEqual(tabNames);
    expect(tabNames).toHaveLength(DATA_SYNC_LEVELS.length);
  });

  it("keeps a persisted redacted level offered on both surfaces while the flag is off", async () => {
    // The two surfaces derive the current level from different places — the tab
    // from its own state, the panel from the host projection — so the
    // never-orphan-the-selection rule is where they can most easily drift.
    installDesktopApi(DataSyncLevel.Redacted);
    const { tab, panel } = renderBothSurfaces(false);

    const tabNames = await renderedOptionAccessibleNames(tab);
    const panelNames = await renderedOptionAccessibleNames(panel);

    expect(panelNames).toEqual(tabNames);
    expect(tabNames).toHaveLength(DATA_SYNC_LEVELS.length);
  });

  it("renders nothing on the panel side when the host has no sync-policy capability", () => {
    // Web. The control's absence is structural — the web adapter omits the
    // capability — not a read that has not landed, so there is no skeleton and
    // no option set either.
    installDesktopApi(DataSyncLevel.Metadata);
    const { container } = render(
      <FeatureFlagAdapterProvider adapter={flagAdapterFor(true)}>
        <SettingsHostAdapterProvider adapter={webSettingsHostAdapter}>
          <ThisDeviceSyncSection />
        </SettingsHostAdapterProvider>
      </FeatureFlagAdapterProvider>
    );

    expect(container.innerHTML).toBe("");
    expect(within(container).queryByRole("radio")).toBeNull();
  });
});
