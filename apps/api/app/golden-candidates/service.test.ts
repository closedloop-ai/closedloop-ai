import {
  ThreadSource,
  TRACE_COMMENT_METADATA_KIND,
  TraceCommentKind,
  TraceCommentTargetType,
} from "@repo/api/src/types/comment";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule({
    Prisma: { JsonNull: null },
  });
});

import { getMockWithDb } from "../../__tests__/utils/db-helpers";
import { goldenCandidatesService } from "./service";

const mockWithDb = getMockWithDb();

const anchor = {
  traceId: "trace:session-1:0",
  turnId: "turn:session-1:0",
  row: 3,
  selectedText: "collected value was wrong",
  sourceText: "A trace row whose collected value was wrong",
  startOffset: 18,
  endOffset: 43,
  sessionId: "session-artifact-1",
  actor: { name: "codex", human: null },
};

const parsingBugMetadata = {
  kind: TRACE_COMMENT_METADATA_KIND,
  schemaVersion: 1,
  targetType: TraceCommentTargetType.Session,
  surface: "session_detail",
  commentKind: TraceCommentKind.ParsingBug,
  anchor,
};

function parsingBugThread() {
  return {
    id: "thread-1",
    artifactId: "session-artifact-1",
    metadata: parsingBugMetadata,
    createdAt: new Date("2026-06-17T10:00:00.000Z"),
    comments: [
      {
        id: "comment-1",
        authorId: "user-1",
        plainText:
          "Expected the tool output to be parsed as JSON, not raw text.",
        createdAt: new Date("2026-06-17T10:00:00.000Z"),
      },
    ],
  };
}

function mockDb(rows: unknown[], total = rows.length) {
  const findMany = vi.fn().mockResolvedValue(rows);
  const count = vi.fn().mockResolvedValue(total);
  const userFindMany = vi.fn().mockResolvedValue([
    {
      id: "user-1",
      firstName: "Test",
      lastName: "User",
      email: "test@example.com",
    },
  ]);
  mockWithDb.mockImplementation((callback) =>
    callback({
      commentThread: { findMany, count },
      user: { findMany: userFindMany },
    })
  );
  return { findMany, count, userFindMany };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("goldenCandidatesService.listAll", () => {
  it("surfaces a parsing-bug comment as a candidate with source session, anchor, and noted expected value", async () => {
    const { findMany } = mockDb([parsingBugThread()]);

    const response = await goldenCandidatesService.listAll({
      organizationId: "org-1",
      filters: {},
    });

    expect(response.items).toHaveLength(1);
    expect(response.items[0]).toEqual({
      commentId: "comment-1",
      threadId: "thread-1",
      target: {
        type: TraceCommentTargetType.Session,
        id: "session-artifact-1",
      },
      sessionId: "session-artifact-1",
      anchor,
      notedExpectedValue:
        "Expected the tool output to be parsed as JSON, not raw text.",
      authorId: "user-1",
      authorName: "Test User",
      createdAt: "2026-06-17T10:00:00.000Z",
    });
    expect(response.total).toBe(1);
    expect(response.nextCursor).toBeNull();

    // The query is org-scoped and filters to the parsing-bug classification on
    // session targets only.
    const where = findMany.mock.calls[0]?.[0]?.where;
    expect(where.organizationId).toBe("org-1");
    expect(where.source).toBe(ThreadSource.Native);
    expect(where.AND).toEqual([
      { metadata: { path: ["kind"], equals: TRACE_COMMENT_METADATA_KIND } },
      {
        metadata: {
          path: ["commentKind"],
          equals: TraceCommentKind.ParsingBug,
        },
      },
      {
        metadata: {
          path: ["targetType"],
          equals: TraceCommentTargetType.Session,
        },
      },
    ]);
  });

  it("restricts the query to session targets so a branch-flagged parsing bug is excluded", async () => {
    // The same SessionTrace composer is mounted on Branch View, so a branch
    // comment can carry commentKind=parsing_bug. Its branch artifact id is not a
    // source session, so it must never surface as a candidate: the query filters
    // metadata.targetType to `session` at the DB level.
    const { findMany } = mockDb([parsingBugThread()]);

    await goldenCandidatesService.listAll({
      organizationId: "org-1",
      filters: {},
    });

    const where = findMany.mock.calls[0]?.[0]?.where;
    expect(where.AND).toContainEqual({
      metadata: {
        path: ["targetType"],
        equals: TraceCommentTargetType.Session,
      },
    });
    // And the branch target is not one of the accepted values.
    expect(where.AND).not.toContainEqual({
      metadata: {
        path: ["targetType"],
        equals: TraceCommentTargetType.Branch,
      },
    });
  });

  it("drops a row whose metadata is not a parsing-bug classification (untagged comment)", async () => {
    // A plain comment thread that slipped past the DB filter (e.g. commentKind
    // omitted) must not surface as a candidate.
    const plainThread = {
      ...parsingBugThread(),
      id: "thread-plain",
      metadata: {
        kind: TRACE_COMMENT_METADATA_KIND,
        schemaVersion: 1,
        targetType: TraceCommentTargetType.Session,
        surface: "session_detail",
        anchor,
      },
    };
    mockDb([plainThread]);

    const response = await goldenCandidatesService.listAll({
      organizationId: "org-1",
      filters: {},
    });

    expect(response.items).toHaveLength(0);
  });

  it("narrows to a single source session when sessionId is supplied", async () => {
    const { findMany } = mockDb([parsingBugThread()]);

    await goldenCandidatesService.listAll({
      organizationId: "org-1",
      filters: { sessionId: "session-artifact-1" },
    });

    const where = findMany.mock.calls[0]?.[0]?.where;
    expect(where.artifactId).toBe("session-artifact-1");
  });

  it("reports a nextCursor when more rows remain and null on the final page", async () => {
    const { findMany } = mockDb([parsingBugThread()], 3);

    const response = await goldenCandidatesService.listAll({
      organizationId: "org-1",
      filters: { limit: 1 },
    });

    expect(response.total).toBe(3);
    expect(response.nextCursor).toBe("1");
    expect(findMany.mock.calls[0]?.[0]?.take).toBe(1);
  });
});
