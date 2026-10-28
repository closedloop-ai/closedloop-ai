import {
  SettingsPanelCapability,
  SettingsPanelHost,
  SettingsPanelId,
} from "@repo/api/src/types/settings-panel";
import {
  defineSettingsPanel,
  type SettingsPanelDescriptor,
} from "@repo/app/settings/v2/lib/settings-panel-registry";
import { UsersIcon } from "lucide-react";
import { MembersSettingsPanelBody } from "./members-settings-panel-body";

/**
 * @file members-settings-panel.ts
 * @description The Settings v2 Members panel descriptor (ISS-8368). Claims the
 * id `@repo/api` already reserved rather than minting one, so nothing shared is
 * edited to add it.
 *
 * `hosts: [Web]` because the desktop renderer mounts no Clerk provider —
 * `@clerk/*` appears nowhere under `apps/desktop/src/renderer`, whose auth runs
 * through `desktop-auth-provider.tsx` — so `<OrganizationProfile>` cannot mount
 * there through any existing supported integration. Absence from a host
 * resolves to `unavailable`, which is a real screen with a recovery link and a
 * different fact from `forbidden`. The matching workspace-menu omission is M2.
 *
 * `requiredCapability: Read` because `SETTINGS_DOMAIN_ACCESS_POLICY[Members]`
 * grants read to every role. Clerk gates its own destructive controls by the
 * caller's organization role, so a plain member reaching the panel sees the
 * roster and not the admin actions.
 *
 * IT READS NO FEATURE FLAG, DELIBERATELY — the ISS-8364 Profile precedent. A
 * panel-level gate would be wrong on the merits: Members flagged off would take
 * away organization administration entirely.
 */
export const MEMBERS_SETTINGS_PANEL: SettingsPanelDescriptor =
  defineSettingsPanel({
    hosts: [SettingsPanelHost.Web],
    icon: UsersIcon,
    id: SettingsPanelId.Members,
    Panel: MembersSettingsPanelBody,
    requiredCapability: SettingsPanelCapability.Read,
  });
