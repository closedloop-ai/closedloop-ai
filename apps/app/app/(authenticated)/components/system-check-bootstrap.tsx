"use client";

import { EngineerRoutingMode } from "@repo/api/src/types/relay";
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

function getAmbientSystemCheckTargetKey(
  routing: ReturnType<typeof useEngineerRoutingSelection>
): string {
  if (routing.mode === EngineerRoutingMode.LocalElectron) {
    return "local-gateway";
  }

  return `${routing.mode}-${routing.computeTargetId ?? "none"}`;
}

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

  // Key forces HealthCheckDialog to remount when the ambient check target
  // changes. Local Electron always uses the localhost gateway, so its key must
  // not churn when the loop-dispatch compute target ID hydrates.
  const targetKey = getAmbientSystemCheckTargetKey(routing);
  const targetLabel = resolveTargetLabel(routing, targets);

  return (
    <HealthCheckDialog
      key={targetKey}
      targetKey={targetKey}
      targetLabel={targetLabel}
    />
  );
}
