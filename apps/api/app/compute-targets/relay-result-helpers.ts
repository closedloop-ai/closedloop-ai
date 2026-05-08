import type { JsonValue } from "@repo/api/src/types/common";
import type {
  DesktopCommandEventType,
  RelayResultIngestRequest,
} from "@repo/api/src/types/compute-target";
import { isRecord } from "@/lib/type-guards";

export type OneShotRelayResult = Extract<
  RelayResultIngestRequest,
  { result: JsonValue }
>;
export type StreamingRelayResult = Extract<
  RelayResultIngestRequest,
  { event: JsonValue }
>;

export function isOneShotRelayResult(
  payload: RelayResultIngestRequest
): payload is OneShotRelayResult {
  return "result" in payload;
}

export function toJsonValue(value: unknown): JsonValue {
  return value as JsonValue;
}

export function toTerminalResultData(result: JsonValue): JsonValue {
  if (isRecord(result)) {
    return { ...result, terminal: true } as JsonValue;
  }
  return { value: result, terminal: true } as JsonValue;
}

export function resolveEventType(
  payload: Record<string, unknown>,
  error?: string,
  done?: boolean
): DesktopCommandEventType {
  let eventType: DesktopCommandEventType = "chunk";
  const rawType = typeof payload.type === "string" ? payload.type : null;

  if (
    rawType === "status" ||
    rawType === "chunk" ||
    rawType === "result" ||
    rawType === "error" ||
    rawType === "done"
  ) {
    eventType = rawType;
  } else if (rawType === "text") {
    eventType = "chunk";
  }

  if (error) {
    return "error";
  }
  if (done === true) {
    return "done";
  }

  return eventType;
}

export function toCommandEventData(
  payload: Record<string, unknown>,
  eventType: DesktopCommandEventType,
  result: StreamingRelayResult
): JsonValue {
  if (eventType === "error") {
    const error =
      result.error ??
      (typeof payload.error === "string" ? payload.error : "Command failed");
    const terminal = result.done ?? payload.terminal ?? true;
    return toJsonValue({ ...payload, error, terminal });
  }

  if (eventType === "done") {
    if (isRecord(result.event)) {
      return toJsonValue(result.event);
    }
    return toJsonValue({ cancelled: false });
  }

  return toJsonValue(result.event ?? {});
}
