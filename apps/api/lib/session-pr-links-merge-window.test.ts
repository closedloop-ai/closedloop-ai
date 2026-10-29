import type { Prisma } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ISS-9924: the merge-window bound on the PR-side read, split from
// `session-pr-links.test.ts` (at the 1,000-line ceiling). `withDb` is the only
// thing stubbed; the predicates come from the real module.
const pullRequestFindMany = vi.fn((_args: unknown) => Promise.resolve([]));
const artifactLinkFindMany = vi.fn((_args: unknown) => Promise.resolve([]));

vi.mock("@repo/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/database")>();
  return {
    Prisma: actual.Prisma,
    withDb: (
      fn: (db: {
        artifactLink: { findMany: typeof artifactLinkFindMany };
        pullRequestDetail: { findMany: typeof pullRequestFindMany };
      }) => unknown
    ) =>
      fn({
        artifactLink: { findMany: artifactLinkFindMany },
        pullRequestDetail: { findMany: pullRequestFindMany },
      }),
  };
});

const { findMergedPrsLinkedToSessions, MERGED_PR_DETAIL_WHERE } = await import(
  "./session-pr-links"
);
const { resolveDeliveryMergeWindow } = await import(
  "./agent-session-delivery-metrics"
);

describe("findMergedPrsLinkedToSessions — merge-window bound (ISS-9924)", () => {
  const where: Prisma.SessionDetailWhereInput = {
    artifact: { is: { createdById: "user-1" } },
  };
  const start = Date.parse("2026-09-01T00:00:00.000Z");

  beforeEach(() => {
    pullRequestFindMany.mockClear();
    artifactLinkFindMany.mockClear();
  });

  function readMergedAt() {
    const args = pullRequestFindMany.mock.calls[0]?.[0] as
      | { where: Record<string, unknown> }
      | undefined;
    return args?.where.mergedAt;
  }

  it("bounds mergedAt to the window, inclusive, and keeps the non-null test", async () => {
    const end = Date.parse("2026-09-14T23:59:59.999Z");

    await findMergedPrsLinkedToSessions(
      "org-1",
      where,
      { number: true },
      { start, end }
    );

    expect(readMergedAt()).toEqual({
      ...MERGED_PR_DETAIL_WHERE.mergedAt,
      gte: new Date(start),
      lte: new Date(end),
    });
  });

  it("adds no upper bound for an open-ended window", async () => {
    await findMergedPrsLinkedToSessions(
      "org-1",
      where,
      { number: true },
      { start, end: Number.MAX_SAFE_INTEGER }
    );

    expect(readMergedAt()).toEqual({
      ...MERGED_PR_DETAIL_WHERE.mergedAt,
      gte: new Date(start),
    });
  });

  it("bounds an end-only window from the epoch start the fold counts from", async () => {
    // The public query accepts `endDate` alone. The resolver opens the start at
    // its all-time sentinel, which the fold tests `mergedAt` against and this
    // read turns into a `Date`; a sentinel a `Date` cannot hold would reach
    // Prisma as an Invalid Date instead of the fold's lower bound.
    const end = "2026-09-14T23:59:59.999Z";

    await findMergedPrsLinkedToSessions(
      "org-1",
      where,
      { number: true },
      resolveDeliveryMergeWindow(undefined, end)
    );

    expect(readMergedAt()).toEqual({
      ...MERGED_PR_DETAIL_WHERE.mergedAt,
      gte: new Date(0),
      lte: new Date(end),
    });
  });
});
