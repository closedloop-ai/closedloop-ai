import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/collaboration/server/webhook", () => ({
  createWebhookHandler: vi.fn(),
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
  log: {
    debug: vi.fn(),
    error: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("@/lib/route-utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/route-utils")>()),
  logRequestCompleted: vi.fn(),
  scheduleLogFlush: vi.fn(),
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
  resolveAndLatchDocumentCommentsSwitch: vi.fn(),
}));

import {
  markArtifactThreadResolved,
  markArtifactThreadUnresolved,
} from "@repo/collaboration/server/room-management";
import {
  createWebhookHandler,
  getLiveblocksApiClient,
} from "@repo/collaboration/server/webhook";
import { parseArtifactRoomId } from "@repo/collaboration/shared/room-utils";
import { log } from "@repo/observability/log";
import {
  commentCreatedEvent,
  commentDeletedEvent,
  commentEditedEvent,
  commentReactionAddedEvent,
  commentReactionRemovedEvent,
  LIVEBLOCKS_ORG_ID,
  LIVEBLOCKS_ROOM_ID,
  LIVEBLOCKS_THREAD_ID,
  threadCreatedEvent,
  threadDeletedEvent,
  threadResolvedEvent,
  threadUnresolvedEvent,
} from "@/__tests__/support/webhooks/liveblocks/liveblocks-events.test-fixtures";
import { commentsService } from "@/app/comments/service";
import {
  isDocumentCommentsSwitchLatched,
  resolveAndLatchDocumentCommentsSwitch,
} from "@/app/comments/service/comment-store-switch";
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
  LIVEBLOCKS_EVENT_AFTER_SWITCH_EVENT,
} from "@/app/webhooks/liveblocks/handlers";
import { POST } from "@/app/webhooks/liveblocks/route";
import { LiveblocksWebhookOutcome } from "@/app/webhooks/liveblocks/webhook-outcome";

const mockClient = {
  getComment: vi.fn(),
  getThread: vi.fn(),
};

const CASES = [
  ["threadCreated", () => handleThreadCreated(threadCreatedEvent())],
  ["commentCreated", () => handleCommentCreated(commentCreatedEvent())],
  ["commentEdited", () => handleCommentEdited(commentEditedEvent())],
  ["commentDeleted", () => handleCommentDeleted(commentDeletedEvent())],
  [
    "commentReactionAdded",
    () => handleCommentReactionAdded(commentReactionAddedEvent()),
  ],
  [
    "commentReactionRemoved",
    () => handleCommentReactionRemoved(commentReactionRemovedEvent()),
  ],
  ["threadDeleted", () => handleThreadDeleted(threadDeletedEvent())],
  ["threadMarkedAsResolved", () => handleThreadResolved(threadResolvedEvent())],
  [
    "threadMarkedAsUnresolved",
    () => handleThreadUnresolved(threadUnresolvedEvent()),
  ],
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(parseArtifactRoomId).mockReturnValue({
    organizationId: LIVEBLOCKS_ORG_ID,
    slug: "my-artifact",
  });
  vi.mocked(getLiveblocksApiClient).mockReturnValue(mockClient as never);
  mockClient.getThread.mockResolvedValue({
    id: LIVEBLOCKS_THREAD_ID,
    roomId: LIVEBLOCKS_ROOM_ID,
    comments: [],
    resolved: false,
    updatedAt: undefined,
  });
  mockClient.getComment.mockResolvedValue({ id: "cm_1" });
  vi.mocked(commentsService.getThreadAuthorship).mockResolvedValue({
    authorId: null,
    participantIds: new Set<string>(),
  });
  // The flag would read on for every org here; only the latch may decide.
  vi.mocked(resolveAndLatchDocumentCommentsSwitch).mockResolvedValue(true);
});

function liveblocksRequest(event: unknown): Request {
  return new Request("http://localhost:3002/webhooks/liveblocks", {
    method: "POST",
    body: JSON.stringify(event),
    headers: {
      "content-type": "application/json",
      "webhook-id": "msg_123",
      "webhook-timestamp": "1614588800000",
      "webhook-signature": "v1,test",
    },
  });
}

