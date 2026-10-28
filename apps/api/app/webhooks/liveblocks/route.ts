import {
  createWebhookHandler,
  type WebhookEvent,
} from "@repo/collaboration/server/webhook";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import { withRequestCompleted } from "@/lib/observability/with-request-completed";
import {
  LIVEBLOCKS_WEBHOOK_MAX_BYTES,
  readVerifiableWebhookBody,
} from "../webhook-body";
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
import { LiveblocksWebhookOutcome } from "./webhook-outcome";

export const POST = withRequestCompleted(handleLiveblocksWebhook);

async function handleLiveblocksWebhook(request: Request): Promise<Response> {
  const webhookHandler = createWebhookHandler();
  if (!webhookHandler) {
    log.warn("[webhook/liveblocks] Webhook secret not configured, rejecting");
    return NextResponse.json(
      { message: "Liveblocks webhooks not configured", ok: false },
      { status: 200 }
    );
  }

  try {
    // Bounded: `verifyRequest` signs over these raw bytes, so the read runs
    // before the caller is authenticated (ISS-7665).
    const { body: rawBody, response: oversized } =
      await readVerifiableWebhookBody(request, LIVEBLOCKS_WEBHOOK_MAX_BYTES);
    if (oversized) {
      return oversized;
    }

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

    let outcome: LiveblocksWebhookOutcome;
    switch (event.type) {
      case "threadCreated":
        outcome = await handleThreadCreated(event);
        break;
      case "commentCreated":
        outcome = await handleCommentCreated(event);
        break;
      case "commentEdited":
        outcome = await handleCommentEdited(event);
        break;
      case "commentDeleted":
        outcome = await handleCommentDeleted(event);
        break;
      case "commentReactionAdded":
        outcome = await handleCommentReactionAdded(event);
        break;
      case "commentReactionRemoved":
        outcome = await handleCommentReactionRemoved(event);
        break;
      case "threadDeleted":
        outcome = await handleThreadDeleted(event);
        break;
      case "threadMarkedAsResolved":
        outcome = await handleThreadResolved(event);
        break;
      case "threadMarkedAsUnresolved":
        outcome = await handleThreadUnresolved(event);
        break;
      default:
        outcome = LiveblocksWebhookOutcome.UnsupportedEvent;
        break;
    }

    logLiveblocksTerminalEvent(event.type, outcome);
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

function logLiveblocksTerminalEvent(
  eventType: string,
  outcome: LiveblocksWebhookOutcome
): void {
  log.info("[webhook/liveblocks] Event handled", {
    eventType,
    outcome,
    provider: "liveblocks",
  });
}
