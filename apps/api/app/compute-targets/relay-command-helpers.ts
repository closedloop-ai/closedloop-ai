import type {
  CommandSignatureFields,
  CreateDesktopCommandInput,
  RelayOperationDispatchRequest,
} from "@repo/api/src/types/compute-target";
import { log } from "@repo/observability/log";
import { env } from "@/env";
import type {
  WireCommandPayload,
  WithCorrelation,
} from "@/lib/desktop-gateway-types";
import {
  toEnvelope,
  toWireCommandFromRelayOperation,
} from "@/lib/desktop-gateway-wire";
import { relayEventBus } from "@/lib/relay-event-bus";

export function appendQuery(
  path: string,
  query?: Record<string, string | string[]>
): string {
  if (!query || Object.keys(query).length === 0) {
    return path;
  }

  const params = new URLSearchParams();
  for (const [key, raw] of Object.entries(query)) {
    if (Array.isArray(raw)) {
      for (const value of raw) {
        params.append(key, value);
      }
      continue;
    }
    params.set(key, raw);
  }
  const queryString = params.toString();
  return queryString ? `${path}?${queryString}` : path;
}

export function toRelayOperation(
  commandId: string,
  input: CreateDesktopCommandInput,
  signatureFields?: CommandSignatureFields
): RelayOperationDispatchRequest {
  return {
    operationId: input.operationId,
    operation: "engineer_http_request",
    params: {
      request: {
        method: input.method,
        path: appendQuery(input.path, input.query),
        headers: input.headers ?? {},
        body: input.body ?? null,
      },
      commandId,
      lockKey: input.lockKey ?? null,
      timeoutMs: input.timeoutMs ?? null,
      requiresApproval: input.requiresApproval ?? null,
      approvalReason: input.approvalReason ?? null,
      ...(signatureFields
        ? {
            signature: signatureFields.signature,
            signaturePayload: signatureFields.signaturePayload,
            publicKeyFingerprint: signatureFields.publicKeyFingerprint,
          }
        : {}),
    },
    streaming: input.streaming ?? false,
  };
}

/**
 * Attach correlation context to a wire command payload for end-to-end tracing
 * across the relay pipeline. Returns a new object without mutating the source.
 */
export function withCorrelationContext(
  wireCommand: WireCommandPayload,
  correlation: {
    requestId?: string;
    gatewaySessionId?: string;
    computeTargetId?: string;
  }
): WithCorrelation<WireCommandPayload> {
  return {
    ...wireCommand,
    ...(correlation.requestId !== undefined && {
      requestId: correlation.requestId,
    }),
    ...(correlation.gatewaySessionId !== undefined && {
      gatewaySessionId: correlation.gatewaySessionId,
    }),
    ...(correlation.computeTargetId !== undefined && {
      computeTargetId: correlation.computeTargetId,
    }),
  };
}

/**
 * Dispatches a queued Desktop command through the external relay when
 * configured, otherwise through the in-process relay event bus.
 */
export async function dispatchRelayCommandToRelay(input: {
  targetId: string;
  commandId: string;
  relayOperation: RelayOperationDispatchRequest;
  requestId?: string;
}): Promise<RelayDispatchResult> {
  const wireCommand = toWireCommandFromRelayOperation(input.relayOperation);
  if (!wireCommand) {
    log.error("Failed to convert relay operation to wire command", {
      targetId: input.targetId,
      computeTargetId: input.targetId,
      commandId: input.commandId,
    });
    return { delivered: false, reason: "wire_conversion_failed" };
  }

  const relayApiUrl = env.RELAY_API_URL;
  const internalSecret = env.INTERNAL_API_SECRET;
  if (!(relayApiUrl && internalSecret)) {
    log.info("Using in-process relay bus (no RELAY_API_URL)", {
      targetId: input.targetId,
      computeTargetId: input.targetId,
      commandId: input.commandId,
    });
    const result = relayEventBus.publishOperation(
      input.targetId,
      input.relayOperation
    );
    return {
      delivered: result.deliveredToSubscriber,
      reason: result.deliveredToSubscriber ? undefined : "target_offline",
    };
  }

  log.info("Dispatching command to relay", {
    relayApiUrl,
    targetId: input.targetId,
    computeTargetId: input.targetId,
    commandId: input.commandId,
  });
  const operation = toEnvelope(
    withCorrelationContext(wireCommand, {
      requestId: input.requestId,
      computeTargetId: input.targetId,
    })
  );
  try {
    const response = await fetch(`${relayApiUrl}/dispatch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": internalSecret,
      },
      body: JSON.stringify({
        targetId: input.targetId,
        operation,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) {
      const result = (await response
        .json()
        .catch(() => ({ delivered: true }))) as {
        delivered?: unknown;
        reason?: unknown;
      };
      log.info("Relay dispatch result", {
        targetId: input.targetId,
        computeTargetId: input.targetId,
        commandId: input.commandId,
        delivered: result.delivered,
        reason: result.reason,
      });
      return {
        delivered: result.delivered !== false,
        reason: typeof result.reason === "string" ? result.reason : undefined,
      };
    }
    const body = await response.text().catch(() => "");
    log.error("Relay dispatch failed", {
      targetId: input.targetId,
      computeTargetId: input.targetId,
      commandId: input.commandId,
      status: response.status,
      body,
    });
    return { delivered: false, reason: `relay_http_${response.status}` };
  } catch (dispatchError) {
    log.error("Failed to dispatch command to relay", {
      targetId: input.targetId,
      computeTargetId: input.targetId,
      commandId: input.commandId,
      error: dispatchError,
    });
    return { delivered: false, reason: "relay_dispatch_failed" };
  }
}

export type RelayDispatchResult = {
  delivered: boolean;
  reason?: string;
};
