import { CommentTargetType, ThreadStatus } from "@repo/api/src/types/comment";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { storedSessionTraceThreadColumns } from "@/__tests__/support/trace-comments/trace-comment-thread.test-fixtures";

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

import { getMockWithDb } from "../../__tests__/utils/db-helpers";
import { traceCommentsService } from "./service";

/**
 * ISS-11113: the by-client-id read is the target's list narrowed to the thread
 * the create's `clientId` was filed under.
 *
 * The thread fake applies the `where` it is HANDED, with Prisma's semantics — a
 * key the service leaves out constrains nothing — so dropping the `externalId`
 * narrowing answers with the sibling thread too, and dropping the org predicate
 * answers with the other org's thread filed under the same key.
 */

const mockWithDb = getMockWithDb();

const ARTIFACT_ID = "session-artifact-1";
const CLIENT_ID = "local-client-a";

type ThreadRow = {
  id: string;
  organizationId: string;
  artifactId: string;
  externalId: string | null;
};

const at = new Date("2026-09-29T10:00:00.000Z");
const threads: ThreadRow[] = [
  {
    id: "thread-a",
    organizationId: "org-1",
    artifactId: ARTIFACT_ID,
    externalId: CLIENT_ID,
  },
  {
    id: "thread-b",
    organizationId: "org-1",
    artifactId: ARTIFACT_ID,
    externalId: "local-client-b",
  },
  {
    id: "thread-web",
    organizationId: "org-1",
    artifactId: ARTIFACT_ID,
    externalId: null,
  },
  {
    id: "thread-other-org",
    organizationId: "org-2",
    artifactId: ARTIFACT_ID,
    externalId: CLIENT_ID,
  },
];

function threadFindMany(args: { where: Partial<ThreadRow> }) {
  const matching = threads.filter((thread) =>
    (["organizationId", "artifactId", "externalId"] as const).every(
      (key) => !(key in args.where) || args.where[key] === thread[key]
    )
  );
  return Promise.resolve(
    matching.map((thread) => ({
      id: thread.id,
      artifactId: thread.artifactId,
      status: ThreadStatus.Open,
      resolvedAt: null,
      resolvedById: null,
      organizationId: thread.organizationId,
      ...storedSessionTraceThreadColumns,
      createdAt: at,
      updatedAt: at,
      comments: [
        {
          id: `root-${thread.id}`,
          authorId: "user-1",
          plainText: `body of ${thread.id}`,
          body: null,
          editedAt: null,
          createdAt: at,
          updatedAt: at,
        },
      ],
    }))
  );
}

beforeEach(() => {
  const findMany = vi.fn(threadFindMany);
  mockWithDb.mockImplementation((callback) =>
    callback({
      sessionDetail: {
        findFirst: vi.fn().mockResolvedValue({ artifactId: ARTIFACT_ID }),
      },
      commentThread: { findMany },
      user: { findMany: vi.fn().mockResolvedValue([]) },
    })
  );
});

describe("traceCommentsService.list by clientId (ISS-11113)", () => {
  const target = { type: CommentTargetType.Session, id: ARTIFACT_ID };

  it("answers only this org's thread filed under the clientId", async () => {
    const comments = await traceCommentsService.list({
      organizationId: "org-1",
      userId: "user-1",
      target,
      clientId: CLIENT_ID,
    });

    expect(comments?.map((comment) => comment.threadId)).toEqual(["thread-a"]);
  });

  it("answers an empty list for a clientId nothing was filed under", async () => {
    const comments = await traceCommentsService.list({
      organizationId: "org-1",
      userId: "user-1",
      target,
      clientId: "local-never-landed",
    });

    expect(comments).toEqual([]);
  });

  it("still answers the whole target without one", async () => {
    const comments = await traceCommentsService.list({
      organizationId: "org-1",
      userId: "user-1",
      target,
    });

    expect(comments?.map((comment) => comment.threadId)).toEqual([
      "thread-a",
      "thread-b",
      "thread-web",
    ]);
  });
});

describe("traceCommentsService.list addressed thread (ISS-11004)", () => {
  it("includes thread 201 while retaining the oldest 200", async () => {
    const [template] = await threadFindMany({
      where: { organizationId: "org-1", artifactId: ARTIFACT_ID },
    });
    const rows = Array.from({ length: 201 }, (_, i) => ({
      ...template,
      id: `thread-${i}`,
      comments: template.comments.map((comment) => ({
        ...comment,
        id: `root-${i}`,
      })),
    }));
    const findFirst = vi.fn(
      async ({ where }) =>
        rows.find(
          (row) =>
            row.id === where.id &&
            row.organizationId === where.organizationId &&
            row.artifactId === where.artifactId
        ) ?? null
    );
    mockWithDb.mockImplementation((callback) =>
      callback({
        sessionDetail: {
          findFirst: vi.fn().mockResolvedValue({ artifactId: ARTIFACT_ID }),
        },
        commentThread: {
          findMany: vi.fn(async ({ take }) => rows.slice(0, take)),
          findFirst,
        },
        user: { findMany: vi.fn().mockResolvedValue([]) },
      })
    );
    const comments = await traceCommentsService.list({
      organizationId: "org-1",
      userId: "user-1",
      target: { type: CommentTargetType.Session, id: ARTIFACT_ID },
      includeThreadId: "thread-200",
    });
    expect(comments).toHaveLength(201);
    expect(comments?.at(-1)?.threadId).toBe("thread-200");
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: "org-1",
          artifactId: ARTIFACT_ID,
          id: "thread-200",
        }),
      })
    );
  });
});
