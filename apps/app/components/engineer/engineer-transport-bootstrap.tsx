"use client";

import { EngineerRoutingMode } from "@repo/api/src/types/relay";
import { useAuth } from "@repo/auth/client";
import { useEffect } from "react";
import { useComputeTargetStatusStream } from "@/hooks/queries/use-compute-target-status-stream";
import { useComputeTargets } from "@/hooks/queries/use-compute-targets";
import {
  CLOUD_RELAY_ENABLED,
  COMPUTE_TARGETS_QUERY_OPTIONS,
} from "@/lib/engineer/constants";
import { useElectronDetection } from "@/lib/engineer/electron-detection";
import { installEngineerFetchInterceptor } from "@/lib/engineer/engineer-fetch-interceptor";
import { setLocalGatewayAuthTokenProvider } from "@/lib/engineer/local-gateway-session";
import {
  getEngineerRoutingSelection,
  setEngineerRoutingAutoSelection,
} from "@/lib/engineer/routing-store";

export function EngineerTransportBootstrap() {
  const { getToken } = useAuth();
  const detection = useElectronDetection(true);
  useComputeTargetStatusStream(CLOUD_RELAY_ENABLED);
  // Always fetch compute targets so we can resolve the local electron's
  // compute target ID for loop dispatch, even when CLOUD_RELAY_ENABLED=false.
  const { data: targets } = useComputeTargets(COMPUTE_TARGETS_QUERY_OPTIONS);

  useEffect(() => {
    if (detection.loading) {
      return;
    }

    const current = getEngineerRoutingSelection();

    console.debug("[engineer-debug] Transport bootstrap routing decision", {
      electronDetected: detection.detected,
      electronPort: detection.port,
      electronMachineName: detection.machineName,
      currentMode: current.mode,
      currentSource: current.source,
      currentComputeTargetId: current.computeTargetId,
      cloudRelayEnabled: CLOUD_RELAY_ENABLED,
      registeredTargets: targets?.map((t) => ({
        id: t.id,
        machineName: t.machineName,
        isOnline: t.isOnline,
      })),
    });

    // Always preserve manual selection, including offline targets that may come
    // online later.
    if (
      current.source === "manual" &&
      (CLOUD_RELAY_ENABLED || current.mode !== EngineerRoutingMode.CloudRelay)
    ) {
      console.debug(
        "[engineer-debug] Preserving manual routing selection:",
        current.mode,
        current.computeTargetId
      );
      return;
    }

    if (detection.detected) {
      // Match the local electron's machine name to a registered compute target
      // so loop dispatch has the compute target ID it needs.
      // Match by machine name. Don't require isOnline here — the API
      // validates online status before dispatch and the socket may reconnect.
      const localTarget = detection.machineName
        ? targets?.find((t) => t.machineName === detection.machineName)
        : undefined;
      console.debug(
        "[engineer-debug] Electron detected, setting LocalElectron mode",
        {
          machineName: detection.machineName,
          matchedTargetId: localTarget?.id ?? null,
        }
      );
      setEngineerRoutingAutoSelection(
        EngineerRoutingMode.LocalElectron,
        localTarget?.id ?? null,
        { force: true }
      );
      return;
    }

    if (!CLOUD_RELAY_ENABLED) {
      console.debug(
        "[engineer-debug] Electron not detected and cloud relay disabled -- no routing change"
      );
      return;
    }

    // Hosted fallback: do not auto-select a cloud target. Users must choose one.
    if (current.mode === EngineerRoutingMode.CloudRelay) {
      console.debug(
        "[engineer-debug] Already in CloudRelay mode, computeTargetId:",
        current.computeTargetId
      );
      return;
    }

    console.debug(
      "[engineer-debug] Electron not detected from hosted origin -- falling back to CloudRelay with null computeTargetId"
    );
    setEngineerRoutingAutoSelection(EngineerRoutingMode.CloudRelay, null, {
      force: true,
    });
  }, [detection.detected, detection.loading, detection.machineName, targets]);

  useEffect(() => {
    setLocalGatewayAuthTokenProvider(getToken);
    return () => setLocalGatewayAuthTokenProvider(null);
  }, [getToken]);

  useEffect(() => installEngineerFetchInterceptor(), []);

  return null;
}
