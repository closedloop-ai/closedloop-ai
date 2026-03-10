"use client";

import { HealthCheckDialog } from "@/components/engineer/HealthCheckDialog";
import { useSystemCheckEligibility } from "@/lib/system-check/use-system-check-eligibility";

export function SystemCheckBootstrap() {
  const { isLoading, shouldRunSystemCheck } = useSystemCheckEligibility();

  if (isLoading || !shouldRunSystemCheck) {
    return null;
  }

  return <HealthCheckDialog />;
}
