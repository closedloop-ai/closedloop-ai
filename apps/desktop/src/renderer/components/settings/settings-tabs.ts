/**
 * ISS-5309 — the desktop Settings tab model, and the Labs gate over it.
 *
 * Extracted from `SettingsPanel.tsx` so the gating rules are pure data plus
 * three total functions: testable without mounting React, and impossible for a
 * second surface to re-derive differently. The panel renders `visibleSettingsTabs`
 * and resolves what it shows through `resolveVisibleSettingsTab`; nothing else
 * decides which tabs exist.
 */

export type SettingsTab =
  | "account"
  | "relay-gateway"
  | "data-sync"
  | "security"
  | "binary-paths"
  | "labs";

/** The Labs tab id, gated by the ISS-5037 `labsNav` container flag. */
export const LABS_SETTINGS_TAB: SettingsTab = "labs";

/**
 * Where the panel lands, and where a Labs-gated selection falls back to. Account
 * is the first tab and the one people are actually looking for, so a user whose
 * Labs toggle flips off mid-visit is put somewhere useful rather than on a blank.
 */
export const DEFAULT_SETTINGS_TAB: SettingsTab = "account";

export const SETTINGS_TABS: readonly { id: SettingsTab; label: string }[] = [
  { id: "account", label: "Account" },
  { id: "relay-gateway", label: "Relay / Gateway" },
  { id: "data-sync", label: "Data & Sync" },
  { id: "security", label: "Security" },
  { id: "binary-paths", label: "CLI Tools" },
  { id: LABS_SETTINGS_TAB, label: "Labs" },
];

export function isSettingsTab(value: string): value is SettingsTab {
  return SETTINGS_TABS.some((item) => item.id === value);
}

/**
 * The tabs that actually render. With the Labs container gate off, Labs is not
 * merely disabled — it is absent, trigger and content both, matching how the
 * sidebar drops the whole section rather than greying it out.
 */
export function visibleSettingsTabs(
  labsTabOn: boolean
): readonly { id: SettingsTab; label: string }[] {
  if (labsTabOn) {
    return SETTINGS_TABS;
  }
  return SETTINGS_TABS.filter((item) => item.id !== LABS_SETTINGS_TAB);
}

/** Whether `value` names a tab that is currently rendered. */
export function isVisibleSettingsTab(
  value: string,
  labsTabOn: boolean
): value is SettingsTab {
  return visibleSettingsTabs(labsTabOn).some((item) => item.id === value);
}

/**
 * The tab to actually SHOW, given the selection the panel is holding.
 *
 * Derived rather than synced through an effect, which is what makes the three
 * ways into a hidden Labs tab collapse into one answer with no
 * selected-but-empty frame in between:
 *   - the user is sitting on Labs when the application-menu toggle flips off —
 *     the next render is Account, live off `desktop:flags-changed`;
 *   - a `desktop:navigate-settings-tab` deep link asks for `"labs"`;
 *   - a relaunch restores a selection. The panel's selection is component state
 *     and is never persisted, so a relaunch starts from the default anyway — but
 *     resolving here means even a future persisted `"labs"` cannot come back
 *     while the gate is closed.
 *
 * The held selection is intentionally NOT rewritten. Turning Labs back on
 * returns the user to the tab they were on, the same composition rule the nav
 * gates use for per-item Labs flags.
 */
export function resolveVisibleSettingsTab(
  tab: SettingsTab,
  labsTabOn: boolean
): SettingsTab {
  return isVisibleSettingsTab(tab, labsTabOn) ? tab : DEFAULT_SETTINGS_TAB;
}
