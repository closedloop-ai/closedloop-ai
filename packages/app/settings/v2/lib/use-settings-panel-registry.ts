"use client";

import { useMemo } from "react";
import { DEVELOPER_SETTINGS_PANELS } from "../panels/developer-settings-panels";
import { DEVICE_SETTINGS_PANELS } from "../panels/device-settings-panels";
import {
  GOVERNANCE_PANELS_WITH_TAGS,
  useGovernanceSettingsPanels,
} from "../panels/governance-settings-panels";
import { organizationGeneralPanel } from "../panels/organization-general/organization-general-panel";
import {
  createSettingsPanelRegistry,
  type SettingsPanelDescriptor,
  type SettingsPanelRegistry,
} from "./settings-panel-registry";

/**
 * The shared descriptors that read no flag. ISS-10244 retired Organization
 * General's own body gate, so this panel is now unconditional end to end rather
 * than a descriptor that registers and then declines to render.
 */
const UNFLAGGED_SHARED_SETTINGS_PANELS: readonly SettingsPanelDescriptor[] =
  Object.freeze([organizationGeneralPanel]);

/**
 * Every descriptor this package offers, flags ignored — the OWNERSHIP set a
 * composition root asserts completeness over at module scope (ISS-8370 D4).
 * Eight of the twelve canonical ids. Three of the other four are web-owned
 * and live in `apps/app`; the twelfth is the desktop-owned Desktop App panel
 * (ISS-10286), which each shell contributes for itself — its real body on
 * desktop, a placeholder on web.
 */
export const SHARED_SETTINGS_PANEL_DESCRIPTORS: readonly SettingsPanelDescriptor[] =
  Object.freeze([
    ...UNFLAGGED_SHARED_SETTINGS_PANELS,
    ...DEVELOPER_SETTINGS_PANELS,
    ...GOVERNANCE_PANELS_WITH_TAGS,
    ...DEVICE_SETTINGS_PANELS,
  ]);

const NO_EXTRA_PANELS: readonly SettingsPanelDescriptor[] = Object.freeze([]);

/**
 * The RENDERED registry (ISS-8370 D4/D5): every shared descriptor, plus whatever
 * the host adds.
 *
 * ISS-10244 retired the three panel-package rollout gates, so the only leaf key
 * left is `artifact-tags` — a product capability rather than a rollout ramp —
 * read by `useGovernanceSettingsPanels` at its own site. This hook still reads
 * no flag itself.
 *
 * `extra` is the host's own descriptors (web: Profile, Members and Local
 * Compute Targets); pass a stable reference, because the registry is memoised
 * on it. The order below is the order the panels register in.
 */
export function useSharedSettingsPanelRegistry(
  extra: readonly SettingsPanelDescriptor[] = NO_EXTRA_PANELS
): SettingsPanelRegistry {
  const governance = useGovernanceSettingsPanels();

  return useMemo(
    () =>
      createSettingsPanelRegistry([
        ...UNFLAGGED_SHARED_SETTINGS_PANELS,
        ...DEVELOPER_SETTINGS_PANELS,
        ...governance,
        ...DEVICE_SETTINGS_PANELS,
        ...extra,
      ]),
    [extra, governance]
  );
}
