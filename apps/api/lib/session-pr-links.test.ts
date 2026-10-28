import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import { BranchParticipationKind } from "@repo/api/src/types/branch";
import { GitHubPRState } from "@repo/api/src/types/github";
import {
  ArtifactRefMethod,
  SessionArtifactLinkKind,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import type { Prisma } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The merged-PR reader is the only DB-touching export exercised here, so the
// client is mocked down to the one delegate it calls: the case asserts the
// STATEMENT the reader builds (predicate, semi-join, select), which is what
// stops the ISS-6028 fix from silently regressing back to a row drain.
const pullRequestFindMany = vi.fn<(args: unknown) => Promise<unknown[]>>(
  (_args) => Promise.resolve([])
);
const artifactLinkFindMany = vi.fn<(args: unknown) => Promise<unknown[]>>(
  (_args) => Promise.resolve([])
);

// `withDb` is the only thing stubbed. The `Prisma` namespace comes from the REAL
// module because the predicates under test carry its filter sentinels
// (`Prisma.AnyNull`); a hand-made stand-in would let this suite assert equality
// against a token production never emits.
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

const {
  buildSessionPrAdmissionIndex,
  deliveryPrLinkFromSessions,
  findMergedPrsLinkedToSessions,
  MergedPrBranchAdmissionKind,
  isMergedPrDetail,
  isNonProseSessionBranchLink,
  MERGED_PR_DETAIL_WHERE,
  linkDeclaresAdmittedPr,
  mergedPrLinkedBranches,
  sessionBranchNonProseLinkArm,
  SessionPrLinkAudience,
  sessionPrLinkFromSessions,
  sessionPrLinkWhere,
} = await import("./session-pr-links");

describe("delivery Branch admission metadata", () => {
  const detail = {
    number: 7,
    prState: GitHubPRState.Merged,
    mergedAt: new Date("2026-07-15T12:00:00.000Z"),
    isCurrent: true,
    lastVerifiedAt: new Date("2026-07-15T11:00:00.000Z"),
    repositoryId: "repo-1",
    repositoryFullName: "acme/repo",
    repository: { fullName: "acme/repo" },
    branchArtifact: {
      id: "branch-1",
      _count: { pullRequestDetails: 1 },
    },
  };

  it("allows unique-Branch fallback only for valid legacy metadata", () => {
    const index = buildSessionPrAdmissionIndex(
      [
        {
          targetId: "branch-1",
          metadata: { linkKind: SessionArtifactLinkKind.SessionPr },
        },
      ],
      new Map([["branch-1", 1]])
    );

    // The unique-Branch legacy arm admits with NO identity: a branch carrying
    // exactly one PR has no ambiguity for a later reader to resolve.
    expect(mergedPrLinkedBranches(detail, index)).toEqual([
      {
        branchArtifactId: "branch-1",
        admissionKind: MergedPrBranchAdmissionKind.LegacyUniqueBranch,
        prIdentity: null,
      },
    ]);
  });

  it("admits a unique repository-less branch through command-derived tier-two evidence", () => {
    const index = buildSessionPrAdmissionIndex(
      [
        {
          targetId: "branch-1",
          branchParticipation: BranchParticipationKind.Wrote,
          metadata: {
            linkKind: SessionArtifactLinkKind.SessionBranch,
            linkKinds: [SessionArtifactLinkKind.SessionBranch],
          },
        },
      ],
      new Map([["branch-1", 1]])
    );

    expect(
      mergedPrLinkedBranches({ ...detail, repositoryId: null }, index)
    ).toEqual([
      {
        branchArtifactId: "branch-1",
        admissionKind: MergedPrBranchAdmissionKind.TierTwoUniqueBranch,
        prIdentity: null,
      },
    ]);
    expect(mergedPrLinkedBranches(detail, index)).toEqual([]);
    const reusedBranchIndex = buildSessionPrAdmissionIndex(
      [
        {
          targetId: "branch-1",
          branchParticipation: BranchParticipationKind.Wrote,
          metadata: {
            linkKind: SessionArtifactLinkKind.SessionBranch,
            linkKinds: [SessionArtifactLinkKind.SessionBranch],
          },
        },
      ],
      new Map([["branch-1", 2]])
    );
    expect(
      mergedPrLinkedBranches(
        { ...detail, repositoryId: null },
        reusedBranchIndex
      )
    ).toEqual([]);
  });

  it("does not admit tier-two branch evidence from prose or review-only links", () => {
    const index = buildSessionPrAdmissionIndex(
      [
        {
          targetId: "branch-1",
          branchParticipation: BranchParticipationKind.Reviewed,
          metadata: {
            linkKind: SessionArtifactLinkKind.SessionBranch,
            linkKinds: [SessionArtifactLinkKind.SessionBranch],
          },
        },
        {
          targetId: "branch-2",
          metadata: {
            linkKind: SessionArtifactLinkKind.SessionBranch,
            method: ArtifactRefMethod.BranchMentionInProse,
          },
        },
      ],
      new Map([
        ["branch-1", 1],
        ["branch-2", 1],
      ])
    );

    expect(
      mergedPrLinkedBranches({ ...detail, repositoryId: null }, index)
    ).toEqual([]);
    expect(
      mergedPrLinkedBranches(
        {
          ...detail,
          repositoryId: null,
          branchArtifact: {
            id: "branch-2",
            _count: { pullRequestDetails: 1 },
          },
        },
        index
      )
    ).toEqual([]);
  });

  it.each([
    [
      "canonical empty",
      { linkKind: SessionArtifactLinkKind.SessionPr, prRefs: [] },
    ],
    [
      "stale scalar plus empty",
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
    // ISS-8051 retired a fourth shape here: an over-500 `prRefs` array, which
    // this table asserted failed closed. That was the defect — the read schema's
    // `.max()` made `safeParse` fail, which classifies as `invalid` and discards
    // the whole stored PR set of a link the cloud had already accepted and
    // written. The expectation itself changed rather than being weakened to
    // pass; the admitting behavior that replaced it is asserted directly below.
    [
      "set marker without array",
      {
        linkKind: SessionArtifactLinkKind.SessionBranch,
        linkKinds: [SessionArtifactLinkKind.SessionPrSet],
      },
    ],
  ])("fails closed for %s", (_label, metadata) => {
    const index = buildSessionPrAdmissionIndex(
      [{ targetId: "branch-1", metadata }],
      new Map([["branch-1", 1]])
    );

    expect(mergedPrLinkedBranches(detail, index)).toEqual([]);
  });

  it("admits a branch from metadata holding more refs than the retired cap", () => {
    // 501 is one past the retired 500 ceiling (ISS-9859 deleted its constant):
    // a wire-shaped row that size now reaches admission.
    const index = buildSessionPrAdmissionIndex(
      [
        {
          targetId: "branch-1",
          metadata: {
            linkKind: SessionArtifactLinkKind.SessionPr,
            prRefs: Array.from({ length: 501 }, (_unused, offset) => ({
              repositoryFullName: "acme/repo",
              prNumber: offset + 1,
              relationTypes: [],
            })),
          },
        },
      ],
      new Map([["branch-1", 1]])
    );

    // Not merely non-empty: the branch is admitted by the SPECIFIC identity the
    // detail names, proving the over-cap refs were read back and matched rather
    // than the unique-Branch legacy arm quietly admitting with a null identity.
    expect(mergedPrLinkedBranches(detail, index)).toEqual([
      {
        branchArtifactId: "branch-1",
        admissionKind: MergedPrBranchAdmissionKind.ExactIdentity,
        prIdentity: "acme/repo#7",
      },
    ]);
  });

  it("admits a link carrying more refs than the retired read bound (ISS-8064)", () => {
    // Previously in the fail-closed table above: the persisted read schema's
    // `.max(500)` made an over-bound link parse Invalid, so its branches
    // silently dropped out of admission with no error and no log.
    const prRefs = Array.from({ length: 501 }, (_, index) => ({
      repositoryFullName: "acme/repo",
      prNumber: index + 1,
      relationTypes: [],
    }));

    const index = buildSessionPrAdmissionIndex(
      [
        {
          targetId: "branch-1",
          metadata: { linkKind: SessionArtifactLinkKind.SessionPr, prRefs },
        },
      ],
      new Map([["branch-1", 1]])
    );

    expect(mergedPrLinkedBranches(detail, index)).not.toEqual([]);
    expect(mergedPrLinkedBranches(detail, index)).toHaveLength(1);
  });
});

describe("branch-evidence admission (ISS-7905)", () => {
  function detailOn(
    branchId: string,
    number: number,
    prCount: number,
    repositoryId: string | null = "repo-1"
  ) {
    return {
      number,
      prState: GitHubPRState.Merged,
      mergedAt: new Date("2026-07-15T12:00:00.000Z"),
      isCurrent: true,
      lastVerifiedAt: new Date("2026-07-15T11:00:00.000Z"),
      repositoryId,
      repositoryFullName: "acme/repo",
      repository: repositoryId === null ? null : { fullName: "acme/repo" },
      branchArtifact: {
        id: branchId,
        _count: { pullRequestDetails: prCount },
      },
    };
  }

  function indexFor(metadata: unknown, branchId = "branch-1", prCount = 2) {
    return buildSessionPrAdmissionIndex(
      [{ targetId: branchId, metadata }],
      new Map([[branchId, prCount]])
    );
  }

  const branchLink = {
    linkKind: SessionArtifactLinkKind.SessionBranch,
    linkKinds: [SessionArtifactLinkKind.SessionBranch],
  };

  it("admits a repository-less unique branch on a non-prose session→branch link", () => {
    // The installation-free / desktop lane at rest: the PR row was materialized
    // from the session's artifact refs and NO session→PR link was ever written
    // (`persistSessionPullRequestDetails` — "this lane writes no link"). Before
    // ISS-7905 this returned `[]`, so `mergedPrCount` was a confident `null`
    // while Insights Delivery counted the same row.
    expect(
      mergedPrLinkedBranches(
        detailOn("branch-1", 7, 1, null),
        indexFor(branchLink, "branch-1", 1)
      )
    ).toEqual([
      {
        admissionKind: MergedPrBranchAdmissionKind.TierTwoUniqueBranch,
        branchArtifactId: "branch-1",
        prIdentity: null,
      },
    ]);
  });

  it("does NOT admit on a prose-derived session→branch link", () => {
    // The sibling of the case above in the opposite state: prose evidence must
    // not move a count (ISS-5823), and the branch arm is not a way back in.
    expect(
      mergedPrLinkedBranches(
        detailOn("branch-1", 7, 2),
        indexFor({ ...branchLink, method: ArtifactRefMethod.PrMentionInProse })
      )
    ).toEqual([]);
  });

  it("keeps per-PR admission governing when the branch names a PR (ISS-8265)", () => {
    // A REUSED branch carrying BOTH a session→branch link and a session→PR link
    // naming #7. The accepted ISS-7705 narrowing must survive: #7 is admitted by
    // its identity, and the unlinked #9 is still refused — the branch arm does
    // not blanket-admit a branch that has already named its PR.
    const index = buildSessionPrAdmissionIndex(
      [
        { targetId: "branch-1", metadata: branchLink },
        {
          targetId: "branch-1",
          metadata: {
            linkKind: SessionArtifactLinkKind.SessionPr,
            prRefs: [
              {
                repositoryFullName: "acme/repo",
                prNumber: 7,
                relationTypes: [SessionPrRelationType.Created],
              },
            ],
          },
        },
      ],
      new Map([["branch-1", 2]])
    );

    expect(mergedPrLinkedBranches(detailOn("branch-1", 7, 2), index)).toEqual([
      {
        admissionKind: MergedPrBranchAdmissionKind.ExactIdentity,
        branchArtifactId: "branch-1",
        prIdentity: "acme/repo#7",
      },
    ]);
    expect(mergedPrLinkedBranches(detailOn("branch-1", 9, 2), index)).toEqual(
      []
    );
  });

  it("still fails closed on invalid identity metadata", () => {
    // The one deliberate asymmetry with the query arm: a `session_pr_set` marker
    // with no array classifies Invalid, and branch-level evidence must not
    // reopen a shape the identity contract already refuses.
    expect(
      isNonProseSessionBranchLink({
        linkKind: SessionArtifactLinkKind.SessionBranch,
        linkKinds: [SessionArtifactLinkKind.SessionPrSet],
      })
    ).toBe(false);
    expect(isNonProseSessionBranchLink(branchLink)).toBe(true);
  });

  it("mirrors the arm on the LINK side so the coverage probe agrees", () => {
    // `linkDeclaresAdmittedPr` is the inverse of the admission above. If it
    // answered only the legacy unique-Branch arm, the LOC/$ coverage probe would
    // find zero sessions behind lines the numerator had just counted and publish
    // `complete` over an unmeasured cohort.
    const admitted = {
      identities: new Set<string>(),
      legacyUniqueFallback: true,
      tierTwoUniqueBranchFallback: true,
    };

    expect(linkDeclaresAdmittedPr(branchLink, admitted)).toBe(true);
    expect(
      linkDeclaresAdmittedPr(
        { ...branchLink, method: ArtifactRefMethod.BranchMentionInProse },
        admitted
      )
    ).toBe(false);
    // A branch that was never admitted with a null identity still refuses it.
    expect(
      linkDeclaresAdmittedPr(branchLink, {
        identities: new Set(["acme/repo#7"]),
        legacyUniqueFallback: false,
        tierTwoUniqueBranchFallback: false,
      })
    ).toBe(false);
  });
});

describe("sessionPrLinkWhere", () => {
  it("selects legacy single-PR and canonical multi-PR links for metrics", () => {
    expect(sessionPrLinkWhere(SessionPrLinkAudience.Metric)).toEqual({
      linkType: LinkType.RelatesTo,
      OR: [
        {
          metadata: {
            path: ["linkKind"],
            equals: SessionArtifactLinkKind.SessionPr,
          },
        },
        {
          metadata: {
            path: ["linkKinds"],
            array_contains: [SessionArtifactLinkKind.SessionPrSet],
          },
        },
      ],
    });
  });

  it("adds BOTH prose arms for the evidence audience (ISS-5823)", () => {
    // Review cid 3839614162: only the Metric shape was pinned, so the Evidence
    // predicate's two NEW arms were untested — and they are not redundant with
    // each other. A prose-only link states its tier in the scalar `linkKind`;
    // a link that ALSO carries independent branch evidence keeps
    // `linkKind: session_branch` and states the weak PR tier only in the
    // `linkKinds` array, so the scalar arm alone would leave those rows
    // invisible to the lanes that own them — the orphaning this audience exists
    // to prevent.
    expect(sessionPrLinkWhere(SessionPrLinkAudience.Evidence)).toEqual({
      linkType: LinkType.RelatesTo,
      OR: [
        {
          metadata: {
            path: ["linkKind"],
            equals: SessionArtifactLinkKind.SessionPr,
          },
        },
        {
          metadata: {
            path: ["linkKinds"],
            array_contains: [SessionArtifactLinkKind.SessionPrSet],
          },
        },
        {
          metadata: {
            path: ["linkKind"],
            equals: SessionArtifactLinkKind.SessionPrProse,
          },
        },
        {
          metadata: {
            path: ["linkKinds"],
            array_contains: [SessionArtifactLinkKind.SessionPrProse],
          },
        },
      ],
    });
  });

  it("keeps the two audiences different, and only by the prose arms", () => {
    // The relationship IS the contract: Evidence is Metric plus prose, strictly.
    // Asserting each shape alone would stay green if both collapsed onto the
    // same predicate — which is precisely the regression that would silently
    // readmit prose-derived links into every metric this ticket gates.
    const metric = sessionPrLinkWhere(SessionPrLinkAudience.Metric);
    const evidence = sessionPrLinkWhere(SessionPrLinkAudience.Evidence);

    expect(evidence).not.toEqual(metric);
    expect(evidence.OR).toEqual([
      ...(metric.OR ?? []),
      ...evidence.OR!.slice(2),
    ]);
  });
});

describe("MERGED_PR_DETAIL_WHERE", () => {
  // The row this builds is derived FROM the mirror's own values, so the case
  // fails if either half of the pair moves: loosening/tightening
  // `isMergedPrDetail` breaks the accept assertion, and changing the mirror to a
  // value `isMergedPrDetail` rejects breaks it too. Asserting the const against
  // a second hand-written literal would pin neither.
  function detailMatching(mirror: typeof MERGED_PR_DETAIL_WHERE) {
    return {
      lastVerifiedAt: new Date("2026-07-15T11:00:00.000Z"),
      prState: mirror.prState,
      mergedAt: new Date("2026-07-15T12:00:00.000Z"),
      number: 1,
      repositoryFullName: "acme/repo",
      repository: { fullName: "acme/repo" },
    };
  }

  it("accepts exactly what isMergedPrDetail accepts", () => {
    const detail = detailMatching(MERGED_PR_DETAIL_WHERE);

    expect(isMergedPrDetail(detail)).toBe(true);
    // Each column the mirror constrains, violated one at a time.
    expect(isMergedPrDetail({ ...detail, prState: GitHubPRState.Open })).toBe(
      false
    );
    expect(isMergedPrDetail({ ...detail, mergedAt: null })).toBe(false);
    expect(isMergedPrDetail({ ...detail, lastVerifiedAt: null })).toBe(false);
  });

  it("constrains merge state, instant, and verification", () => {
    // A new column in the mirror without a matching clause in `isMergedPrDetail`
    // (or vice versa) is the drift this pins.
    expect(Object.keys(MERGED_PR_DETAIL_WHERE).sort()).toEqual([
      "lastVerifiedAt",
      "mergedAt",
      "prState",
    ]);
    expect(MERGED_PR_DETAIL_WHERE.mergedAt).toEqual({ not: null });
  });
});

describe("findMergedPrsLinkedToSessions (ISS-6028)", () => {
  const ORGANIZATION_ID = "org-1";
  const where: Prisma.SessionDetailWhereInput = {
    artifact: { is: { createdById: "user-1" } },
  };
  const linkedBranchArtifact = {
    targetLinks: { some: deliveryPrLinkFromSessions(where) },
  };

  beforeEach(() => {
    pullRequestFindMany.mockClear();
    artifactLinkFindMany.mockClear();
  });

  function readArgs() {
    return pullRequestFindMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
      select: Record<string, unknown>;
      take?: number;
    };
  }

  // ISS-7905: the expectation MOVED, it was not loosened. The reader used to
  // semi-join through `sessionPrLinkFromSessions` (the session→PR arms alone);
  // it now joins through `deliveryPrLinkFromSessions`, which adds the non-prose
  // session→branch arm the ISS-8153 population already counts. The two helpers
  // are asserted to be DIFFERENT below, so this cannot pass by the widening
  // silently collapsing back onto the old predicate.
  it("reads the PR side, semi-joined back through the session-linked delivery links", async () => {
    await findMergedPrsLinkedToSessions(ORGANIZATION_ID, where, {
      number: true,
    });

    // The scan population is merged PRs — NOT sessions. The session `where`
    // survives inside the link semi-join, so the same scope is honored.
    expect(readArgs().where).toEqual({
      // Org-scoped in the statement itself (not only through the join): it is
      // the tenant boundary AND the leading column of the index this predicate
      // shape targets.
      organizationId: ORGANIZATION_ID,
      ...MERGED_PR_DETAIL_WHERE,
      branchArtifact: { is: linkedBranchArtifact },
    });
    expect(deliveryPrLinkFromSessions(where).source).toEqual({
      type: ArtifactType.Session,
      session: { is: where },
    });
  });

  it("selects the sanctioned session-linked arms, not the session→PR arms alone (ISS-7905)", () => {
    // The RELATIONSHIP is the contract, the same way the two audiences are
    // pinned above. Asserting the delivery shape alone would stay green if the
    // widening were reverted and both helpers collapsed onto the narrow
    // predicate — which is exactly the regression that re-blanks the card.
    const delivery = deliveryPrLinkFromSessions(where);
    const prOnly = sessionPrLinkFromSessions(where);

    expect(delivery).not.toEqual(prOnly);
    expect(delivery.OR).toEqual([
      ...(prOnly.OR ?? []),
      sessionBranchNonProseLinkArm(),
    ]);
    // Same source-session scope on both: the widening is about which LINK
    // shapes count, never about which sessions the card is measured over.
    expect(delivery.source).toEqual(prOnly.source);
    expect(delivery.linkType).toEqual(prOnly.linkType);
  });

  it("returns caller columns and reads matching link metadata separately", async () => {
    pullRequestFindMany.mockResolvedValueOnce([
      {
        number: 1,
        additions: 2,
        branchArtifact: {
          id: "branch-1",
          _count: { pullRequestDetails: 1 },
        },
      },
    ]);
    await findMergedPrsLinkedToSessions(ORGANIZATION_ID, where, {
      number: true,
      additions: true,
    });

    expect(readArgs().select).toEqual({
      number: true,
      additions: true,
      branchArtifact: {
        select: {
          id: true,
          _count: { select: { pullRequestDetails: true } },
        },
      },
    });
    expect(artifactLinkFindMany).toHaveBeenCalledWith({
      where: {
        ...deliveryPrLinkFromSessions(where),
        targetId: { in: ["branch-1"] },
      },
      select: { targetId: true, metadata: true, branchParticipation: true },
    });
  });

  it("loads link metadata once for 500 PR candidates on one Branch", async () => {
    pullRequestFindMany.mockResolvedValueOnce(
      Array.from({ length: 500 }, (_, index) => ({
        number: index + 1,
        branchArtifact: {
          id: "branch-reused",
          _count: { pullRequestDetails: 500 },
        },
      }))
    );

    await findMergedPrsLinkedToSessions(ORGANIZATION_ID, where, {
      number: true,
    });

    expect(pullRequestFindMany).toHaveBeenCalledTimes(1);
    expect(artifactLinkFindMany).toHaveBeenCalledTimes(1);
    expect(artifactLinkFindMany.mock.calls[0]?.[0]).toMatchObject({
      where: { targetId: { in: ["branch-reused"] } },
      select: { targetId: true, metadata: true, branchParticipation: true },
    });
  });

  it("does NOT cap the read (whole-population aggregates)", async () => {
    await findMergedPrsLinkedToSessions(ORGANIZATION_ID, where, {
      number: true,
    });

    // mergedPrCount and medianPrSize are whole-population figures over the
    // scope; a `take` would silently understate both rather than truncate
    // something the caller could report as partial.
    expect(readArgs().take).toBeUndefined();
  });
});

describe("mergedPrLinkedBranches — the admitting identity (ISS-7705)", () => {
  const detail = {
    number: 7,
    prState: GitHubPRState.Merged,
    mergedAt: new Date("2026-07-15T12:00:00.000Z"),
    isCurrent: true,
    lastVerifiedAt: new Date("2026-07-15T11:00:00.000Z"),
    repositoryFullName: "acme/repo",
    repository: { fullName: "acme/repo" },
    branchArtifact: { id: "branch-reused", _count: { pullRequestDetails: 2 } },
  };

  it("reports WHICH PR identity admitted the branch, not just the branch", () => {
    // A REUSED branch: two PRs, so the unique-branch fallback cannot apply and
    // the exact identity is the only thing that admits. Returning the branch id
    // alone here is what let a downstream branch-scoped read pull the OTHER PR's
    // sessions into the LOC/$ numerator cohort.
    const index = buildSessionPrAdmissionIndex(
      [
        {
          targetId: "branch-reused",
          metadata: {
            linkKind: SessionArtifactLinkKind.SessionPr,
            prRefs: [
              {
                repositoryFullName: "acme/repo",
                prNumber: 7,
                relationTypes: [],
              },
              {
                repositoryFullName: "acme/repo",
                prNumber: 8,
                relationTypes: [],
              },
            ],
          },
        },
      ],
      new Map([["branch-reused", 2]])
    );

    expect(mergedPrLinkedBranches(detail, index)).toEqual([
      {
        branchArtifactId: "branch-reused",
        admissionKind: MergedPrBranchAdmissionKind.ExactIdentity,
        prIdentity: "acme/repo#7",
      },
    ]);
  });

  it("admits a PR-derived Branch link by exact identity, not branch fallback", () => {
    const index = buildSessionPrAdmissionIndex(
      [
        {
          targetId: "branch-reused",
          branchParticipation: BranchParticipationKind.Wrote,
          metadata: {
            linkKind: SessionArtifactLinkKind.SessionPr,
            linkKinds: [
              SessionArtifactLinkKind.SessionBranch,
              SessionArtifactLinkKind.SessionPr,
            ],
            branchName: "feat/reused",
            branchRepositoryFullName: "acme/repo",
            repositoryFullName: "acme/repo",
            prNumber: 7,
            prRefs: [
              {
                repositoryFullName: "acme/repo",
                prNumber: 7,
                relationTypes: [SessionPrRelationType.Created],
              },
            ],
          },
        },
      ],
      new Map([["branch-reused", 2]])
    );

    expect(mergedPrLinkedBranches(detail, index)).toEqual([
      {
        branchArtifactId: "branch-reused",
        admissionKind: MergedPrBranchAdmissionKind.ExactIdentity,
        prIdentity: "acme/repo#7",
      },
    ]);
    expect(
      mergedPrLinkedBranches(
        {
          ...detail,
          number: 9,
        },
        index
      )
    ).toEqual([]);
  });
});

describe("linkDeclaresAdmittedPr — the link-side mirror (ISS-7705)", () => {
  const admittedSeven = {
    identities: new Set(["acme/repo#7"]),
    legacyUniqueFallback: false,
    tierTwoUniqueBranchFallback: false,
  };

  it("does NOT admit on prose-derived evidence, matching the branch side (ISS-5823)", () => {
    // The lockstep invariant this predicate's own docstring calls "arm for arm".
    // `buildSessionPrAdmissionIndex` builds `exactIdentities` from the
    // COMMAND-DERIVED refs only, so a prose mention never buys its PR admission
    // on the branch side. Reading the full ref set here would break the mirror
    // in the one direction that is silent: the branch refuses the PR while this
    // side keeps admitting the link that declared it, and the link's session
    // goes on being pulled into a cost-bearing read through the weaker signal.
    //
    // The link keeps the strong `SessionPr` kind on purpose — that is exactly
    // the case the link-level predicate cannot separate, and the per-ref
    // `method` discriminator is what does.
    expect(
      linkDeclaresAdmittedPr(
        {
          linkKind: SessionArtifactLinkKind.SessionPr,
          prRefs: [
            {
              repositoryFullName: "acme/repo",
              prNumber: 7,
              relationTypes: [],
              method: ArtifactRefMethod.PrMentionInProse,
            },
          ],
        },
        admittedSeven
      )
    ).toBe(false);
  });

  it("still admits a ref carrying no method at all", () => {
    // Anti-vacuity, and a real compatibility arm: a row written before ISS-5823
    // carries no `method` and came from the command-derived carrier, so absent
    // must NOT read as prose. Without this case, narrowing the extractor to
    // "only refs with an explicitly command-derived method" would pass the case
    // above while silently dropping every pre-ISS-5823 link.
    expect(
      linkDeclaresAdmittedPr(
        {
          linkKind: SessionArtifactLinkKind.SessionPr,
          prRefs: [
            { repositoryFullName: "acme/repo", prNumber: 7, relationTypes: [] },
          ],
        },
        admittedSeven
      )
    ).toBe(true);
  });

  it("admits a link declaring the admitted PR", () => {
    expect(
      linkDeclaresAdmittedPr(
        {
          linkKind: SessionArtifactLinkKind.SessionPr,
          prRefs: [
            { repositoryFullName: "acme/repo", prNumber: 7, relationTypes: [] },
          ],
        },
        admittedSeven
      )
    ).toBe(true);
  });

  it("rejects a link declaring a DIFFERENT PR on the same reused branch", () => {
    // The whole point: PR #8's session never contributed a line to the window
    // that admitted PR #7, so it must not be measured as if it had.
    expect(
      linkDeclaresAdmittedPr(
        {
          linkKind: SessionArtifactLinkKind.SessionPr,
          prRefs: [
            { repositoryFullName: "acme/repo", prNumber: 8, relationTypes: [] },
          ],
        },
        admittedSeven
      )
    ).toBe(false);
  });

  it("admits a legacy fallback link only when the branch was admitted that way", () => {
    const legacyMetadata = { linkKind: SessionArtifactLinkKind.SessionPr };

    expect(
      linkDeclaresAdmittedPr(legacyMetadata, {
        identities: new Set<string>(),
        legacyUniqueFallback: true,
        tierTwoUniqueBranchFallback: false,
      })
    ).toBe(true);
    // Mirrors `mergedPrLinkedBranches`: a branch admitted purely by exact
    // identity does not admit the identity-less links that share it.
    expect(linkDeclaresAdmittedPr(legacyMetadata, admittedSeven)).toBe(false);
  });

  it("admits a tier-two fallback link only when the branch was admitted that way", () => {
    const branchMetadata = {
      linkKind: SessionArtifactLinkKind.SessionBranch,
      linkKinds: [SessionArtifactLinkKind.SessionBranch],
    };
    const admittedByTierTwoBranch = {
      identities: new Set<string>(),
      legacyUniqueFallback: false,
      tierTwoUniqueBranchFallback: true,
    };

    expect(
      linkDeclaresAdmittedPr(
        branchMetadata,
        admittedByTierTwoBranch,
        BranchParticipationKind.Wrote
      )
    ).toBe(true);
    expect(
      linkDeclaresAdmittedPr(
        { ...branchMetadata, method: ArtifactRefMethod.BranchMentionInProse },
        admittedByTierTwoBranch,
        BranchParticipationKind.Wrote
      )
    ).toBe(false);
    expect(
      linkDeclaresAdmittedPr(
        { linkKind: SessionArtifactLinkKind.SessionPr },
        admittedByTierTwoBranch
      )
    ).toBe(false);
  });

  it("rejects every link for a branch that was never admitted", () => {
    expect(
      linkDeclaresAdmittedPr(
        { linkKind: SessionArtifactLinkKind.SessionPr },
        undefined
      )
    ).toBe(false);
  });
});
