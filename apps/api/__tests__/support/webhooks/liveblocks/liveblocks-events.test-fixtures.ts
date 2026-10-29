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

export const LIVEBLOCKS_ORG_ID = "org-123";
export const LIVEBLOCKS_ROOM_ID = `${LIVEBLOCKS_ORG_ID}:artifact:my-artifact`;
export const LIVEBLOCKS_THREAD_ID = "th_1";
export const LIVEBLOCKS_COMMENT_ID = "cm_1";

const PROJECT_ID = "proj-1";
const OCCURRED_AT = "2025-06-01T00:00:00.000Z";

export function threadCreatedEvent(roomId = LIVEBLOCKS_ROOM_ID) {
  return {
    type: "threadCreated",
    data: {
      projectId: PROJECT_ID,
      roomId,
      threadId: LIVEBLOCKS_THREAD_ID,
      createdAt: OCCURRED_AT,
      createdBy: "user-1",
    },
  } satisfies ThreadCreatedEvent;
}

export function commentCreatedEvent(roomId = LIVEBLOCKS_ROOM_ID) {
  return {
    type: "commentCreated",
    data: {
      projectId: PROJECT_ID,
      roomId,
      threadId: LIVEBLOCKS_THREAD_ID,
      commentId: LIVEBLOCKS_COMMENT_ID,
      createdAt: OCCURRED_AT,
      createdBy: "user-1",
    },
  } satisfies CommentCreatedEvent;
}

export function commentEditedEvent(roomId = LIVEBLOCKS_ROOM_ID) {
  return {
    type: "commentEdited",
    data: {
      projectId: PROJECT_ID,
      roomId,
      threadId: LIVEBLOCKS_THREAD_ID,
      commentId: LIVEBLOCKS_COMMENT_ID,
      editedAt: OCCURRED_AT,
    },
  } satisfies CommentEditedEvent;
}

export function commentDeletedEvent(roomId = LIVEBLOCKS_ROOM_ID) {
  return {
    type: "commentDeleted",
    data: {
      projectId: PROJECT_ID,
      roomId,
      threadId: LIVEBLOCKS_THREAD_ID,
      commentId: LIVEBLOCKS_COMMENT_ID,
      deletedAt: OCCURRED_AT,
    },
  } satisfies CommentDeletedEvent;
}

export function commentReactionAddedEvent(roomId = LIVEBLOCKS_ROOM_ID) {
  return {
    type: "commentReactionAdded",
    data: {
      projectId: PROJECT_ID,
      roomId,
      threadId: LIVEBLOCKS_THREAD_ID,
      commentId: LIVEBLOCKS_COMMENT_ID,
      emoji: "+1",
      addedAt: OCCURRED_AT,
      addedBy: "user-2",
    },
  } satisfies CommentReactionAdded;
}

export function commentReactionRemovedEvent(roomId = LIVEBLOCKS_ROOM_ID) {
  return {
    type: "commentReactionRemoved",
    data: {
      projectId: PROJECT_ID,
      roomId,
      threadId: LIVEBLOCKS_THREAD_ID,
      commentId: LIVEBLOCKS_COMMENT_ID,
      emoji: "+1",
      removedAt: OCCURRED_AT,
      removedBy: "user-2",
    },
  } satisfies CommentReactionRemoved;
}

export function threadDeletedEvent(roomId = LIVEBLOCKS_ROOM_ID) {
  return {
    type: "threadDeleted",
    data: {
      projectId: PROJECT_ID,
      roomId,
      threadId: LIVEBLOCKS_THREAD_ID,
      deletedAt: OCCURRED_AT,
    },
  } satisfies ThreadDeletedEvent;
}

export function threadResolvedEvent(
  overrides: Partial<ThreadMarkedAsResolvedEvent["data"]> = {}
) {
  return {
    type: "threadMarkedAsResolved",
    data: {
      projectId: PROJECT_ID,
      roomId: LIVEBLOCKS_ROOM_ID,
      threadId: LIVEBLOCKS_THREAD_ID,
      updatedAt: OCCURRED_AT,
      updatedBy: "user-1",
      ...overrides,
    },
  } satisfies ThreadMarkedAsResolvedEvent;
}

export function threadUnresolvedEvent(
  overrides: Partial<ThreadMarkedAsUnresolvedEvent["data"]> = {}
) {
  return {
    type: "threadMarkedAsUnresolved",
    data: {
      projectId: PROJECT_ID,
      roomId: LIVEBLOCKS_ROOM_ID,
      threadId: LIVEBLOCKS_THREAD_ID,
      updatedAt: OCCURRED_AT,
      updatedBy: "user-1",
      ...overrides,
    },
  } satisfies ThreadMarkedAsUnresolvedEvent;
}
