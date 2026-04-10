"use client";

import { useSearchParams } from "next/navigation";
import { HealthCheckDialog } from "@/components/engineer/HealthCheckDialog";
import { useComputeTargets } from "@/hooks/queries/use-compute-targets";
import {
  CLOUD_RELAY_ENABLED,
  COMPUTE_TARGETS_QUERY_OPTIONS,
} from "@/lib/engineer/constants";
import { resolveTargetLabel } from "@/lib/engineer/routing-label";
import { useEngineerRoutingSelection } from "@/lib/engineer/routing-store";
import { useSystemCheckEligibility } from "@/lib/system-check/use-system-check-eligibility";

export function SystemCheckBootstrap() {
  const { isLoading, shouldRunSystemCheck } = useSystemCheckEligibility();
  const routing = useEngineerRoutingSelection();
  const { data: targets = [] } = useComputeTargets({
    ...COMPUTE_TARGETS_QUERY_OPTIONS,
    enabled: CLOUD_RELAY_ENABLED,
  });
  const searchParams = useSearchParams();
  const fromOnboarding = searchParams.get("from") === "onboarding";

  // When the user arrives directly from onboarding, trigger the health check
  // immediately even if the normal eligibility gate has not yet passed —
  // so that ClaudeCode plugin installation guidance surfaces without delay.
  if (isLoading || !(shouldRunSystemCheck || fromOnboarding)) {
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
