"use client";

import { EngineerRoutingMode } from "@repo/api/src/types/relay";
import { useComputeTargets } from "@/hooks/queries/use-compute-targets";
import { useElectronDetection } from "@/lib/engineer/electron-detection";
import { useEngineerRoutingSelection } from "@/lib/engineer/routing-store";
import { appEnvironment } from "@/lib/environment";

type SystemCheckEligibility = {
  shouldRunSystemCheck: boolean;
  isLoading: boolean;
  selectedCloudTargetOnline: boolean;
  selectedLocalElectronReady: boolean;
  selectedLocalDevReady: boolean;
};

export function useSystemCheckEligibility(): SystemCheckEligibility {
  const routing = useEngineerRoutingSelection();
  const detection = useElectronDetection(
    routing.mode === EngineerRoutingMode.LocalElectron
  );
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

  // LocalElectron remains eligible here because the desktop relay can execute
  // the same system-check flow as the hosted compute-target path.
  const selectedLocalElectronReady =
    routing.mode === EngineerRoutingMode.LocalElectron && detection.detected;

  const selectedLocalDevReady =
    routing.mode === EngineerRoutingMode.LocalDev && appEnvironment === "local";

  return {
    shouldRunSystemCheck:
      selectedCloudTargetOnline ||
      selectedLocalElectronReady ||
      selectedLocalDevReady,
    isLoading:
      targetsLoading ||
      (routing.mode === EngineerRoutingMode.LocalElectron && detection.loading),
    selectedCloudTargetOnline,
    selectedLocalElectronReady,
    selectedLocalDevReady,
  };
}
