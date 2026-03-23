import { parseArtifactRoomId } from "@repo/collaboration/room-utils";
import type {
  CommentCreatedEvent,
  CommentDeletedEvent,
  CommentEditedEvent,
  CommentReactionAdded,
  CommentReactionRemoved,
  ThreadCreatedEvent,
  ThreadDeletedEvent,
  ThreadMarkedAsResolvedEvent,
  ThreadMarkedAsUnresolvedEvent,
} from "@repo/collaboration/webhook";
import { getLiveblocksApiClient } from "@repo/collaboration/webhook";
import { log } from "@repo/observability/log";
import { commentsService } from "../../comments/service";

export async function handleThreadCreated(
  event: ThreadCreatedEvent
): Promise<void> {
  const { roomId, threadId, createdBy } = event.data;
  const organizationId = getOrganizationId(roomId);
  if (!organizationId) {
    log.info("[webhook/liveblocks] Skipping non-artifact room", { roomId });
    return;
  }

  const client = requireApiClient();
  const thread = await client.getThread({ roomId, threadId });

  await commentsService.upsertThreadFromLiveblocks(
    organizationId,
    thread,
    createdBy
  );

  for (const comment of thread.comments) {
    await commentsService.upsertCommentFromLiveblocks(
      organizationId,
      thread.id,
      comment
    );
  }

  log.info("[webhook/liveblocks] Synced thread", {
    threadId,
    commentCount: thread.comments.length,
  });
}

export function handleCommentCreated(
  event: CommentCreatedEvent
): Promise<void> {
  return upsertCommment(event);
}

export function handleCommentEdited(event: CommentEditedEvent): Promise<void> {
  return upsertCommment(event);
}

async function upsertCommment(
  event: CommentCreatedEvent | CommentEditedEvent
): Promise<void> {
  const { roomId, threadId, commentId } = event.data;
  const organizationId = getOrganizationId(roomId);
  if (!organizationId) {
    log.info("[webhook/liveblocks] Skipping non-artifact room", { roomId });
    return;
  }

  const client = requireApiClient();

  // Thread-first upsert: ensure parent thread exists
  const thread = await client.getThread({ roomId, threadId });
  await commentsService.upsertThreadFromLiveblocks(organizationId, thread);

  const comment = await client.getComment({ roomId, threadId, commentId });
  await commentsService.upsertCommentFromLiveblocks(
    organizationId,
    threadId,
    comment
  );

  log.info("[webhook/liveblocks] Synced comment", { threadId, commentId });
}

export async function handleCommentDeleted(
  event: CommentDeletedEvent
): Promise<void> {
  const { roomId, commentId } = event.data;
  const organizationId = getOrganizationId(roomId);
  if (!organizationId) {
    log.info("[webhook/liveblocks] Skipping non-artifact room", { roomId });
    return;
  }

  await commentsService.softDeleteComment(organizationId, commentId);

  log.info("[webhook/liveblocks] Soft-deleted comment", { commentId });
}

export async function handleCommentReactionAdded(
  event: CommentReactionAdded
): Promise<void> {
  const { roomId, threadId, commentId } = event.data;
  const organizationId = getOrganizationId(roomId);
  if (!organizationId) {
    log.info("[webhook/liveblocks] Skipping non-artifact room", { roomId });
    return;
  }

  const client = requireApiClient();
  const comment = await client.getComment({ roomId, threadId, commentId });
  await commentsService.upsertCommentFromLiveblocks(
    organizationId,
    threadId,
    comment
  );

  log.info("[webhook/liveblocks] Synced reaction added", {
    threadId,
    commentId,
  });
}

export async function handleCommentReactionRemoved(
  event: CommentReactionRemoved
): Promise<void> {
  const { roomId, threadId, commentId } = event.data;
  const organizationId = getOrganizationId(roomId);
  if (!organizationId) {
    log.info("[webhook/liveblocks] Skipping non-artifact room", { roomId });
    return;
  }

  const client = requireApiClient();
  const comment = await client.getComment({ roomId, threadId, commentId });
  await commentsService.upsertCommentFromLiveblocks(
    organizationId,
    threadId,
    comment
  );

  log.info("[webhook/liveblocks] Synced reaction removed", {
    threadId,
    commentId,
  });
}

export async function handleThreadDeleted(
  event: ThreadDeletedEvent
): Promise<void> {
  const { roomId, threadId } = event.data;
  const organizationId = getOrganizationId(roomId);
  if (!organizationId) {
    log.info("[webhook/liveblocks] Skipping non-artifact room", { roomId });
    return;
  }

  const { count } = await commentsService.deleteThread(
    organizationId,
    threadId
  );
  log.info("[webhook/liveblocks] Deleted thread", { threadId, count });
}

export async function handleThreadResolved(
  event: ThreadMarkedAsResolvedEvent
): Promise<void> {
  const { roomId, threadId, updatedAt } = event.data;
  const organizationId = getOrganizationId(roomId);
  if (!organizationId) {
    log.info("[webhook/liveblocks] Skipping non-artifact room", { roomId });
    return;
  }

  const client = requireApiClient();

  // Thread-first upsert: ensure thread exists before updating status
  const thread = await client.getThread({ roomId, threadId });
  await commentsService.upsertThreadFromLiveblocks(organizationId, thread);

  const resolvedAt = updatedAt ? new Date(updatedAt) : new Date();
  await commentsService.resolveThread(organizationId, threadId, resolvedAt);

  log.info("[webhook/liveblocks] Resolved thread", { threadId });
}

export async function handleThreadUnresolved(
  event: ThreadMarkedAsUnresolvedEvent
): Promise<void> {
  const { roomId, threadId } = event.data;
  const organizationId = getOrganizationId(roomId);
  if (!organizationId) {
    log.info("[webhook/liveblocks] Skipping non-artifact room", { roomId });
    return;
  }

  const client = requireApiClient();

  // Thread-first upsert: ensure thread exists before updating status
  const thread = await client.getThread({ roomId, threadId });
  await commentsService.upsertThreadFromLiveblocks(organizationId, thread);
  await commentsService.unresolveThread(organizationId, threadId);

  log.info("[webhook/liveblocks] Unresolved thread", { threadId });
}

function getOrganizationId(roomId: string): string | null {
  try {
    const { organizationId } = parseArtifactRoomId(roomId);
    return organizationId;
  } catch {
    return null;
  }
}

function requireApiClient() {
  const client = getLiveblocksApiClient();
  if (!client) {
    throw new Error("Liveblocks API client not configured");
  }
  return client;
}
