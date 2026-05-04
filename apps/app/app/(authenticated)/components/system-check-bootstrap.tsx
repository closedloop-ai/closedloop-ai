"use client";

import { HealthCheckDialog } from "@/components/engineer/HealthCheckDialog";
import { useComputeTargets } from "@/hooks/queries/use-compute-targets";
import {
  CLOUD_RELAY_ENABLED,
  COMPUTE_TARGETS_QUERY_OPTIONS,
} from "@/lib/engineer/constants";
import { resolveTargetLabel } from "@/lib/engineer/routing-label";
import { useEngineerRoutingSelection } from "@/lib/engineer/routing-store";
import { useOptionalPreLoopSystemCheckGate } from "@/lib/system-check/pre-loop-system-check-provider";
import { useSystemCheckEligibility } from "@/lib/system-check/use-system-check-eligibility";

export function SystemCheckBootstrap() {
  const { isLoading, shouldRunSystemCheck } = useSystemCheckEligibility();
  const preLoopGate = useOptionalPreLoopSystemCheckGate();
  const routing = useEngineerRoutingSelection();
  const { data: targets = [] } = useComputeTargets({
    ...COMPUTE_TARGETS_QUERY_OPTIONS,
    enabled: CLOUD_RELAY_ENABLED,
  });

  if (isLoading || !shouldRunSystemCheck || preLoopGate?.isDialogOpen) {
    return null;
  }

  // Key forces HealthCheckDialog to remount (and re-run checks) when the
  // execution target changes — preserving the per-context freshness that the
  // previous per-/engineer-page mount provided.
  const targetKey = `${routing.mode}-${routing.computeTargetId ?? "none"}`;
  const targetLabel = resolveTargetLabel(routing, targets);

  return (
    <HealthCheckDialog
      key={targetKey}
      targetKey={targetKey}
      targetLabel={targetLabel}
    />
  );
}
