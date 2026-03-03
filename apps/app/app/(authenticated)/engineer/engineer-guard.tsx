"use client";

import { EngineerRoutingMode } from "@repo/api/src/types/relay";
import { AlertCircle, Loader2 } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";
import { ComputeTargetSelector } from "@/components/engineer/compute-target-selector";
import { EngineerDashboard } from "@/components/engineer/engineer-dashboard";
import { useComputeTargets } from "@/hooks/queries/use-compute-targets";
import { DESKTOP_SETUP_URL } from "@/lib/engineer/constants";
import { useElectronDetection } from "@/lib/engineer/electron-detection";
import {
  setEngineerRoutingAutoSelection,
  useEngineerRoutingSelection,
} from "@/lib/engineer/routing-store";
import { appEnvironment } from "@/lib/environment";

/**
 * Guards engineer access based on the currently selected routing target.
 * Hosted users must select an available execution target.
 */
export function EngineerGuard() {
  const detection = useElectronDetection();
  const routing = useEngineerRoutingSelection();
  const { data: targets = [], isLoading: targetsLoading } = useComputeTargets({
    staleTime: 30_000,
    refetchInterval: 30_000,
  });

  const selectedCloudTargetOnline =
    routing.mode === EngineerRoutingMode.CloudRelay &&
    routing.computeTargetId !== null &&
    targets.some(
      (target) => target.id === routing.computeTargetId && target.isOnline
    );
  const selectedLocalElectronReady =
    routing.mode === EngineerRoutingMode.LocalElectron && detection.detected;
  const selectedLocalDevReady =
    routing.mode === EngineerRoutingMode.LocalDev && appEnvironment === "local";
  const canAccess =
    selectedCloudTargetOnline ||
    selectedLocalElectronReady ||
    selectedLocalDevReady;

  // Auto-fallback: when running locally and the current selection is
  // unreachable (e.g. stale CloudRelay/LocalElectron in localStorage),
  // switch to LocalDev instead of showing the error screen.
  useEffect(() => {
    if (detection.loading || targetsLoading || canAccess) {
      return;
    }
    if (appEnvironment === "local") {
      setEngineerRoutingAutoSelection(EngineerRoutingMode.LocalDev, null, {
        force: true,
      });
    }
  }, [detection.loading, targetsLoading, canAccess]);

  if (canAccess) {
    return <EngineerDashboard />;
  }

  if (detection.loading || targetsLoading) {
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
          Select an execution target to continue. If your previously selected
          target is offline, wait for it to come online or choose another
          target.
        </p>
        <div className="flex justify-center pt-1">
          <ComputeTargetSelector />
        </div>
        <p className="text-muted-foreground">
          You can also run{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm">
            pnpm dev:engineer
          </code>{" "}
          on localhost for local-only development.
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
