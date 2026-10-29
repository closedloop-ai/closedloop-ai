"use client";

import { useFeatureFlagEnabledOptional } from "../../../shared/feature-flags/use-feature-flag-enabled";
import { ARTIFACT_TAGS_FEATURE_FLAG_KEY } from "../../../shared/lib/feature-flags";
import type { SettingsPanelDescriptor } from "../lib/settings-panel-registry";
import { complianceSettingsPanel } from "./compliance/compliance-settings-panel";
import { customFieldsSettingsPanel } from "./custom-fields/custom-fields-settings-panel";
import { tagsSettingsPanel } from "./tags/tags-settings-panel";

/**
 * The three organization-governance panel packages ISS-8367 owns, authored the
 * way the registry expects (ISS-8362): one `defineSettingsPanel` call each, no
 * shared file edited, each body behind `React.lazy` so it stays out of the
 * Settings entry bundle. The full set is exported for the ownership registry
 * the composition root asserts over (ISS-8370 D4), the tags capability ignored.
 */
export const GOVERNANCE_PANELS_WITH_TAGS: readonly SettingsPanelDescriptor[] =
  Object.freeze([
    customFieldsSettingsPanel,
    tagsSettingsPanel,
    complianceSettingsPanel,
  ]);

const GOVERNANCE_PANELS_WITHOUT_TAGS: readonly SettingsPanelDescriptor[] =
  Object.freeze([customFieldsSettingsPanel, complianceSettingsPanel]);

/**
 * THE read site for `artifact-tags`, the one key that still decides anything
 * about this package.
 *
 * ISS-10244 retired `settings-governance-panels`, the PACKAGE gate that used to
 * sit above this read. These panels shipped, so the gate is gone rather than
 * opened — the three descriptors are registered unconditionally and there is no
 * "none" shape left to return.
 *
 * **`artifact-tags`** survives because it is not a rollout flag: it decides
 * whether the tags capability exists in the product at all, and legacy Settings
 * hides its Tags tab behind it today. Registering Tags without consulting it
 * would resurrect, for every organization, a capability an operator has
 * switched off — so the key is read once, here, and swaps the descriptor in or
 * out. It is never threaded into the panel body, which has no idea it exists.
 *
 * `…Optional` rather than the plain hook so a mount site without a feature-flag
 * provider (Storybook, a bare test tree) resolves CLOSED instead of throwing.
 */
export function useGovernanceSettingsPanels(): readonly SettingsPanelDescriptor[] {
  return useFeatureFlagEnabledOptional(ARTIFACT_TAGS_FEATURE_FLAG_KEY)
    ? GOVERNANCE_PANELS_WITH_TAGS
    : GOVERNANCE_PANELS_WITHOUT_TAGS;
}
