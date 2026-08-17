import {
  markArtifactThreadResolved,
  markArtifactThreadUnresolved,
} from "@repo/collaboration/server/room-management";
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
} from "@repo/collaboration/server/webhook";
import { getLiveblocksApiClient } from "@repo/collaboration/server/webhook";
import { parseArtifactRoomId } from "@repo/collaboration/shared/room-utils";
import { log } from "@repo/observability/log";
import { commentsService } from "../../comments/service";
import { unionProviderParticipants } from "../../comments/thread-participants";

export async function handleThreadCreated(
  event: ThreadCreatedEvent
): Promise<void> {
  const { roomId, threadId, createdBy } = event.data;
  const organizationId = getOrganizationId(roomId);
  if (!organizationId) {
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
}

export async function handleCommentDeleted(
  event: CommentDeletedEvent
): Promise<void> {
  const { roomId, commentId } = event.data;
  const organizationId = getOrganizationId(roomId);
  if (!organizationId) {
    return;
  }

  await commentsService.softDeleteComment(organizationId, commentId);
}

export async function handleCommentReactionAdded(
  event: CommentReactionAdded
): Promise<void> {
  const { roomId, threadId, commentId } = event.data;
  const organizationId = getOrganizationId(roomId);
  if (!organizationId) {
    return;
  }

  const client = requireApiClient();
  const comment = await client.getComment({ roomId, threadId, commentId });
  await commentsService.upsertCommentFromLiveblocks(
    organizationId,
    threadId,
    comment
  );
}

export async function handleCommentReactionRemoved(
  event: CommentReactionRemoved
): Promise<void> {
  const { roomId, threadId, commentId } = event.data;
  const organizationId = getOrganizationId(roomId);
  if (!organizationId) {
    return;
  }

  const client = requireApiClient();
  const comment = await client.getComment({ roomId, threadId, commentId });
  await commentsService.upsertCommentFromLiveblocks(
    organizationId,
    threadId,
    comment
  );
}

export async function handleThreadDeleted(
  event: ThreadDeletedEvent
): Promise<void> {
  const { roomId, threadId } = event.data;
  const organizationId = getOrganizationId(roomId);
  if (!organizationId) {
    return;
  }

  await commentsService.deleteThread(organizationId, threadId);
}

export async function handleThreadResolved(
  event: ThreadMarkedAsResolvedEvent
): Promise<void> {
  const { roomId, threadId, updatedAt, updatedBy } = event.data;
  const organizationId = getOrganizationId(roomId);
  if (!organizationId) {
    return;
  }

  const client = requireApiClient();

  // Thread-first upsert: ensure thread exists before updating status. This also
  // projects `createdById` so the author lookup below can succeed on first
  // delivery.
  const thread = await client.getThread({ roomId, threadId });
  await commentsService.upsertThreadFromLiveblocks(organizationId, thread);

  // Reconcile from current provider state, not the event type: a resolve and a
  // later unresolve can commit in one order at Liveblocks and be delivered here
  // in the reverse order. `thread.resolved` is the source of truth as of this
  // fetch, so if the thread is no longer resolved a superseding unresolve
  // already won — mirror it and stop, instead of re-applying a stale resolve
  // that would leave Prisma opposite Liveblocks (FEA-3950).
  if (!thread.resolved) {
    await commentsService.unresolveThread(organizationId, threadId);
    return;
  }

  // Do not authorize a superseded event. `updatedBy` is the actor of *this*
  // resolve event, but a later transition may already have won at Liveblocks and
  // be reflected in the just-fetched `thread`. Consider the sequence
  // resolve(attacker) → unresolve(author) → resolve(participant), where the first
  // (attacker) event is delivered last: the fetched thread is `resolved` (from
  // the participant), yet `updatedBy` is the stale attacker. Authorizing the
  // attacker here would reopen the participant's legitimate resolution. The
  // event's `updatedAt` predating the provider thread's `updatedAt` proves a
  // newer write superseded this one, so we skip actor authorization and just
  // mirror the current (resolved) provider state (FEA-4092, wongk review).
  if (isSupersededEvent(updatedAt, thread.updatedAt)) {
    const resolvedAt = new Date(thread.updatedAt);
    await commentsService.resolveThread(organizationId, threadId, resolvedAt);
    return;
  }

  // Participant-resolve enforcement at the source-of-truth boundary (FEA-3950,
  // relaxed by FEA-4092). Every org user holds Liveblocks FULL_ACCESS to artifact
  // rooms, so a non-participant can resolve directly through the client SDK,
  // bypassing the REST participant guard. Liveblocks reports the resolving actor
  // as `updatedBy`; if it is neither the thread author nor a comment author on
  // the thread (a participant), reopen the thread at Liveblocks (the source of
  // truth) and project it as unresolved so the illegitimate resolve does not
  // stick. Derive the participant set from the DB projection unioned with the
  // just-fetched provider comments (`thread.comments`), so a reply-then-resolve
  // that beat the `commentCreated` projection still counts the replier as a
  // participant instead of reopening their valid resolution. When no participant
  // can be attributed (legacy thread with no projected creator or comments), we
  // cannot prove a violation, so the resolution is preserved. Reopen the thread
  // as the author when known so the reversal is attributed to a legitimate actor;
  // fall back to the resolving actor otherwise.
  const authorship = await commentsService.getThreadAuthorship(
    organizationId,
    threadId
  );
  const { authorId, participantIds } = unionProviderParticipants(
    authorship,
    thread.comments
  );
  if (participantIds.size > 0 && !participantIds.has(updatedBy)) {
    await markArtifactThreadUnresolved({
      roomId,
      threadId,
      userId: authorId ?? updatedBy,
    });
    await commentsService.unresolveThread(organizationId, threadId);
    log.warn(
      "[webhook/liveblocks] Rejected non-participant thread resolution, reopened",
      { threadId, resolver: updatedBy, authorId }
    );
    return;
  }

  const resolvedAt = updatedAt ? new Date(updatedAt) : new Date();
  await commentsService.resolveThread(organizationId, threadId, resolvedAt, {
    resolvedById: updatedBy,
  });
}

export async function handleThreadUnresolved(
  event: ThreadMarkedAsUnresolvedEvent
): Promise<void> {
  const { roomId, threadId, updatedAt, updatedBy } = event.data;
  const organizationId = getOrganizationId(roomId);
  if (!organizationId) {
    return;
  }

  const client = requireApiClient();

  // Thread-first upsert: ensure thread exists before updating status. This also
  // projects `createdById` so the author lookup below can succeed on first
  // delivery.
  const thread = await client.getThread({ roomId, threadId });
  await commentsService.upsertThreadFromLiveblocks(organizationId, thread);

  // Reconcile from current provider state (FEA-3950): if a later resolve has
  // already won at Liveblocks (delivered out of order), mirror that resolve
  // instead of re-applying a stale unresolve that would flip Prisma opposite
  // the source of truth. `updatedAt` on the unresolve event is not the resolver
  // attribution, so the resolve projection carries no resolvedById here — a
  // subsequent resolve webhook (or native resolve) backfills it.
  if (thread.resolved) {
    await commentsService.resolveThread(
      organizationId,
      threadId,
      thread.updatedAt ?? new Date()
    );
    return;
  }

  // Do not authorize a superseded event (symmetric with handleThreadResolved):
  // if this unresolve event predates the provider thread's current `updatedAt`, a
  // newer transition already won, so skip actor authorization and just mirror the
  // current (unresolved) provider state (FEA-4092, wongk review).
  if (isSupersededEvent(updatedAt, thread.updatedAt)) {
    await commentsService.unresolveThread(organizationId, threadId);
    return;
  }

  // Author-only reopen enforcement at the source-of-truth boundary (FEA-3950,
  // unchanged by FEA-4092). Reopen is author-only via REST, but every org user
  // holds Liveblocks FULL_ACCESS, so a non-author can unresolve directly through
  // the client SDK and bypass that REST guard. Liveblocks reports the reopening
  // actor as `updatedBy`; if it is not the thread author, re-resolve the thread
  // at Liveblocks (the source of truth) and project it resolved so the
  // illegitimate reopen does not stick. When the author cannot be determined
  // (legacy thread with no projected creator), we cannot prove a violation, so
  // the reopen is preserved. (wongk review)
  const { authorId } = await commentsService.getThreadAuthorship(
    organizationId,
    threadId
  );
  if (authorId !== null && updatedBy !== authorId) {
    await markArtifactThreadResolved({ roomId, threadId, userId: authorId });
    await commentsService.resolveThread(
      organizationId,
      threadId,
      thread.updatedAt ?? new Date()
    );
    log.warn(
      "[webhook/liveblocks] Rejected non-author thread reopen, re-resolved",
      { threadId, reopener: updatedBy, authorId }
    );
    return;
  }

  await commentsService.unresolveThread(organizationId, threadId);
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

/**
 * True when a resolve/unresolve webhook event has been superseded by a newer
 * transition — i.e. the event's own `updatedAt` is strictly older than the
 * provider thread's current `updatedAt` fetched in the same handler. When true,
 * the event's actor (`updatedBy`) is stale and must NOT drive actor
 * authorization; the handler mirrors the current provider state instead
 * (FEA-4092, wongk review). Fails toward "not superseded" (returns `false`) when
 * either timestamp is missing or unparseable, so an event with an unusable
 * timestamp still runs the authorization check rather than skipping it.
 */
function isSupersededEvent(
  eventUpdatedAt: string | undefined,
  providerUpdatedAt: Date | undefined
): boolean {
  if (!(eventUpdatedAt && providerUpdatedAt)) {
    return false;
  }
  const eventTime = new Date(eventUpdatedAt).getTime();
  const providerTime = providerUpdatedAt.getTime();
  if (Number.isNaN(eventTime) || Number.isNaN(providerTime)) {
    return false;
  }
  return eventTime < providerTime;
}
