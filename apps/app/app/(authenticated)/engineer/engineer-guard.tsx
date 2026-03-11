"use client";

import { AlertCircle, Loader2 } from "lucide-react";
import Link from "next/link";
import { ComputeTargetSelector } from "@/components/engineer/compute-target-selector";
import { EngineerDashboard } from "@/components/engineer/engineer-dashboard";
import { DESKTOP_SETUP_URL } from "@/lib/engineer/constants";
import { useSystemCheckEligibility } from "@/lib/system-check/use-system-check-eligibility";

/**
 * Guards engineer access based on the currently selected routing target.
 * Hosted users must select an available execution target.
 */
export function EngineerGuard() {
  // Engineer access intentionally reuses the same execution-readiness rules as
  // the global system-check bootstrap.
  const { isLoading, shouldRunSystemCheck: canAccess } =
    useSystemCheckEligibility();

  if (canAccess) {
    return <EngineerDashboard />;
  }

  if (isLoading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center p-8">
        <div className="max-w-md space-y-4 text-center text-muted-foreground">
          <Loader2 className="mx-auto size-8 animate-spin" />
          <p className="text-sm">
            Checking local Electron and compute targets...
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-8">
      <div className="max-w-md space-y-4 text-center">
        <AlertCircle className="mx-auto size-12 text-muted-foreground" />
        <h2 className="font-semibold text-xl">Engineer View Not Available</h2>
        <p className="text-muted-foreground">
          No execution target available. Connect the desktop client or register
          a compute target in Settings to get started. If your previously
          selected target is offline, wait for it to come online or choose
          another.
        </p>
        <div className="flex justify-center pt-1">
          <ComputeTargetSelector />
        </div>
        <p className="text-muted-foreground">
          Install the Closedloop desktop client for local execution.
        </p>
        <p className="text-muted-foreground text-sm">
          Open{" "}
          <Link className="underline" href="/settings?tab=integrations">
            Settings - Integrations
          </Link>{" "}
          to manage compute targets.
        </p>
        <a
          className="text-primary text-sm underline"
          href={DESKTOP_SETUP_URL}
          rel="noreferrer"
          target="_blank"
        >
          Desktop setup instructions
        </a>
      </div>
    </div>
  );
}
