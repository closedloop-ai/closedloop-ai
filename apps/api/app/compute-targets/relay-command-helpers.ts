import type {
  CreateDesktopCommandInput,
  RelayOperationDispatchRequest,
} from "@repo/api/src/types/compute-target";
import type {
  WireCommandPayload,
  WithCorrelation,
} from "@/lib/desktop-gateway-types";

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
  input: CreateDesktopCommandInput
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
