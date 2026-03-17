import "server-only";
import { Liveblocks, WebhookHandler } from "@liveblocks/node";
import { keys } from "./keys";

export type {
  CommentBody,
  CommentBodyInlineElement,
  CommentCreatedEvent,
  CommentData,
  CommentDeletedEvent,
  CommentEditedEvent,
  CommentReactionAdded,
  CommentReactionRemoved,
  ThreadCreatedEvent,
  ThreadData,
  ThreadMarkedAsResolvedEvent,
  ThreadMarkedAsUnresolvedEvent,
  WebhookEvent,
} from "@liveblocks/node";

/**
 * Create a WebhookHandler for verifying Liveblocks webhook signatures.
 * Returns null if LIVEBLOCKS_WEBHOOK_SECRET is not configured.
 */
export function createWebhookHandler(): WebhookHandler | null {
  const secret = keys().LIVEBLOCKS_WEBHOOK_SECRET;
  if (!secret) {
    return null;
  }
  return new WebhookHandler(secret);
}

/**
 * Get a Liveblocks API client for fetching thread/comment data.
 * Returns null if LIVEBLOCKS_SECRET is not configured.
 */
export function getLiveblocksApiClient(): Liveblocks | null {
  const secret = keys().LIVEBLOCKS_SECRET;
  if (!secret) {
    return null;
  }
  return new Liveblocks({ secret });
}
