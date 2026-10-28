"use client";

import type { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { Button } from "@repo/design-system/components/ui/button";
import { DataSyncLevelPicker } from "./data-sync-level-picker";
import { DataSyncPolicySummary } from "./data-sync-policy-summary";

/** Portable ready state of Settings' existing device policy control (ISS-12523). */
export function DataSyncPolicyChoice({
  currentLevel,
  selectedLevel,
  levels,
  isWriting,
  onSelect,
  onSave,
}: {
  currentLevel: DataSyncLevel | null;
  selectedLevel: DataSyncLevel | null;
  levels: readonly DataSyncLevel[];
  isWriting: boolean;
  onSelect: (level: DataSyncLevel) => void;
  onSave: (level: DataSyncLevel) => void;
}) {
  const saveEnabled = selectedLevel !== null && selectedLevel !== currentLevel;
  return (
    <div className="flex flex-col gap-3">
      <DataSyncPolicySummary level={currentLevel} />
      <DataSyncLevelPicker
        className={isWriting ? "opacity-60" : undefined}
        disabled={isWriting}
        label="Sync level for this device"
        levels={levels}
        onSelect={onSelect}
        selected={selectedLevel}
      />
      <div className="flex justify-end">
        <Button
          data-analytics-sync-choice={selectedLevel ?? ""}
          disabled={!saveEnabled || isWriting}
          onClick={() => {
            if (selectedLevel !== null) {
              onSave(selectedLevel);
            }
          }}
          size="sm"
          type="button"
        >
          {isWriting ? "Saving" : "Save sync choice"}
        </Button>
      </div>
    </div>
  );
}
