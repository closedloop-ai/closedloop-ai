import {
  type SettingsActorCapabilities,
  SettingsActorCapabilityStatus,
  SettingsPanelCapability,
  SettingsPanelHost,
  type SettingsPanelId,
} from "@repo/api/src/types/settings-panel";
import { CircleIcon } from "lucide-react";
import {
  defineSettingsPanel,
  type SettingsPanelDescriptor,
} from "../lib/settings-panel-registry";

/**
 * A panel authored exactly as a panel package (ISS-8363..8369) would author it:
 * one `defineSettingsPanel` call, no shared file touched.
 */
export function fixturePanel(
  id: SettingsPanelId,
  overrides: Partial<Omit<SettingsPanelDescriptor, "id">> = {}
): SettingsPanelDescriptor {
  return defineSettingsPanel({
    hosts: [SettingsPanelHost.Web, SettingsPanelHost.Desktop],
    icon: CircleIcon,
    id,
    Panel: () => <div data-testid={`panel-body-${id}`}>{id} body</div>,
    requiredCapability: SettingsPanelCapability.Read,
    ...overrides,
  });
}

export function grantRead(
  ...ids: readonly SettingsPanelId[]
): SettingsActorCapabilities {
  return {
    grants: Object.fromEntries(
      ids.map((id) => [id, [SettingsPanelCapability.Read]])
    ),
    status: SettingsActorCapabilityStatus.Ready,
  };
}
