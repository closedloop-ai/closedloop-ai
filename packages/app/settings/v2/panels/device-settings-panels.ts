"use client";

import type { SettingsPanelDescriptor } from "../lib/settings-panel-registry";
import { connectedDevicesSettingsPanel } from "./connected-devices/connected-devices-settings-panel";

/**
 * The `packages/app` half of ISS-8366's device panels, authored the way the
 * registry expects (ISS-8362): one `defineSettingsPanel` call, no shared file
 * edited, the body behind `React.lazy`.
 *
 * ISS-10244 retired `settings-device-panels`, the flag both halves used to read.
 * The panels shipped, so the gate is gone rather than opened, and with it the
 * two-read-site arrangement that gate required.
 */
export const DEVICE_SETTINGS_PANELS: readonly SettingsPanelDescriptor[] =
  Object.freeze([connectedDevicesSettingsPanel]);
