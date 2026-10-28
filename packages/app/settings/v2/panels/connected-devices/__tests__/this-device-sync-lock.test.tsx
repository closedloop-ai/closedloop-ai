import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import {
  SettingsLocalDeviceReason,
  type SettingsLocalSyncPolicyProjection,
  settingsLocalDeviceUnavailable,
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
 * The in-flight lock on the sync picker (ISS-8366).
 *
 * The section used to hold the control with `pointer-events-none` alone, which
 * stops a mouse and lets an arrow key straight through Radix's roving-tabindex
 * group. This asserts the RENDERED control, so deleting the `disabled` prop the
 * section passes fails here rather than shipping a lock that is real for one
 * input mode and decorative for the other.
 */

function gatedSyncHost(): {
  adapter: SettingsHostAdapter;
  settleWrite: () => void;
} {
  const gates: Array<() => void> = [];
  return {
    adapter: {
      host: SettingsPanelHost.Desktop,
      localSyncPolicy: {
        read: () =>
          Promise.resolve(settingsLocalSyncPolicyReady(DataSyncLevel.Off)),
        write: (level: DataSyncLevel) =>
          new Promise<SettingsLocalSyncPolicyProjection>((resolve) => {
            gates.push(() => resolve(settingsLocalSyncPolicyReady(level)));
          }),
      },
      readLocalDevice: () =>
        Promise.resolve(
          settingsLocalDeviceUnavailable(
            SettingsLocalDeviceReason.BridgeUnavailable
          )
        ),
    },
    settleWrite: () => {
      for (const gate of gates) {
        gate();
      }
    },
  };
}

describe("ThisDeviceSyncSection while a write is in flight", () => {
  it("locks the picker itself, not just its pointer events", async () => {
    const { adapter, settleWrite } = gatedSyncHost();
    render(
      <SettingsHostAdapterProvider adapter={adapter}>
        <ThisDeviceSyncSection />
      </SettingsHostAdapterProvider>
    );

    const metadata = await screen.findByRole("radio", {
      name: DATA_SYNC_LEVEL_COPY[DataSyncLevel.Metadata].title,
    });
    fireEvent.click(metadata);
    fireEvent.click(screen.getByRole("button", { name: "Save sync choice" }));

    await waitFor(() => expect(metadata).toBeDisabled());

    // ...and released when the host answers, or the control would be inert for
    // the rest of the session.
    settleWrite();
    await waitFor(() => expect(metadata).not.toBeDisabled());
  });
});
