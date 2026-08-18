import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import type { ReactNode } from "react";
import { DataSyncLevel } from "../../../shared/contracts";
import { DESKTOP_SHOW_REDACTED_SYNC_LEVEL_FEATURE_FLAG_KEY } from "../../../shared/feature-flags";
import { DataSyncTab } from "./data-sync-tab";

/**
 * ISS-4779 (wongk story review on PR #4500): the closed-by-default gating of the
 * "Redacted sessions" option is a prop-driven visual state matrix, and exactly
 * the kind of thing a jsdom render test cannot pin — `visibleLevels` filters the
 * rendered radio set from two inputs (the show-Redacted Labs flag and the level
 * the user is already persisted on), so which options appear is a rendered
 * outcome, not a static list. The sibling render test
 * (`__tests__/data-sync-tab.test.tsx`) proves which option set is chosen; it
 * runs with no Tailwind loaded and is structurally blind to how the picker,
 * badges, and elevated affordance actually lay out.
 *
 * Each story drives the same two seams the component and its unit test already
 * use — no new provider is invented: `window.desktopApi.getDataSyncLevel` seeds
 * the persisted level (installed synchronously before the tab mounts, so its
 * mount-time read resolves against the fixture), and `FeatureFlagAdapterProvider`
 * resolves the show-Redacted flag. `setDataSyncLevel` echoes the picked level so
 * Apply round-trips on the canvas the way the real IPC bridge does.
 */
const meta = {
  title: "Desktop/Settings/Data Sync Tab",
  component: DataSyncTab,
  parameters: {
    layout: "fullscreen",
  },
};

export default meta;

/**
 * The closed-by-default state: the show-Redacted Labs flag is OFF and the user
 * is on the Metadata level, so "Redacted sessions" is filtered out and only the
 * non-Redacted options render — most-permissive first (ISS-5318), with the green
 * "Recommended" pill on "Full transcripts" and no chip on any other level.
 */
export const FlagOffDefault = {
  render: () => renderDataSyncStage(DataSyncLevel.Metadata, false),
};

/**
 * The flag ON: "Redacted sessions" joins the picker between Metadata only and
 * Full transcripts on the exposure ranking — so, rendered most-permissive first,
 * it sits second — and all four ranked levels are visible.
 */
export const FlagOn = {
  render: () => renderDataSyncStage(DataSyncLevel.Metadata, true),
};

/**
 * Orphan prevention: the flag is OFF, but the user is already persisted on
 * `redacted` (a migrated choice, or a level set while the flag was on). The
 * option they are on stays visible so their current selection is never orphaned
 * out from under them — the gate hides the option, it never strands a user.
 */
export const OrphanPrevention = {
  render: () => renderDataSyncStage(DataSyncLevel.Redacted, false),
};

// Installs the narrow `window.desktopApi` slice DataSyncTab reads, seeded with
// the persisted level, and wraps the tab in a feature-flag adapter that resolves
// the show-Redacted flag to `showRedacted` (every other flag stays off). The API
// is installed synchronously during render — before the tab's mount effect runs
// its `getDataSyncLevel` read — so the fixture, not a missing bridge, answers.
function renderDataSyncStage(
  persistedLevel: DataSyncLevel,
  showRedacted: boolean
): ReactNode {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      getDataSyncLevel: () => Promise.resolve({ level: persistedLevel }),
      setDataSyncLevel: (level: DataSyncLevel) => Promise.resolve({ level }),
    },
  });
  const adapter = {
    useFeatureFlagEnabled: (key: string) =>
      key === DESKTOP_SHOW_REDACTED_SYNC_LEVEL_FEATURE_FLAG_KEY && showRedacted,
  };
  return (
    <FeatureFlagAdapterProvider adapter={adapter}>
      <div className="mx-auto max-w-3xl p-6">
        <DataSyncTab />
      </div>
    </FeatureFlagAdapterProvider>
  );
}
