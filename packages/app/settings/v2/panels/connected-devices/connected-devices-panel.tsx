"use client";

import { SettingsPanelIntent } from "@repo/api/src/types/settings-panel";
import { useSettingsLocalDevice } from "../../../../shared/settings-host/use-settings-local-device";
import { SettingsPanelSection } from "../../components/settings-panel-section";
import type { SettingsPanelProps } from "../../lib/settings-panel-registry";
import { BrowserSessionsSection } from "./browser-sessions-section";
import { DevicePanelGroup } from "./device-panel-group";
import { RegisteredDesktopsSection } from "./registered-desktops-section";
import { ThisDeviceSyncSection } from "./this-device-sync-section";

/**
 * Settings v2 → User → **Connected Devices** (ISS-8366, PLN-1915 Step 3).
 *
 * THREE PRODUCERS AND NO FOURTH (D5): the browser sign-in sessions ISS-9085
 * landed, the viewer's own registered Desktops from `/compute-targets`, and
 * this machine's own sync policy through the host port. Each block reads its
 * own data and classifies its own read, so one failing producer states its own
 * failure instead of blanking or, worse, emptying the others.
 *
 * WHAT THE APPROVED PREVIEW DRAWS AND THIS OMITS, with the producer that does
 * not exist: a reported sync policy on ANOTHER Desktop. `ComputeTarget` carries
 * no sync-level column, and deriving one from a device's most recent session
 * would render a fabricated measurement — and would show nothing at all for
 * exactly the devices that keep everything local. ISS-8366's v1 scope ruling
 * authorises the cut in terms.
 *
 * Both hosts (D1). Every read here goes through the shared api client, and
 * `currentSessionKnown` exists precisely to answer for a Desktop token that has
 * no browser session to identify, so declaring this Web-only would strand a
 * field built for this consumer.
 */
export function ConnectedDevicesPanel({ intent }: SettingsPanelProps) {
  const localDevice = useSettingsLocalDevice();

  return (
    <SettingsPanelSection
      description="Manage signed-in browsers, desktop clients, and device sync preferences."
      title="Connected Devices"
    >
      <div className="flex flex-col gap-6">
        <DevicePanelGroup
          description="Browsers you're currently signed in with."
          title="Browser sessions"
        >
          <BrowserSessionsSection />
        </DevicePanelGroup>
        <DevicePanelGroup
          description="Desktop clients connected to your account."
          title="Registered desktops"
        >
          <RegisteredDesktopsSection localDevice={localDevice} />
        </DevicePanelGroup>
        <ThisDeviceSyncSection
          focusSyncPolicy={intent === SettingsPanelIntent.SyncPolicy}
        />
      </div>
    </SettingsPanelSection>
  );
}
