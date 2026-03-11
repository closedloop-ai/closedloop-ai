"use client";

import { EngineerRoutingMode } from "@repo/api/src/types/relay";
import { useEffect } from "react";
import { useComputeTargetStatusStream } from "@/hooks/queries/use-compute-target-status-stream";
import { useComputeTargets } from "@/hooks/queries/use-compute-targets";
import { useElectronDetection } from "@/lib/engineer/electron-detection";
import { installEngineerFetchInterceptor } from "@/lib/engineer/engineer-fetch-interceptor";
import {
  getEngineerRoutingSelection,
  setEngineerRoutingAutoSelection,
} from "@/lib/engineer/routing-store";

export function EngineerTransportBootstrap() {
  const detection = useElectronDetection(true);
  useComputeTargetStatusStream();
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
      (current.mode === EngineerRoutingMode.LocalElectron &&
        detection.detected) ||
      (current.mode === EngineerRoutingMode.CloudRelay &&
        current.computeTargetId !== null &&
        selectedTargetOnline);

    // Always preserve manual selection, including offline targets that may come
    // online later.
    if (current.source === "manual" || currentSelectionValid) {
      return;
    }

    if (detection.detected) {
      setEngineerRoutingAutoSelection(EngineerRoutingMode.LocalElectron, null, {
        force: true,
      });
      return;
    }

    // Hosted fallback: do not auto-select a cloud target. Users must choose one.
    if (current.mode === EngineerRoutingMode.CloudRelay) {
      return;
    }

    setEngineerRoutingAutoSelection(EngineerRoutingMode.CloudRelay, null, {
      force: true,
    });
  }, [detection.detected, detection.loading, targets]);

  useEffect(() => installEngineerFetchInterceptor(), []);

  return null;
}
