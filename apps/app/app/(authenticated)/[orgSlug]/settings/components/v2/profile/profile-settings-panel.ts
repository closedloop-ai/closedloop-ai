import {
  SettingsPanelCapability,
  SettingsPanelHost,
  SettingsPanelId,
} from "@repo/api/src/types/settings-panel";
import {
  defineSettingsPanel,
  type SettingsPanelDescriptor,
} from "@repo/app/settings/v2/lib/settings-panel-registry";
import { UserRoundIcon } from "lucide-react";
import { ProfileSettingsPanelBody } from "./profile-settings-panel-body";

/**
 * @file profile-settings-panel.ts
 * @description The Settings v2 Profile panel descriptor (ISS-8364) — the first
 * panel package. It claims the id `@repo/api` already reserved rather than
 * minting one, so nothing shared is edited to add it.
 *
 * IT READS NO FEATURE FLAG, DELIBERATELY. ISS-8370 D5 retired the
 * `settings-v2-profile-panel` ledger row, which never had a read site, and
 * ISS-10195 retired the program gate above it. A panel-level gate cannot work
 * anyway: `DEFAULT_SETTINGS_PANEL_ID` IS
 * `profile`, so a flag-off read would leave `resolveSettingsPanel` answering
 * `ready` with the nav still offering the row, and moving the gate up to
 * registration turns a plain visit into `Unknown` — the "that settings link
 * doesn't point anywhere" screen shown to a user who followed no link — while
 * making `assertSettingsPanelRegistryComplete` throw. The web composition root
 * (`../settings-v2-root.tsx`) registers it unconditionally.
 *
 * `hosts: [Web]` because the desktop renderer has its own Settings surface and
 * does not mount this one. Absence from a host resolves to `unavailable`, which
 * is a real screen with a recovery link, not a blank.
 */
export const PROFILE_SETTINGS_PANEL: SettingsPanelDescriptor =
  defineSettingsPanel({
    hosts: [SettingsPanelHost.Web],
    icon: UserRoundIcon,
    id: SettingsPanelId.Profile,
    Panel: ProfileSettingsPanelBody,
    requiredCapability: SettingsPanelCapability.Read,
  });
