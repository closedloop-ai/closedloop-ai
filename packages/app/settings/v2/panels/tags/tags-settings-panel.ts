import {
  SettingsPanelCapability,
  SettingsPanelHost,
  SettingsPanelId,
} from "@repo/api/src/types/settings-panel";
import { TagsIcon } from "lucide-react";
import { lazy } from "react";
import {
  defineSettingsPanel,
  type SettingsPanelDescriptor,
} from "../../lib/settings-panel-registry";

/**
 * Settings v2 → Labs → Tags (ISS-8367).
 *
 * `Read` opens it, and every role also holds `edit`: there is no admin gate
 * anywhere in `apps/api/app/tags`, and `SETTINGS_DOMAIN_ACCESS_POLICY[Tags]`
 * mirrors exactly that. Both hosts — `/tags` is a cloud read with no web-only
 * concept in it.
 */
export const tagsSettingsPanel: SettingsPanelDescriptor = defineSettingsPanel({
  hosts: [SettingsPanelHost.Web, SettingsPanelHost.Desktop],
  icon: TagsIcon,
  id: SettingsPanelId.Tags,
  Panel: lazy(async () => ({
    default: (await import("./tags-panel")).TagsPanel,
  })),
  requiredCapability: SettingsPanelCapability.Read,
});
