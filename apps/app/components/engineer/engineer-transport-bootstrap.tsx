"use client";

import { EngineerRoutingMode } from "@repo/api/src/types/relay";
import { useEffect } from "react";
import { useComputeTargetStatusStream } from "@/hooks/queries/use-compute-target-status-stream";
import { useComputeTargets } from "@/hooks/queries/use-compute-targets";
import {
  CLOUD_RELAY_ENABLED,
  COMPUTE_TARGETS_QUERY_OPTIONS,
} from "@/lib/engineer/constants";
import { useElectronDetection } from "@/lib/engineer/electron-detection";
import { installEngineerFetchInterceptor } from "@/lib/engineer/engineer-fetch-interceptor";
import {
  getEngineerRoutingSelection,
  setEngineerRoutingAutoSelection,
} from "@/lib/engineer/routing-store";

export function EngineerTransportBootstrap() {
  const detection = useElectronDetection(true);
  useComputeTargetStatusStream(CLOUD_RELAY_ENABLED);
  const { data: targets = [] } = useComputeTargets({
    ...COMPUTE_TARGETS_QUERY_OPTIONS,
    enabled: CLOUD_RELAY_ENABLED,
  });

  useEffect(() => {
    if (detection.loading) {
      return;
    }

    const current = getEngineerRoutingSelection();

    // Always preserve manual selection, including offline targets that may come
    // online later.
    if (
      current.source === "manual" &&
      (CLOUD_RELAY_ENABLED || current.mode !== EngineerRoutingMode.CloudRelay)
    ) {
      return;
    }

    if (detection.detected) {
      setEngineerRoutingAutoSelection(EngineerRoutingMode.LocalElectron, null, {
        force: true,
      });
      return;
    }

    if (!CLOUD_RELAY_ENABLED) {
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
