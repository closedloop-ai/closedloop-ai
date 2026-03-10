import { randomUUID } from "node:crypto";
import type { JsonObject, JsonValue } from "@repo/api/src/types/common";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import { computeTargetsService } from "@/app/compute-targets/service";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import {
  PROTOCOL_VERSION,
  type WireCommandPayload,
} from "@/lib/desktop-gateway-types";
import {
  isDesktopCommandEventType,
  isTerminalEventData,
  toWireCommandFromStore,
} from "@/lib/desktop-gateway-wire";
import { validateInternalSecret } from "@/lib/internal-auth";
import { relayEventBus } from "@/lib/relay-event-bus";
import { isRecord } from "@/lib/type-guards";

type EmitInstruction = { event: string; payload: unknown };

type SocketEventResponse = {
  targetId?: string;
  emit: EmitInstruction[];
  disconnect?: boolean;
};

function envelope<T extends Record<string, unknown>>(
  payload: T
): T & {
  protocolVersion: string;
  messageId: string;
  timestamp: string;
} {
  return {
    ...payload,
    protocolVersion: PROTOCOL_VERSION,
    messageId: randomUUID(),
    timestamp: new Date().toISOString(),
  };
}

function wireCommand(command: WireCommandPayload): EmitInstruction {
  return { event: "desktop.command", payload: envelope(command) };
}

// ---------------------------------------------------------------------------
// Event handlers — each returns what the relay should emit back to the worker
// ---------------------------------------------------------------------------

async function handleHello(
  payload: unknown,
  auth: { organizationId: string; userId: string }
): Promise<SocketEventResponse> {
  if (!isRecord(payload)) {
    return { emit: [], disconnect: true };
  }

  if (
    typeof payload.machineName !== "string" ||
    typeof payload.platform !== "string"
  ) {
    return { emit: [], disconnect: true };
  }

  const machineName = payload.machineName;
  const platform = payload.platform;
  const capabilities: JsonObject = {
    ...(isRecord(payload.capabilities)
      ? (payload.capabilities as JsonObject)
      : {}),
    maxInFlightCommands: (payload.maxInFlightCommands as JsonValue) ?? null,
    allowedDirectoriesHash:
      (payload.allowedDirectoriesHash as JsonValue) ?? null,
    socketProtocolVersion: PROTOCOL_VERSION,
    pluginVersion: (payload.pluginVersion as JsonValue) ?? null,
  };
  const supportedOperations = Array.isArray(payload.supportedOperations)
    ? (payload.supportedOperations as string[])
    : [];

  let targetId = payload.computeTargetId as string | undefined;
  let targetCreated = false;

  if (targetId) {
    const updated = await computeTargetsService.updateOwned(
      targetId,
      auth.organizationId,
      auth.userId,
      { machineName, platform, capabilities, supportedOperations }
    );
    if (!updated) {
      targetId = undefined;
    }
  }

  if (!targetId) {
    const target = await computeTargetsService.register(
      auth.organizationId,
      auth.userId,
      {
        machineName,
        platform,
        capabilities,
        supportedOperations,
        pluginVersion:
          typeof payload.pluginVersion === "string"
            ? payload.pluginVersion
            : undefined,
      }
    );
    targetId = target.id;
    targetCreated = true;
  }

  const [pendingCommands] = await Promise.all([
    desktopCommandStore.listNonTerminalDispatchCommands(targetId),
    targetCreated
      ? Promise.resolve(true)
      : computeTargetsService.setOnlineState(
          targetId,
          auth.organizationId,
          auth.userId,
          true
        ),
  ]);

  // Clear stale in-process backlog so new dispatches go through clean
  relayEventBus.clearOperationBacklog(targetId);

  const sessionId = randomUUID();
  const resumeFromSequence = Object.fromEntries(
    pendingCommands.map((c) => [c.commandId, c.lastSequenceAcked])
  );

  const emit: EmitInstruction[] = [
    {
      event: "desktop.hello.ack",
      payload: envelope({
        computeTargetId: targetId,
        sessionId,
        serverTime: new Date().toISOString(),
        ...(Object.keys(resumeFromSequence).length > 0
          ? { resumeFromSequence }
          : {}),
      }),
    },
  ];

  for (const command of pendingCommands) {
    emit.push(wireCommand(toWireCommandFromStore(command)));
  }

  return { targetId, emit };
}

