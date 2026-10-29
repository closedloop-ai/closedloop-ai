import {
  GitHubCommentThreadKind,
  PullRequestCommentLane,
  PullRequestCommentLaneStatus,
} from "@repo/database/generated/enums";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockWithDbCall } from "../utils/db-helpers";

vi.mock("@repo/collaboration/server/webhook", () => ({
  createWebhookHandler: vi.fn(),
  getLiveblocksApiClient: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("@repo/collaboration/shared/room-utils", () => {
  // The handlers parse through the legacy alias, the service through the new
  // name; one vi.fn() behind both keeps them on the same room.
  const parseDocumentRoomId = vi.fn();
  return {
    parseArtifactRoomId: parseDocumentRoomId,
    parseDocumentRoomId,
    generateDocumentRoomId: vi.fn(),
  };
});

vi.mock("@repo/database", () => ({
  GitHubCommentThreadKind,
  PullRequestCommentLane,
  PullRequestCommentLaneStatus,

  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  Prisma: { JsonNull: "DbNull" },
}));

vi.mock("@/app/comments/service/comment-store-switch", () => ({
  isDocumentCommentsSwitchLatched: vi.fn(),
}));

import { getLiveblocksApiClient } from "@repo/collaboration/server/webhook";
import { parseDocumentRoomId } from "@repo/collaboration/shared/room-utils";
import { log } from "@repo/observability/log";
import { isDocumentCommentsSwitchLatched } from "@/app/comments/service/comment-store-switch";
import {
  handleCommentCreated,
  handleThreadCreated,
} from "@/app/webhooks/liveblocks/handlers";

const ORG_ID = "org-123";
const ROOM_ID = `${ORG_ID}:artifact:deleted-artifact`;
const ARTIFACT_ROOM_ID = `${ORG_ID}:artifact:my-artifact`;
const ROOM_ARTIFACT = { id: "artifact-1", document: null };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(isDocumentCommentsSwitchLatched).mockResolvedValue(false);
});

describe("handleThreadCreated for a room whose artifact is gone", () => {
  it("stores none of the thread's comments when the thread was not stored", async () => {
    vi.mocked(parseDocumentRoomId).mockReturnValue({
      organizationId: ORG_ID,
      slug: "deleted-artifact",
    });
    const mockDb = {
      artifact: { findUnique: vi.fn().mockResolvedValue(null) },
      commentThread: { upsert: vi.fn(), findUnique: vi.fn() },
    };
    mockWithDbCall(mockDb);
    vi.mocked(getLiveblocksApiClient).mockReturnValue({
      getThread: vi.fn().mockResolvedValue({
        id: "th_1",
        roomId: ROOM_ID,
        createdAt: new Date(),
        updatedAt: new Date(),
        resolved: false,
        metadata: {},
        comments: [{ id: "cm_1", body: { version: 1, content: [] } }],
      }),
    } as never);

    await handleThreadCreated({
      type: "threadCreated",
      data: {
        projectId: "proj-1",
        roomId: ROOM_ID,
        threadId: "th_1",
        createdAt: "2025-01-01T00:00:00Z",
        createdBy: "user-1",
      },
    });

    expect(mockDb.commentThread.upsert).not.toHaveBeenCalled();
    expect(mockDb.commentThread.findUnique).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});

describe("handleCommentCreated", () => {
  it("fetches thread first then comment (thread-first upsert)", async () => {
    vi.mocked(parseDocumentRoomId).mockReturnValue({
      organizationId: ORG_ID,
      slug: "my-artifact",
    });

    const mockThread = {
      id: "th_1",
      roomId: ARTIFACT_ROOM_ID,
      createdAt: new Date(),
      updatedAt: new Date(),
      resolved: false,
      metadata: {},
      comments: [],
    };
    const mockComment = {
      id: "cm_1",
      threadId: "th_1",
      roomId: ARTIFACT_ROOM_ID,
      userId: "user-1",
      createdAt: new Date(),
      body: { version: 1, content: [] },
      reactions: [],
      attachments: [],
    };

    const mockClient = {
      getThread: vi.fn().mockResolvedValue(mockThread),
      getComment: vi.fn().mockResolvedValue(mockComment),
    };
    vi.mocked(getLiveblocksApiClient).mockReturnValue(mockClient as never);
    mockWithDbCall({
      artifact: { findUnique: vi.fn().mockResolvedValue(ROOM_ARTIFACT) },
      commentThread: {
        upsert: vi.fn().mockResolvedValue({ id: "db-th-1" }),
        findUnique: vi.fn().mockResolvedValue(null),
      },
    });

    await handleCommentCreated({
      type: "commentCreated",
      data: {
        projectId: "proj-1",
        roomId: ARTIFACT_ROOM_ID,
        threadId: "th_1",
        commentId: "cm_1",
        createdAt: "2025-01-01T00:00:00Z",
        createdBy: "user-1",
      },
    });

    // Thread fetched first
    expect(mockClient.getThread).toHaveBeenCalledWith({
      roomId: ARTIFACT_ROOM_ID,
      threadId: "th_1",
    });
    // Then comment
    expect(mockClient.getComment).toHaveBeenCalledWith({
      roomId: ARTIFACT_ROOM_ID,
      threadId: "th_1",
      commentId: "cm_1",
    });
  });
});
