import {
  CommentTargetType,
  ThreadSource,
  TRACE_COMMENT_METADATA_KIND,
  TraceCommentKind,
} from "@repo/api/src/types/comment";
import { GOLDEN_CANDIDATE_LIST_MAX_OFFSET } from "@repo/api/src/types/golden-candidate";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule({
    Prisma: { JsonNull: null },
  });
});

vi.mock("@repo/observability/log", () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { log } from "@repo/observability/log";
import {
  COMMENTS_DATA_INVALID_EVENT,
  CommentDataInvalidReason,
} from "@/app/comments/comment-data-invalid";
import { resetReportedTraceAnchorFailures } from "@/app/comments/service/trace-comment-anchor-json";
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
  targetType: CommentTargetType.Session,
  surface: "session_detail",
  commentKind: TraceCommentKind.ParsingBug,
};

function parsingBugThread() {
  return {
    id: "thread-1",
    artifactId: "session-artifact-1",
    metadata: parsingBugMetadata,
    anchor: { v: 1, kind: "trace", ...anchor },
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
  resetReportedTraceAnchorFailures();
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
        type: CommentTargetType.Session,
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
          equals: CommentTargetType.Session,
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
        equals: CommentTargetType.Session,
      },
    });
    // And the branch target is not one of the accepted values.
    expect(where.AND).not.toContainEqual({
      metadata: {
        path: ["targetType"],
        equals: CommentTargetType.Branch,
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
        targetType: CommentTargetType.Session,
        surface: "session_detail",
      },
    };
    mockDb([plainThread]);

    const response = await goldenCandidatesService.listAll({
      organizationId: "org-1",
      filters: {},
    });

    expect(response.items).toHaveLength(0);
  });

  it("reports and drops a candidate whose stored anchor does not read back (ISS-11212)", async () => {
    const unreadable = {
      ...parsingBugThread(),
      id: "thread-bad-anchor",
      anchor: { v: 1, kind: "trace", traceId: "" },
    };
    const missing = {
      ...parsingBugThread(),
      id: "thread-no-anchor",
      anchor: null,
    };
    mockDb([unreadable, missing, parsingBugThread()]);

    const response = await goldenCandidatesService.listAll({
      organizationId: "org-1",
      filters: {},
    });

    expect(response.items.map((item) => item.threadId)).toEqual(["thread-1"]);
    expect(log.error).toHaveBeenCalledWith(COMMENTS_DATA_INVALID_EVENT, {
      event: COMMENTS_DATA_INVALID_EVENT,
      reason: CommentDataInvalidReason.AnchorUnparseable,
      organizationId: "org-1",
      threadId: "thread-bad-anchor",
    });
    expect(log.error).toHaveBeenCalledWith(COMMENTS_DATA_INVALID_EVENT, {
      event: COMMENTS_DATA_INVALID_EVENT,
      reason: CommentDataInvalidReason.AnchorMissing,
      organizationId: "org-1",
      threadId: "thread-no-anchor",
    });
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

  it("still mints a cursor when the next offset lands exactly on the ceiling", async () => {
    mockDb([parsingBugThread()], GOLDEN_CANDIDATE_LIST_MAX_OFFSET + 5);

    const response = await goldenCandidatesService.listAll({
      organizationId: "org-1",
      filters: { limit: 1, offset: GOLDEN_CANDIDATE_LIST_MAX_OFFSET - 1 },
    });

    expect(response.nextCursor).toBe(String(GOLDEN_CANDIDATE_LIST_MAX_OFFSET));
  });

  it("withholds the cursor past the ceiling rather than minting a token the schema rejects", async () => {
    mockDb([parsingBugThread()], GOLDEN_CANDIDATE_LIST_MAX_OFFSET + 500);

    const response = await goldenCandidatesService.listAll({
      organizationId: "org-1",
      filters: { limit: 1, offset: GOLDEN_CANDIDATE_LIST_MAX_OFFSET },
    });

    // Rows remain, so this is not "exhausted" — `total` says so, and the null
    // cursor says this pagination cannot reach them. Minting
    // `GOLDEN_CANDIDATE_LIST_MAX_OFFSET + 1` would be a token
    // `goldenCandidateListQuerySchema` answers 400 to.
    expect(response.total).toBe(GOLDEN_CANDIDATE_LIST_MAX_OFFSET + 500);
    expect(response.nextCursor).toBeNull();
  });
});
