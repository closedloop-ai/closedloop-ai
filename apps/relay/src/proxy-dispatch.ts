/**
 * Cross-instance dispatch: forwarding a command to the relay instance that
 * owns the target. Split out of index.ts (ISS-7976, continuing the ISS-7612
 * split) so the peer hop, its timeout budget and its SSRF guard sit together
 * rather than in the entrypoint.
 */

import {
  RelayDispatchDiagnosticReason,
  RelayDispatchReason,
  type RelayDispatchResult,
  relayDispatchNotDelivered,
  relayDispatchResultSchema,
} from "@repo/api/src/types/relay-dispatch";
import { log } from "@repo/observability/log";
import { isAllowedPeerInstance } from "./peer-dispatch.js";
import { INTERNAL_API_SECRET } from "./relay-env.js";
import {
  type InstanceInfo,
  type InstanceLookupResult,
  RegistryLookupOutcome,
  type TargetLookupResult,
  type TargetMetadata,
  type TargetRegistry,
  TargetRegistryBackend,
} from "./target-registry.js";

// Cross-instance proxy dispatch must finish well inside the API caller's budget.
// apps/api/app/compute-targets/relay-command-helpers.ts aborts the POST /dispatch
// request after 5000ms; a peer timeout at or above that lets a slow peer outlive
// the upstream request, so the API reports failure while the peer is still
// working. Keep this comfortably below 5000ms so the relay can return an
// explicit not-delivered result before the caller gives up.
export const API_DISPATCH_CALLER_TIMEOUT_MS = 5000;
export const PEER_DISPATCH_TIMEOUT_MS = 4000;

/**
 * Forward a dispatch to the relay instance that currently owns `targetId`.
 *
 * Resolves either the peer's answer or a locally classified not-delivered
 * envelope. The coarse `reason` remains backward-compatible; the diagnostic
 * field separates the causes that used to collapse into that one value.
 *
 * `registry` and `localInstanceId` are parameters rather than module state
 * because the registry binding is swapped at boot by `initializeTargetRegistry`.
 */
export async function tryProxyDispatch(
  registry: TargetRegistry,
  localInstanceId: string,
  targetId: string,
  operation: unknown
): Promise<RelayDispatchResult> {
  const targetLookup = await registry.lookup(targetId);
  const targetMeta = targetMetadataFromLookup(targetLookup);
  if (!targetMeta) {
    return targetLookupToNotDelivered(registry, targetLookup);
  }
  if (targetMeta.instanceId === localInstanceId) {
    return relayDispatchNotDelivered(
      RelayDispatchDiagnosticReason.LocalWorkerNotConnected
    );
  }

  const instanceLookup = await registry.lookupInstance(targetMeta.instanceId);
  const instanceInfo = instanceInfoFromLookup(instanceLookup);
  if (!instanceInfo) {
    return instanceLookupToNotDelivered(instanceLookup);
  }

  // SSRF guard: instanceInfo is read from Redis, which must be treated as
  // untrusted input. A poisoned or malformed registry record could otherwise
  // redirect this request — carrying the internal shared secret — to an
  // attacker-controlled host. Only proxy (and attach the secret) when the peer
  // address is an allowed private/VPC target on the expected relay port.
  if (!isAllowedPeerInstance(instanceInfo)) {
    log.warn("Refusing to proxy dispatch to disallowed peer instance", {
      targetId,
      peerInstanceId: targetMeta.instanceId,
      peerPrivateIp: instanceInfo.privateIp,
      peerPort: instanceInfo.port,
    });
    return relayDispatchNotDelivered(
      RelayDispatchDiagnosticReason.PeerInstanceDisallowed
    );
  }

  const peerAbortSignal = AbortSignal.timeout(PEER_DISPATCH_TIMEOUT_MS);
  try {
    const proxyRes = await fetch(
      `http://${instanceInfo.privateIp}:${instanceInfo.port}/internal/dispatch`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-internal-secret": INTERNAL_API_SECRET as string,
        },
        body: JSON.stringify({ targetId, operation }),
        signal: peerAbortSignal,
      }
    );

    // Treat any non-2xx peer status as not-delivered. Without this, a peer
    // 401/403/500 with a JSON error body would be forwarded verbatim with a 200,
    // and the API caller (which only treats delivered === false as failure)
    // would report the command as successfully dispatched.
    if (!proxyRes.ok) {
      log.warn("Peer instance returned non-2xx for proxied dispatch", {
        targetId,
        peerInstanceId: targetMeta.instanceId,
        status: proxyRes.status,
      });
      return relayDispatchNotDelivered(
        RelayDispatchDiagnosticReason.PeerHttpNotOk,
        { peerStatusCode: proxyRes.status }
      );
    }

    const peerResult = await proxyRes.json();
    const proxyResult = relayDispatchResultSchema.safeParse(peerResult);
    if (!proxyResult.success) {
      log.warn("Peer instance returned a malformed dispatch response", {
        targetId,
        peerInstanceId: targetMeta.instanceId,
      });
      return relayDispatchNotDelivered(
        RelayDispatchDiagnosticReason.PeerMalformedResponse
      );
    }

    const result = withLegacyPeerDiagnostic(proxyResult.data, peerResult);
    if (shouldDeregisterStalePeerTarget(result)) {
      registry.deregister(targetId, targetMeta.ownerToken).catch(() => {});
    }

    return result;
  } catch (error) {
    log.warn("Proxy dispatch to peer instance failed", {
      targetId,
      peerInstanceId: targetMeta.instanceId,
      peerPrivateIp: instanceInfo.privateIp,
      peerPort: instanceInfo.port,
      error,
    });
    if (isPeerTimeout(error, peerAbortSignal)) {
      return relayDispatchNotDelivered(
        RelayDispatchDiagnosticReason.PeerTimeout
      );
    }
    if (error instanceof SyntaxError) {
      return relayDispatchNotDelivered(
        RelayDispatchDiagnosticReason.PeerBodyNotJson
      );
    }
    return relayDispatchNotDelivered(
      RelayDispatchDiagnosticReason.PeerNetworkFailed,
      { peerErrorCode: errorCodeFrom(error) }
    );
  }
}

