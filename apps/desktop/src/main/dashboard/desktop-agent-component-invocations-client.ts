import {
  type AgentComponentInvocationSyncAckState as AgentComponentInvocationAckState,
  type AgentComponentInvocationSyncAck,
  AgentComponentInvocationSyncAckState,
  type AgentComponentInvocationSyncBatch,
  type AgentComponentInvocationSyncPart,
  type AgentComponentInvocationSyncProtocolVersion,
  AgentComponentInvocationSyncRejectReason,
} from "@repo/api/src/types/agent-component-invocation";
import { unwrapApiEnvelope } from "../util/api-response-utils.js";

const INVOCATION_SYNC_REQUEST_TIMEOUT_MS = 30_000;
const PROTOCOL_UNAVAILABLE_STATUSES = new Set([404, 410, 501]);
const PERMANENT_VALIDATION_FAILURE_STATUSES = new Set([400, 413]);

export type DesktopAgentComponentInvocationsClientOptions = {
  fetch?: typeof fetch;
  getAccessToken: () => Promise<string | null>;
  getApiKey?: () => string | null;
  getApiOrigin: () => string | undefined;
  getComputeTargetId: () => string | null;
};

export type AgentComponentInvocationSyncClientResult =
  | { kind: "ack"; ack: AgentComponentInvocationSyncAck }
  | { kind: "unavailable"; status?: number }
  | { kind: "retry"; error: string; status?: number };

export type DesktopAgentComponentInvocationsClient = {
  syncPart(
    part: AgentComponentInvocationSyncPart,
    computeTargetId?: string
  ): Promise<AgentComponentInvocationSyncClientResult>;
};

export function createDesktopAgentComponentInvocationsClient(
  options: DesktopAgentComponentInvocationsClientOptions
): DesktopAgentComponentInvocationsClient {
  const fetchImpl = options.fetch ?? fetch;

  return {
    async syncPart(part, computeTargetId) {
      const request = await resolveRequest(options, computeTargetId);
      if (!request) {
        return { kind: "unavailable" };
      }
      // ISS-4976: the envelope declares the PART's version, not a build-wide
      // constant. That is what an older API's pre-parse gate reads, so a
      // telemetry-carrying part earns the retryable 501 `protocol_unsupported`
      // there instead of the permanent 400 that dead-letters the generation,
      // while a telemetry-free part still declares v1 and is accepted as today.
      const payload: AgentComponentInvocationSyncBatch = {
        protocolVersion: part.protocolVersion,
        parts: [part],
      };

      let response: Response;
      try {
        response = await fetchImpl(request.url, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: `Bearer ${request.token}`,
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(INVOCATION_SYNC_REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        return { kind: "retry", error: errorMessage(error) };
      }

      if (PROTOCOL_UNAVAILABLE_STATUSES.has(response.status)) {
        return { kind: "unavailable", status: response.status };
      }
      if (PERMANENT_VALIDATION_FAILURE_STATUSES.has(response.status)) {
        return {
          kind: "ack",
          ack: {
            accepted: false,
            protocolVersion: part.protocolVersion,
            externalGenerationId: part.externalGenerationId,
            partIndex: part.partIndex,
            partHash: part.partHash,
            reason: AgentComponentInvocationSyncRejectReason.ValidationFailed,
          },
        };
      }
      if (!response.ok) {
        return {
          kind: "retry",
          status: response.status,
          error: `invocation sync returned HTTP ${response.status}`,
        };
      }

      const body = await response.json().catch(() => null);
      const ack = parseAck(unwrapApiEnvelope(body), part.protocolVersion);
      if (!ack) {
        return {
          kind: "retry",
          error: "invocation sync returned an invalid ack",
        };
      }
      if (
        !ack.accepted &&
        ack.reason ===
          AgentComponentInvocationSyncRejectReason.ProtocolUnsupported
      ) {
        return { kind: "unavailable" };
      }
      return { kind: "ack", ack };
    },
  };
}

async function resolveRequest(
  options: DesktopAgentComponentInvocationsClientOptions,
  computeTargetIdOverride?: string
): Promise<{ url: URL; token: string } | null> {
  const computeTargetId =
    computeTargetIdOverride ?? options.getComputeTargetId();
  const origin = options.getApiOrigin();
  if (!(computeTargetId && origin)) {
    return null;
  }
  let token: string | null = null;
  try {
    token = await options.getAccessToken();
  } catch {
    // API-key fallback below is intentionally available after token failures.
  }
  token ??= options.getApiKey?.() ?? null;
  if (!token) {
    return null;
  }
  try {
    const url = new URL("/desktop/agent-sessions/invocations/sync", origin);
    url.searchParams.set("computeTargetId", computeTargetId);
    return { url, token };
  } catch {
    return null;
  }
}

/**
 * ISS-4976: the ack must echo the version the REQUEST declared. Pinning it to
 * the part rather than to a build-wide constant is what lets this build speak v1
 * for a telemetry-free part and v2 for a telemetry-carrying one without the ack
 * parser rejecting one of them as unrecognizable.
 */
function parseAck(
  value: unknown,
  expectedProtocolVersion: AgentComponentInvocationSyncProtocolVersion
): AgentComponentInvocationSyncAck | null {
  if (!(value && typeof value === "object")) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.accepted !== "boolean" ||
    record.protocolVersion !== expectedProtocolVersion ||
    typeof record.externalGenerationId !== "string" ||
    typeof record.partIndex !== "number" ||
    !Number.isInteger(record.partIndex) ||
    typeof record.partHash !== "string"
  ) {
    return null;
  }
  if (record.accepted) {
    if (!isAckState(record.state)) {
      return null;
    }
    return {
      accepted: true,
      protocolVersion: expectedProtocolVersion,
      externalGenerationId: record.externalGenerationId,
      partIndex: record.partIndex,
      partHash: record.partHash,
      state: record.state,
    };
  }
  if (!isRejectReason(record.reason)) {
    return null;
  }
  return {
    accepted: false,
    protocolVersion: expectedProtocolVersion,
    externalGenerationId: record.externalGenerationId,
    partIndex: record.partIndex,
    partHash: record.partHash,
    reason: record.reason,
  };
}

function isAckState(value: unknown): value is AgentComponentInvocationAckState {
  return Object.values(AgentComponentInvocationSyncAckState).includes(
    value as AgentComponentInvocationAckState
  );
}

function isRejectReason(
  value: unknown
): value is AgentComponentInvocationSyncRejectReason {
  return Object.values(AgentComponentInvocationSyncRejectReason).includes(
    value as AgentComponentInvocationSyncRejectReason
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
