import type { JsonValue } from "@repo/api/src/types/common";
import type { DesktopCommandEventType } from "@repo/api/src/types/compute-target";
import { log } from "@repo/observability/log";
import { desktopCommandStore } from "./desktop-command-store";
import { isTerminalEventData } from "./desktop-gateway-wire";
import { failLoopFromTerminalCommandError } from "./loops/rejected-command-loop-failure";
import { relayEventBus } from "./relay-event-bus";
import { isRecord } from "./type-guards";

/**
 * Bridge a desktop command event into the in-process relay event bus so
 * SSE subscribers (Chrome) pick up live updates.
 *
 * Shared by both the relay HTTP route and the direct-connect socket server.
 */
export async function publishLegacyRelayEvent(
  commandId: string,
  event: {
    commandId: string;
    eventType: DesktopCommandEventType | string;
    data: JsonValue;
    sequence: number;
  }
): Promise<void> {
  const command = await desktopCommandStore.getCommandById(commandId);
  if (!command) {
    return;
  }

  if (event.eventType === "result" && isTerminalEventData(event.data)) {
    relayEventBus.publishResult(command.operationId, {
      operationId: command.operationId,
      result: event.data,
      done: true,
      sequence: event.sequence,
    });
    return;
  }

  if (event.eventType === "done") {
    relayEventBus.publishResult(command.operationId, {
      operationId: command.operationId,
      event: event.data,
      done: true,
      sequence: event.sequence,
    });
    return;
  }

  if (event.eventType === "error") {
    const error =
      isRecord(event.data) && typeof event.data.error === "string"
        ? event.data.error
        : "Command failed";
    if (isTerminalEventData(event.data)) {
      try {
        await failLoopFromTerminalCommandError({
          commandId,
          targetId: command.computeTargetId,
          error,
        });
      } catch (loopFailureError) {
        log.error("Failed applying terminal command loop failure", {
          commandId,
          computeTargetId: command.computeTargetId,
          error: loopFailureError,
        });
      }
    }
    relayEventBus.publishResult(command.operationId, {
      operationId: command.operationId,
      event: event.data,
      done: isTerminalEventData(event.data),
      error,
      sequence: event.sequence,
    });
    return;
  }

  relayEventBus.publishResult(command.operationId, {
    operationId: command.operationId,
    event: event.data,
    done: false,
    sequence: event.sequence,
  });
}
