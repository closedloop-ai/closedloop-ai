"use client";

import { HealthCheckDialog } from "@/components/engineer/HealthCheckDialog";
import { useEngineerRoutingSelection } from "@/lib/engineer/routing-store";
import { useSystemCheckEligibility } from "@/lib/system-check/use-system-check-eligibility";

export function SystemCheckBootstrap() {
  const { isLoading, shouldRunSystemCheck } = useSystemCheckEligibility();
  const routing = useEngineerRoutingSelection();

  if (isLoading || !shouldRunSystemCheck) {
    return null;
  }

  // Key forces HealthCheckDialog to remount (and re-run checks) when the
  // execution target changes — preserving the per-context freshness that the
  // previous per-/engineer-page mount provided.
  return (
    <HealthCheckDialog
      key={`${routing.mode}-${routing.computeTargetId ?? "none"}`}
    />
  );
}
