"use client";

import type { ComputeTargetConflictBody } from "@repo/api/src/types/compute-target";
import { LoopDispatchTargetSelector } from "@/components/engineer/LoopDispatchTargetSelector";

type GeneratePrdTargetSelectorState = {
  availableTargets: ComputeTargetConflictBody["availableTargets"];
} | null;

/**
 * Compute-target picker shown after a GENERATE_PRD launch conflicts on multiple
 * online targets. Shared by CreateDocumentModal and the generate-PRD-from-doc
 * dialog so the "seed committed, now pick a machine" affordance renders
 * identically across both entry points. Renders nothing until a conflict has
 * populated `state`.
 */
export function GeneratePrdTargetSelector({
  onSelect,
  state,
}: Readonly<{
  onSelect: (targetId: string) => void;
  state: GeneratePrdTargetSelectorState;
}>) {
  if (!state) {
    return null;
  }

  return (
    <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/30 p-3">
      <p className="text-muted-foreground text-sm">
        Select a compute target to start generation.
      </p>
      <LoopDispatchTargetSelector
        availableTargets={state.availableTargets}
        onSelect={onSelect}
      />
    </div>
  );
}
