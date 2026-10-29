"use client";

import type { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import {
  SettingsLocalDeviceStatus,
  type SettingsLocalSyncPolicyProjection,
} from "@repo/api/src/types/settings-host-capabilities";
import { SHOW_REDACTED_SYNC_LEVEL_FLAG_KEY } from "@repo/api/src/types/show-redacted-sync-level-flag";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { useEffect, useRef, useState } from "react";
import { DataSyncPolicyChoice } from "../../../../shared/components/data-sync-policy-choice";
import { useFeatureFlagEnabledOptional } from "../../../../shared/feature-flags/use-feature-flag-enabled";
import {
  offeredDataSyncLevelsWithoutRedaction,
  offeredDataSyncLevelsWithRedaction,
} from "../../../../shared/lib/data-sync-level-options";
import { useLocalSyncPolicy } from "../../../../shared/settings-host/use-local-sync-policy";
import { SettingsWriteOutcomeAlert } from "../../components/settings-write-outcome-alert";
import { SettingsPanelDataState } from "../../lib/settings-panel-data-state";
import { DevicePanelGroup } from "./device-panel-group";

/**
 * THIS machine's own sync policy, the third producer Connected Devices renders
 * (PLN-1915 Step 4, D5/D6).
 *
 * CURRENT DEVICE ONLY, and the absence elsewhere is structural: the control
 * exists exactly where the host port carries a local sync-policy capability,
 * and the web adapter omits it, so there is no host check and no hidden branch
 * deciding whether to offer a local write. No other device gets a policy row at
 * all, read-only or otherwise — production has none to report.
 *
 * The write goes through the already-landed consent-recording bridge, so
 * Settings saves an explicit answer for the current organization instead of
 * merely changing the reconciled level the picker displays.
 */

export function ThisDeviceSyncSection({
  focusSyncPolicy = false,
}: Readonly<{ focusSyncPolicy?: boolean }> = {}) {
  const policy = useLocalSyncPolicy();
  const sectionRef = useRef<HTMLDivElement | null>(null);
  /** The labelled region, which is what gets aligned — see the effect below. */
  const groupRef = useRef<HTMLElement | null>(null);
  const [selectedLevel, setSelectedLevel] = useState<DataSyncLevel | null>(
    null
  );
  // THE read site for this key on this surface. It picks between two whole
  // option sets rather than handing a boolean onward; the desktop Data & Sync
  // tab reads the same shared key and picks between the same two.
  const showRedacted = useFeatureFlagEnabledOptional(
    SHOW_REDACTED_SYNC_LEVEL_FLAG_KEY
  );

  const readyProjection =
    policy.state.status === "settled" &&
    policy.state.projection.status === SettingsLocalDeviceStatus.Ready
      ? policy.state.projection
      : null;
  const currentLevel = readyProjection?.recorded ? readyProjection.level : null;
  const levels = showRedacted
    ? offeredDataSyncLevelsWithRedaction()
    : offeredDataSyncLevelsWithoutRedaction(currentLevel);
  const focusSyncPolicyState =
    policy.state.status === "settled"
      ? policy.state.projection.status
      : policy.state.status;

  useEffect(() => {
    setSelectedLevel(policy.state.status === "pending" ? null : currentLevel);
  }, [currentLevel, policy.state.status]);

  useEffect(() => {
    if (!focusSyncPolicy || focusSyncPolicyState === "pending") {
      return;
    }
    // `start` on the GROUP, not `center` on the options.
    //
    // Centring worked while this section was short and stopped the day it grew
    // its comparison rows: four option cards at four rows each is taller than
    // the dialog's scroller, so centring a box taller than the viewport lands
    // the reader in the MIDDLE of it — the heading and the first option cut off
    // above, the Save control below the fold, and no part of the screen saying
    // there is anything to save. Aligning the group's top means the reader
    // arrives at the question and reads down to the answer, which is the order
    // the section is written in.
    groupRef.current?.scrollIntoView({ block: "start", inline: "nearest" });
    // Focus stays on the options themselves — that is what a keyboard reader is
    // being sent here to operate — and `preventScroll` keeps it from undoing the
    // alignment above.
    sectionRef.current?.focus({ preventScroll: true });
  }, [focusSyncPolicy, focusSyncPolicyState]);

  if (!policy.supported) {
    return null;
  }

  return (
    <DevicePanelGroup
      description="How much of this machine's data goes to the Closedloop cloud."
      ref={groupRef}
      title="This device's sync level"
    >
      <div
        className="flex flex-col gap-3 outline-none"
        data-this-device-sync-policy=""
        data-this-device-sync-recorded={
          readyProjection ? String(readyProjection.recorded) : undefined
        }
        ref={sectionRef}
        tabIndex={focusSyncPolicy ? -1 : undefined}
      >
        <LocalSyncPolicyBody
          currentLevel={currentLevel}
          isWriting={policy.isWriting}
          levels={levels}
          onSave={policy.write}
          onSelect={setSelectedLevel}
          selectedLevel={selectedLevel}
          state={policy.state}
        />
        <LocalSyncWriteOutcome outcome={policy.writeOutcome} />
      </div>
    </DevicePanelGroup>
  );
}

function LocalSyncPolicyBody({
  state,
  currentLevel,
  levels,
  isWriting,
  onSave,
  onSelect,
  selectedLevel,
}: Readonly<{
  state: ReturnType<typeof useLocalSyncPolicy>["state"];
  currentLevel: DataSyncLevel | null;
  levels: readonly DataSyncLevel[];
  isWriting: boolean;
  onSave: (level: DataSyncLevel) => void;
  onSelect: (level: DataSyncLevel) => void;
  selectedLevel: DataSyncLevel | null;
}>) {
  if (state.status === "pending") {
    return (
      <div aria-busy="true" className="flex flex-col gap-2" role="status">
        <span className="sr-only">Loading this device's sync level</span>
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }
  if (state.projection.status === SettingsLocalDeviceStatus.Ready) {
    return (
      <DataSyncPolicyChoice
        currentLevel={currentLevel}
        isWriting={isWriting}
        levels={levels}
        onSave={onSave}
        onSelect={onSelect}
        selectedLevel={selectedLevel}
      />
    );
  }
  // Unavailable and Error are NOT the same fact. An installed build whose
  // preload predates the sync channels simply cannot offer the control, and
  // saying so plainly is not an error — nothing failed and there is nothing to
  // retry. A read that was supposed to work and did not gets the alert below.
  if (state.projection.status === SettingsLocalDeviceStatus.Unavailable) {
    return (
      <p
        className="text-muted-foreground text-sm"
        data-this-device-sync-state={state.projection.status}
      >
        This app can't change the sync level from here. Update the desktop app,
        or use Settings → Data &amp; Sync.
      </p>
    );
  }
  return (
    <div data-this-device-sync-state={state.projection.status}>
      <SettingsWriteOutcomeAlert state={SettingsPanelDataState.Failed} />
    </div>
  );
}

function LocalSyncWriteOutcome({
  outcome,
}: Readonly<{ outcome: SettingsLocalSyncPolicyProjection | null }>) {
  if (outcome === null || outcome.status === SettingsLocalDeviceStatus.Ready) {
    return null;
  }
  return (
    <div data-this-device-sync-write={outcome.status}>
      <SettingsWriteOutcomeAlert
        state={
          outcome.status === SettingsLocalDeviceStatus.Unavailable
            ? SettingsPanelDataState.Unavailable
            : SettingsPanelDataState.Failed
        }
      />
    </div>
  );
}
