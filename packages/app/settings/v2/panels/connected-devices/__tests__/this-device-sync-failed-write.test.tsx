import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import {
  SettingsLocalDeviceReason,
  settingsLocalDeviceUnavailable,
  settingsLocalSyncPolicyError,
  settingsLocalSyncPolicyReady,
} from "@repo/api/src/types/settings-host-capabilities";
import { SettingsPanelHost } from "@repo/api/src/types/settings-panel";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DATA_SYNC_LEVEL_COPY } from "../../../../../shared/lib/data-sync-copy";
import { SettingsHostAdapterProvider } from "../../../../../shared/settings-host/provider";
import type { SettingsHostAdapter } from "../../../../../shared/settings-host/settings-host-adapter";
import { ThisDeviceSyncSection } from "../this-device-sync-section";

/**
 * A failed write must not take the panel with it (ISS-8366, whitlockk #6767).
 *
 * The write's answer used to replace the read state outright, and the read state
 * is what decides whether the picker renders at all — so one transient IPC
 * failure swapped the control for an error message with no retry and no re-read,
 * and the panel stayed unusable until it remounted.
 */

function failingWriteHost(): SettingsHostAdapter {
  return {
    host: SettingsPanelHost.Desktop,
    localSyncPolicy: {
      read: () =>
        Promise.resolve(settingsLocalSyncPolicyReady(DataSyncLevel.Off)),
      write: () =>
        Promise.resolve(
          settingsLocalSyncPolicyError(SettingsLocalDeviceReason.ReadFailed)
        ),
    },
    readLocalDevice: () =>
      Promise.resolve(
        settingsLocalDeviceUnavailable(
          SettingsLocalDeviceReason.BridgeUnavailable
        )
      ),
  };
}

describe("ThisDeviceSyncSection after a write that failed", () => {
  it("keeps the picker on screen, enabled, and reports the failure beside it", async () => {
    render(
      <SettingsHostAdapterProvider adapter={failingWriteHost()}>
        <ThisDeviceSyncSection />
      </SettingsHostAdapterProvider>
    );

    const metadata = await screen.findByRole("radio", {
      name: DATA_SYNC_LEVEL_COPY[DataSyncLevel.Metadata].title,
    });
    fireEvent.click(metadata);
    fireEvent.click(screen.getByRole("button", { name: "Save sync choice" }));

    await waitFor(() =>
      expect(
        document.querySelector('[data-this-device-sync-write="error"]')
      ).not.toBeNull()
    );
    // The control the user would retry with is still there, still usable, and
    // still carrying the user's staged retry value beside the failed-save state.
    expect(metadata).toBeInTheDocument();
    expect(metadata).not.toBeDisabled();
    expect(metadata).toBeChecked();
  });
});
