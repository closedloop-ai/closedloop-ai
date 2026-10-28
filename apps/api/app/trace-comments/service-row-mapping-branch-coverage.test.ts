import { CommentTargetType, ThreadStatus } from "@repo/api/src/types/comment";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule({
    ArtifactType: { SESSION: "SESSION", BRANCH: "BRANCH" },
  });
});

vi.mock("@/app/compute-targets/service", () => ({
  computeTargetsService: { findOwnedById: vi.fn() },
}));

vi.mock("@/lib/mention-notifications", () => ({
  dispatchMentionNotifications: vi.fn(),
}));

import { mockWithDbAll } from "../../__tests__/utils/db-helpers";
import { traceCommentsService } from "./service";

const anchor = {
  traceId: "trace:session-1:0",
  turnId: "turn:session-1:0",
  row: 0,
  selectedText: "quote target",
  sourceText: "A trace quote target row",
  startOffset: 8,
  endOffset: 20,
  sessionId: "session-1",
  actor: { name: "codex", human: null },
};

const storedAnchor = { v: 1, kind: "trace", ...anchor };

const metadata = {
  kind: "trace_comment",
  schemaVersion: 1,
  targetType: CommentTargetType.Session,
  surface: "session_detail",
};

const createdAt = new Date("2026-06-17T10:00:00.000Z");
const updatedAt = new Date("2026-06-17T10:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("traceCommentsService — malformed row exclusion", () => {
  it("excludes rows with no root comment from list() results", async () => {
    const rows = [
      {
        id: "thread-no-comments",
        artifactId: "session-artifact-1",
        status: ThreadStatus.Open,
        metadata,
        anchor: storedAnchor,
        syncStates: [],
        createdAt,
        updatedAt,
        comments: [],
      },
    ];
    mockWithDbAll({
      sessionDetail: {
        findFirst: vi
          .fn()
          .mockResolvedValue({ artifactId: "session-artifact-1" }),
      },
      commentThread: { findMany: vi.fn().mockResolvedValue(rows) },
      user: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const comments = await traceCommentsService.list({
      organizationId: "org-1",
      userId: "user-1",
      target: {
        type: CommentTargetType.Session,
        id: "session-artifact-1",
      },
    });

    expect(comments).toEqual([]);
  });
});

describe("traceCommentsService — author and body fallbacks", () => {
  it("falls back an unresolvable resolver/reply author to null, a missing plain-text body to an empty string, and an empty display name to email or 'Unknown user'", async () => {
    const row = {
      id: "thread-1",
      artifactId: "session-artifact-1",
      status: ThreadStatus.Resolved,
      resolvedAt: new Date("2026-06-17T10:07:00.000Z"),
      resolvedById: "ghost-resolver",
      metadata,
      anchor: storedAnchor,
      syncStates: [],
      createdAt,
      updatedAt,
      comments: [
        {
          id: "comment-1",
          authorId: "user-1",
          plainText: null,
          editedAt: null,
          createdAt,
          updatedAt,
        },
        {
          id: "reply-1",
          authorId: "ghost-reply-author",
          plainText: null,
          editedAt: null,
          createdAt,
          updatedAt,
        },
        {
          id: "reply-2",
          authorId: "nameless-user",
          plainText: "reply two body",
          editedAt: null,
          createdAt,
          updatedAt,
        },
      ],
    };
    mockWithDbAll({
      sessionDetail: {
        findFirst: vi
          .fn()
          .mockResolvedValue({ artifactId: "session-artifact-1" }),
      },
      commentThread: { findMany: vi.fn().mockResolvedValue([row]) },
      user: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "user-1",
            firstName: null,
            lastName: null,
            email: "root@example.com",
            avatarUrl: null,
          },
          {
            id: "nameless-user",
            firstName: null,
            lastName: null,
            email: "",
            avatarUrl: null,
          },
        ]),
      },
    });

    const comments = await traceCommentsService.list({
      organizationId: "org-1",
      userId: "user-1",
      target: {
        type: CommentTargetType.Session,
        id: "session-artifact-1",
      },
    });

    expect(comments).toHaveLength(1);
    expect(comments?.[0]).toMatchObject({
      id: "comment-1",
      body: "",
      authorName: "root@example.com",
      resolvedById: "ghost-resolver",
      resolvedByName: null,
      replies: [
        {
          id: "reply-1",
          body: "",
          authorName: null,
          authorAvatarUrl: null,
        },
        {
          id: "reply-2",
          body: "reply two body",
          authorName: "Unknown user",
        },
      ],
    });
  });
});
