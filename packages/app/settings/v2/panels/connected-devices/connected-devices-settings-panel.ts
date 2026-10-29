import {
  SettingsPanelCapability,
  SettingsPanelHost,
  SettingsPanelId,
} from "@repo/api/src/types/settings-panel";
import { MonitorSmartphoneIcon } from "lucide-react";
import { lazy } from "react";
import {
  defineSettingsPanel,
  type SettingsPanelDescriptor,
} from "../../lib/settings-panel-registry";

/**
 * Settings v2 → User → Connected Devices (ISS-8366, PLN-1915 Step 3).
 *
 * BOTH HOSTS (D1). The panel reads two cloud endpoints through the shared api
 * client and works on either shell; ISS-9085 built `currentSessionKnown`
 * specifically to answer for the Desktop transport, so declaring this Web-only
 * would strand a field designed for this consumer.
 *
 * `requiredCapability` is `Read` because `SETTINGS_DOMAIN_ACCESS_POLICY[Devices]`
 * already answers who may open it — every role — and restating a rung here
 * would be the same rule written twice, and the copy that goes stale the day the
 * policy row moves. The finer gate in this domain is ownership rather than
 * role, and it lives in the body: the desktop list shows only rows the viewer
 * owns.
 *
 * `React.lazy` so the body stays out of the Settings entry bundle; the shell
 * already provides the Suspense and error boundaries it needs.
 */
export const connectedDevicesSettingsPanel: SettingsPanelDescriptor =
  defineSettingsPanel({
    hosts: [SettingsPanelHost.Web, SettingsPanelHost.Desktop],
    icon: MonitorSmartphoneIcon,
    id: SettingsPanelId.ConnectedDevices,
    Panel: lazy(async () => ({
      default: (await import("./connected-devices-panel"))
        .ConnectedDevicesPanel,
    })),
    requiredCapability: SettingsPanelCapability.Read,
  });
