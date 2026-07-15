import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockWithDbCall, mockWithDbTx } from "../utils/db-helpers";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  Prisma: {
    JsonNull: "DbNull",
    InputJsonValue: {},
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
  },
}));

vi.mock("@repo/collaboration/shared/room-utils", () => ({
  parseArtifactRoomId: vi.fn(),
  parseDocumentRoomId: vi.fn((roomId: string) => {
    const parts = roomId.split(":");
    if (parts.length < 3 || parts[1] !== "artifact") {
      throw new Error("Invalid room ID format");
    }
    return { organizationId: parts[0], slug: parts[2] };
  }),
  generateDocumentRoomId: vi.fn(),
}));

import { ThreadSource, ThreadStatus } from "@repo/api/src/types/comment";
import type {
  CommentData,
  ThreadData,
} from "@repo/collaboration/server/webhook";
import { parseArtifactRoomId } from "@repo/collaboration/shared/room-utils";
import {
  commentsService,
  GitHubReviewThreadResolutionAttributionKind,
} from "@/app/comments/service";

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
    it("prefers thread.metadata.version over the artifact's latestVersion", async () => {
      const mockDb = {
        commentThread: { upsert: vi.fn().mockResolvedValue({ id: "db-th-1" }) },
        artifact: {
          findUnique: vi.fn().mockResolvedValue({
            id: "artifact-1",
            document: { latestVersion: 5 },
          }),
        },
      };
      mockWithDbCall(mockDb);

      await commentsService.upsertThreadFromLiveblocks(
        ORG_ID,
        makeThread({ metadata: { version: 2 } as never })
      );

      expect(mockDb.commentThread.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            organizationId: ORG_ID,
            source: ThreadSource.Liveblocks,
            externalId: THREAD_ID,
            roomId: ROOM_ID,
            artifactId: "artifact-1",
            createdAtVersion: 2,
          }),
        })
      );
    });

    it("falls back to latestVersion when metadata.version is absent", async () => {
      const mockDb = {
        commentThread: { upsert: vi.fn().mockResolvedValue({ id: "db-th-1" }) },
        artifact: {
          findUnique: vi.fn().mockResolvedValue({
            id: "artifact-1",
            document: { latestVersion: 3 },
          }),
        },
      };
      mockWithDbCall(mockDb);

      await commentsService.upsertThreadFromLiveblocks(ORG_ID, makeThread());

      expect(mockDb.commentThread.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            createdAtVersion: 3,
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

      await commentsService.upsertThreadFromLiveblocks(
        ORG_ID,
        makeThread({ roomId: "some-other-room" })
      );

      expect(mockDb.commentThread.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            artifactId: null,
            createdAtVersion: null,
          }),
        })
      );
    });

    it("yields createdAtVersion null when the artifact has no document row", async () => {
      const mockDb = {
        commentThread: { upsert: vi.fn().mockResolvedValue({ id: "db-th-1" }) },
        artifact: {
          findUnique: vi.fn().mockResolvedValue({
            id: "artifact-1",
            document: null,
          }),
        },
      };
      mockWithDbCall(mockDb);

      await commentsService.upsertThreadFromLiveblocks(ORG_ID, makeThread());

      expect(mockDb.commentThread.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            artifactId: "artifact-1",
            createdAtVersion: null,
          }),
        })
      );
    });

    it("does NOT overwrite createdAtVersion on update", async () => {
      const mockDb = {
        commentThread: { upsert: vi.fn().mockResolvedValue({ id: "db-th-1" }) },
        artifact: {
          findUnique: vi.fn().mockResolvedValue({
            id: "artifact-1",
            document: { latestVersion: 5 },
          }),
        },
      };
      mockWithDbCall(mockDb);

      await commentsService.upsertThreadFromLiveblocks(ORG_ID, makeThread());

      const call = mockDb.commentThread.upsert.mock.calls[0][0];
      expect(call.update).not.toHaveProperty("createdAtVersion");
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
    it("returns null when the target thread is missing", async () => {
      const mockDb = {
        commentThread: {
          findUnique: vi.fn().mockResolvedValue(null),
          update: vi.fn(),
        },
      };
      mockWithDbTx(mockDb);

      const result = await commentsService.resolveThread(
        ORG_ID,
        THREAD_ID,
        new Date("2025-06-01")
      );

      expect(result).toBeNull();
      expect(mockDb.commentThread.update).not.toHaveBeenCalled();
    });

    it("locks the thread row with SELECT ... FOR UPDATE before mutating", async () => {
      const resolvedAt = new Date("2025-06-01");
      const queryRaw = vi.fn().mockResolvedValue([{ id: "db-th-1" }]);
      const mockDb = {
        $queryRaw: queryRaw,
        commentThread: {
          findUnique: vi.fn().mockResolvedValue({
            id: "db-th-1",
            status: ThreadStatus.Open,
            resolvedAt: null,
            resolvedById: null,
            metadata: null,
          }),
          update: vi.fn().mockResolvedValue({
            id: "db-th-1",
            status: ThreadStatus.Resolved,
            resolvedAt,
            resolvedById: null,
            metadata: {},
          }),
        },
      };
      mockWithDbTx(mockDb);

      await commentsService.resolveThread(ORG_ID, THREAD_ID, resolvedAt);

      expect(queryRaw).toHaveBeenCalledTimes(1);
      const sql = queryRaw.mock.calls[0][0] as { strings: string[] };
      expect(sql.strings.join("")).toContain("FOR UPDATE");
      expect(queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        mockDb.commentThread.update.mock.invocationCallOrder[0]
      );
    });

    it("marks a Liveblocks thread as resolved without GitHub attribution", async () => {
      const resolvedAt = new Date("2025-06-01");
      const mockDb = {
        commentThread: {
          findUnique: vi.fn().mockResolvedValue({
            id: "db-th-1",
            status: ThreadStatus.Open,
            resolvedAt: null,
            resolvedById: null,
            metadata: null,
          }),
          update: vi.fn().mockResolvedValue({
            id: "db-th-1",
            status: ThreadStatus.Resolved,
            resolvedAt,
            resolvedById: null,
            metadata: {},
          }),
        },
      };
      mockWithDbTx(mockDb);

      const result = await commentsService.resolveThread(
        ORG_ID,
        THREAD_ID,
        resolvedAt
      );

      expect(result).toEqual({
        kind: "transition",
        thread: {
          id: "db-th-1",
          status: ThreadStatus.Resolved,
          resolvedAt,
          resolvedById: null,
          metadata: {},
        },
      });
      expect(mockDb.commentThread.update).toHaveBeenCalledWith({
        where: { id: "db-th-1" },
        data: {
          status: ThreadStatus.Resolved,
          resolvedAt,
          resolvedById: null,
          metadata: {},
        },
        select: {
          id: true,
          status: true,
          resolvedAt: true,
          resolvedById: true,
          metadata: true,
        },
      });
    });

    it("overwrites stale open resolution fields with provider-confirmed GitHub attribution", async () => {
      const staleResolvedAt = new Date("2025-05-01");
      const resolvedAt = new Date("2025-06-01");
      const attribution = githubAttribution({
        kind: GitHubReviewThreadResolutionAttributionKind.ConnectedUser,
        recordedAt: resolvedAt.toISOString(),
      });
      const mockDb = {
        commentThread: {
          findUnique: vi.fn().mockResolvedValue({
            id: "db-th-1",
            status: ThreadStatus.Open,
            resolvedAt: staleResolvedAt,
            resolvedById: "stale-user",
            metadata: {
              githubReviewThreadResolutionAttribution: githubAttribution({
                githubLogin: "stale",
              }),
            },
          }),
          update: vi.fn().mockResolvedValue({
            id: "db-th-1",
            status: ThreadStatus.Resolved,
            resolvedAt,
            resolvedById: "user-1",
            metadata: {
              githubReviewThreadResolutionAttribution: attribution,
            },
          }),
        },
      };
      mockWithDbTx(mockDb);

      const result = await commentsService.resolveThread(
        ORG_ID,
        THREAD_ID,
        resolvedAt,
        { resolvedById: "user-1", attribution }
      );

      expect(result?.kind).toBe("transition");
      expect(mockDb.commentThread.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            resolvedAt,
            resolvedById: "user-1",
            metadata: {
              githubReviewThreadResolutionAttribution: attribution,
            },
          }),
        })
      );
    });

    it("repairs already-resolved legacy-missing attribution without a transition", async () => {
      const existingResolvedAt = new Date("2025-05-01");
      const resolvedAt = new Date("2025-06-01");
      const attribution = githubAttribution({
        kind: GitHubReviewThreadResolutionAttributionKind.ExternalUnconnected,
        githubLogin: "external-user",
      });
      const mockDb = {
        commentThread: {
          findUnique: vi.fn().mockResolvedValue({
            id: "db-th-1",
            status: ThreadStatus.Resolved,
            resolvedAt: existingResolvedAt,
            resolvedById: null,
            metadata: {
              githubReviewThreadResolutionAttribution: githubAttribution({
                kind: GitHubReviewThreadResolutionAttributionKind.LegacyMissing,
              }),
            },
          }),
          update: vi.fn().mockResolvedValue({
            id: "db-th-1",
            status: ThreadStatus.Resolved,
            resolvedAt: existingResolvedAt,
            resolvedById: null,
            metadata: {
              githubReviewThreadResolutionAttribution: attribution,
            },
          }),
        },
      };
      mockWithDbTx(mockDb);

      const result = await commentsService.resolveThread(
        ORG_ID,
        THREAD_ID,
        resolvedAt,
        { resolvedById: null, attribution }
      );

      expect(result?.kind).toBe("metadata_repair");
      expect(mockDb.commentThread.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            resolvedAt: existingResolvedAt,
            resolvedById: null,
            metadata: {
              githubReviewThreadResolutionAttribution: attribution,
            },
          }),
        })
      );
    });

    it("repairs already-resolved malformed attribution instead of trusting JSON shape", async () => {
      const existingResolvedAt = new Date("2025-05-01");
      const resolvedAt = new Date("2025-06-01");
      const attribution = githubAttribution({
        kind: GitHubReviewThreadResolutionAttributionKind.ConnectedUser,
        githubLogin: "connected-user",
      });
      const mockDb = {
        commentThread: {
          findUnique: vi.fn().mockResolvedValue({
            id: "db-th-1",
            status: ThreadStatus.Resolved,
            resolvedAt: existingResolvedAt,
            resolvedById: null,
            metadata: {
              githubReviewThreadResolutionAttribution: {
                kind: "connected_user",
                source: "pull_request_review_thread",
              },
            },
          }),
          update: vi.fn().mockResolvedValue({
            id: "db-th-1",
            status: ThreadStatus.Resolved,
            resolvedAt: existingResolvedAt,
            resolvedById: "user-1",
            metadata: {
              githubReviewThreadResolutionAttribution: attribution,
            },
          }),
        },
      };
      mockWithDbTx(mockDb);

      const result = await commentsService.resolveThread(
        ORG_ID,
        THREAD_ID,
        resolvedAt,
        { resolvedById: "user-1", attribution }
      );

      expect(result?.kind).toBe("metadata_repair");
      expect(mockDb.commentThread.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            metadata: {
              githubReviewThreadResolutionAttribution: attribution,
            },
          }),
        })
      );
    });

    it("does not overwrite authoritative attribution on already-resolved replay", async () => {
      const resolvedAt = new Date("2025-06-01");
      const authoritativeAttribution = githubAttribution({
        kind: GitHubReviewThreadResolutionAttributionKind.ExternalUnconnected,
        githubLogin: "external-user",
      });
      const mockDb = {
        commentThread: {
          findUnique: vi.fn().mockResolvedValue({
            id: "db-th-1",
            status: ThreadStatus.Resolved,
            resolvedAt,
            resolvedById: null,
            metadata: {
              githubReviewThreadResolutionAttribution: authoritativeAttribution,
            },
          }),
          update: vi.fn(),
        },
      };
      mockWithDbTx(mockDb);

      const result = await commentsService.resolveThread(
        ORG_ID,
        THREAD_ID,
        new Date("2025-06-02"),
        {
          resolvedById: "connected-user",
          attribution: githubAttribution({
            kind: GitHubReviewThreadResolutionAttributionKind.ConnectedUser,
            githubLogin: "connected-user",
          }),
        }
      );

      expect(result).toEqual({
        kind: "noop",
        thread: {
          id: "db-th-1",
          status: ThreadStatus.Resolved,
          resolvedAt,
          resolvedById: null,
          metadata: {
            githubReviewThreadResolutionAttribution: authoritativeAttribution,
          },
        },
      });
      expect(mockDb.commentThread.update).not.toHaveBeenCalled();
    });
  });

  describe("unresolveThread", () => {
    it("returns null when the target thread is missing", async () => {
      const mockDb = {
        commentThread: {
          findUnique: vi.fn().mockResolvedValue(null),
          update: vi.fn(),
        },
      };
      mockWithDbTx(mockDb);

      const result = await commentsService.unresolveThread(ORG_ID, THREAD_ID);

      expect(result).toBeNull();
      expect(mockDb.commentThread.update).not.toHaveBeenCalled();
    });

    it("transitions a resolved thread to open and clears resolution data", async () => {
      const mockDb = {
        commentThread: {
          findUnique: vi.fn().mockResolvedValue({
            id: "db-th-1",
            status: ThreadStatus.Resolved,
            resolvedAt: new Date("2025-06-01"),
            resolvedById: "user-1",
            metadata: {
              keep: "value",
              githubReviewThreadResolutionAttribution: githubAttribution(),
            },
          }),
          update: vi.fn().mockResolvedValue({
            id: "db-th-1",
            status: ThreadStatus.Open,
            resolvedAt: null,
            resolvedById: null,
            metadata: { keep: "value" },
          }),
        },
      };
      mockWithDbTx(mockDb);

      const result = await commentsService.unresolveThread(ORG_ID, THREAD_ID);

      expect(result).toEqual({
        kind: "transition",
        thread: {
          id: "db-th-1",
          status: ThreadStatus.Open,
          resolvedAt: null,
          resolvedById: null,
          metadata: { keep: "value" },
        },
      });
      expect(mockDb.commentThread.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            status: ThreadStatus.Open,
            resolvedAt: null,
            resolvedById: null,
            metadata: { keep: "value" },
          },
        })
      );
    });

    it("clears stale open resolution metadata without a transition", async () => {
      const mockDb = {
        commentThread: {
          findUnique: vi.fn().mockResolvedValue({
            id: "db-th-1",
            status: ThreadStatus.Open,
            resolvedAt: new Date("2025-06-01"),
            resolvedById: "stale-user",
            metadata: {
              keep: "value",
              githubReviewThreadResolutionAttribution: githubAttribution(),
            },
          }),
          update: vi.fn().mockResolvedValue({
            id: "db-th-1",
            status: ThreadStatus.Open,
            resolvedAt: null,
            resolvedById: null,
            metadata: { keep: "value" },
          }),
        },
      };
      mockWithDbTx(mockDb);

      const result = await commentsService.unresolveThread(ORG_ID, THREAD_ID);

      expect(result?.kind).toBe("metadata_repair");
      expect(mockDb.commentThread.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            status: ThreadStatus.Open,
            resolvedAt: null,
            resolvedById: null,
            metadata: { keep: "value" },
          },
        })
      );
    });

    it("leaves a clean open thread unchanged", async () => {
      const metadata = { keep: "value" };
      const mockDb = {
        commentThread: {
          findUnique: vi.fn().mockResolvedValue({
            id: "db-th-1",
            status: ThreadStatus.Open,
            resolvedAt: null,
            resolvedById: null,
            metadata,
          }),
          update: vi.fn(),
        },
      };
      mockWithDbTx(mockDb);

      const result = await commentsService.unresolveThread(ORG_ID, THREAD_ID);

      expect(result).toEqual({
        kind: "noop",
        thread: {
          id: "db-th-1",
          status: ThreadStatus.Open,
          resolvedAt: null,
          resolvedById: null,
          metadata,
        },
      });
      expect(mockDb.commentThread.update).not.toHaveBeenCalled();
    });
  });
});

function githubAttribution(
  overrides: Partial<{
    kind: GitHubReviewThreadResolutionAttributionKind;
    githubUserId: string | null;
    githubNodeId: string | null;
    githubLogin: string | null;
    recordedAt: string;
  }> = {}
) {
  return {
    kind:
      overrides.kind ??
      GitHubReviewThreadResolutionAttributionKind.ExternalUnconnected,
    githubUserId: overrides.githubUserId ?? null,
    githubNodeId: overrides.githubNodeId ?? null,
    githubLogin: overrides.githubLogin ?? "octocat",
    source: "pull_request_review_thread" as const,
    recordedAt: overrides.recordedAt ?? "2025-06-01T00:00:00.000Z",
  };
}
