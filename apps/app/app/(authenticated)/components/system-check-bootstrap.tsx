"use client";

import { EngineerRoutingMode } from "@repo/api/src/types/relay";
import { HealthCheckDialog } from "@/components/engineer/HealthCheckDialog";
import { useComputeTargets } from "@/hooks/queries/use-compute-targets";
import { useEngineerRoutingSelection } from "@/lib/engineer/routing-store";
import { useSystemCheckEligibility } from "@/lib/system-check/use-system-check-eligibility";

export function SystemCheckBootstrap() {
  const { isLoading, shouldRunSystemCheck } = useSystemCheckEligibility();
  const routing = useEngineerRoutingSelection();
  const { data: targets = [] } = useComputeTargets();

  if (isLoading || !shouldRunSystemCheck) {
    return null;
  }

  // Key forces HealthCheckDialog to remount (and re-run checks) when the
  // execution target changes — preserving the per-context freshness that the
  // previous per-/engineer-page mount provided.
  const targetKey = `${routing.mode}-${routing.computeTargetId ?? "none"}`;

  let targetLabel: string | undefined;
  if (
    routing.mode === EngineerRoutingMode.CloudRelay &&
    routing.computeTargetId
  ) {
    const target = targets.find((t) => t.id === routing.computeTargetId);
    targetLabel = target?.machineName;
  } else if (routing.mode === EngineerRoutingMode.LocalElectron) {
    targetLabel = "localhost";
  }

  return (
    <HealthCheckDialog
      key={targetKey}
      targetKey={targetKey}
      targetLabel={targetLabel}
    />
  );
}
