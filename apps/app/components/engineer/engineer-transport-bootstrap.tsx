"use client";

import {
  CURRENT_DESKTOP_API_NAMESPACE,
  getDesktopApiNamespaceFromCapabilities,
  withDesktopApiNamespaceCapability,
} from "@repo/api/src/desktop-api-namespace";
import type { ComputeTarget } from "@repo/api/src/types/compute-target";
import { EngineerRoutingMode } from "@repo/api/src/types/relay";
import { useAuth } from "@repo/auth/client";
import { log } from "@repo/observability/log";
import { useEffect } from "react";
import { useComputeTargetStatusStream } from "@/hooks/queries/use-compute-target-status-stream";
import { useComputeTargets } from "@/hooks/queries/use-compute-targets";
import { useApiClient } from "@/hooks/use-api-client";
import {
  CLOUD_RELAY_ENABLED,
  COMPUTE_TARGETS_QUERY_OPTIONS,
} from "@/lib/engineer/constants";
import { useElectronDetection } from "@/lib/engineer/electron-detection";
import { installEngineerFetchInterceptor } from "@/lib/engineer/engineer-fetch-interceptor";
import { ensureLocalGatewayApiNamespace } from "@/lib/engineer/local-gateway-api-namespace";
import {
  ensureLocalGatewaySession,
  setLocalGatewayAuthTokenProvider,
} from "@/lib/engineer/local-gateway-session";
import {
  getEngineerRoutingSelection,
  setEngineerRoutingAutoSelection,
} from "@/lib/engineer/routing-store";

function findOwnedLocalTarget(
  machineName: string | null,
  userId: string | null | undefined,
  availableTargets: ComputeTarget[] | undefined
): ComputeTarget | undefined {
  if (!(machineName && userId)) {
    return undefined;
  }

  return availableTargets?.find(
    (target) => target.machineName === machineName && target.userId === userId
  );
}

export function EngineerTransportBootstrap() {
  const { getToken, userId } = useAuth();
  const apiClient = useApiClient();
  const detection = useElectronDetection(true);
  useComputeTargetStatusStream(CLOUD_RELAY_ENABLED);
  // Always fetch compute targets so we can resolve the local electron's
  // compute target ID for loop dispatch, even when CLOUD_RELAY_ENABLED=false.
  const { data: targets } = useComputeTargets(COMPUTE_TARGETS_QUERY_OPTIONS);

  useEffect(() => {
    setLocalGatewayAuthTokenProvider(getToken);
    return () => setLocalGatewayAuthTokenProvider(null);
  }, [getToken]);

  useEffect(() => {
    if (detection.loading) {
      return;
    }

    const current = getEngineerRoutingSelection();

    log.debug("[engineer-debug] Transport bootstrap routing decision", {
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
      log.debug(
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
      const localTarget = findOwnedLocalTarget(
        detection.machineName,
        userId,
        targets
      );
      log.debug(
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
      log.debug(
        "[engineer-debug] Electron not detected and cloud relay disabled -- no routing change"
      );
      return;
    }

    // Hosted fallback: do not auto-select a cloud target. Users must choose one.
    if (current.mode === EngineerRoutingMode.CloudRelay) {
      log.debug(
        "[engineer-debug] Already in CloudRelay mode, computeTargetId:",
        current.computeTargetId
      );
      return;
    }

    log.debug(
      "[engineer-debug] Electron not detected from hosted origin -- falling back to CloudRelay with null computeTargetId"
    );
    setEngineerRoutingAutoSelection(EngineerRoutingMode.CloudRelay, null, {
      force: true,
    });
  }, [
    detection.detected,
    detection.loading,
    detection.machineName,
    targets,
    userId,
  ]);

  useEffect(() => {
    if (!(detection.detected && detection.port && detection.machineName)) {
      return;
    }

    const localTarget = findOwnedLocalTarget(
      detection.machineName,
      userId,
      targets
    );
    if (!localTarget) {
      return;
    }

    let cancelled = false;

    const syncDesktopApiNamespace = async () => {
      const sessionToken = await ensureLocalGatewaySession(detection.port!);
      if (!sessionToken) {
        return;
      }

      const namespace = await ensureLocalGatewayApiNamespace(
        detection.port!,
        sessionToken
      );
      if (!namespace) {
        return;
      }
      if (cancelled) {
        return;
      }

      const currentNamespace =
        getDesktopApiNamespaceFromCapabilities(localTarget.capabilities) ??
        CURRENT_DESKTOP_API_NAMESPACE;
      if (currentNamespace === namespace) {
        return;
      }

      const nextCapabilities = withDesktopApiNamespaceCapability(
        localTarget.capabilities,
        namespace === CURRENT_DESKTOP_API_NAMESPACE ? null : namespace
      );

      await apiClient.put(`/compute-targets/${localTarget.id}`, {
        capabilities: nextCapabilities,
      });
    };

    syncDesktopApiNamespace().catch((error) => {
      log.warn("[engineer-debug] Failed to sync desktop API namespace", {
        computeTargetId: localTarget.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    return () => {
      cancelled = true;
    };
  }, [
    apiClient,
    detection.detected,
    detection.machineName,
    detection.port,
    targets,
    userId,
  ]);

  useEffect(() => installEngineerFetchInterceptor(), []);

  return null;
}
