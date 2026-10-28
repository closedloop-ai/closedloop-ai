import {
  DATA_SYNC_LEVELS,
  DataSyncLevel,
} from "@repo/api/src/types/data-sync-level";
import {
  OnboardingAnalyticsEvent,
  OnboardingAnalyticsPageName,
  OnboardingAnalyticsProperty,
} from "@repo/api/src/types/onboarding-analytics";
import {
  SettingsLocalDeviceReason,
  type SettingsLocalSyncPolicyProjection,
  settingsLocalDeviceUnavailable,
  settingsLocalSyncPolicyReady,
} from "@repo/api/src/types/settings-host-capabilities";
import { SettingsPanelHost } from "@repo/api/src/types/settings-panel";
import { SHOW_REDACTED_SYNC_LEVEL_FLAG_KEY } from "@repo/api/src/types/show-redacted-sync-level-flag";
import { Surface } from "@repo/api/src/types/surface-analytics";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { FeatureFlagAdapterProvider } from "../../../../../shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "../../../../../shared/feature-flags/static-feature-flag-adapter";
import { DATA_SYNC_LEVEL_COPY } from "../../../../../shared/lib/data-sync-copy";
import { installButtonClickTracker } from "../../../../../shared/observability/button-click-tracker";
import { SettingsHostAdapterProvider } from "../../../../../shared/settings-host/provider";
import type { SettingsHostAdapter } from "../../../../../shared/settings-host/settings-host-adapter";
import { ThisDeviceSyncSection } from "../this-device-sync-section";

describe("ThisDeviceSyncSection explicit save", () => {
  it.each(DATA_SYNC_LEVELS)(
    "captures the selected %s on the real save button",
    async (level) => {
      const capture = vi.fn();
      const tracker = installButtonClickTracker({
        document: globalThis.document,
        capture,
        surface: Surface.Desktop,
        getPage: () => ({
          pageName: OnboardingAnalyticsPageName.Settings,
          entry: "/settings",
        }),
      });
      try {
        renderSection({
          projection: settingsLocalSyncPolicyReady(level, false),
        });
        const save = await screen.findByRole("button", {
          name: "Save sync choice",
        });
        fireEvent.click(
          screen.getByRole("radio", { name: DATA_SYNC_LEVEL_COPY[level].title })
        );
        await waitFor(() => expect(save).toBeEnabled());
        capture.mockClear();
        await userEvent.click(save);
        expect(capture).toHaveBeenCalledExactlyOnceWith(
          OnboardingAnalyticsEvent.ButtonClicked,
          expect.objectContaining({
            [OnboardingAnalyticsProperty.SyncChoiceSelected]: level,
          })
        );
      } finally {
        tracker.dispose();
      }
    }
  );

  it("requires a deliberate selection before recording the proposed Full level", async () => {
    const write = vi.fn((level: DataSyncLevel) =>
      Promise.resolve(settingsLocalSyncPolicyReady(level))
    );

    renderSection({
      projection: settingsLocalSyncPolicyReady(DataSyncLevel.Full, false),
      write,
    });

    const full = await fullRadio();
    expect(full).not.toBeChecked();
    const save = screen.getByRole("button", { name: "Save sync choice" });
    expect(save).toBeDisabled();
    fireEvent.click(full);
    await waitFor(() => expect(save).toBeEnabled());

    fireEvent.click(save);

    await waitFor(() => expect(write).toHaveBeenCalledWith(DataSyncLevel.Full));
  });

  it("does not offer a redundant save once the current level is recorded", async () => {
    renderSection({
      projection: settingsLocalSyncPolicyReady(DataSyncLevel.Full, true),
    });

    expect(await fullRadio()).toBeChecked();
    expect(
      screen.getByRole("button", { name: "Save sync choice" })
    ).toBeDisabled();
  });

  it("saves a changed recorded level only after the user confirms it", async () => {
    const write = vi.fn((level: DataSyncLevel) =>
      Promise.resolve(settingsLocalSyncPolicyReady(level))
    );

    renderSection({
      projection: settingsLocalSyncPolicyReady(DataSyncLevel.Full, true),
      write,
    });

    const metadata = await screen.findByRole("radio", {
      name: DATA_SYNC_LEVEL_COPY[DataSyncLevel.Metadata].title,
    });
    fireEvent.click(metadata);
    expect(write).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Save sync choice" }));

    await waitFor(() =>
      expect(write).toHaveBeenCalledWith(DataSyncLevel.Metadata)
    );
  });
});

function renderSection({
  projection,
  write = () => Promise.resolve(projection),
}: {
  projection: SettingsLocalSyncPolicyProjection;
  write?: (level: DataSyncLevel) => Promise<SettingsLocalSyncPolicyProjection>;
}) {
  return render(<ThisDeviceSyncSection />, {
    wrapper: wrapperFor(projection, write),
  });
}

function wrapperFor(
  projection: SettingsLocalSyncPolicyProjection,
  write: (level: DataSyncLevel) => Promise<SettingsLocalSyncPolicyProjection>
) {
  const adapter: SettingsHostAdapter = {
    host: SettingsPanelHost.Desktop,
    localSyncPolicy: {
      read: () => Promise.resolve(projection),
      write,
    },
    readLocalDevice: () =>
      Promise.resolve(
        settingsLocalDeviceUnavailable(
          SettingsLocalDeviceReason.BridgeUnavailable
        )
      ),
  };
  return ({ children }: { children: ReactNode }) => (
    <SettingsHostAdapterProvider adapter={adapter}>
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({
          enabledFlags: [SHOW_REDACTED_SYNC_LEVEL_FLAG_KEY],
        })}
      >
        {children}
      </FeatureFlagAdapterProvider>
    </SettingsHostAdapterProvider>
  );
}

function fullRadio() {
  return screen.findByRole("radio", {
    name: DATA_SYNC_LEVEL_COPY[DataSyncLevel.Full].title,
  });
}
