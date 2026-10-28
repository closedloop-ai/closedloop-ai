import {
  SessionArtifactLinkKind,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import type { Prisma } from "@repo/database";
import { describe, expect, it, vi } from "vitest";
import { createDbFanoutLimiter } from "./db-fanout";

// Mock the attribution DB read so the fold runs without a database. It yields
// the records under test; the reads behind it, and the predicates they run, are
// covered by `agent-session-attribution-read.test.ts`.
let pageRows: unknown[] = [];

vi.mock("./agent-session-attribution-read", () => ({
  readSessionAttributionRecords: vi.fn(() => Promise.resolve(pageRows)),
}));

const { aggregateSessionAttributionLenses } = await import(
  "./agent-session-attribution"
);
const { readSessionAttributionRecords } = await import(
  "./agent-session-attribution-read"
);

describe("aggregateSessionAttributionLenses — scan scoping (ISS-4549)", () => {
  it("reads the attribution population for the caller's own where", async () => {
    pageRows = [];
    const where = { userId: "user-1" } as Prisma.SessionDetailWhereInput;
    vi.mocked(readSessionAttributionRecords).mockClear();

    await aggregateSessionAttributionLenses("org-1", where);

    // The fold must hand the read its own org AND its own matched-session
    // predicate. Output assertions can't catch a regression here — an unlinked
    // session has no PR-derived branches and is dropped by the accumulator's
    // early-return regardless — so guard what is passed. Positional, so the
    // optional ISS-7598 limiter this call omits is not pinned here; the case
    // below owns that argument.
    expect(
      vi.mocked(readSessionAttributionRecords).mock.calls[0]?.slice(0, 2)
    ).toEqual(["org-1", where]);
  });

  it("hands the caller's shared limiter to the read (ISS-7598)", async () => {
    pageRows = [];
    const where = { userId: "user-3" } as Prisma.SessionDetailWhereInput;
    const limiter = createDbFanoutLimiter();
    vi.mocked(readSessionAttributionRecords).mockClear();

    await aggregateSessionAttributionLenses("org-1", where, limiter);

    // The bound only composes if the SAME limiter reaches the read. A fold that
    // dropped it here would leave this path spending its own budget beside the
    // caller's, which is the 2x-stacking `db-fanout.ts` warns about — and no
    // output assertion could see it.
    expect(vi.mocked(readSessionAttributionRecords)).toHaveBeenCalledWith(
      "org-1",
      where,
      limiter
    );
  });

  it("returns empty lenses when the read yields no session→PR links", async () => {
    pageRows = [];
    const where = { userId: "user-2" } as Prisma.SessionDetailWhereInput;

    const lenses = await aggregateSessionAttributionLenses("org-1", where);

    expect(lenses).toEqual({ byBranch: [], byPr: [] });
  });

  it("splits one reused-branch share across only its declared PR identities", async () => {
    const detail = (number: number, isCurrent: boolean) => ({
      number,
      title: `PR ${number}`,
      isCurrent,
      lastVerifiedAt: new Date("2026-08-17T12:00:00.000Z"),
      repositoryFullName: "acme/web",
      repository: { fullName: "acme/web" },
    });
    pageRows = [
      {
        artifactId: "session-1",
        inputTokens: 100n,
        outputTokens: 50n,
        cacheReadTokens: 20n,
        cacheWriteTokens: 10n,
        estimatedCost: 12,
        artifact: {
          organizationId: "org-1",
          sourceLinks: [
            {
              metadata: {
                linkKind: SessionArtifactLinkKind.SessionBranch,
                linkKinds: [SessionArtifactLinkKind.SessionPrSet],
                confidence: 1,
                prRefs: [1, 2].map((prNumber) => ({
                  repositoryFullName: "acme/web",
                  prNumber,
                  relationTypes: [SessionPrRelationType.Created],
                })),
              },
              targetId: "branch-1",
              target: {
                organizationId: "org-1",
                branch: {
                  branchName: "feat/reused",
                  repository: { fullName: "acme/web" },
                  currentPullRequestDetail: detail(3, true),
                },
                pullRequestDetails: [
                  detail(1, false),
                  detail(2, false),
                  detail(3, true),
                ],
              },
            },
          ],
        },
      },
    ];

    const lenses = await aggregateSessionAttributionLenses("org-1", {});

    expect(lenses.byBranch).toHaveLength(1);
    expect(lenses.byBranch[0]?.estimatedCost).toBe(12);
    expect(lenses.byPr.map((pr) => pr.prNumber).sort()).toEqual([1, 2]);
    expect(lenses.byPr.map((pr) => pr.estimatedCost)).toEqual([6, 6]);
  });

  it("allows unique-Branch inference only for valid legacy metadata", async () => {
    pageRows = [
      attributionRow({ linkKind: SessionArtifactLinkKind.SessionPr }),
    ];

    const lenses = await aggregateSessionAttributionLenses("org-1", {});

    expect(lenses.byPr.map((pr) => pr.prNumber)).toEqual([7]);
  });

  it.each([
    [
      "canonical empty",
      { linkKind: SessionArtifactLinkKind.SessionPr, prRefs: [] },
    ],
    [
      "stale scalar plus canonical empty",
      {
        linkKind: SessionArtifactLinkKind.SessionPr,
        repositoryFullName: "stale/repo",
        prNumber: 99,
        prRefs: [],
      },
    ],
    [
      "malformed",
      { linkKind: SessionArtifactLinkKind.SessionPr, prRefs: "bad" },
    ],
    [
      "set marker without array",
      {
        linkKind: SessionArtifactLinkKind.SessionBranch,
        linkKinds: [SessionArtifactLinkKind.SessionPrSet],
      },
    ],
    // ISS-8051 retired a fifth shape here: an over-500 `prRefs` array, which
    // this table asserted failed closed. That was the defect — the read schema's
    // `.max()` made `safeParse` fail, which classifies as `invalid` and discards
    // the whole stored PR set of a link the cloud had already accepted and
    // written, so the session read back with no PR attribution at all. The
    // expectation itself changed rather than being weakened to pass; the
    // replacement readback contract is asserted in
    // `packages/api/src/types/session-pr-link-metadata.test.ts`, and the
    // consumer-side admission it enables in `lib/session-pr-links.test.ts`.
  ])("fails closed for %s metadata", async (_label, metadata) => {
    pageRows = [attributionRow(metadata)];

    const lenses = await aggregateSessionAttributionLenses("org-1", {});

    expect(lenses.byPr).toEqual([]);
  });

  it("attributes every PR on a link with more refs than the retired read bound (ISS-8064)", async () => {
    // This shape used to sit in the fail-closed table above, because the
    // persisted read schema carried `.max(500)`. That was the defect: a link
    // past the bound parsed as Invalid, so its PRs silently left the
    // attribution population entirely. Count and identity, not silence.
    const prRefs = Array.from({ length: 501 }, (_, index) => ({
      repositoryFullName: "acme/web",
      prNumber: index + 1,
      relationTypes: [],
    }));
    pageRows = [
      attributionRow({
        linkKind: SessionArtifactLinkKind.SessionPr,
        prRefs,
      }),
    ];

    const lenses = await aggregateSessionAttributionLenses("org-1", {});

    // The row's PR detail declares PR 7, so that is the identity that survives
    // the join — the point is that it is present at all rather than dropped.
    expect(lenses.byPr.map((pr) => pr.prNumber)).toEqual([7]);
  });
});

function attributionRow(metadata: Record<string, unknown>) {
  const detail = {
    number: 7,
    title: "PR 7",
    isCurrent: true,
    lastVerifiedAt: new Date("2026-08-17T12:00:00.000Z"),
    repositoryFullName: "acme/web",
    repository: { fullName: "acme/web" },
  };
  return {
    artifactId: "session-fallback",
    inputTokens: 10n,
    outputTokens: 5n,
    cacheReadTokens: 2n,
    cacheWriteTokens: 1n,
    estimatedCost: 1,
    artifact: {
      organizationId: "org-1",
      sourceLinks: [
        {
          metadata,
          targetId: "branch-fallback",
          target: {
            organizationId: "org-1",
            branch: {
              branchName: "feat/fallback",
              repository: { fullName: "acme/web" },
              currentPullRequestDetail: detail,
            },
            pullRequestDetails: [detail],
          },
        },
      ],
    },
  };
}
