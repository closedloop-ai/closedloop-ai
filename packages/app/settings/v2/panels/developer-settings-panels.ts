"use client";

import {
  SettingsPanelCapability,
  SettingsPanelHost,
  SettingsPanelId,
} from "@repo/api/src/types/settings-panel";
import { FlaskConicalIcon, KeyRoundIcon, PuzzleIcon } from "lucide-react";
import { lazy } from "react";
import type { SettingsPanelDescriptor } from "../lib/settings-panel-registry";
import { defineSettingsPanel } from "../lib/settings-panel-registry";

/**
 * The three panel packages ISS-8369 owns, authored the way the registry expects
 * (ISS-8362): one {@link defineSettingsPanel} call each, no shared file edited,
 * each body behind `React.lazy` so it stays out of the Settings entry bundle.
 * The shell already provides the Suspense and error boundaries a lazy body
 * needs.
 */
const PLUGINS_PANEL: SettingsPanelDescriptor = defineSettingsPanel({
  // Web only. Connecting a plugin starts a browser OAuth redirect to a web app
  // route; a desktop renderer would need a system browser and a loopback
  // callback, which does not exist. Declaring the host is what makes desktop
  // render the registry's `unavailable` screen ("this build cannot do that")
  // instead of a Connect button that silently cannot work — and it is a
  // different fact from `forbidden`, which the registry already keeps apart.
  hosts: [SettingsPanelHost.Web],
  icon: PuzzleIcon,
  id: SettingsPanelId.Plugins,
  Panel: lazy(async () => ({
    default: (await import("./plugins-settings-panel")).PluginsSettingsPanel,
  })),
  requiredCapability: SettingsPanelCapability.Read,
});

const API_KEYS_PANEL: SettingsPanelDescriptor = defineSettingsPanel({
  hosts: [SettingsPanelHost.Web, SettingsPanelHost.Desktop],
  icon: KeyRoundIcon,
  id: SettingsPanelId.ApiKeys,
  Panel: lazy(async () => ({
    default: (await import("./api-keys-settings-panel")).ApiKeysSettingsPanel,
  })),
  // `Read` opens the panel; a member sees and manages their OWN keys, which the
  // route already scopes by user. The narrower question of whose keys come back
  // is the server's, not this descriptor's, and it stays the server's: the
  // panel renders whatever `/api-keys` returns and does no filtering of its own.
  requiredCapability: SettingsPanelCapability.Read,
});

const OTHER_LABS_PANEL: SettingsPanelDescriptor = defineSettingsPanel({
  hosts: [SettingsPanelHost.Web, SettingsPanelHost.Desktop],
  icon: FlaskConicalIcon,
  id: SettingsPanelId.OtherLabs,
  Panel: lazy(async () => ({
    default: (await import("./other-labs-settings-panel"))
      .OtherLabsSettingsPanel,
  })),
  // Reading the org's Labs settings needs `Read`; the WRITE is admin-gated by
  // the route (`/settings/frustration` PUT), and the panel renders that refusal
  // rather than hiding the switch, because a hidden control is not a denial.
  requiredCapability: SettingsPanelCapability.Read,
});

/**
 * The three descriptors this package offers (ISS-8369).
 *
 * ISS-10244 retired `settings-developer-panels`, the flag that used to decide
 * whether these were registered at all. The panels shipped, so the gate is gone
 * rather than opened: there is no hook and no boolean, and the composition roots
 * spread this list directly.
 */
export const DEVELOPER_SETTINGS_PANELS: readonly SettingsPanelDescriptor[] =
  Object.freeze([PLUGINS_PANEL, API_KEYS_PANEL, OTHER_LABS_PANEL]);
