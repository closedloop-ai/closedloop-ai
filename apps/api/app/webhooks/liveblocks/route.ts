import {
  createWebhookHandler,
  type WebhookEvent,
} from "@repo/collaboration/webhook";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import {
  handleCommentCreated,
  handleCommentDeleted,
  handleCommentEdited,
  handleCommentReactionAdded,
  handleCommentReactionRemoved,
  handleThreadCreated,
  handleThreadResolved,
  handleThreadUnresolved,
} from "./handlers";

export async function POST(request: Request): Promise<Response> {
  log.info("[webhook/liveblocks] Received webhook request");

  const webhookHandler = createWebhookHandler();
  if (!webhookHandler) {
    log.warn("[webhook/liveblocks] Webhook secret not configured, rejecting");
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
      return NextResponse.json(
        { message: "Invalid signature", ok: false },
        { status: 401 }
      );
    }

    log.info("[webhook/liveblocks] Processing event", { type: event.type });

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
      case "threadMarkedAsResolved":
        await handleThreadResolved(event);
        break;
      case "threadMarkedAsUnresolved":
        await handleThreadUnresolved(event);
        break;
      default:
        log.info("[webhook/liveblocks] Ignoring unsupported event type", {
          type: event.type,
        });
        break;
    }

    return NextResponse.json({ message: "Event processed", ok: true });
  } catch (error) {
    const message = parseError(error);
    log.error("[webhook/liveblocks] Unhandled error processing webhook", {
      error: message,
    });
    return NextResponse.json(
      { message: "Something went wrong", ok: false },
      { status: 500 }
    );
  }
}
