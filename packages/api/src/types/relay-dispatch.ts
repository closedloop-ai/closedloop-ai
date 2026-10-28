import { z } from "zod";

/**
 * Backward-compatible relay dispatch envelope shared by relay and API callers.
 *
 * `reason` remains the coarse legacy value old consumers already understand.
 * `diagnosticReason` is additive and optional so rolling deploys and
 * version-skewed clients can ignore values they do not know.
 */
export type RelayDispatchResult = {
  delivered: boolean;
  reason?: string;
  diagnosticReason?: string;
  peerStatusCode?: number;
  peerErrorCode?: string;
};

export const RelayDispatchReason = {
  TargetNotConnected: "target_not_connected",
} as const;
export type RelayDispatchReason =
  (typeof RelayDispatchReason)[keyof typeof RelayDispatchReason];

export const RelayDispatchDiagnosticReason = {
  NoRegistryEntry: "no_registry_entry",
  TargetRegistryLookupFailed: "target_registry_lookup_failed",
  TargetRegistryRecordUnreadable: "target_registry_record_unreadable",
  LocalWorkerNotConnected: "local_worker_not_connected",
  SameInstanceOwnerTokenMismatch: "same_instance_owner_token_mismatch",
  RegistryUnavailableInMemory: "registry_unavailable_inmemory",
  PeerInstanceMissing: "peer_instance_missing",
  PeerInstanceLookupFailed: "peer_instance_lookup_failed",
  PeerInstanceDisallowed: "peer_instance_disallowed",
  PeerHttpNotOk: "peer_http_not_ok",
  PeerTimeout: "peer_timeout",
  PeerNetworkFailed: "peer_network_failed",
  PeerBodyNotJson: "peer_body_not_json",
  PeerMalformedResponse: "peer_malformed_response",
  PeerNoWorker: "peer_no_worker",
  PeerReportedNotConnected: "peer_reported_not_connected",
} as const;
export type RelayDispatchDiagnosticReason =
  (typeof RelayDispatchDiagnosticReason)[keyof typeof RelayDispatchDiagnosticReason];

export type RelayDispatchDiagnosticMetadata = {
  peerStatusCode?: number;
  peerErrorCode?: string;
};

export type RelayDispatchNotDeliveredResult = {
  delivered: false;
  reason: typeof RelayDispatchReason.TargetNotConnected;
  diagnosticReason: RelayDispatchDiagnosticReason;
  peerStatusCode?: number;
  peerErrorCode?: string;
};

export type RelayDispatchConditionRationale = {
  condition: string;
  reason: RelayDispatchReason;
  compatibilityRationale: string;
};

