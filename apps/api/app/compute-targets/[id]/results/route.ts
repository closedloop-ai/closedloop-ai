import type { JsonValue } from "@repo/api/src/types/common";
import type {
  DesktopCommandEventType,
  RelayResultIngestRequest,
} from "@repo/api/src/types/compute-target";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import { relayEventBus } from "@/lib/relay-event-bus";
import {
  errorResponse,
  forbiddenResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { isRecord } from "@/lib/type-guards";
import { computeTargetsService } from "../../service";
import { relayResultIngestValidator } from "../../validators";

type IngestResultResponse = {
  ok: true;
};

type OneShotRelayResult = Extract<
  RelayResultIngestRequest,
  { result: JsonValue }
>;
type StreamingRelayResult = Extract<
  RelayResultIngestRequest,
  { event: JsonValue }
>;

function isOneShotRelayResult(
  payload: RelayResultIngestRequest
): payload is OneShotRelayResult {
  return "result" in payload;
}

function toJsonValue(value: unknown): JsonValue {
  return value as JsonValue;
}

function toTerminalResultData(result: JsonValue): JsonValue {
  if (isRecord(result)) {
    return { ...result, terminal: true } as JsonValue;
  }
  return { value: result, terminal: true } as JsonValue;
}

function resolveEventType(
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

function toCommandEventData(
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

async function ingestOneShotResult(
  payload: OneShotRelayResult
): Promise<boolean> {
  const commandId = await desktopCommandStore.findCommandIdByOperationId(
    payload.operationId
  );
  if (!commandId) {
    return false;
  }

  const result = await desktopCommandStore.ingestCommandEvent({
    commandId,
    eventType: "result",
    data: toTerminalResultData(payload.result),
    sequence: payload.sequence,
  });
  return result.accepted && !result.duplicate;
}

async function ingestStreamingResult(
  payload: StreamingRelayResult
): Promise<boolean> {
  const commandId = await desktopCommandStore.findCommandIdByOperationId(
    payload.operationId
  );
  if (!commandId) {
    return false;
  }

  const eventPayload = isRecord(payload.event) ? payload.event : {};
  const eventType = resolveEventType(eventPayload, payload.error, payload.done);
  const data = toCommandEventData(eventPayload, eventType, payload);

  const result = await desktopCommandStore.ingestCommandEvent({
    commandId,
    eventType,
    data,
    sequence: payload.sequence,
  });
  return result.accepted && !result.duplicate;
}

function publishOneShotResult(payload: OneShotRelayResult): void {
  relayEventBus.publishResult(payload.operationId, {
    operationId: payload.operationId,
    result: payload.result,
    done: true,
    sequence: payload.sequence,
  });
}

function publishStreamingResult(payload: StreamingRelayResult): void {
  relayEventBus.publishResult(payload.operationId, {
    operationId: payload.operationId,
    event: payload.event,
    done: payload.done,
    error: payload.error,
    sequence: payload.sequence,
  });
}

/**
 * POST /compute-targets/:id/results
 * Ingests one-shot or streaming relay result events from a compute target.
 */
export const POST = withAnyAuth<
  IngestResultResponse,
  "/compute-targets/[id]/results"
>(async ({ user }, request, params) => {
  try {
    const { id } = await params;
    const { body, errorResponse: parseError } = await parseBody(
      request,
      relayResultIngestValidator
    );
    if (parseError) {
      return parseError;
    }
    if (!body) {
      return errorResponse(
        "Invalid request body",
        new Error("Empty body"),
        400
      );
    }

    const target = await computeTargetsService.findOwnedById(
      id,
      user.organizationId,
      user.id
    );
    if (!target) {
      return forbiddenResponse();
    }

    await computeTargetsService.heartbeat(id, user.organizationId, user.id);

    const payload = body as RelayResultIngestRequest;
    if (isOneShotRelayResult(payload)) {
      const shouldPublish = await ingestOneShotResult(payload);
      if (shouldPublish) {
        publishOneShotResult(payload);
      }
    } else {
      const shouldPublish = await ingestStreamingResult(payload);
      if (shouldPublish) {
        publishStreamingResult(payload);
      }
    }

    return successResponse({ ok: true });
  } catch (error) {
    return errorResponse("Failed to ingest relay result", error);
  }
});
