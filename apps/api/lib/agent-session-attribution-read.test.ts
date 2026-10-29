import type { Prisma } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The read is the only thing under test, so the client is mocked down to the
// three delegates it may call — which is also what makes the round-trip count
// observable (ISS-7655).
const artifactLinkFindMany = vi.fn<(args: unknown) => Promise<unknown[]>>(() =>
  Promise.resolve([])
);
const sessionDetailFindMany = vi.fn<(args: unknown) => Promise<unknown[]>>(() =>
  Promise.resolve([])
);
const artifactFindMany = vi.fn<(args: unknown) => Promise<unknown[]>>(() =>
  Promise.resolve([])
);

vi.mock("@repo/database", () => ({
  withDb: (
    fn: (db: {
      artifact: { findMany: typeof artifactFindMany };
      artifactLink: { findMany: typeof artifactLinkFindMany };
      sessionDetail: { findMany: typeof sessionDetailFindMany };
    }) => unknown
  ) =>
    fn({
      artifact: { findMany: artifactFindMany },
      artifactLink: { findMany: artifactLinkFindMany },
      sessionDetail: { findMany: sessionDetailFindMany },
    }),
}));

const { readSessionAttributionRecords } = await import(
  "./agent-session-attribution-read"
);
const { SessionPrLinkAudience, sessionPrLinkFromSessions, sessionPrLinkWhere } =
  await import("./session-pr-links");
const { LINK_BRANCH_QUERY_CHUNK_SIZE } = await import(
  "./session-pr-links-chunking"
);

const ORG = "org-1";
const WHERE = { userId: "user-1" } as Prisma.SessionDetailWhereInput;

// Measured against this repo's Postgres on 2026-08-22: a 32,764-id `in:` list is
// the largest that reaches the server, and 32,765 is refused by the client with
// "The query parameter limit supported by your database is exceeded" — Prisma's
// Postgres driver counts parameters in a SIGNED i16. The documented 65,535 wire
// limit is twice the ceiling that actually applies here, so a fix sized against
// it would still fail at half the assumed headroom.
const DRIVER_PARAMETER_CEILING = 32_767;
const POPULATION_OVER_THE_CEILING = 40_000;

