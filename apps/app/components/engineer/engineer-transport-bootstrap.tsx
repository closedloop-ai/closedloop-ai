"use client";

import { useEffect } from "react";
import { useComputeTargets } from "@/hooks/queries/use-compute-targets";
import { useElectronDetection } from "@/lib/engineer/electron-detection";
import { installEngineerFetchInterceptor } from "@/lib/engineer/engineer-fetch-interceptor";
import {
  getEngineerRoutingSelection,
  setEngineerRoutingAutoSelection,
} from "@/lib/engineer/routing-store";
import { appEnvironment } from "@/lib/environment";

export function EngineerTransportBootstrap() {
  // Prime detection cache on page load for Tier 2 fast-path routing.
  const detection = useElectronDetection();
  const { data: targets = [] } = useComputeTargets({
    staleTime: 30_000,
    refetchInterval: 30_000,
  });

  useEffect(() => {
    if (detection.loading) {
      return;
    }

    const current = getEngineerRoutingSelection();
    const onlineTargets = targets.filter((target) => target.isOnline);
    const selectedTargetOnline =
      current.computeTargetId !== null &&
      onlineTargets.some((target) => target.id === current.computeTargetId);
    const currentSelectionValid =
      (current.mode === "local-electron" && detection.detected) ||
      (current.mode === "local-dev" && appEnvironment === "local") ||
      (current.mode === "cloud-relay" &&
        current.computeTargetId !== null &&
        selectedTargetOnline);

    // Always preserve manual selection, including offline targets that may come
    // online later.
    if (current.source === "manual" || currentSelectionValid) {
      return;
    }

    if (detection.detected) {
      setEngineerRoutingAutoSelection("local-electron", null, { force: true });
      return;
    }

    if (appEnvironment === "local") {
      setEngineerRoutingAutoSelection("local-dev", null, { force: true });
      return;
    }

    // Hosted fallback: do not auto-select a cloud target. Users must choose one.
    if (current.mode === "cloud-relay") {
      return;
    }

    setEngineerRoutingAutoSelection("cloud-relay", null, { force: true });
  }, [detection.detected, detection.loading, targets]);

  useEffect(() => installEngineerFetchInterceptor(), []);

  return null;
}
