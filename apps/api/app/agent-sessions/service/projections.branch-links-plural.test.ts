// ISS-8427: `AgentSessionDetail.branches` — every branch a session touched.
//
// The sibling `projections.branch-link.test.ts` covers the SCALAR
// `branchArtifactId`, and its only multi-link case carries exactly one `Wrote`
// branch, so nothing there ever ran a session with several eligible branches
// through the derivation. This file owns that fixture: the reported record's
// shape (five authored-PR branches, one pushed branch with no PR, two prose-only
// mentions), which is the population the scalar was silently choosing one of.

import { ArtifactType } from "@repo/api/src/types/artifact";
import { BranchParticipationKind } from "@repo/api/src/types/branch";
import {
  ArtifactRefRelation,
  SessionArtifactLinkKind,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSessionDetailRecord,
  installDb,
} from "@/__tests__/support/agent-sessions/service.test-harness";
import { agentSessionsService } from "../service";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return databaseModuleMock();
});

vi.mock("@repo/observability/telemetry/metrics", async () => {
  const { telemetryModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return telemetryModuleMock();
});

const REPOSITORY_FULL_NAME = "closedloop-ai/closedloop-ai";

/**
 * The reported session's own branch names and PR numbers, transcribed from
 * ISS-8427 rather than read back out of the derivation. The five authored-PR
 * branches are listed in the order their links were created, so the LAST is the
 * one the scalar `branch` renders today.
 */
const AUTHORED_PR_BRANCHES = [
  { branchName: "worktree-iss-5517-facet-counts", prNumber: 5517 },
  { branchName: "worktree-iss-5551-cost-rollup", prNumber: 5551 },
  { branchName: "worktree-iss-5705-status-fold", prNumber: 5705 },
  { branchName: "worktree-iss-5871-timeline-bands", prNumber: 5871 },
  { branchName: "worktree-iss-bundled-pr-page-size", prNumber: 5898 },
] as const;

const PUSHED_BRANCH_WITHOUT_PR = "worktree-pln-1775-m3-m5";

/** The two links the read-side gate drops: PRs the transcript merely named. */
const PROSE_ONLY_MENTIONS = [
  { branchName: "someone-elses/hotfix-auth", prNumber: 6001 },
  { branchName: "someone-elses/docs-pass", prNumber: 6002 },
] as const;

function branchArtifactIdFor(branchName: string): string {
  return `branch-artifact-${branchName}`;
}

function branchTarget(branchName: string) {
  return {
    id: branchArtifactIdFor(branchName),
    name: branchName,
    type: ArtifactType.Branch,
    branch: {
      repository: { fullName: REPOSITORY_FULL_NAME },
      currentPullRequestDetail: null,
    },
  };
}

/** A session→BRANCH link: a branch the session pushed but opened no PR from. */
function pushedBranchLink(branchName: string) {
  return {
    metadata: {
      linkKind: SessionArtifactLinkKind.SessionBranch,
      branchName,
      branchRepositoryFullName: REPOSITORY_FULL_NAME,
    },
    branchParticipation: BranchParticipationKind.Wrote,
    target: branchTarget(branchName),
  };
}

/** A session→PR link whose BRANCH target is the PR's head branch. */
function prLink({
  branchName,
  prNumber,
  relation,
  branchParticipation,
}: {
  branchName: string;
  prNumber: number;
  relation: SessionPrRelationType;
  branchParticipation?: BranchParticipationKind;
}) {
  return {
    metadata: {
      linkKind: SessionArtifactLinkKind.SessionPr,
      relationTypes: [relation],
      repositoryFullName: REPOSITORY_FULL_NAME,
      prNumber,
      source: "DETERMINISTIC",
      confidence: 1.0,
      extractorVersion: 1,
    },
    ...(branchParticipation ? { branchParticipation } : {}),
    target: branchTarget(branchName),
  };
}

/**
 * The reported record's link set, in `createdAt asc` order: the pushed branch
 * first, then the five authored PRs, then the two prose mentions.
 */
function reportedSessionLinks() {
  return [
    pushedBranchLink(PUSHED_BRANCH_WITHOUT_PR),
    ...AUTHORED_PR_BRANCHES.map((pr) =>
      prLink({
        branchName: pr.branchName,
        prNumber: pr.prNumber,
        relation: SessionPrRelationType.Created,
        branchParticipation: BranchParticipationKind.Wrote,
      })
    ),
    ...PROSE_ONLY_MENTIONS.map((mention) =>
      prLink({
        branchName: mention.branchName,
        prNumber: mention.prNumber,
        relation: SessionPrRelationType.Referenced,
      })
    ),
  ];
}

async function findDetail(sourceLinks: unknown[]) {
  installDb({
    sessionDetail: {
      findFirst: vi.fn().mockResolvedValue(
        buildSessionDetailRecord({
          artifact: {
            organizationId: "org-1",
            name: "Five-PR session",
            status: "completed",
            slug: "SES-8427",
            project: null,
            sourceLinks,
          },
        })
      ),
    },
  });
  return await agentSessionsService.findSessionDetail({
    id: "session-1",
    organizationId: "org-1",
  });
}

describe("AgentSessionDetail.branches (ISS-8427)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("serves every touched branch for a session that authored five PRs", async () => {
    const detail = await findDetail(reportedSessionLinks());
    // Written out rather than mapped from the fixture constants: a set derived
    // from the same arrays the links were built from would pass against any
    // derivation that echoes its input, including one that also echoed the two
    // prose mentions.
    expect(detail?.branches?.map((entry) => entry.name)).toEqual([
      "worktree-pln-1775-m3-m5",
      "worktree-iss-5517-facet-counts",
      "worktree-iss-5551-cost-rollup",
      "worktree-iss-5705-status-fold",
      "worktree-iss-5871-timeline-bands",
      "worktree-iss-bundled-pr-page-size",
    ]);
  });

  it("excludes the prose-only PR mentions the read-side gate already drops", async () => {
    const detail = await findDetail(reportedSessionLinks());
    const names = detail?.branches?.map((entry) => entry.name) ?? [];
    for (const mention of PROSE_ONLY_MENTIONS) {
      expect(names).not.toContain(mention.branchName);
    }
    expect(names).toContain(PUSHED_BRANCH_WITHOUT_PR);
  });

  it("keeps a branch reached by both a push link and its own PR link once", async () => {
    const detail = await findDetail([
      pushedBranchLink("worktree-iss-8427-plural"),
      prLink({
        branchName: "worktree-iss-8427-plural",
        prNumber: 8427,
        relation: SessionPrRelationType.Created,
        branchParticipation: BranchParticipationKind.Wrote,
      }),
    ]);
    expect(detail?.branches).toEqual([
      {
        name: "worktree-iss-8427-plural",
        branchArtifactId: branchArtifactIdFor("worktree-iss-8427-plural"),
      },
    ]);
  });

  it("addresses each branch by its own artifact id, not the scalar's", async () => {
    const detail = await findDetail(reportedSessionLinks());
    expect(detail?.branches?.map((entry) => entry.branchArtifactId)).toEqual([
      branchArtifactIdFor("worktree-pln-1775-m3-m5"),
      branchArtifactIdFor("worktree-iss-5517-facet-counts"),
      branchArtifactIdFor("worktree-iss-5551-cost-rollup"),
      branchArtifactIdFor("worktree-iss-5705-status-fold"),
      branchArtifactIdFor("worktree-iss-5871-timeline-bands"),
      branchArtifactIdFor("worktree-iss-bundled-pr-page-size"),
    ]);
  });

  it("keeps a branch reachable only through its authored PR link", async () => {
    // The two eligibility lanes are independent: a `session_branch` link
    // carries a participation, an authored PR link carries none. A derivation
    // that kept only the first lane still passes every fixture above, because
    // the reported record's PR links happen to carry a participation too.
    const detail = await findDetail([
      pushedBranchLink("worktree-pushed-only"),
      prLink({
        branchName: "worktree-authored-pr-only",
        prNumber: 8428,
        relation: SessionPrRelationType.Created,
      }),
    ]);
    expect(detail?.branches?.map((entry) => entry.name)).toEqual([
      "worktree-pushed-only",
      "worktree-authored-pr-only",
    ]);
  });

  it("recovers a pre-column session_branch link that states participation only in metadata", async () => {
    // `branch_participation` was added by migration 20260723021001 with no
    // backfill, so a link written before it carries a NULL column and is not an
    // authored-PR link either — invisible to a column-only test, and dropped
    // from a field whose contract says EVERY branch.
    const detail = await findDetail([
      {
        metadata: {
          linkKind: SessionArtifactLinkKind.SessionBranch,
          branchName: "worktree-legacy-pre-column",
          branchRepositoryFullName: REPOSITORY_FULL_NAME,
          relationTypes: [SessionPrRelationType.Created],
        },
        target: branchTarget("worktree-legacy-pre-column"),
      },
    ]);
    expect(detail?.branches?.map((entry) => entry.name)).toEqual([
      "worktree-legacy-pre-column",
    ]);
  });

  it("recovers a pre-column COMPOSITE link that declares its branch kind in linkKinds", async () => {
    // A link that carried both roles — the session's branch link, also used as
    // its PR link — persists as `linkKind: session_pr` with `session_branch` in
    // `linkKinds`, the shape `isNonProseSessionBranchLink` already reads. The
    // authored-PR lane cannot rescue this one: it declares no PR identity, so
    // `resolveAuthoredPrLinkIdentity` returns null and the branch would be
    // missing from a field whose contract says EVERY branch.
    const detail = await findDetail([
      {
        metadata: {
          linkKind: SessionArtifactLinkKind.SessionPr,
          linkKinds: [
            SessionArtifactLinkKind.SessionPr,
            SessionArtifactLinkKind.SessionBranch,
          ],
          branchName: "worktree-legacy-composite",
          branchRepositoryFullName: REPOSITORY_FULL_NAME,
          relation: ArtifactRefRelation.Created,
        },
        target: branchTarget("worktree-legacy-composite"),
      },
    ]);
    expect(detail?.branches?.map((entry) => entry.name)).toEqual([
      "worktree-legacy-composite",
    ]);
  });

  it("does not let a composite declaration admit a reviewed PR link", async () => {
    // The widening is a DECLARATION check, not a relaxation of the relation
    // rule: a merely-reviewed PR link declares no branch kind in either marker,
    // so it stays excluded exactly as before.
    const detail = await findDetail([
      {
        metadata: {
          linkKind: SessionArtifactLinkKind.SessionPr,
          linkKinds: [SessionArtifactLinkKind.SessionPr],
          repositoryFullName: REPOSITORY_FULL_NAME,
          prNumber: 6101,
          relation: ArtifactRefRelation.Reviewed,
        },
        target: branchTarget("someone-elses/composite-reviewed"),
      },
    ]);
    expect(detail?.branches).toEqual([]);
  });

  it("does not let the legacy fallback admit a reviewed PR link", async () => {
    // The metadata rule maps a `Reviewed` relation to a participation, so a
    // fallback applied to PR links as well would readmit exactly the link both
    // derivations exclude on purpose.
    const detail = await findDetail([
      prLink({
        branchName: "someone-elses/reviewed-only",
        prNumber: 6100,
        relation: SessionPrRelationType.Reviewed,
      }),
    ]);
    expect(detail?.branches).toEqual([]);
  });

  it("serves [] for a session that touched no branch", async () => {
    const detail = await findDetail([]);
    expect(detail?.branches).toEqual([]);
  });

  it("still serves the unchanged scalar pair a version-skewed client reads", async () => {
    const detail = await findDetail(reportedSessionLinks());
    // The value the panel renders TODAY: the most-recently-created authored-PR
    // head branch. A client that never learns about `branches` must keep seeing
    // exactly this, and it must be one of the plural set rather than a sixth
    // answer.
    expect(detail?.branch).toBe("worktree-iss-bundled-pr-page-size");
    expect(detail?.branchArtifactId).toBe(
      branchArtifactIdFor("worktree-iss-bundled-pr-page-size")
    );
    expect(detail?.branches?.map((entry) => entry.name)).toContain(
      detail?.branch
    );
  });
});
