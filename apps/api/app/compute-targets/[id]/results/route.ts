import type { RelayResultIngestRequest } from "@repo/api/src/types/compute-target";
import { log } from "@repo/observability/log";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import { relayEventBus } from "@/lib/relay-event-bus";
import {
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { isRecord } from "@/lib/type-guards";
import {
  isOneShotRelayResult,
  resolveEventType,
  type StreamingRelayResult,
  toCommandEventData,
  toTerminalResultData,
} from "../../relay-result-helpers";
import { computeTargetsService } from "../../service";
import { relayResultIngestValidator } from "../../validators";

type IngestResultResponse = {
  ok: true;
};

async function ingestOneShotResult(
  payload: Extract<RelayResultIngestRequest, { result: unknown }>,
  computeTargetId: string
): Promise<boolean> {
  const commandId = await desktopCommandStore.findCommandIdByOperationId(
    payload.operationId,
    computeTargetId
  );
  if (!commandId) {
    // Result arrives for an unknown operationId — may happen if the command
    // expired or was created on a different target. 200 OK is returned to
    // avoid triggering retry loops in the relay runner.
    log.warn("Result dropped: no command found for operationId", {
      operationId: payload.operationId,
      computeTargetId,
    });
    return false;
  }

  const result = await desktopCommandStore.ingestCommandEvent({
    commandId,
    computeTargetId,
    eventType: "result",
    data: toTerminalResultData(payload.result),
    sequence: payload.sequence,
  });
  return result.accepted && !result.duplicate;
}

async function ingestStreamingResult(
  payload: StreamingRelayResult,
  computeTargetId: string
): Promise<boolean> {
  const commandId = await desktopCommandStore.findCommandIdByOperationId(
    payload.operationId,
    computeTargetId
  );
  if (!commandId) {
    log.warn("Streaming result dropped: no command found for operationId", {
      operationId: payload.operationId,
      computeTargetId,
    });
    return false;
  }

  const eventPayload = isRecord(payload.event) ? payload.event : {};
  const eventType = resolveEventType(eventPayload, payload.error, payload.done);
  const data = toCommandEventData(eventPayload, eventType, payload);

  const result = await desktopCommandStore.ingestCommandEvent({
    commandId,
    computeTargetId,
    eventType,
    data,
    sequence: payload.sequence,
  });
  return result.accepted && !result.duplicate;
}

function publishOneShotResult(
  payload: Extract<RelayResultIngestRequest, { result: unknown }>
): void {
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
      return notFoundResponse("Compute target");
    }

    await computeTargetsService.heartbeat(id, user.organizationId, user.id);

    const payload = body as RelayResultIngestRequest;
    if (isOneShotRelayResult(payload)) {
      const shouldPublish = await ingestOneShotResult(payload, target.id);
      if (shouldPublish) {
        publishOneShotResult(payload);
      }
    } else {
      const shouldPublish = await ingestStreamingResult(payload, target.id);
      if (shouldPublish) {
        publishStreamingResult(payload);
      }
    }

    return successResponse({ ok: true });
  } catch (error) {
    return errorResponse("Failed to ingest relay result", error);
  }
});