async function handleCommandEvent(
  payload: unknown,
  targetId: string
): Promise<SocketEventResponse> {
  if (!isRecord(payload)) {
    return { emit: [] };
  }

  if (
    typeof payload.commandId !== "string" ||
    typeof payload.sequence !== "number"
  ) {
    return { emit: [] };
  }

  const commandId = payload.commandId;
  const rawEventType = payload.eventType;
  const data = payload.data as JsonValue;
  const sequence = payload.sequence;

  if (!isDesktopCommandEventType(rawEventType)) {
    return { emit: [] };
  }

  const result = await desktopCommandStore.ingestCommandEvent({
    commandId,
    eventType: rawEventType,
    data,
    sequence,
    computeTargetId: targetId,
  });

  if (result.accepted) {
    if (!result.duplicate) {
      // Publish to in-process event bus for live SSE subscribers on this Vercel instance
      await publishLegacyRelayEvent(commandId, {
        commandId,
        eventType: rawEventType,
        data,
        sequence,
      });
    }
    return {
      emit: [
        {
          event: "desktop.command.event.ack",
          payload: envelope({ commandId, sequence: result.sequence }),
        },
      ],
    };
  }

  if (result.reason === "sequence_gap") {
    const command = await desktopCommandStore.getCommandById(commandId);
    if (command) {
      return {
        emit: [
          {
            event: "desktop.hello.ack",
            payload: envelope({
              computeTargetId: command.computeTargetId,
              sessionId: randomUUID(),
              serverTime: new Date().toISOString(),
              resumeFromSequence: {
                [commandId]: command.lastSequenceAcked,
              },
            }),
          },
        ],
      };
    }
  }

  return { emit: [] };
}

async function handleCommandAck(
  payload: unknown,
  targetId: string
): Promise<SocketEventResponse> {
  if (!isRecord(payload)) {
    return { emit: [] };
  }

  if (
    typeof payload.commandId !== "string" ||
    typeof payload.accepted !== "boolean"
  ) {
    return { emit: [] };
  }

  const commandId = payload.commandId;
  const accepted = payload.accepted;
  const reason =
    typeof payload.reason === "string" ? payload.reason : undefined;

  await desktopCommandStore.acknowledgeCommand(
    commandId,
    accepted,
    reason,
    targetId
  );

  // When Electron rejects a command (accepted=false), synthesize a terminal
  // error event so SSE subscribers (Chrome) stop waiting and see the failure.
  if (!accepted) {
    log.warn("Command rejected by desktop", { commandId, reason, targetId });
    await desktopCommandStore.ingestCommandEvent({
      commandId,
      eventType: "error",
      data: {
        terminal: true,
        error: reason || "Command rejected by desktop",
        code: "rejected",
      } as unknown as JsonValue,
      computeTargetId: targetId,
    });
  }

  return { emit: [] };
}

async function handlePresence(auth: {
  organizationId: string;
  userId: string;
  targetId: string;
}): Promise<SocketEventResponse> {
  await computeTargetsService.heartbeat(
    auth.targetId,
    auth.organizationId,
    auth.userId
  );
  return { emit: [] };
}

async function handleDisconnect(auth: {
  organizationId: string;
  userId: string;
  targetId: string;
}): Promise<SocketEventResponse> {
  await computeTargetsService.setOnlineState(
    auth.targetId,
    auth.organizationId,
    auth.userId,
    false
  );
  return { emit: [] };
}

// Publish to the in-process relay event bus so SSE subscribers pick up events
async function publishLegacyRelayEvent(
  commandId: string,
  event: {
    commandId: string;
    eventType: string;
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

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(request: Request): Promise<Response> {
  if (!validateInternalSecret(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!isRecord(body) || typeof body.event !== "string") {
    return NextResponse.json({ error: "Missing event field" }, { status: 400 });
  }

  const event = body.event as string;
  const payload = body.payload;
  const auth = isRecord(body.auth)
    ? (body.auth as { organizationId: string; userId: string })
    : null;
  const targetId =
    typeof body.targetId === "string" ? body.targetId : undefined;

  try {
    let result: SocketEventResponse;

    switch (event) {
      case "desktop.hello":
        if (!auth) {
          return NextResponse.json(
            { error: "Missing auth context" },
            { status: 400 }
          );
        }
        result = await handleHello(payload, auth);
        break;

      case "desktop.command.event":
        if (!targetId) {
          return NextResponse.json(
            { error: "Missing targetId" },
            { status: 400 }
          );
        }
        result = await handleCommandEvent(payload, targetId);
        break;

      case "desktop.command.ack":
        if (!targetId) {
          return NextResponse.json(
            { error: "Missing targetId" },
            { status: 400 }
          );
        }
        result = await handleCommandAck(payload, targetId);
        break;

      case "desktop.presence":
        if (!(auth && targetId)) {
          return NextResponse.json(
            { error: "Missing auth/targetId" },
            { status: 400 }
          );
        }
        result = await handlePresence({ ...auth, targetId });
        break;

      case "disconnect":
        if (!(auth && targetId)) {
          return NextResponse.json(
            { error: "Missing auth/targetId" },
            { status: 400 }
          );
        }
        result = await handleDisconnect({ ...auth, targetId });
        break;

      default:
        log.warn("Unknown relay socket event", { event });
        result = { emit: [] };
        break;
    }

    return NextResponse.json(result);
  } catch (error) {
    log.error("Internal relay socket-event handler failed", { event, error });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
