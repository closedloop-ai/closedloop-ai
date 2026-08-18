import {
  ThreadStatus,
  TRACE_COMMENT_METADATA_KIND,
  TRACE_COMMENT_SCHEMA_VERSION,
  TraceCommentSurface,
  TraceCommentTargetType,
  traceCommentDraftSchema,
  traceTextAnchorSchema,
} from "@repo/api/src/types/comment";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule({
    ArtifactType: {
      SESSION: "SESSION",
      BRANCH: "BRANCH",
    },
    Prisma: {
      JsonNull: null,
    },
  });
});

vi.mock("@/app/compute-targets/service", () => ({
  computeTargetsService: {
    findOwnedById: vi.fn(),
  },
}));

vi.mock("@/lib/mention-notifications", () => ({
  dispatchMentionNotifications: vi.fn(),
}));

import { getMockWithDb } from "../../__tests__/utils/db-helpers";
import { traceCommentsService } from "./service";

const mockWithDb = getMockWithDb();
const createdAt = new Date("2026-07-20T09:00:00.000Z");
const updatedAt = new Date("2026-07-20T09:01:00.000Z");
const resolvedAt = new Date("2026-07-20T10:00:00.000Z");

const anchor = {
  traceId: "trace-1",
  turnId: "turn-1",
  row: 3,
  selectedText: "selected",
  sourceText: "source selected text",
  startOffset: 7,
  endOffset: 15,
  sessionId: "session-artifact-1",
  actor: { name: "codex", human: null },
};

