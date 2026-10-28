import {
  SettingsPanelCapability,
  SettingsPanelHost,
  SettingsPanelId,
} from "@repo/api/src/types/settings-panel";
import { SlidersHorizontalIcon } from "lucide-react";
import { lazy } from "react";
import {
  defineSettingsPanel,
  type SettingsPanelDescriptor,
} from "../../lib/settings-panel-registry";

/**
 * Settings v2 → Labs → Custom Fields (ISS-8367).
 *
 * `requiredCapability` is `Read`, and that is the policy table speaking rather
 * than a second opinion: `SETTINGS_DOMAIN_ACCESS_POLICY[CustomFields]` already
 * grants `read` to every role, so the descriptor restating `Admin` here would
 * be one rule written twice — and wrong the day the row moves. The admin-gated
 * WRITES are gated on the `admin` rung inside the body, where a per-control
 * gate belongs.
 *
 * Both hosts: the panel reads `/custom-fields` through the shared api client
 * and has no web-only concept in it.
 */
export const customFieldsSettingsPanel: SettingsPanelDescriptor =
  defineSettingsPanel({
    hosts: [SettingsPanelHost.Web, SettingsPanelHost.Desktop],
    icon: SlidersHorizontalIcon,
    id: SettingsPanelId.CustomFields,
    Panel: lazy(async () => ({
      default: (await import("./custom-fields-panel")).CustomFieldsPanel,
    })),
    requiredCapability: SettingsPanelCapability.Read,
  });
