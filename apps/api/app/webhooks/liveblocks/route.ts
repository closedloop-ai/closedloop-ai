import {
  createWebhookHandler,
  type WebhookEvent,
} from "@repo/collaboration/server/webhook";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import { scheduleLogFlush } from "@/lib/route-utils";
import {
  handleCommentCreated,
  handleCommentDeleted,
  handleCommentEdited,
  handleCommentReactionAdded,
  handleCommentReactionRemoved,
  handleThreadCreated,
  handleThreadDeleted,
  handleThreadResolved,
  handleThreadUnresolved,
} from "./handlers";

export async function POST(request: Request): Promise<Response> {
  const webhookHandler = createWebhookHandler();
  if (!webhookHandler) {
    log.warn("[webhook/liveblocks] Webhook secret not configured, rejecting");
    scheduleLogFlush();
    return NextResponse.json(
      { message: "Liveblocks webhooks not configured", ok: false },
      { status: 200 }
    );
  }

  try {
    const rawBody = await request.text();

    let event: WebhookEvent;
    try {
      event = webhookHandler.verifyRequest({
        rawBody,
        headers: request.headers,
      });
    } catch {
      log.warn("[webhook/liveblocks] Invalid webhook signature");
      scheduleLogFlush();
      return NextResponse.json(
        { message: "Invalid signature", ok: false },
        { status: 401 }
      );
    }

    switch (event.type) {
      case "threadCreated":
        await handleThreadCreated(event);
        break;
      case "commentCreated":
        await handleCommentCreated(event);
        break;
      case "commentEdited":
        await handleCommentEdited(event);
        break;
      case "commentDeleted":
        await handleCommentDeleted(event);
        break;
      case "commentReactionAdded":
        await handleCommentReactionAdded(event);
        break;
      case "commentReactionRemoved":
        await handleCommentReactionRemoved(event);
        break;
      case "threadDeleted":
        await handleThreadDeleted(event);
        break;
      case "threadMarkedAsResolved":
        await handleThreadResolved(event);
        break;
      case "threadMarkedAsUnresolved":
        await handleThreadUnresolved(event);
        break;
      default:
        logLiveblocksTerminalEvent(event.type, "unsupported_event");
        break;
    }

    if (isSupportedLiveblocksEvent(event.type)) {
      logLiveblocksTerminalEvent(event.type, "processed");
    }
    scheduleLogFlush();
    return NextResponse.json({ message: "Event processed", ok: true });
  } catch (error) {
    const message = parseError(error);
    log.error("[webhook/liveblocks] Unhandled error processing webhook", {
      error: message,
    });
    scheduleLogFlush();
    return NextResponse.json(
      { message: "Something went wrong", ok: false },
      { status: 500 }
    );
  }
}

function isSupportedLiveblocksEvent(type: string): boolean {
  return (
    type === "threadCreated" ||
    type === "commentCreated" ||
    type === "commentEdited" ||
    type === "commentDeleted" ||
    type === "commentReactionAdded" ||
    type === "commentReactionRemoved" ||
    type === "threadDeleted" ||
    type === "threadMarkedAsResolved" ||
    type === "threadMarkedAsUnresolved"
  );
}

function logLiveblocksTerminalEvent(
  eventType: string,
  outcome: "processed" | "unsupported_event"
): void {
  log.info("[webhook/liveblocks] Event handled", {
    eventType,
    outcome,
    provider: "liveblocks",
  });
}
