"use client";

import type { ComputeTargetConflictBody } from "@repo/api/src/types/compute-target";
import { LoopDispatchTargetSelector } from "@/components/engineer/LoopDispatchTargetSelector";

export type FloatingTargetPickerState = {
  availableTargets: ComputeTargetConflictBody["availableTargets"];
};

export type FloatingTargetPickerSource = {
  multiTargetState: FloatingTargetPickerState | null;
  onSelect: (targetId: string) => void;
};

export function resolveFloatingTargetPickerSource(
  primary: FloatingTargetPickerSource,
  fallback: FloatingTargetPickerSource
): FloatingTargetPickerSource {
  return primary.multiTargetState ? primary : fallback;
}

export function FloatingTargetPicker({
  multiTargetState,
  onSelect,
}: Readonly<FloatingTargetPickerSource>) {
  if (!multiTargetState) {
    return null;
  }
  return (
    <div className="fixed right-4 bottom-4 z-50 rounded-lg border bg-background p-4 shadow-lg">
      <p className="mb-2 text-muted-foreground text-sm">
        Multiple compute targets are online. Select one:
      </p>
      <LoopDispatchTargetSelector
        availableTargets={multiTargetState.availableTargets}
        onSelect={onSelect}
      />
    </div>
  );
}