describe("Liveblocks thread and comment events for a switched org", () => {
  it.each(CASES)(
    "drops %s without projecting it or calling Liveblocks",
    async (eventType, run) => {
      vi.mocked(isDocumentCommentsSwitchLatched).mockResolvedValue(true);

      await expect(run()).resolves.toBe(LiveblocksWebhookOutcome.Ignored);

      expect(isDocumentCommentsSwitchLatched).toHaveBeenCalledWith(
        LIVEBLOCKS_ORG_ID
      );
      expect(resolveAndLatchDocumentCommentsSwitch).not.toHaveBeenCalled();
      for (const method of Object.values(commentsService)) {
        expect(method).not.toHaveBeenCalled();
      }
      expect(mockClient.getThread).not.toHaveBeenCalled();
      expect(mockClient.getComment).not.toHaveBeenCalled();
      expect(markArtifactThreadResolved).not.toHaveBeenCalled();
      expect(markArtifactThreadUnresolved).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledTimes(1);
      expect(log.warn).toHaveBeenCalledWith(
        LIVEBLOCKS_EVENT_AFTER_SWITCH_EVENT,
        {
          event: LIVEBLOCKS_EVENT_AFTER_SWITCH_EVENT,
          organizationId: LIVEBLOCKS_ORG_ID,
          eventType,
          roomId: LIVEBLOCKS_ROOM_ID,
          threadId: LIVEBLOCKS_THREAD_ID,
        }
      );
    }
  );

  it.each(CASES)(
    "projects %s for an org whose flag reads on but has no latch, without latching it",
    async (_eventType, run) => {
      vi.mocked(isDocumentCommentsSwitchLatched).mockResolvedValue(false);

      await expect(run()).resolves.toBe(LiveblocksWebhookOutcome.Processed);

      expect(resolveAndLatchDocumentCommentsSwitch).not.toHaveBeenCalled();
      const projected = Object.values(commentsService).some(
        (method) => vi.mocked(method).mock.calls.length > 0
      );
      expect(projected).toBe(true);
      expect(log.warn).not.toHaveBeenCalledWith(
        LIVEBLOCKS_EVENT_AFTER_SWITCH_EVENT,
        expect.anything()
      );
    }
  );

  it("does not look up the switch for a room that is not an artifact room", async () => {
    vi.mocked(parseArtifactRoomId).mockImplementation(() => {
      throw new Error("Invalid room ID format");
    });

    await handleCommentDeleted(commentDeletedEvent("presence-room"));

    expect(isDocumentCommentsSwitchLatched).not.toHaveBeenCalled();
    expect(resolveAndLatchDocumentCommentsSwitch).not.toHaveBeenCalled();
  });
});

describe("the Liveblocks webhook route for a switched org", () => {
  it("answers a dropped event with the success it gives a projected one and logs it once as ignored", async () => {
    vi.mocked(isDocumentCommentsSwitchLatched).mockResolvedValue(true);
    const event = commentCreatedEvent();
    vi.mocked(createWebhookHandler).mockReturnValue({
      verifyRequest: vi.fn().mockReturnValue(event),
    } as never);

    const response = await POST(liveblocksRequest(event));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      message: "Event processed",
      ok: true,
    });
    expect(commentsService.upsertCommentFromLiveblocks).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      "[webhook/liveblocks] Event handled",
      {
        eventType: event.type,
        outcome: LiveblocksWebhookOutcome.Ignored,
        provider: "liveblocks",
      }
    );
  });

  it("logs a projected event once as processed", async () => {
    vi.mocked(isDocumentCommentsSwitchLatched).mockResolvedValue(false);
    const event = commentCreatedEvent();
    vi.mocked(createWebhookHandler).mockReturnValue({
      verifyRequest: vi.fn().mockReturnValue(event),
    } as never);

    const response = await POST(liveblocksRequest(event));

    expect(response.status).toBe(200);
    expect(commentsService.upsertThreadFromLiveblocks).toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      "[webhook/liveblocks] Event handled",
      {
        eventType: event.type,
        outcome: LiveblocksWebhookOutcome.Processed,
        provider: "liveblocks",
      }
    );
  });

  it("leaves storage events alone and never consults the switch", async () => {
    vi.mocked(isDocumentCommentsSwitchLatched).mockResolvedValue(true);
    const event = {
      type: "storageUpdated",
      data: { roomId: LIVEBLOCKS_ROOM_ID },
    };
    vi.mocked(createWebhookHandler).mockReturnValue({
      verifyRequest: vi.fn().mockReturnValue(event),
    } as never);

    const response = await POST(
      new Request("http://localhost:3002/webhooks/liveblocks", {
        method: "POST",
        body: JSON.stringify(event),
      })
    );

    expect(response.status).toBe(200);
    expect(isDocumentCommentsSwitchLatched).not.toHaveBeenCalled();
    expect(resolveAndLatchDocumentCommentsSwitch).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });
});