export const RelayDispatchConditionRationale = {
  [RelayDispatchDiagnosticReason.NoRegistryEntry]: {
    condition: "No target registry entry",
    reason: RelayDispatchReason.TargetNotConnected,
    compatibilityRationale:
      "No relay owner is known; legacy consumers already treat this as not delivered.",
  },
  [RelayDispatchDiagnosticReason.TargetRegistryLookupFailed]: {
    condition: "Target registry lookup failed",
    reason: RelayDispatchReason.TargetNotConnected,
    compatibilityRationale:
      "Registry state is unknown, but old consumers must still receive the ambiguous non-delivery bucket.",
  },
  [RelayDispatchDiagnosticReason.TargetRegistryRecordUnreadable]: {
    condition: "Target registry record is unreadable",
    reason: RelayDispatchReason.TargetNotConnected,
    compatibilityRationale:
      "The record cannot be trusted; report diagnostic detail without changing old behavior.",
  },
  [RelayDispatchDiagnosticReason.LocalWorkerNotConnected]: {
    condition: "Local worker absent with no proxyable peer",
    reason: RelayDispatchReason.TargetNotConnected,
    compatibilityRationale: "This is the legacy truly-local no-worker case.",
  },
  [RelayDispatchDiagnosticReason.SameInstanceOwnerTokenMismatch]: {
    condition:
      "Registry names this relay instance with a different owner token",
    reason: RelayDispatchReason.TargetNotConnected,
    compatibilityRationale:
      "The live local socket is stale for this owner; do not emit locally or invent delivery.",
  },
  [RelayDispatchDiagnosticReason.RegistryUnavailableInMemory]: {
    condition:
      "Relay is in degraded in-memory mode and cannot proxy to another instance",
    reason: RelayDispatchReason.TargetNotConnected,
    compatibilityRationale:
      "Cross-instance discovery is disabled; preserve the old not-delivered envelope while making the mode visible.",
  },
  [RelayDispatchDiagnosticReason.PeerInstanceMissing]: {
    condition: "Peer instance record is missing",
    reason: RelayDispatchReason.TargetNotConnected,
    compatibilityRationale:
      "The target registry points to a peer that cannot be reached through registry metadata.",
  },
  [RelayDispatchDiagnosticReason.PeerInstanceLookupFailed]: {
    condition: "Peer instance lookup failed or the record is unreadable",
    reason: RelayDispatchReason.TargetNotConnected,
    compatibilityRationale:
      "The peer owner is known but its connection metadata is unusable.",
  },
  [RelayDispatchDiagnosticReason.PeerInstanceDisallowed]: {
    condition: "Peer instance fails the private-address guard",
    reason: RelayDispatchReason.TargetNotConnected,
    compatibilityRationale:
      "This is a safety refusal, not a disconnected desktop; keep old callers in the same non-delivered bucket.",
  },
  [RelayDispatchDiagnosticReason.PeerHttpNotOk]: {
    condition: "Peer returns non-2xx",
    reason: RelayDispatchReason.TargetNotConnected,
    compatibilityRationale:
      "Peer HTTP failures stay distinguishable through metadata without exploding reason values.",
  },
  [RelayDispatchDiagnosticReason.PeerTimeout]: {
    condition: "Peer fetch times out",
    reason: RelayDispatchReason.TargetNotConnected,
    compatibilityRationale:
      "Separate the high-volume misdiagnosed case without changing retry semantics.",
  },
  [RelayDispatchDiagnosticReason.PeerNetworkFailed]: {
    condition: "Peer fetch, network, or body stream fails",
    reason: RelayDispatchReason.TargetNotConnected,
    compatibilityRationale:
      "Network and body-termination failures remain ambiguous from the sender.",
  },
  [RelayDispatchDiagnosticReason.PeerBodyNotJson]: {
    condition: "Peer 2xx body is not JSON",
    reason: RelayDispatchReason.TargetNotConnected,
    compatibilityRationale:
      "This is distinct from a JSON envelope that is malformed.",
  },
  [RelayDispatchDiagnosticReason.PeerMalformedResponse]: {
    condition: "Peer 2xx JSON envelope lacks a boolean delivered field",
    reason: RelayDispatchReason.TargetNotConnected,
    compatibilityRationale: "Do not forward an invalid delivery envelope.",
  },
  [RelayDispatchDiagnosticReason.PeerNoWorker]: {
    condition: "Peer reports no worker with the new field",
    reason: RelayDispatchReason.TargetNotConnected,
    compatibilityRationale:
      "This is the only peer-reported stale-target case that can deregister.",
  },
  [RelayDispatchDiagnosticReason.PeerReportedNotConnected]: {
    condition:
      "Older peer reports target_not_connected without a diagnostic field",
    reason: RelayDispatchReason.TargetNotConnected,
    compatibilityRationale:
      "Rolling deploy compatibility; the sender synthesizes a diagnostic while preserving peer provenance.",
  },
} satisfies Record<
  RelayDispatchDiagnosticReason,
  RelayDispatchConditionRationale
>;

export function isRelayDispatchDiagnosticReason(
  value: unknown
): value is RelayDispatchDiagnosticReason {
  return (
    typeof value === "string" &&
    Object.values(RelayDispatchDiagnosticReason).includes(
      value as RelayDispatchDiagnosticReason
    )
  );
}

