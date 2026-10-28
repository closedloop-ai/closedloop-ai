import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import { BranchParticipationKind } from "@repo/api/src/types/branch";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import {
  ArtifactRefMethod,
  SessionArtifactLinkKind,
  sessionPrIdentityKey,
} from "@repo/api/src/types/session-artifact-link";
import { Prisma } from "@repo/database";
import { describe, expect, it, vi } from "vitest";
import {
  filterOrgMergedPullRequestDetails,
  isOrgPullRequestMetricDetail,
  type OrgPullRequestMetricDetail,
  orgMergedPullRequestMembershipSql,
  readOrgMergedPullRequestAdmissionByBranchId,
  sessionLinkedPullRequestLinkWhere,
  sessionLinkedPullRequestMembershipSql,
} from "./pull-request-population";
import { sessionBranchPrPopulationLinkWhere } from "./session-pr-links";

describe("sessionLinkedPullRequestLinkWhere", () => {
  it("scopes the link to session sources on the RELATES_TO edge, excluding prose kinds", () => {
    const link = sessionLinkedPullRequestLinkWhere("org-1");
    // Source org check: a foreign-org session must not admit (see the
    // builder's comment; the schema does not force source org = link org).
    expect(link.source).toEqual({
      type: ArtifactType.Session,
      organizationId: "org-1",
    });
    expect(link.linkType).toBe(LinkType.RelatesTo);
    // Index reachability: every artifact_links index is org-leading, so the
    // link filter carries the org even though callers scope the branch.
    expect(link.organizationId).toBe("org-1");
    // The two strong session→PR kinds plus the non-prose session→branch arm
    // shared by the Delivery population.
    expect(link.OR).toEqual([
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
        AND: [
          {
            OR: [
              {
                metadata: {
                  path: ["linkKind"],
                  equals: SessionArtifactLinkKind.SessionBranch,
                },
              },
              {
                metadata: {
                  path: ["linkKinds"],
                  array_contains: [SessionArtifactLinkKind.SessionBranch],
                },
              },
            ],
          },
          // A prose-derived branch mention must not admit (ISS-5823): the arm
          // matches the reconciler's NOT-prose gate, not a push-method
          // allowlist. ISS-7905: the absent-`method` arm is load-bearing rather
          // than defensive — a bare `NOT` over this JSON path is SQL NULL when
          // the key is missing, which is the desktop lane's own shape, so the
          // arm selected almost nothing. `orgMergedPullRequestMembershipSql`
          // below spells the same guard with `COALESCE(metadata ? 'method',
          // FALSE)`, and the Postgres behaviour is pinned in
          // `agent-session-delivery-metrics.integration.test.ts`.
          {
            OR: [
              { metadata: { path: ["method"], equals: Prisma.AnyNull } },
              {
                NOT: {
                  OR: [
                    {
                      metadata: {
                        path: ["method"],
                        equals: ArtifactRefMethod.PrMentionInProse,
                      },
                    },
                    {
                      metadata: {
                        path: ["method"],
                        equals: ArtifactRefMethod.BranchMentionInProse,
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ]);
  });
});

describe("orgMergedPullRequestMembershipSql", () => {
  it("mirrors exact session-to-PR admission over the p alias", () => {
    const sql = orgMergedPullRequestMembershipSql("org-1");
    const text = sql.sql;
    expect(text).toContain("p.last_verified_at IS NOT NULL");
    // Org-leading, so the EXISTS walks the org-leading artifact_links index.
    expect(text).toContain("al.organization_id =");
    expect(text).toContain("sa.organization_id =");
    expect(text).toContain("al.target_id = p.branch_artifact_id");
    expect(text).toContain("FROM github_installation_repositories");
    expect(text).toContain("jsonb_array_elements(CASE");
    expect(text).toContain("jsonb_typeof(al.metadata) = 'object'");
    expect(text).toContain("IS DISTINCT FROM 'array'");
    expect(text).toContain("p.number::text");
    expect(text).not.toContain("::int");
    expect(text).toContain(
      "sibling_pr.branch_artifact_id = p.branch_artifact_id"
    );
    expect(text).toContain("REGEXP_REPLACE");
    expect(text).toContain("SELECT pr_repository.full_name");
    expect(text).toContain("BTRIM(COALESCE(");
    expect(sql.values).toEqual(
      expect.arrayContaining(["^/+", "/+$", "%.git", 4])
    );
    // No provenance arm survives in the SQL dialect either.
    expect(text).not.toContain("fetch_mechanism");
    expect(text).not.toContain("fetch_credential_type");
    expect(text).not.toContain("github_id");
    expect(sql.values).toEqual(
      expect.arrayContaining([
        "org-1",
        LinkType.RelatesTo,
        ArtifactType.Session,
        SessionArtifactLinkKind.SessionPr,
        JSON.stringify([SessionArtifactLinkKind.SessionPrSet]),
        SessionArtifactLinkKind.SessionPrProse,
        SessionArtifactLinkKind.SessionBranch,
        ArtifactRefMethod.PrMentionInProse,
        ArtifactRefMethod.BranchMentionInProse,
      ])
    );
  });

  /**
   * ISS-8424 + ISS-8426: the census's linked probe is this predicate with the
   * verification clause removed, so it must be this predicate's own text.
   *
   * A substring assertion rather than a shape one, because the two used to be
   * separate spellings that agreed by review alone: the census's half then
   * stopped at the Metric link kinds while this one went on to require the link
   * to NAME the row's `repo#number`, so a merged row admitted by neither made
   * the census report a pending measurement over a population the count had
   * already measured as 0. Re-forking them fails here.
   */
  it("is the census linkage predicate plus the verification clause", () => {
    const merged = orgMergedPullRequestMembershipSql("org-1").sql;
    const linked = sessionLinkedPullRequestMembershipSql("org-1").sql;

    expect(merged).toContain(linked);
    expect(linked).not.toContain("p.last_verified_at IS NOT NULL");
    // The identity conjunct is what separates a candidate row from any row on a
    // session-linked branch, and the census has to apply it too.
    expect(linked).toContain("jsonb_typeof(al.metadata) = 'object'");
    expect(linked).toContain("p.number::text");
  });
});

describe("org merged pull request admission helpers", () => {
  it("admits exact PR identities without admitting a reused branch sibling", () => {
    const admitted = detail({ id: "admitted", number: 1 });
    const unlinkedSibling = detail({ id: "unlinked", number: 2 });
    const closed = detail({
      id: "closed",
      number: 3,
      prState: GitHubPRState.Closed,
      mergedAt: null,
    });
    const admissionByBranchId = new Map([
      [
        "branch-1",
        {
          exactIdentities: new Set([
            sessionPrIdentityKey("closedloop-ai/closedloop-ai", 1),
            sessionPrIdentityKey("closedloop-ai/closedloop-ai", 3),
          ]),
          legacyUniqueFallback: true,
          tierTwoUniqueBranchFallback: false,
          branchEvidence: false,
          pullRequestCount: 3,
        },
      ],
    ]);

    expect(
      filterOrgMergedPullRequestDetails(
        [admitted, unlinkedSibling, closed],
        admissionByBranchId
      )
    ).toEqual([admitted]);
    expect(isOrgPullRequestMetricDetail(closed, admissionByBranchId)).toBe(
      true
    );
  });

  it("matches repository identity through canonical normalization", () => {
    const admitted = detail({ id: "admitted", number: 7 });
    const admissionByBranchId = new Map([
      [
        "branch-1",
        {
          exactIdentities: new Set([
            sessionPrIdentityKey("/ClosedLoop-AI/ClosedLoop-AI.git/", 7),
          ]),
          legacyUniqueFallback: false,
          tierTwoUniqueBranchFallback: false,
          branchEvidence: false,
          pullRequestCount: 1,
        },
      ],
    ]);

    expect(
      filterOrgMergedPullRequestDetails([admitted], admissionByBranchId)
    ).toEqual([admitted]);
  });

  it("keeps the legacy fallback unique to one-PR branches", () => {
    const onlyPullRequest = detail({
      branchArtifact: {
        id: "legacy-branch",
        _count: { pullRequestDetails: 1 },
      },
    });
    const reusedBranchPullRequest = detail({
      branchArtifact: {
        id: "reused-branch",
        _count: { pullRequestDetails: 2 },
      },
    });
    const admissionByBranchId = new Map([
      [
        "legacy-branch",
        {
          exactIdentities: new Set<string>(),
          legacyUniqueFallback: true,
          tierTwoUniqueBranchFallback: false,
          branchEvidence: false,
          pullRequestCount: 1,
        },
      ],
      [
        "reused-branch",
        {
          exactIdentities: new Set<string>(),
          legacyUniqueFallback: true,
          tierTwoUniqueBranchFallback: false,
          branchEvidence: false,
          pullRequestCount: 2,
        },
      ],
    ]);

    expect(
      filterOrgMergedPullRequestDetails(
        [onlyPullRequest, reusedBranchPullRequest],
        admissionByBranchId
      )
    ).toEqual([onlyPullRequest]);
  });

  it("admits repository-less tier-two rows only through a unique command-linked branch", () => {
    const admitted = detail({
      id: "tier-two",
      repositoryId: null,
      repository: null,
    });
    const installed = detail({
      id: "installed",
      branchArtifact: {
        id: "installed-branch",
        _count: { pullRequestDetails: 1 },
      },
    });
    const reused = detail({
      id: "reused",
      repositoryId: null,
      repository: null,
      branchArtifact: {
        id: "reused-branch",
        _count: { pullRequestDetails: 2 },
      },
    });
    const admissionByBranchId = new Map([
      [
        "branch-1",
        {
          exactIdentities: new Set<string>(),
          legacyUniqueFallback: false,
          tierTwoUniqueBranchFallback: true,
          branchEvidence: true,
          pullRequestCount: 1,
        },
      ],
      [
        "installed-branch",
        {
          exactIdentities: new Set<string>(),
          legacyUniqueFallback: false,
          tierTwoUniqueBranchFallback: true,
          branchEvidence: true,
          pullRequestCount: 1,
        },
      ],
      [
        "reused-branch",
        {
          exactIdentities: new Set<string>(),
          legacyUniqueFallback: false,
          tierTwoUniqueBranchFallback: true,
          branchEvidence: true,
          pullRequestCount: 2,
        },
      ],
    ]);

    expect(
      filterOrgMergedPullRequestDetails(
        [admitted, installed, reused],
        admissionByBranchId
      )
    ).toEqual([admitted]);
  });

  /**
   * ISS-8265 review (whitlockk, codex on PR #6246): both arms compose ONE metadata
   * decision.
   *
   * The guard used to be reachable only from the session→PR arm, so a
   * session→branch link whose `prRefs` is a scalar — which
   * `parseSessionPrLinkMetadata` and `isNonProseSessionBranchLink` both reject —
   * was admitted by this dialect alone, and the SQL totals then counted a PR the
   * Prisma scan and the Delivery rows dropped.
   *
   * Asserted per ALIAS rather than on the whole statement, because a guard on
   * `al.metadata` alone satisfies any assertion that only asks whether the text
   * appears somewhere: the branch arm reads `branch_link.metadata`, so naming
   * that alias is what makes the assertion able to fail.
   *
   * The behavioural twin runs against real Postgres in
   * `delivery-cross-surface-reused-branch.integration.test.ts`, which seeds the
   * malformed link and the well-formed control and reads both dialects.
   */
  it("guards link metadata on the branch arm, not only the session-to-PR arm", () => {
    const text = sessionLinkedPullRequestMembershipSql("org-1").sql;

    for (const alias of ["al.metadata", "branch_link.metadata"]) {
      expect(text).toContain(`jsonb_typeof(${alias}) = 'object'`);
      expect(text).toContain(`jsonb_typeof(${alias}->'linkKinds') = 'array'`);
      expect(text).toContain(`jsonb_typeof(${alias}->'prRefs') = 'array'`);
      expect(text).toContain(`jsonb_typeof(${alias}->'prNumber') = 'number'`);
    }
    // The full link schema's `method` is asserted on the branch arm ONLY: its
    // mirror parses `sessionPrLinkMetadataSchema`, while the session→PR arms
    // classify through the identity schema, which passes `method` through
    // unread. Asserting it on `al` too would narrow this dialect past its own
    // mirror — the same divergence pointing the other way.
    expect(text).toContain("jsonb_typeof(branch_link.metadata->'method')");
    expect(text).not.toContain("jsonb_typeof(al.metadata->'method')");
  });

  it("reads Metric session-to-PR links and builds the shared admission index", async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        targetId: "branch-1",
        metadata: {
          linkKind: SessionArtifactLinkKind.SessionPr,
          repositoryFullName: "closedloop-ai/closedloop-ai",
          prNumber: 7,
        },
      },
      {
        targetId: "branch-1",
        branchParticipation: BranchParticipationKind.Wrote,
        metadata: {
          linkKind: SessionArtifactLinkKind.SessionBranch,
          linkKinds: [SessionArtifactLinkKind.SessionBranch],
        },
      },
    ]);

    const admissionByBranchId =
      await readOrgMergedPullRequestAdmissionByBranchId(
        { artifactLink: { findMany } } as unknown as Parameters<
          typeof readOrgMergedPullRequestAdmissionByBranchId
        >[0],
        "org-1",
        [
          {
            branchArtifact: {
              id: "branch-1",
              _count: { pullRequestDetails: 1 },
            },
          },
        ]
      );

    expect(findMany).toHaveBeenCalledWith({
      where: {
        targetId: { in: ["branch-1"] },
        OR: [
          sessionLinkedPullRequestLinkWhere("org-1"),
          {
            organizationId: "org-1",
            ...sessionBranchPrPopulationLinkWhere(),
            source: { type: ArtifactType.Session, organizationId: "org-1" },
          },
        ],
      },
      select: { targetId: true, metadata: true, branchParticipation: true },
    });
    expect(
      admissionByBranchId
        .get("branch-1")
        ?.exactIdentities.has(
          sessionPrIdentityKey("closedloop-ai/closedloop-ai", 7)
        )
    ).toBe(true);
    expect(
      admissionByBranchId.get("branch-1")?.tierTwoUniqueBranchFallback
    ).toBe(true);
  });
});

function detail(
  overrides: Partial<OrgPullRequestMetricDetail & { id: string }> = {}
): OrgPullRequestMetricDetail & { id: string } {
  return { ...baseDetail(), ...overrides };
}

function baseDetail(): OrgPullRequestMetricDetail & { id: string } {
  return {
    id: "pr-1",
    number: 1,
    prState: GitHubPRState.Merged,
    mergedAt: new Date("2026-08-01T00:00:00.000Z"),
    lastVerifiedAt: new Date("2026-08-01T01:00:00.000Z"),
    repositoryId: "repo-1",
    repositoryFullName: "closedloop-ai/closedloop-ai",
    repository: { fullName: "closedloop-ai/closedloop-ai" },
    branchArtifact: {
      id: "branch-1",
      _count: { pullRequestDetails: 1 },
    },
  };
}