describe("readSessionAttributionRecords (ISS-7655)", () => {
  // mockReset, not mockClear: an early-returning case leaves its unconsumed
  // `mockResolvedValueOnce` queued, and the next case then reads that stale
  // value instead of its own (this suite's config sets no global reset).
  beforeEach(() => {
    artifactLinkFindMany.mockReset();
    sessionDetailFindMany.mockReset();
    artifactFindMany.mockReset();
  });

  it.each([1, 500, POPULATION_OVER_THE_CEILING])(
    "issues one link and one session read for %i linked sessions",
    async (sessionCount) => {
      seed(sessionCount);

      const records = await readSessionAttributionRecords(ORG, WHERE);

      expect(records).toHaveLength(sessionCount);
      // The count must not scale with the population. The keyset pager this
      // replaced issued ceil(n / 200) session reads, each dragging its nested
      // relation levels along, so 500 sessions cost three pages of ~10 queries
      // instead of the two here.
      expect(artifactLinkFindMany).toHaveBeenCalledTimes(1);
      expect(sessionDetailFindMany).toHaveBeenCalledTimes(1);
      // The target read is the one that chunks, and only over DISTINCT branches
      // — a far smaller population than the sessions that link to them.
      expect(artifactFindMany).toHaveBeenCalledTimes(
        Math.ceil(sessionCount / LINK_BRANCH_QUERY_CHUNK_SIZE)
      );
    }
  );

  it("never emits a bind list that scales with the matched population", async () => {
    seed(POPULATION_OVER_THE_CEILING);

    await readSessionAttributionRecords(ORG, WHERE);

    // The session read states the link predicate instead of listing the source
    // ids the link read returned, so it spends no bind per matched session.
    // Listing them here is what a population this size would refuse to send.
    expect(longestInList(sessionDetailFindMany)).toBe(0);
    // The one surviving `in:` list is the target read's, capped by the chunk.
    expect(longestInList(artifactFindMany)).toBe(LINK_BRANCH_QUERY_CHUNK_SIZE);
    expect(LINK_BRANCH_QUERY_CHUNK_SIZE).toBeLessThan(DRIVER_PARAMETER_CEILING);
  });

  it("scopes all three reads, and looks targets up once each", async () => {
    artifactLinkFindMany.mockResolvedValueOnce([
      { sourceId: "session-1", targetId: "branch-a", metadata: null },
      { sourceId: "session-2", targetId: "branch-a", metadata: null },
    ]);
    sessionDetailFindMany.mockResolvedValueOnce([
      sessionRow("session-1"),
      sessionRow("session-2"),
    ]);
    artifactFindMany.mockResolvedValueOnce([targetRow("branch-a")]);

    await readSessionAttributionRecords(ORG, WHERE);

    // ISS-4549: an unlinked session contributes nothing to the lenses, and a
    // surplus target row is dropped by the stitch, so no output assertion can
    // catch a widened scan — guard the predicates themselves.
    // A LITERAL organizationId, not one reached through a nested relation
    // filter: every `artifact_links` index leads with it, so dropping it costs
    // the index and turns this into a cross-tenant scan.
    expect(artifactLinkFindMany.mock.calls[0]?.[0]).toMatchObject({
      where: { organizationId: ORG, ...sessionPrLinkFromSessions(WHERE) },
      // Load-bearing, not cosmetic: `sessionPrIdentityKey` normalizes a
      // repository name, so when two links declare one PR under different
      // spellings the surviving literal is decided by link order. `createdAt`
      // alone does not decide it — links written in one transaction share its
      // timestamp — so the total order needs the `id` tie-break.
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    // Bounded by the SAME link predicate, not by an `in:` list of the source
    // ids the link read returned: an id list spends one bind per matched
    // session, and this read is deliberately uncapped.
    expect(sessionDetailFindMany.mock.calls[0]?.[0]).toMatchObject({
      where: {
        AND: [
          WHERE,
          {
            artifact: {
              organizationId: ORG,
              sourceLinks: {
                some: sessionPrLinkWhere(SessionPrLinkAudience.Metric),
              },
            },
          },
        ],
      },
      orderBy: { artifactId: "asc" },
    });
    // A keyed, org-scoped lookup of the DISTINCT targets — two links on one
    // branch must not become two ids, nor an unfiltered artifact scan.
    expect(artifactFindMany.mock.calls[0]?.[0]).toMatchObject({
      where: { organizationId: ORG, id: { in: ["branch-a"] } },
    });
  });

  it("skips the session and target reads when no link matches", async () => {
    seed(0);

    const records = await readSessionAttributionRecords(ORG, WHERE);

    expect(records).toEqual([]);
    expect(artifactLinkFindMany).toHaveBeenCalledTimes(1);
    expect(sessionDetailFindMany).not.toHaveBeenCalled();
    expect(artifactFindMany).not.toHaveBeenCalled();
  });

  it("attaches each link to its own session, in link order", async () => {
    artifactLinkFindMany.mockResolvedValueOnce([
      { sourceId: "session-1", targetId: "branch-a", metadata: { seq: 1 } },
      { sourceId: "session-1", targetId: "branch-b", metadata: { seq: 2 } },
      { sourceId: "session-2", targetId: "branch-a", metadata: { seq: 3 } },
      { sourceId: "session-3", targetId: "branch-gone", metadata: { seq: 4 } },
    ]);
    sessionDetailFindMany.mockResolvedValueOnce([
      sessionRow("session-1"),
      sessionRow("session-2"),
      sessionRow("session-3"),
    ]);
    artifactFindMany.mockResolvedValueOnce([
      targetRow("branch-a"),
      targetRow("branch-b"),
    ]);

    const records = await readSessionAttributionRecords(ORG, WHERE);

    // `metadata` rides along per link and is what the fold parses into PR
    // identity and purpose, so a stitch that pairs the right target with the
    // wrong metadata would misclassify PRs while the totals still added up.
    expect(
      records.map((record) => [
        record.artifactId,
        record.artifact.sourceLinks.map((link) => [
          link.targetId,
          link.metadata,
        ]),
      ])
    ).toEqual([
      [
        "session-1",
        [
          ["branch-a", { seq: 1 }],
          ["branch-b", { seq: 2 }],
        ],
      ],
      ["session-2", [["branch-a", { seq: 3 }]]],
      // A link whose target row is absent is dropped, not stitched as a hole.
      ["session-3", []],
    ]);
    expect(records[0]?.artifact.sourceLinks[0]?.target.branch?.branchName).toBe(
      "feat/branch-a"
    );
    expect(records[0]?.artifact.organizationId).toBe("org-1");
  });
});

function seed(sessionCount: number) {
  artifactLinkFindMany.mockResolvedValueOnce(
    Array.from({ length: sessionCount }, (_, index) => ({
      sourceId: `session-${index}`,
      targetId: `branch-${index}`,
      metadata: null,
    }))
  );
  sessionDetailFindMany.mockResolvedValueOnce(
    Array.from({ length: sessionCount }, (_, index) =>
      sessionRow(`session-${index}`)
    )
  );
  // The target read is chunked, so it is answered per chunk from the ids that
  // chunk actually asked for. A single queued result would starve every call
  // after the first and hide the chunking entirely.
  artifactFindMany.mockImplementation((args) =>
    Promise.resolve(requestedIds(args).map(targetRow))
  );
}

function requestedIds(args: unknown): string[] {
  return (
    (args as { where?: { id?: { in?: string[] } } } | undefined)?.where?.id
      ?.in ?? []
  );
}

/**
 * The longest `in:` list this delegate emitted — one bind each, and what the
 * driver's i16 parameter counter actually sees.
 */
function longestInList(delegate: { mock: { calls: unknown[][] } }): number {
  let longest = 0;
  const walk = (node: unknown, isBindList: boolean) => {
    if (Array.isArray(node)) {
      if (isBindList) {
        longest = Math.max(longest, node.length);
      }
      for (const item of node) {
        walk(item, false);
      }
      return;
    }
    if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        walk(value, key === "in");
      }
    }
  };
  for (const call of delegate.mock.calls) {
    walk(call[0], false);
  }
  return longest;
}

function sessionRow(artifactId: string) {
  return {
    artifactId,
    inputTokens: 1n,
    outputTokens: 1n,
    cacheReadTokens: 0n,
    cacheWriteTokens: 0n,
    estimatedCost: 1,
    artifact: { organizationId: "org-1" },
  };
}

function targetRow(id: string) {
  return {
    id,
    organizationId: "org-1",
    branch: {
      branchName: `feat/${id}`,
      repository: { fullName: "acme/web" },
      currentPullRequestDetail: null,
    },
    pullRequestDetails: [],
  };
}
