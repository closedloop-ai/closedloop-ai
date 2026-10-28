import {
  SettingsPanelCapability,
  SettingsPanelHost,
  SettingsPanelId,
} from "@repo/api/src/types/settings-panel";
import type { SettingsPanelDescriptor } from "@repo/app/settings/v2/lib/settings-panel-registry";
import { defineSettingsPanel } from "@repo/app/settings/v2/lib/settings-panel-registry";
import { LaptopIcon } from "lucide-react";
import { lazy } from "react";

/**
 * Settings v2 → Labs → **Desktop App** (ISS-10286).
 *
 * WHY IT EXISTS. ISS-10195 made Settings v2 unconditional, which left the whole
 * legacy desktop Settings tree with no mount: its controls are held by the
 * Electron main process and no v2 panel owned any of them, so Trusted Browser
 * Enforcement, Dangerous Auto-Approve, the desktop API-key editor, the global
 * sandbox root, the relay-gateway profiles, the CLI binary paths and the
 * data-sync level all became unreachable. Where they should live was a product
 * decision; the operator ruled on 2026-09-16 that they get a tab under Labs.
 *
 * DESKTOP ONLY, and that is the panel's nature rather than a rollout stage:
 * every control reads and writes `window.desktopApi`, which no browser has.
 * The web shell registers a placeholder for this id so a link naming it there
 * resolves `unavailable` ("isn't part of the web app") rather than `unknown`.
 *
 * `requiredCapability` is `Read` because these are the viewer's own machine
 * settings — there is no org role that grants or withholds them, and restating
 * a rung here would be a second, drifting copy of a rule the domain policy does
 * not have.
 *
 * `React.lazy` so the four control bodies stay out of the Settings entry
 * bundle; the shell already provides the Suspense and error boundaries.
 */
export const DESKTOP_APP_SETTINGS_PANEL: SettingsPanelDescriptor =
  defineSettingsPanel({
    hosts: [SettingsPanelHost.Desktop],
    icon: LaptopIcon,
    id: SettingsPanelId.DesktopApp,
    Panel: lazy(async () => ({
      default: (await import("./desktop-app-panel")).DesktopAppPanel,
    })),
    requiredCapability: SettingsPanelCapability.Read,
  });