const metadata = {
  kind: TRACE_COMMENT_METADATA_KIND,
  schemaVersion: TRACE_COMMENT_SCHEMA_VERSION,
  targetType: TraceCommentTargetType.Session,
  surface: TraceCommentSurface.SessionDetail,
  anchor,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("traceCommentsService MCP projection contracts", () => {
  it("keeps anchorType out of shared anchor schemas and create serialization", async () => {
    const draft = traceCommentDraftSchema.parse({
      anchor: { ...anchor, anchorType: "text" },
      body: "Persisted note",
    });

    expect(
      traceTextAnchorSchema.parse({ ...anchor, anchorType: "text" })
    ).not.toHaveProperty("anchorType");
    expect(draft.anchor).not.toHaveProperty("anchorType");

    mockSessionTarget();
    let persistedMetadata: unknown;
    const threadCreate = vi.fn((args) => {
      persistedMetadata = args.data.metadata;
      return Promise.resolve(thread({ metadata: persistedMetadata }));
    });
    mockWithDb.tx.mockImplementation((callback) =>
      callback({
        commentThread: { create: threadCreate },
        user: { findMany: vi.fn().mockResolvedValue([author()]) },
      })
    );

    const created = await traceCommentsService.create({
      organizationId: "org-1",
      userId: "user-1",
      target: {
        type: TraceCommentTargetType.Session,
        id: "session-artifact-1",
      },
      draft,
    });

    expect(created?.anchor).not.toHaveProperty("anchorType");
    expect(persistedMetadata).toMatchObject({ anchor });
    expect(
      (persistedMetadata as { anchor?: unknown }).anchor
    ).not.toHaveProperty("anchorType");
  });

  it("projects nullable resolver metadata through create replay, reply, and update", async () => {
    mockSessionTarget();
    const replayedThread = thread({
      id: "thread-create",
      commentId: "comment-create",
      resolvedById: "resolver-1",
      resolvedAt,
    });
    mockWithDb.tx.mockImplementationOnce((callback) =>
      callback({
        commentThread: {
          findUnique: vi.fn().mockResolvedValue(replayedThread),
          create: vi.fn(),
        },
        user: { findMany: vi.fn().mockResolvedValue([author(), resolver()]) },
      })
    );

    const replayed = await traceCommentsService.create({
      organizationId: "org-1",
      userId: "user-1",
      target: {
        type: TraceCommentTargetType.Session,
        id: "session-artifact-1",
      },
      draft: { anchor, body: "Persisted note", clientId: "local-comment-1" },
    });

    expect(replayed).toMatchObject(resolverFields());

    const parentThread = thread({
      id: "thread-reply",
      commentId: "comment-reply",
    });
    const repliedThread = thread({
      id: "thread-reply",
      commentId: "comment-reply",
      replyId: "reply-1",
      resolvedById: "resolver-1",
      resolvedAt,
    });
    mockWithDb.tx.mockImplementationOnce((callback) =>
      callback({
        commentThread: {
          findFirst: vi
            .fn()
            .mockResolvedValueOnce(parentThread)
            .mockResolvedValueOnce(repliedThread),
        },
        comment: { create: vi.fn().mockResolvedValue({ id: "reply-1" }) },
        user: { findMany: vi.fn().mockResolvedValue([author(), resolver()]) },
      })
    );

    const replied = await traceCommentsService.reply({
      organizationId: "org-1",
      userId: "user-1",
      target: {
        type: TraceCommentTargetType.Session,
        id: "session-artifact-1",
      },
      commentId: "comment-reply",
      draft: { body: "Reply note" },
    });

    expect(replied).toMatchObject({ ok: true, value: resolverFields() });

    mockWithDb.tx.mockImplementationOnce((callback) =>
      callback({
        commentThread: {
          findFirst: vi
            .fn()
            .mockResolvedValueOnce(parentThread)
            .mockResolvedValueOnce(replayedThread),
        },
        comment: {
          findUnique: vi.fn().mockResolvedValue({ body: null }),
          update: vi.fn().mockResolvedValue({ id: "comment-reply" }),
        },
        user: { findMany: vi.fn().mockResolvedValue([author(), resolver()]) },
      })
    );

    const updated = await traceCommentsService.update({
      organizationId: "org-1",
      userId: "user-1",
      target: {
        type: TraceCommentTargetType.Session,
        id: "session-artifact-1",
      },
      commentId: "comment-reply",
      update: { body: "Edited note" },
    });

    expect(updated).toMatchObject({ ok: true, value: resolverFields() });
  });

  it("projects resolver metadata and null fallbacks through aggregate listAll", async () => {
    mockWithDb.mockImplementation((callback) =>
      callback({
        commentThread: {
          findMany: vi.fn().mockResolvedValue([
            thread({
              id: "resolved",
              resolvedById: "resolver-1",
              resolvedAt,
            }),
            thread({ id: "open", status: ThreadStatus.Open }),
          ]),
          count: vi.fn().mockResolvedValue(2),
        },
        user: { findMany: vi.fn().mockResolvedValue([author(), resolver()]) },
      })
    );

    const response = await traceCommentsService.listAll({
      organizationId: "org-1",
      userId: "user-1",
      filters: {},
    });

    expect(response.items).toEqual([
      expect.objectContaining(resolverFields()),
      expect.objectContaining({
        resolvedAt: null,
        resolvedById: null,
        resolvedByName: null,
        resolvedByAvatarUrl: null,
      }),
    ]);
  });
});

function mockSessionTarget() {
  mockWithDb.mockImplementation((callback) =>
    callback({
      sessionDetail: {
        findFirst: vi
          .fn()
          .mockResolvedValue({ artifactId: "session-artifact-1" }),
      },
    })
  );
}

function thread(
  overrides: {
    id?: string;
    commentId?: string;
    replyId?: string;
    status?: ThreadStatus;
    resolvedAt?: Date | null;
    resolvedById?: string | null;
    metadata?: unknown;
  } = {}
) {
  const rootComment = {
    id: overrides.commentId ?? "comment-1",
    authorId: "user-1",
    plainText: "Persisted note",
    body: null,
    editedAt: null,
    createdAt,
    updatedAt,
  };
  const comments = [rootComment];
  if (overrides.replyId) {
    comments.push({
      ...rootComment,
      id: overrides.replyId,
      plainText: "Reply note",
    });
  }
  return {
    id: overrides.id ?? "thread-1",
    artifactId: "session-artifact-1",
    status: overrides.status ?? ThreadStatus.Resolved,
    resolvedAt: overrides.resolvedAt ?? null,
    resolvedById: overrides.resolvedById ?? null,
    metadata: overrides.metadata ?? metadata,
    createdAt,
    updatedAt,
    comments,
  };
}

function author() {
  return {
    id: "user-1",
    firstName: "Author",
    lastName: "User",
    email: "author@example.com",
    avatarUrl: null,
  };
}

function resolver() {
  return {
    id: "resolver-1",
    firstName: "Resolve",
    lastName: "User",
    email: "resolver@example.com",
    avatarUrl: "https://example.com/resolver.png",
  };
}

function resolverFields() {
  return {
    resolvedAt: resolvedAt.toISOString(),
    resolvedById: "resolver-1",
    resolvedByName: "Resolve User",
    resolvedByAvatarUrl: "https://example.com/resolver.png",
  };
}
