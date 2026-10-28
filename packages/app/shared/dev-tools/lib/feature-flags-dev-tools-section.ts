"use client";

import {
  FEATURE_FLAG_OVERRIDES_STORAGE_KEY,
  isOverridableFeatureFlagKey,
} from "@repo/api/src/types/feature-flag-overrides";
import { useMemo } from "react";
import { ArtifactFlag } from "../../lib/artifact-flags";
// biome-ignore lint/performance/noNamespaceImport: this module's export set IS the canonical flag-key registry. A named-import list would restate every key, and a key added there would silently never appear in the overlay.
import * as FeatureFlagKeys from "../../lib/feature-flags";
import { useCheckedFeatureFlags } from "../hooks/use-checked-feature-flags";
import { useFeatureFlagProductionValue } from "../hooks/use-feature-flag-production-value";
import {
  DEV_TOOLS_ALL_FLAGS_LABEL,
  DEV_TOOLS_FEATURE_FLAGS_TITLE,
  DEV_TOOLS_ON_THIS_PAGE_LABEL,
} from "./dev-tools-copy";
import type { DevToolsControl, DevToolsSection } from "./dev-tools-registry";

// Above the section below, which reads it while this module initializes.
const FLAG_KEY_EXPORT_NAME = /_FEATURE_FLAG_KEY$/;

/**
 * ISS-12048: the first Dev Tools section. One On/Off control per flag key in
 * the canonical client registry (`shared/lib/feature-flags.ts`, plus the
 * `ArtifactFlag` keys it re-exports), labelled with the key itself. Its
 * settings are the overrides `@repo/analytics/feature-flag-overrides` applies
 * over PostHog while Dev Mode is on.
 *
 * The flags the current page checked (browser and server) come first. Each
 * flag shows its production value until overridden, and choosing that value
 * clears the override. A restriction flag never gets a control: it can never
 * be overridden.
 */
export const FEATURE_FLAGS_DEV_TOOLS_SECTION: DevToolsSection = {
  id: "feature-flags",
  title: DEV_TOOLS_FEATURE_FLAGS_TITLE,
  storageKey: FEATURE_FLAG_OVERRIDES_STORAGE_KEY,
  controls: collectFeatureFlagKeys(FeatureFlagKeys).map(toControl),
  highlight: {
    useControls: useCheckedFeatureFlagControls,
    showAllLabel: DEV_TOOLS_ALL_FLAGS_LABEL,
    heading: DEV_TOOLS_ON_THIS_PAGE_LABEL,
  },
  useDefaultValue: useFeatureFlagProductionValue,
};

/**
 * Every flag key exported by `moduleExports` (each `*_FEATURE_FLAG_KEY` string
 * export) plus the `ArtifactFlag` keys, de-duplicated (several exports alias
 * one key) and sorted by key.
 */
export function collectFeatureFlagKeys(
  moduleExports: Readonly<Record<string, unknown>>
): string[] {
  const keys = new Set<string>(Object.values(ArtifactFlag));
  for (const [exportName, value] of Object.entries(moduleExports)) {
    if (typeof value === "string" && FLAG_KEY_EXPORT_NAME.test(exportName)) {
      keys.add(value);
    }
  }
  return [...keys]
    .filter(isOverridableFeatureFlagKey)
    .sort((a, b) => a.localeCompare(b));
}

/** The page's checked keys as controls, overridable only, sorted by key. */
function useCheckedFeatureFlagControls(): readonly DevToolsControl[] {
  const checked = useCheckedFeatureFlags();
  return useMemo(
    () =>
      [...checked]
        .filter(isOverridableFeatureFlagKey)
        .sort((a, b) => a.localeCompare(b))
        .map(toControl),
    [checked]
  );
}

function toControl(key: string): DevToolsControl {
  return { id: key, label: key };
}