export function relayDispatchNotDelivered(
  diagnosticReason: RelayDispatchDiagnosticReason,
  metadata: RelayDispatchDiagnosticMetadata = {}
): RelayDispatchNotDeliveredResult {
  const peerStatusCode = normalizeRelayDispatchPeerStatusCode(
    metadata.peerStatusCode
  );
  const peerErrorCode = normalizeRelayDispatchPeerErrorCode(
    metadata.peerErrorCode
  );
  return {
    delivered: false,
    reason: RelayDispatchReason.TargetNotConnected,
    diagnosticReason,
    ...(peerStatusCode === undefined ? {} : { peerStatusCode }),
    ...(peerErrorCode === undefined ? {} : { peerErrorCode }),
  };
}

export function normalizeRelayDispatchReason(
  value: unknown
): string | undefined {
  return normalizeRelayDispatchMetadataToken(
    value,
    RelayDispatchMetadataLimit.ReasonMaxLength
  );
}

export function normalizeRelayDispatchDiagnosticReason(
  value: unknown
): string | undefined {
  return normalizeRelayDispatchMetadataToken(
    value,
    RelayDispatchMetadataLimit.DiagnosticReasonMaxLength
  );
}

export function normalizeRelayDispatchPeerStatusCode(
  value: unknown
): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return undefined;
  }
  return value >= 100 && value <= 599 ? value : undefined;
}

export function normalizeRelayDispatchPeerErrorCode(
  value: unknown
): string | undefined {
  return normalizeRelayDispatchMetadataToken(
    value,
    RelayDispatchMetadataLimit.PeerErrorCodeMaxLength
  );
}

export const relayDispatchResultSchema = z.object({
  delivered: z.boolean(),
  reason: z.preprocess(normalizeRelayDispatchReason, z.string().optional()),
  diagnosticReason: z.preprocess(
    normalizeRelayDispatchDiagnosticReason,
    z.string().optional()
  ),
  peerStatusCode: z.preprocess(
    normalizeRelayDispatchPeerStatusCode,
    z.number().int().min(100).max(599).optional()
  ),
  peerErrorCode: z.preprocess(
    normalizeRelayDispatchPeerErrorCode,
    z.string().optional()
  ),
});

export function normalizeLenientRelayDispatchResult(
  value: unknown,
  fallbackDelivered: boolean
): RelayDispatchResult {
  const parsed = relayDispatchLenientResultSchema.safeParse(value);
  if (!parsed.success) {
    return { delivered: fallbackDelivered };
  }
  return {
    delivered:
      typeof parsed.data.delivered === "boolean"
        ? parsed.data.delivered
        : fallbackDelivered,
    ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
    ...(parsed.data.diagnosticReason
      ? { diagnosticReason: parsed.data.diagnosticReason }
      : {}),
    ...(parsed.data.peerStatusCode === undefined
      ? {}
      : { peerStatusCode: parsed.data.peerStatusCode }),
    ...(parsed.data.peerErrorCode
      ? { peerErrorCode: parsed.data.peerErrorCode }
      : {}),
  };
}

function normalizeRelayDispatchMetadataToken(
  value: unknown,
  maxLength: number
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > maxLength ||
    !RELAY_DISPATCH_METADATA_TOKEN_PATTERN.test(trimmed)
  ) {
    return undefined;
  }
  return trimmed;
}

const relayDispatchLenientResultSchema = z.object({
  delivered: z.boolean().optional().catch(undefined),
  reason: z.preprocess(normalizeRelayDispatchReason, z.string().optional()),
  diagnosticReason: z.preprocess(
    normalizeRelayDispatchDiagnosticReason,
    z.string().optional()
  ),
  peerStatusCode: z.preprocess(
    normalizeRelayDispatchPeerStatusCode,
    z.number().int().min(100).max(599).optional()
  ),
  peerErrorCode: z.preprocess(
    normalizeRelayDispatchPeerErrorCode,
    z.string().optional()
  ),
});

export const RelayDispatchMetadataLimit = {
  ReasonMaxLength: 96,
  DiagnosticReasonMaxLength: 96,
  PeerErrorCodeMaxLength: 64,
} as const;

const RELAY_DISPATCH_METADATA_TOKEN_PATTERN = /^[A-Za-z0-9_.:-]+$/;
