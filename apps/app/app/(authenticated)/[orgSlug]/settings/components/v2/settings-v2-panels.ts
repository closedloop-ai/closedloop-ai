import { DESKTOP_ONLY_SETTINGS_PANEL_PLACEHOLDERS } from "@repo/app/settings/v2/lib/settings-panel-host-availability";
import type { SettingsPanelDescriptor } from "@repo/app/settings/v2/lib/settings-panel-registry";
import { SHARED_SETTINGS_PANEL_DESCRIPTORS } from "@repo/app/settings/v2/lib/use-settings-panel-registry";
import { MEMBERS_SETTINGS_PANEL } from "./members/members-settings-panel";
import { PROFILE_SETTINGS_PANEL } from "./profile/profile-settings-panel";

/**
 * The web-owned descriptors that read no flag (ISS-8370 D5). Profile is the
 * default panel, so gating it would turn a plain visit into `Unknown`; Members
 * flagged off inside v2 would withdraw administration the legacy tree offers.
 */
export const UNFLAGGED_WEB_SETTINGS_PANELS: readonly SettingsPanelDescriptor[] =
  Object.freeze([PROFILE_SETTINGS_PANEL, MEMBERS_SETTINGS_PANEL]);

/**
 * Every descriptor the web shell can import, flags ignored — all eleven. The
 * eleventh is the desktop-owned Desktop App panel, present as the placeholder
 * that makes a web link naming it `unavailable` rather than `unknown`
 * (ISS-10286); the web shell cannot import its real body. The
 * ownership set the web root asserts completeness over at module scope; the
 * rendered registry is the flag-filtered composition `useSharedSettingsPanelRegistry`
 * builds in render.
 */
export const WEB_SETTINGS_PANEL_DESCRIPTORS: readonly SettingsPanelDescriptor[] =
  Object.freeze([
    ...SHARED_SETTINGS_PANEL_DESCRIPTORS,
    ...UNFLAGGED_WEB_SETTINGS_PANELS,
    ...DESKTOP_ONLY_SETTINGS_PANEL_PLACEHOLDERS,
  ]);
