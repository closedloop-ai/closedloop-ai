/**
 * ISS-11212 (PLN-2120 Step 5): the Liveblocks projection no longer stores a
 * thread without an artifact, and it stamps `bodyFormat` on every comment.
 */
import {
  GitHubCommentThreadKind,
  PullRequestCommentLane,
  PullRequestCommentLaneStatus,
} from "@repo/database/generated/enums";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockWithDbCall, mockWithDbTx } from "../../__tests__/utils/db-helpers";

vi.mock("@repo/database", () => ({
  GitHubCommentThreadKind,
  PullRequestCommentLane,
  PullRequestCommentLaneStatus,

  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  Prisma: { JsonNull: "DbNull" },
}));

vi.mock("@repo/collaboration/shared/room-utils", () => ({
  parseDocumentRoomId: vi.fn(),
  generateDocumentRoomId: vi.fn(),
}));

vi.mock("@repo/collaboration/server/webhook", () => ({
  getLiveblocksApiClient: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { CommentBodyFormat } from "@repo/api/src/types/comment-thread-dto";
import type {
  CommentData,
  ThreadData,
} from "@repo/collaboration/server/webhook";
import { parseDocumentRoomId } from "@repo/collaboration/shared/room-utils";
import { log } from "@repo/observability/log";
import {
  COMMENTS_DATA_INVALID_EVENT,
  CommentDataInvalidReason,
} from "@/app/comments/comment-data-invalid";
import { commentsService } from "@/app/comments/service";

const ORG_ID = "org-123";
const THREAD_ID = "th_abc";
const ROOM_ID = `${ORG_ID}:artifact:my-artifact`;

function makeThread(overrides?: Partial<ThreadData>): ThreadData {
  return {
    type: "thread",
    id: THREAD_ID,
    roomId: ROOM_ID,
    createdAt: new Date("2025-01-01"),
    updatedAt: new Date("2025-01-01"),
    resolved: false,
    metadata: {},
    comments: [],
    ...overrides,
  } as ThreadData;
}

function makeComment(): CommentData {
  return {
    type: "comment",
    id: "cm_xyz",
    threadId: THREAD_ID,
    roomId: ROOM_ID,
    userId: "user-1",
    createdAt: new Date("2025-01-01"),
    body: {
      version: 1,
      content: [{ type: "paragraph", children: [{ text: "Hello" }] }],
    },
    reactions: [],
    attachments: [],
    metadata: {},
  } as CommentData;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(parseDocumentRoomId).mockReturnValue({
    organizationId: ORG_ID,
    slug: "my-artifact",
  });
});

describe("upsertThreadFromLiveblocks", () => {
  it("writes no thread for a non-artifact room and reports it (ISS-11212)", async () => {
    vi.mocked(parseDocumentRoomId).mockImplementation(() => {
      throw new Error("Invalid room ID format");
    });

    const mockDb = {
      commentThread: { upsert: vi.fn().mockResolvedValue({ id: "db-th-1" }) },
    };
    mockWithDbCall(mockDb);

    const result = await commentsService.upsertThreadFromLiveblocks(
      ORG_ID,
      makeThread({ roomId: "some-other-room" })
    );

    expect(result).toBeNull();
    expect(mockDb.commentThread.upsert).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(COMMENTS_DATA_INVALID_EVENT, {
      event: COMMENTS_DATA_INVALID_EVENT,
      reason: CommentDataInvalidReason.ThreadWithoutArtifact,
      organizationId: ORG_ID,
      threadId: THREAD_ID,
      roomId: "some-other-room",
    });
  });

  it("writes no thread when no artifact matches the room's slug (ISS-11212)", async () => {
    const mockDb = {
      commentThread: { upsert: vi.fn().mockResolvedValue({ id: "db-th-1" }) },
      artifact: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    mockWithDbCall(mockDb);

    const result = await commentsService.upsertThreadFromLiveblocks(
      ORG_ID,
      makeThread()
    );

    expect(result).toBeNull();
    expect(mockDb.commentThread.upsert).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(COMMENTS_DATA_INVALID_EVENT, {
      event: COMMENTS_DATA_INVALID_EVENT,
      reason: CommentDataInvalidReason.ThreadWithoutArtifact,
      organizationId: ORG_ID,
      threadId: THREAD_ID,
      roomId: ROOM_ID,
    });
  });

  it("back-fills artifactId on an existing row once the artifact resolves (ISS-11212)", async () => {
    const mockDb = {
      commentThread: { upsert: vi.fn().mockResolvedValue({ id: "db-th-1" }) },
      artifact: {
        findUnique: vi.fn().mockResolvedValue({
          id: "artifact-1",
          document: { latestVersion: 1 },
        }),
      },
    };
    mockWithDbCall(mockDb);

    await commentsService.upsertThreadFromLiveblocks(ORG_ID, makeThread());

    const call = mockDb.commentThread.upsert.mock.calls[0][0];
    expect(call.update.artifactId).toBe("artifact-1");
    expect(call.create.artifactId).toBe("artifact-1");
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });
});

describe("upsertCommentFromLiveblocks", () => {
  it("stores the Liveblocks body with its bodyFormat on create and update (ISS-11212)", async () => {
    const mockTx = {
      comment: { upsert: vi.fn().mockResolvedValue({ id: "db-cm-1" }) },
      commentAttachment: { deleteMany: vi.fn(), createMany: vi.fn() },
      commentReaction: { deleteMany: vi.fn(), createMany: vi.fn() },
    };
    mockWithDbCall({
      commentThread: {
        findUnique: vi.fn().mockResolvedValue({ id: "db-th-1" }),
      },
    });
    mockWithDbTx(mockTx);

    await commentsService.upsertCommentFromLiveblocks(
      ORG_ID,
      THREAD_ID,
      makeComment()
    );

    const call = mockTx.comment.upsert.mock.calls[0][0];
    expect(call.create.bodyFormat).toBe(CommentBodyFormat.LiveblocksV1);
    expect(call.update.bodyFormat).toBe(CommentBodyFormat.LiveblocksV1);
  });
});
