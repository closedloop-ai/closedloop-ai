import type { Prisma } from "@repo/database";
import { describe, expect, it, vi } from "vitest";
import { resolveBranchIdentities } from "./identity-attribution";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const BRANCH_ID = "55555555-5555-4555-8555-555555555551";
const THREAD_ID = "66666666-6666-4666-8666-666666666661";
const AUTHOR_ID = "77777777-7777-4777-8777-777777777771";
const DIRECT_PARTICIPATION_SQL = "direct_comments AS (";
const COMMENT_SCAN_SQL = "FROM comment_threads";

function mockDb() {
  const rawQueries: Prisma.Sql[] = [];
  return {
    rawQueries,
    db: {
      $queryRaw: vi.fn((query: Prisma.Sql) => {
        rawQueries.push(query);
        return Promise.resolve([]);
      }),
      comment: {
        findMany: vi.fn().mockResolvedValue([
          {
            authorId: AUTHOR_ID,
            createdAt: new Date("2026-10-01T00:00:00.000Z"),
            id: "88888888-8888-4888-8888-888888888881",
            thread: { artifactId: BRANCH_ID, id: THREAD_ID },
          },
        ]),
      },
      gitHubCommentProjection: { findMany: vi.fn().mockResolvedValue([]) },
      gitHubUserConnection: { findMany: vi.fn().mockResolvedValue([]) },
      user: { findMany: vi.fn().mockResolvedValue([]) },
      branchDetail: { findMany: vi.fn().mockResolvedValue([]) },
      pullRequestDetail: { findMany: vi.fn().mockResolvedValue([]) },
      branchPushContribution: { findMany: vi.fn().mockResolvedValue([]) },
      externalCommentAuthor: { findMany: vi.fn().mockResolvedValue([]) },
    },
  };
}

describe("resolveBranchIdentities direct participation read", () => {
  it("feeds the page's Branch comments to the direct read instead of scanning comments again", async () => {
    const { db, rawQueries } = mockDb();

    await resolveBranchIdentities(
      db as never,
      ORGANIZATION_ID,
      [
        {
          branchId: BRANCH_ID,
          assigneeId: null,
          firstPushedAt: null,
          associatedPullRequestCount: 0,
        },
      ],
      []
    );

    const directReads = rawQueries.filter((query) =>
      query.sql.includes(DIRECT_PARTICIPATION_SQL)
    );
    expect(directReads).toHaveLength(1);
    expect(directReads[0]?.sql).not.toContain(COMMENT_SCAN_SQL);
    expect(directReads[0]?.values).toEqual(
      expect.arrayContaining([[BRANCH_ID], [THREAD_ID], [AUTHOR_ID]])
    );
  });

  it("starts the GitHub connection read without waiting on the direct read", async () => {
    const { db, rawQueries } = mockDb();
    let releaseDirect: (rows: never[]) => void = () => undefined;
    db.$queryRaw.mockImplementation((query: Prisma.Sql) => {
      rawQueries.push(query);
      if (!query.sql.includes(DIRECT_PARTICIPATION_SQL)) {
        return Promise.resolve([]);
      }
      return new Promise<never[]>((resolve) => {
        releaseDirect = resolve;
      });
    });

    const read = resolveBranchIdentities(
      db as never,
      ORGANIZATION_ID,
      [
        {
          branchId: BRANCH_ID,
          assigneeId: null,
          firstPushedAt: null,
          associatedPullRequestCount: 0,
        },
      ],
      []
    );
    await vi.waitFor(() =>
      expect(
        rawQueries.some((query) => query.sql.includes(DIRECT_PARTICIPATION_SQL))
      ).toBe(true)
    );
    await new Promise((resolve) => setImmediate(resolve));
    const connectionReadsWhileDirectPending =
      db.gitHubUserConnection.findMany.mock.calls.length;
    releaseDirect([]);
    await read;

    expect(connectionReadsWhileDirectPending).toBeGreaterThan(0);
  });
});