function targetMetadataFromLookup(
  lookup: TargetLookupResult
): TargetMetadata | null {
  if (lookup.outcome === RegistryLookupOutcome.Found) {
    return lookup.metadata;
  }
  return null;
}

function targetLookupToNotDelivered(
  registry: TargetRegistry,
  lookup: TargetLookupResult
): RelayDispatchResult {
  switch (lookup.outcome) {
    case RegistryLookupOutcome.Missing:
      return relayDispatchNotDelivered(
        registry.backend === TargetRegistryBackend.InMemory
          ? RelayDispatchDiagnosticReason.RegistryUnavailableInMemory
          : RelayDispatchDiagnosticReason.NoRegistryEntry
      );
    case RegistryLookupOutcome.Unreadable:
      return relayDispatchNotDelivered(
        RelayDispatchDiagnosticReason.TargetRegistryRecordUnreadable
      );
    case RegistryLookupOutcome.Error:
      return relayDispatchNotDelivered(
        RelayDispatchDiagnosticReason.TargetRegistryLookupFailed
      );
    case RegistryLookupOutcome.Found:
      return relayDispatchNotDelivered(
        RelayDispatchDiagnosticReason.LocalWorkerNotConnected
      );
    default: {
      const unhandled: never = lookup;
      throw new Error(
        `Unhandled target registry lookup outcome: ${JSON.stringify(unhandled)}`
      );
    }
  }
}

function instanceInfoFromLookup(
  lookup: InstanceLookupResult
): InstanceInfo | null {
  if (lookup.outcome === RegistryLookupOutcome.Found) {
    return lookup.info;
  }
  return null;
}

function instanceLookupToNotDelivered(
  lookup: InstanceLookupResult
): RelayDispatchResult {
  switch (lookup.outcome) {
    case RegistryLookupOutcome.Missing:
      return relayDispatchNotDelivered(
        RelayDispatchDiagnosticReason.PeerInstanceMissing
      );
    case RegistryLookupOutcome.Unreadable:
    case RegistryLookupOutcome.Error:
      return relayDispatchNotDelivered(
        RelayDispatchDiagnosticReason.PeerInstanceLookupFailed
      );
    case RegistryLookupOutcome.Found:
      return relayDispatchNotDelivered(
        RelayDispatchDiagnosticReason.PeerNetworkFailed
      );
    default: {
      const unhandled: never = lookup;
      throw new Error(
        `Unhandled peer instance lookup outcome: ${JSON.stringify(unhandled)}`
      );
    }
  }
}

function withLegacyPeerDiagnostic(
  result: RelayDispatchResult,
  rawResult: unknown
): RelayDispatchResult {
  if (
    result.delivered ||
    result.reason !== RelayDispatchReason.TargetNotConnected ||
    result.diagnosticReason ||
    hasPeerDiagnosticField(rawResult)
  ) {
    return result;
  }
  return {
    ...result,
    diagnosticReason: RelayDispatchDiagnosticReason.PeerReportedNotConnected,
  };
}

function hasPeerDiagnosticField(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    Object.hasOwn(value, "diagnosticReason")
  );
}

function shouldDeregisterStalePeerTarget(result: RelayDispatchResult): boolean {
  return (
    !result.delivered &&
    result.reason === RelayDispatchReason.TargetNotConnected &&
    (result.diagnosticReason === RelayDispatchDiagnosticReason.PeerNoWorker ||
      result.diagnosticReason ===
        RelayDispatchDiagnosticReason.PeerReportedNotConnected)
  );
}

function isPeerTimeout(error: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted || (error instanceof Error && error.name === "TimeoutError")
  );
}

function errorCodeFrom(error: unknown): string | undefined {
  const cause =
    error && typeof error === "object"
      ? (error as { cause?: unknown }).cause
      : undefined;
  return stringProperty(cause, "code") ?? stringProperty(error, "code");
}

function stringProperty(value: unknown, property: string): string | undefined {
  if (!(value && typeof value === "object")) {
    return undefined;
  }
  const field = (value as Record<string, unknown>)[property];
  return typeof field === "string" ? field : undefined;
}
