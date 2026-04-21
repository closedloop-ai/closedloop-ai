import { vi } from "vitest";
import { mockWithDbCall, mockWithDbTx } from "../utils/db-helpers";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  Prisma: { JsonNull: "DbNull", InputJsonValue: {} },
}));

vi.mock("@repo/collaboration/room-utils", () => ({
  parseArtifactRoomId: vi.fn(),
  parseDocumentRoomId: vi.fn((roomId: string) => {
    const parts = roomId.split(":");
    return { organizationId: parts[0], slug: parts[2] };
  }),
  generateDocumentRoomId: vi.fn(),
}));

import { ThreadSource, ThreadStatus } from "@repo/api/src/types/comment";
import { parseArtifactRoomId } from "@repo/collaboration/room-utils";
import type { CommentData, ThreadData } from "@repo/collaboration/webhook";
import { commentsService } from "@/app/comments/service";

const ORG_ID = "org-123";
const THREAD_ID = "th_abc";
const COMMENT_ID = "cm_xyz";
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

function makeComment(overrides?: Partial<CommentData>): CommentData {
  return {
    type: "comment",
    id: COMMENT_ID,
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
    ...overrides,
  } as CommentData;
}

describe("commentsService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(parseArtifactRoomId).mockReturnValue({
      organizationId: ORG_ID,
      slug: "my-artifact",
    });
  });

  describe("upsertThreadFromLiveblocks", () => {
    it("upserts a thread with entity from room lookup", async () => {
      const mockDb = {
        commentThread: { upsert: vi.fn().mockResolvedValue({ id: "db-th-1" }) },
        document: {
          findUnique: vi.fn().mockResolvedValue({ id: "artifact-1" }),
        },
      };
      mockWithDbCall(mockDb);

      const result = await commentsService.upsertThreadFromLiveblocks(
        ORG_ID,
        makeThread()
      );

      expect(result).toEqual({ id: "db-th-1" });
      expect(mockDb.commentThread.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            organizationId_externalId: {
              organizationId: ORG_ID,
              externalId: THREAD_ID,
            },
          },
          create: expect.objectContaining({
            organizationId: ORG_ID,
            source: ThreadSource.Liveblocks,
            externalId: THREAD_ID,
            roomId: ROOM_ID,
            entityId: "artifact-1",
          }),
        })
      );
    });

    it("handles non-artifact room gracefully", async () => {
      vi.mocked(parseArtifactRoomId).mockImplementation(() => {
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

      expect(result).toEqual({ id: "db-th-1" });
      expect(mockDb.commentThread.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            entityId: null,
            entityType: null,
          }),
        })
      );
    });
  });

  describe("upsertCommentFromLiveblocks", () => {
    it("upserts a comment with attachments and reactions", async () => {
      const mockTx = {
        comment: {
          upsert: vi.fn().mockResolvedValue({ id: "db-cm-1" }),
        },
        commentAttachment: {
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
          createMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        commentReaction: {
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
          createMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      };

      const mockDb = {
        commentThread: {
          findUnique: vi.fn().mockResolvedValue({ id: "db-th-1" }),
        },
      };

      mockWithDbCall(mockDb);
      mockWithDbTx(mockTx);

      const comment = makeComment({
        attachments: [
          {
            type: "attachment" as const,
            id: "att-1",
            name: "file.png",
            size: 1024,
            mimeType: "image/png",
          },
        ],
        reactions: [
          {
            emoji: "👍",
            createdAt: new Date("2025-01-01"),
            users: [{ id: "user-1" }, { id: "user-2" }],
          },
        ],
      });

      const result = await commentsService.upsertCommentFromLiveblocks(
        ORG_ID,
        THREAD_ID,
        comment
      );

      expect(result).toEqual({ id: "db-cm-1" });
      expect(mockTx.comment.upsert).toHaveBeenCalled();
      expect(mockTx.commentAttachment.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            commentId: "db-cm-1",
            externalId: "att-1",
            name: "file.png",
          }),
        ],
      });
      expect(mockTx.commentReaction.createMany).toHaveBeenCalledWith({
        data: expect.arrayContaining([
          expect.objectContaining({
            commentId: "db-cm-1",
            userId: "user-1",
            emoji: "👍",
          }),
          expect.objectContaining({
            commentId: "db-cm-1",
            userId: "user-2",
            emoji: "👍",
          }),
        ]),
      });
    });

    it("returns null when thread not found", async () => {
      const mockDb = {
        commentThread: {
          findUnique: vi.fn().mockResolvedValue(null),
        },
      };
      mockWithDbCall(mockDb);

      const result = await commentsService.upsertCommentFromLiveblocks(
        ORG_ID,
        THREAD_ID,
        makeComment()
      );

      expect(result).toBeNull();
    });
  });

  describe("softDeleteComment", () => {
    it("soft-deletes a comment by setting deletedAt", async () => {
      const mockDb = {
        comment: {
          findUnique: vi.fn().mockResolvedValue({
            id: "db-cm-1",
            thread: { organizationId: ORG_ID },
          }),
          update: vi.fn().mockResolvedValue({ id: "db-cm-1" }),
        },
      };
      mockWithDbCall(mockDb);

      const result = await commentsService.softDeleteComment(
        ORG_ID,
        COMMENT_ID
      );

      expect(result).toEqual({ id: "db-cm-1" });
      expect(mockDb.comment.update).toHaveBeenCalledWith({
        where: { id: "db-cm-1" },
        data: expect.objectContaining({
          deletedAt: expect.any(Date),
        }),
      });
    });

    it("returns null when comment not found", async () => {
      const mockDb = {
        comment: {
          findUnique: vi.fn().mockResolvedValue(null),
        },
      };
      mockWithDbCall(mockDb);

      const result = await commentsService.softDeleteComment(
        ORG_ID,
        COMMENT_ID
      );

      expect(result).toBeNull();
    });

    it("returns null when comment belongs to different org", async () => {
      const mockDb = {
        comment: {
          findUnique: vi.fn().mockResolvedValue({
            id: "db-cm-1",
            thread: { organizationId: "other-org" },
          }),
        },
      };
      mockWithDbCall(mockDb);

      const result = await commentsService.softDeleteComment(
        ORG_ID,
        COMMENT_ID
      );

      expect(result).toBeNull();
    });
  });

  describe("resolveThread", () => {
    it("marks a thread as resolved", async () => {
      const resolvedAt = new Date("2025-06-01");
      const mockDb = {
        commentThread: {
          update: vi.fn().mockResolvedValue({
            id: "db-th-1",
            status: ThreadStatus.Resolved,
          }),
        },
      };
      mockWithDbCall(mockDb);

      const result = await commentsService.resolveThread(
        ORG_ID,
        THREAD_ID,
        resolvedAt
      );

      expect(result).toEqual({ id: "db-th-1", status: ThreadStatus.Resolved });
      expect(mockDb.commentThread.update).toHaveBeenCalledWith({
        where: {
          organizationId_externalId: {
            organizationId: ORG_ID,
            externalId: THREAD_ID,
          },
        },
        data: {
          status: ThreadStatus.Resolved,
          resolvedAt,
        },
      });
    });
  });
});
