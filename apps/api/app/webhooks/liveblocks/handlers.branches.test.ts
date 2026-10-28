import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/collaboration/server/webhook", () => ({
  getLiveblocksApiClient: vi.fn(),
}));

vi.mock("@repo/collaboration/server/room-management", () => ({
  markArtifactThreadResolved: vi.fn(),
  markArtifactThreadUnresolved: vi.fn(),
}));

vi.mock("@repo/collaboration/shared/room-utils", () => ({
  parseArtifactRoomId: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("@/app/comments/service", () => ({
  commentsService: {
    deleteThread: vi.fn(),
    getThreadAuthorship: vi.fn(),
    resolveThread: vi.fn(),
    softDeleteComment: vi.fn(),
    unresolveThread: vi.fn(),
    upsertCommentFromLiveblocks: vi.fn(),
    upsertThreadFromLiveblocks: vi.fn(),
  },
}));

vi.mock("@/app/comments/service/comment-store-switch", () => ({
  isDocumentCommentsSwitchLatched: vi.fn(),
}));

import {
  markArtifactThreadResolved,
  markArtifactThreadUnresolved,
} from "@repo/collaboration/server/room-management";
import { getLiveblocksApiClient } from "@repo/collaboration/server/webhook";
import { parseArtifactRoomId } from "@repo/collaboration/shared/room-utils";
import { log } from "@repo/observability/log";
import {
  commentDeletedEvent,
  commentEditedEvent,
  commentReactionAddedEvent,
  commentReactionRemovedEvent,
  LIVEBLOCKS_COMMENT_ID,
  LIVEBLOCKS_ORG_ID,
  LIVEBLOCKS_ROOM_ID,
  LIVEBLOCKS_THREAD_ID,
  threadDeletedEvent,
  threadResolvedEvent,
  threadUnresolvedEvent,
} from "@/__tests__/support/webhooks/liveblocks/liveblocks-events.test-fixtures";
import { commentsService } from "@/app/comments/service";
import { isDocumentCommentsSwitchLatched } from "@/app/comments/service/comment-store-switch";
import {
  handleCommentDeleted,
  handleCommentEdited,
  handleCommentReactionAdded,
  handleCommentReactionRemoved,
  handleThreadDeleted,
  handleThreadResolved,
  handleThreadUnresolved,
} from "@/app/webhooks/liveblocks/handlers";
import { LiveblocksWebhookOutcome } from "@/app/webhooks/liveblocks/webhook-outcome";

const NON_ARTIFACT_ROOM_ID = "presence-room";
const SYSTEM_NOW = new Date("2026-09-01T12:00:00.000Z");
const PROVIDER_UPDATED_AT = new Date("2025-06-02T00:00:00.000Z");
const STALE_EVENT_UPDATED_AT = "2025-06-01T00:00:00.000Z";

const COMMENTS_SERVICE_METHODS = [
  "deleteThread",
  "getThreadAuthorship",
  "resolveThread",
  "softDeleteComment",
  "unresolveThread",
  "upsertCommentFromLiveblocks",
  "upsertThreadFromLiveblocks",
] as const;

const PROVIDER_COMMENT = {
  id: LIVEBLOCKS_COMMENT_ID,
  threadId: LIVEBLOCKS_THREAD_ID,
  roomId: LIVEBLOCKS_ROOM_ID,
  userId: "user-2",
};

const mockClient = {
  getComment: vi.fn(),
  getThread: vi.fn(),
};

function providerThread(overrides: {
  resolved: boolean;
  updatedAt: Date | undefined;
  comments?: { userId: string }[];
}) {
  return {
    id: LIVEBLOCKS_THREAD_ID,
    roomId: LIVEBLOCKS_ROOM_ID,
    comments: overrides.comments ?? [],
    resolved: overrides.resolved,
    updatedAt: overrides.updatedAt,
  };
}

beforeEach(() => {
  vi.mocked(parseArtifactRoomId).mockImplementation((roomId: string) => {
    if (roomId !== LIVEBLOCKS_ROOM_ID) {
      throw new Error("Invalid room ID format");
    }
    return { organizationId: LIVEBLOCKS_ORG_ID, slug: "my-artifact" };
  });
  vi.mocked(getLiveblocksApiClient).mockReturnValue(mockClient as never);
  mockClient.getComment.mockResolvedValue(PROVIDER_COMMENT);
  vi.mocked(isDocumentCommentsSwitchLatched).mockResolvedValue(false);
});

describe("non-artifact room guard", () => {
  it.each([
    [
      "handleCommentEdited",
      () => handleCommentEdited(commentEditedEvent(NON_ARTIFACT_ROOM_ID)),
    ],
    [
      "handleCommentDeleted",
      () => handleCommentDeleted(commentDeletedEvent(NON_ARTIFACT_ROOM_ID)),
    ],
    [
      "handleCommentReactionAdded",
      () =>
        handleCommentReactionAdded(
          commentReactionAddedEvent(NON_ARTIFACT_ROOM_ID)
        ),
    ],
    [
      "handleCommentReactionRemoved",
      () =>
        handleCommentReactionRemoved(
          commentReactionRemovedEvent(NON_ARTIFACT_ROOM_ID)
        ),
    ],
    [
      "handleThreadDeleted",
      () => handleThreadDeleted(threadDeletedEvent(NON_ARTIFACT_ROOM_ID)),
    ],
    [
      "handleThreadResolved",
      () =>
        handleThreadResolved(
          threadResolvedEvent({ roomId: NON_ARTIFACT_ROOM_ID })
        ),
    ],
    [
      "handleThreadUnresolved",
      () =>
        handleThreadUnresolved(
          threadUnresolvedEvent({ roomId: NON_ARTIFACT_ROOM_ID })
        ),
    ],
  ])("%s ignores a room that is not an artifact room", async (_name, run) => {
    await expect(run()).resolves.toBe(LiveblocksWebhookOutcome.Processed);

    expect(parseArtifactRoomId).toHaveBeenCalledWith(NON_ARTIFACT_ROOM_ID);
    expect(getLiveblocksApiClient).not.toHaveBeenCalled();
    for (const method of COMMENTS_SERVICE_METHODS) {
      expect(commentsService[method]).not.toHaveBeenCalled();
    }
    expect(markArtifactThreadResolved).not.toHaveBeenCalled();
    expect(markArtifactThreadUnresolved).not.toHaveBeenCalled();
  });
});

describe("artifact room projections", () => {
  it("soft-deletes the comment in the parsed organization", async () => {
    await handleCommentDeleted(commentDeletedEvent());

    expect(commentsService.softDeleteComment).toHaveBeenCalledWith(
      LIVEBLOCKS_ORG_ID,
      LIVEBLOCKS_COMMENT_ID
    );
  });

  it("deletes the thread in the parsed organization", async () => {
    await handleThreadDeleted(threadDeletedEvent());

    expect(commentsService.deleteThread).toHaveBeenCalledWith(
      LIVEBLOCKS_ORG_ID,
      LIVEBLOCKS_THREAD_ID
    );
  });

  it.each([
    [
      "handleCommentReactionAdded",
      () => handleCommentReactionAdded(commentReactionAddedEvent()),
    ],
    [
      "handleCommentReactionRemoved",
      () => handleCommentReactionRemoved(commentReactionRemovedEvent()),
    ],
  ])(
    "%s re-projects the provider comment without a thread fetch",
    async (_name, run) => {
      await run();

      expect(mockClient.getComment).toHaveBeenCalledWith({
        roomId: LIVEBLOCKS_ROOM_ID,
        threadId: LIVEBLOCKS_THREAD_ID,
        commentId: LIVEBLOCKS_COMMENT_ID,
      });
      expect(commentsService.upsertCommentFromLiveblocks).toHaveBeenCalledWith(
        LIVEBLOCKS_ORG_ID,
        LIVEBLOCKS_THREAD_ID,
        PROVIDER_COMMENT
      );
      expect(mockClient.getThread).not.toHaveBeenCalled();
      expect(commentsService.upsertThreadFromLiveblocks).not.toHaveBeenCalled();
    }
  );
});

describe("thread resolve/unresolve reconciliation", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(SYSTEM_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reopens a non-participant resolve as the resolver when the only participant comes from the provider payload", async () => {
    // No projected creator, so authorId stays null, but the provider comment
    // makes the participant set non-empty and the guard applies.
    mockClient.getThread.mockResolvedValue(
      providerThread({
        resolved: true,
        updatedAt: PROVIDER_UPDATED_AT,
        comments: [{ userId: "replier-2" }],
      })
    );
    vi.mocked(commentsService.getThreadAuthorship).mockResolvedValue({
      authorId: null,
      participantIds: new Set<string>(),
    });

    await handleThreadResolved(
      threadResolvedEvent({
        updatedAt: PROVIDER_UPDATED_AT.toISOString(),
        updatedBy: "outsider-3",
      })
    );

    // pins current behavior; looks odd because the reopen is attributed to the
    // same actor whose resolve is being rejected (authorId ?? updatedBy).
    expect(markArtifactThreadUnresolved).toHaveBeenCalledWith({
      roomId: LIVEBLOCKS_ROOM_ID,
      threadId: LIVEBLOCKS_THREAD_ID,
      userId: "outsider-3",
    });
    expect(commentsService.unresolveThread).toHaveBeenCalledWith(
      LIVEBLOCKS_ORG_ID,
      LIVEBLOCKS_THREAD_ID
    );
    expect(commentsService.resolveThread).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      "[webhook/liveblocks] Rejected non-participant thread resolution, reopened",
      { threadId: LIVEBLOCKS_THREAD_ID, resolver: "outsider-3", authorId: null }
    );
  });

  it("preserves the resolve of a legacy thread with no attributable participant", async () => {
    // No projected creator, no projected comments, no provider comments: the
    // participant set is empty, so no violation can be proven.
    mockClient.getThread.mockResolvedValue(
      providerThread({ resolved: true, updatedAt: PROVIDER_UPDATED_AT })
    );
    vi.mocked(commentsService.getThreadAuthorship).mockResolvedValue({
      authorId: null,
      participantIds: new Set<string>(),
    });

    await handleThreadResolved(
      threadResolvedEvent({
        updatedAt: PROVIDER_UPDATED_AT.toISOString(),
        updatedBy: "outsider-3",
      })
    );

    expect(commentsService.getThreadAuthorship).toHaveBeenCalledWith(
      LIVEBLOCKS_ORG_ID,
      LIVEBLOCKS_THREAD_ID
    );
    expect(commentsService.resolveThread).toHaveBeenCalledWith(
      LIVEBLOCKS_ORG_ID,
      LIVEBLOCKS_THREAD_ID,
      PROVIDER_UPDATED_AT,
      { resolvedById: "outsider-3" }
    );
    expect(markArtifactThreadUnresolved).not.toHaveBeenCalled();
    expect(commentsService.unresolveThread).not.toHaveBeenCalled();
  });

  it("stamps an authorized resolve with the current time when the event updatedAt is empty", async () => {
    mockClient.getThread.mockResolvedValue(
      providerThread({ resolved: true, updatedAt: PROVIDER_UPDATED_AT })
    );
    vi.mocked(commentsService.getThreadAuthorship).mockResolvedValue({
      authorId: "user-1",
      participantIds: new Set(["user-1"]),
    });

    await handleThreadResolved(
      threadResolvedEvent({ updatedAt: "", updatedBy: "user-1" })
    );

    // An empty event timestamp cannot prove supersession, so authorization
    // runs and the resolve is stamped at receipt time.
    expect(commentsService.getThreadAuthorship).toHaveBeenCalledWith(
      LIVEBLOCKS_ORG_ID,
      LIVEBLOCKS_THREAD_ID
    );
    expect(commentsService.resolveThread).toHaveBeenCalledWith(
      LIVEBLOCKS_ORG_ID,
      LIVEBLOCKS_THREAD_ID,
      SYSTEM_NOW,
      { resolvedById: "user-1" }
    );
    expect(markArtifactThreadUnresolved).not.toHaveBeenCalled();
  });

  it("mirrors a provider-resolved thread at receipt time when the provider omits updatedAt", async () => {
    const thread = providerThread({ resolved: true, updatedAt: undefined });
    mockClient.getThread.mockResolvedValue(thread);

    await handleThreadUnresolved(threadUnresolvedEvent());

    expect(mockClient.getThread).toHaveBeenCalledWith({
      roomId: LIVEBLOCKS_ROOM_ID,
      threadId: LIVEBLOCKS_THREAD_ID,
    });
    expect(commentsService.upsertThreadFromLiveblocks).toHaveBeenCalledWith(
      LIVEBLOCKS_ORG_ID,
      thread
    );
    expect(commentsService.resolveThread).toHaveBeenCalledWith(
      LIVEBLOCKS_ORG_ID,
      LIVEBLOCKS_THREAD_ID,
      SYSTEM_NOW
    );
    expect(commentsService.unresolveThread).not.toHaveBeenCalled();
    expect(commentsService.getThreadAuthorship).not.toHaveBeenCalled();
  });

  it("mirrors a superseded unresolve without authorizing its actor", async () => {
    mockClient.getThread.mockResolvedValue(
      providerThread({ resolved: false, updatedAt: PROVIDER_UPDATED_AT })
    );

    await handleThreadUnresolved(
      threadUnresolvedEvent({
        updatedAt: STALE_EVENT_UPDATED_AT,
        updatedBy: "replier-2",
      })
    );

    expect(commentsService.unresolveThread).toHaveBeenCalledWith(
      LIVEBLOCKS_ORG_ID,
      LIVEBLOCKS_THREAD_ID
    );
    expect(commentsService.getThreadAuthorship).not.toHaveBeenCalled();
    expect(markArtifactThreadResolved).not.toHaveBeenCalled();
    expect(commentsService.resolveThread).not.toHaveBeenCalled();
  });

  it("re-resolves a non-author reopen at receipt time when the provider omits updatedAt", async () => {
    mockClient.getThread.mockResolvedValue(
      providerThread({ resolved: false, updatedAt: undefined })
    );
    vi.mocked(commentsService.getThreadAuthorship).mockResolvedValue({
      authorId: "author-1",
      participantIds: new Set(["author-1", "replier-2"]),
    });

    await handleThreadUnresolved(
      threadUnresolvedEvent({ updatedBy: "replier-2" })
    );

    // A missing provider timestamp cannot prove supersession, so the author-only
    // reopen check still runs.
    expect(markArtifactThreadResolved).toHaveBeenCalledWith({
      roomId: LIVEBLOCKS_ROOM_ID,
      threadId: LIVEBLOCKS_THREAD_ID,
      userId: "author-1",
    });
    expect(commentsService.resolveThread).toHaveBeenCalledWith(
      LIVEBLOCKS_ORG_ID,
      LIVEBLOCKS_THREAD_ID,
      SYSTEM_NOW
    );
    expect(commentsService.unresolveThread).not.toHaveBeenCalled();
  });

  it("runs the author check when the event updatedAt is unparseable", async () => {
    mockClient.getThread.mockResolvedValue(
      providerThread({ resolved: false, updatedAt: PROVIDER_UPDATED_AT })
    );
    vi.mocked(commentsService.getThreadAuthorship).mockResolvedValue({
      authorId: "author-1",
      participantIds: new Set(["author-1", "replier-2"]),
    });

    await handleThreadUnresolved(
      threadUnresolvedEvent({ updatedAt: "not-a-date", updatedBy: "replier-2" })
    );

    expect(markArtifactThreadResolved).toHaveBeenCalledWith({
      roomId: LIVEBLOCKS_ROOM_ID,
      threadId: LIVEBLOCKS_THREAD_ID,
      userId: "author-1",
    });
    expect(commentsService.resolveThread).toHaveBeenCalledWith(
      LIVEBLOCKS_ORG_ID,
      LIVEBLOCKS_THREAD_ID,
      PROVIDER_UPDATED_AT
    );
    expect(commentsService.unresolveThread).not.toHaveBeenCalled();
  });
});
