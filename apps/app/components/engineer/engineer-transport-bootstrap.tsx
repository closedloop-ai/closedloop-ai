"use client";

import {
  CURRENT_DESKTOP_API_NAMESPACE,
  getDesktopApiNamespaceFromCapabilities,
  withDesktopApiNamespaceCapability,
} from "@repo/api/src/desktop-api-namespace";
import type { ComputeTarget } from "@repo/api/src/types/compute-target";
import { isComputeTargetOwnedByViewer } from "@repo/api/src/types/compute-target";
import { EngineerRoutingMode } from "@repo/api/src/types/relay";
import { useAuth } from "@repo/auth/client";
import { usePath } from "@repo/navigation/use-path";
import { useEffect } from "react";
import { useComputeTargetStatusStream } from "@/hooks/queries/use-compute-target-status-stream";
import { useComputeTargets } from "@/hooks/queries/use-compute-targets";
import { useApiClient } from "@/hooks/use-api-client";
import { shouldRunAmbientDesktopBootstrap } from "@/lib/engineer/ambient-desktop-routes";
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
  useEngineerRoutingSelection,
} from "@/lib/engineer/routing-store";

function findOwnedLocalTarget(
  machineName: string | null,
  availableTargets: ComputeTarget[] | undefined
): ComputeTarget | undefined {
  if (!machineName) {
    return undefined;
  }

  return availableTargets?.find(
    (target) =>
      target.machineName === machineName && isComputeTargetOwnedByViewer(target)
  );
}

export function EngineerTransportBootstrap() {
  const { getToken } = useAuth();
  const apiClient = useApiClient();
  const pathname = usePath();
  const ambientDesktopEnabled = shouldRunAmbientDesktopBootstrap(pathname);
  const routingSelection = useEngineerRoutingSelection();
  // A user who has manually pinned a CloudRelay target dispatches through the
  // relay, never the loopback gateway — the effect below already refuses to
  // re-auto-select for them. Probing localhost anyway can only produce refused
  // requests the browser logs itself, so do not issue them at all.
  const routesThroughRelay =
    routingSelection.source === "manual" &&
    routingSelection.mode === EngineerRoutingMode.CloudRelay &&
    CLOUD_RELAY_ENABLED;
  useComputeTargetStatusStream(CLOUD_RELAY_ENABLED);
  // Always fetch compute targets so we can resolve the local electron's
  // compute target ID for loop dispatch, even when CLOUD_RELAY_ENABLED=false.
  const { data: targets } = useComputeTargets(COMPUTE_TARGETS_QUERY_OPTIONS);
  // ISS-6084: this is the ONE ambient detection loop -- it mounts on every
  // authenticated page from the layout, so it is the loop that was spraying
  // refused localhost requests into every visitor's console. Owning a registered
  // compute target is durable, account-scoped evidence that this user really has
  // a desktop app (only a desktop connecting to the cloud creates one), so it is
  // what buys this loop the right to probe. A user with no target relies on the
  // browser-local marker the store keeps from any previous detection, and a user
  // with neither has never had a desktop app and gets no loopback requests.
  const desktopKnown = ownsRegisteredComputeTarget(targets);
  const detection = useElectronDetection(
    ambientDesktopEnabled && !routesThroughRelay,
    { ambient: true, desktopKnown }
  );

  useEffect(() => {
    setLocalGatewayAuthTokenProvider(getToken);
    return () => setLocalGatewayAuthTokenProvider(null);
  }, [getToken]);

  useEffect(() => {
    if (!ambientDesktopEnabled) {
      return;
    }
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
      // Match the local electron's machine name to a registered compute target
      // so loop dispatch has the compute target ID it needs.
      // Match by machine name. Don't require isOnline here — the API
      // validates online status before dispatch and the socket may reconnect.
      const localTarget = findOwnedLocalTarget(detection.machineName, targets);
      setEngineerRoutingAutoSelection(
        EngineerRoutingMode.LocalElectron,
        localTarget?.id ?? null,
        { force: true }
      );
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
  }, [
    detection.detected,
    detection.loading,
    detection.machineName,
    ambientDesktopEnabled,
    targets,
  ]);

  useEffect(() => {
    if (
      !(
        ambientDesktopEnabled &&
        detection.detected &&
        detection.port &&
        detection.machineName
      )
    ) {
      return;
    }

    const localTarget = findOwnedLocalTarget(detection.machineName, targets);
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

    syncDesktopApiNamespace().catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [
    apiClient,
    ambientDesktopEnabled,
    detection.detected,
    detection.machineName,
    detection.port,
    targets,
  ]);

  useEffect(() => installEngineerFetchInterceptor(), []);

  return null;
}

/**
 * Whether the signed-in user owns at least one registered compute target.
 *
 * A compute target row exists only because a desktop app connected to the cloud
 * under this account, so this is durable, account-scoped evidence that the user
 * has a desktop app -- unlike a browser-local marker it holds on a fresh profile,
 * an incognito window, or a second machine's browser. It is deliberately looser
 * than {@link findOwnedLocalTarget}, which must match a specific machine name:
 * here the question is only "is it worth looking on loopback at all?", and a user
 * whose desktop is on another machine still legitimately gets a probe.
 *
 * A cold or failed `/compute-targets` read yields `undefined` and therefore
 * `false`; ambient probing then falls back to the store's browser-local marker
 * rather than probing speculatively.
 */
function ownsRegisteredComputeTarget(
  availableTargets: ComputeTarget[] | undefined
): boolean {
  return availableTargets?.some(isComputeTargetOwnedByViewer) ?? false;
}
