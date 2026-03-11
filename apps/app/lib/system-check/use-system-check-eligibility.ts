"use client";

import { EngineerRoutingMode } from "@repo/api/src/types/relay";
import { useComputeTargets } from "@/hooks/queries/use-compute-targets";
import { useElectronDetection } from "@/lib/engineer/electron-detection";
import { useEngineerRoutingSelection } from "@/lib/engineer/routing-store";

type SystemCheckEligibility = {
  shouldRunSystemCheck: boolean;
  isLoading: boolean;
  selectedCloudTargetOnline: boolean;
  selectedLocalElectronReady: boolean;
};

export function useSystemCheckEligibility(): SystemCheckEligibility {
  const routing = useEngineerRoutingSelection();
  // Always probe for Electron so the guard shows a loading state while
  // auto-detection is in progress, regardless of the current routing mode.
  const detection = useElectronDetection(true);
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

  // Electron detected but EngineerTransportBootstrap's auto-selection hasn't
  // updated the routing store yet.  Keep isLoading true to avoid flashing the
  // "no target" fallback for one frame before the mode switches.
  // Skip when an online cloud target is already selected — the bootstrap won't
  // override a valid cloud selection, so the pending state would never clear.
  const autoSelectionPending =
    detection.detected &&
    routing.source === "auto" &&
    routing.mode !== EngineerRoutingMode.LocalElectron &&
    !selectedCloudTargetOnline;

  // Only gate on Electron probing when it actually matters:
  //  - LocalElectron mode: need probe result to know if desktop is reachable
  //  - Auto-selected default with no valid cloud target: probe determines
  //    whether we'll auto-switch to LocalElectron
  // Cloud users with a valid target should never wait on localhost probing.
  const electronLoadingRelevant =
    routing.mode === EngineerRoutingMode.LocalElectron ||
    (!selectedCloudTargetOnline && routing.source === "auto");

  return {
    shouldRunSystemCheck:
      selectedCloudTargetOnline || selectedLocalElectronReady,
    isLoading:
      targetsLoading ||
      (electronLoadingRelevant && detection.loading) ||
      autoSelectionPending,
    selectedCloudTargetOnline,
    selectedLocalElectronReady,
  };
}
