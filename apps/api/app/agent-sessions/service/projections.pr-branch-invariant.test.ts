// FEA-4188 (recurrence): read-boundary PR⇒Branch invariant for the cloud
// agent-session projection. A rendered session with ≥1 PR MUST carry a non-null
// Branch identifying the corresponding head branch (PR present ⇒ Branch
// present). A session that surfaces a PR but resolves NO head branch is an
// impossible artifact relationship — it breaks session→branch→PR
// attribution/navigation.
//
// The prior fix (#3801) closed this only on the DESKTOP SQLite local read path
// (orphaned authored PR-write EXTRACTION); the CLOUD projection still let a PR
// associated via desktop-reported legacy JSON — or the sync/enrichment
// source-link lanes — render with Branch = None. The cloud read boundary
// (`toSessionListItem`, shared by list + detail) must SUPPRESS the orphaned PR
// so no surface shows a PR write without its required branch.
//
// Split out of projections.pull-requests.test.ts to keep that file under the
// 1000-line ceiling; this file owns the PR⇒Branch invariant cases.

import { ArtifactType } from "@repo/api/src/types/artifact";
import { BranchParticipationKind } from "@repo/api/src/types/branch";
import { PullRequestState } from "@repo/api/src/types/document";
import {
  SessionArtifactLinkKind,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import { SessionPrLifecycleStatus } from "@repo/lib/session-trace/derivation";
import { describe, expect, it, vi } from "vitest";
import {
  buildSessionListRecord,
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

// A session→PR sourceLink whose BRANCH target carries the PR head-ref `name`
// the branch back-fill (`deriveLinkedPrHeadBranch`) reads. Mirrors the fixture
// in projections.pull-requests.test.ts; kept local so this focused file stays
// self-contained.
function prHeadRefSourceLink({
  headRef,
  prNumber,
}: {
  headRef: string;
  prNumber: number;
}) {
  return {
    metadata: {
      linkKind: SessionArtifactLinkKind.SessionPr,
      relationTypes: [SessionPrRelationType.Created],
      repositoryFullName: "closedloop-ai/symphony-alpha",
      prNumber,
      source: "DETERMINISTIC",
      confidence: 1.0,
      extractorVersion: 1,
    },
    target: {
      name: headRef,
      type: "BRANCH",
      branch: {
        repository: { fullName: "closedloop-ai/symphony-alpha" },
        currentPullRequestDetail: {
          number: prNumber,
          title: "Linked PR",
          prState: PullRequestState.Open,
          closedAt: null,
          mergedAt: null,
          lastVerifiedAt: new Date("2026-07-20T02:09:00.000Z"),
          isCurrent: true,
          repository: { fullName: "closedloop-ai/symphony-alpha" },
        },
      },
    },
  };
}

// A session→BRANCH sourceLink (branch-links.ts's RELATES_TO edge). Mirrors the
// fixture in projections.branch-link.test.ts. `branchName` sets the target's
// `name` — the head-branch name the invariant resolves; pass null to model a
// branch link whose target resolved no usable name (still carries an id).
function sessionBranchLink({
  id,
  branchName,
  branchParticipation,
}: {
  id: string;
  branchName: string | null;
  branchParticipation?: BranchParticipationKind;
}) {
  return {
    metadata: {
      linkKind: SessionArtifactLinkKind.SessionBranch,
      branchName,
      branchRepositoryFullName: "closedloop-ai/symphony-alpha",
    },
    ...(branchParticipation ? { branchParticipation } : {}),
    target: {
      id,
      name: branchName,
      type: ArtifactType.Branch,
      branch: {
        repository: { fullName: "closedloop-ai/symphony-alpha" },
        currentPullRequestDetail: null,
      },
    },
  };
}

describe("agent-session projection — PR⇒Branch invariant (FEA-4188)", () => {
  // The recurrence: session 019fa508-… showed repo PR #3837 with Branch None,
  // associated via the cloud path AFTER #3801 shipped. With branch + baseBranch
  // null and no branch-resolving PR source link, the cloud read boundary must
  // SUPPRESS the orphaned PR rather than render it with Branch = None.
  it("suppresses a legacy-JSON PR when the session resolves no branch", async () => {
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          buildSessionListRecord({
            branch: null,
            baseBranch: null,
            pullRequests: [
              {
                num: 3837,
                title: "Orphaned PR write",
                status: SessionPrLifecycleStatus.Unknown,
              },
            ],
            artifact: {
              name: "Session with orphaned PR",
              status: "completed",
              slug: "SES-4188",
              project: null,
              // No branch-resolving source link — nothing back-fills a branch.
              sourceLinks: [],
            },
          }),
        ]),
        count: vi.fn().mockResolvedValue(1),
      },
    });

    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {},
    });

    // No branch resolved → the PR is suppressed rather than shown Branch: None.
    expect(result.items[0]?.branch).toBeNull();
    expect(result.items[0]?.prs).toEqual([]);
    expect(result.items[0]?.prsMerged).toBe(0);
  });

  // The invariant only suppresses ORPHANED PRs — a PR alongside a resolved
  // branch (here the linked PR's own head ref back-fills the branch) stays
  // visible. Guards against over-suppression regressing the common case.
  it("keeps a legacy-JSON PR when a linked head ref resolves the branch", async () => {
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          buildSessionListRecord({
            branch: null,
            baseBranch: null,
            pullRequests: [
              {
                num: 3143,
                title: "Legacy title",
                status: SessionPrLifecycleStatus.Unknown,
              },
            ],
            artifact: {
              name: "Session with resolvable branch",
              status: "completed",
              slug: "SES-4188-ok",
              project: null,
              sourceLinks: [
                prHeadRefSourceLink({
                  headRef: "mikeangstadt/fea-4188-head-ref",
                  prNumber: 3143,
                }),
              ],
            },
          }),
        ]),
        count: vi.fn().mockResolvedValue(1),
      },
    });

    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {},
    });

    expect(result.items[0]?.branch).toBe("mikeangstadt/fea-4188-head-ref");
    expect(result.items[0]?.prs).toEqual([
      {
        num: 3143,
        title: "Linked PR",
        status: SessionPrLifecycleStatus.Open,
      },
    ]);
  });

  // Thread 1 (wongk): `baseBranch` is the PR's base/target ref, NOT its head.
  // With the harness default `baseBranch: "main"` left in place — the realistic
  // launch-metadata shape — an orphaned PR that resolves no head branch must
  // still be SUPPRESSED. `baseBranch` is a display fallback only; it does not
  // satisfy the PR⇒Branch invariant, so `main` cannot masquerade as the head.
  it("suppresses an orphaned PR even when baseBranch is main", async () => {
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          buildSessionListRecord({
            branch: null,
            // baseBranch NOT overridden — harness default is "main".
            pullRequests: [
              {
                num: 3837,
                title: "Orphaned PR write",
                status: SessionPrLifecycleStatus.Unknown,
              },
            ],
            artifact: {
              name: "Session with orphaned PR + base main",
              status: "completed",
              slug: "SES-4188-base",
              project: null,
              sourceLinks: [],
            },
          }),
        ]),
        count: vi.fn().mockResolvedValue(1),
      },
    });

    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {},
    });

    // `baseBranch` still renders as the display branch, but the PR is suppressed
    // because no HEAD branch resolved — the invariant does not accept the base.
    expect(result.items[0]?.branch).toBe("main");
    expect(result.items[0]?.baseBranch).toBe("main");
    expect(result.items[0]?.prs).toEqual([]);
    expect(result.items[0]?.prsMerged).toBe(0);
  });

  // Thread 2 (wongk): a branch-artifact id alone does NOT make the branch
  // non-null. A legacy PR plus a session_branch link whose target resolved no
  // branch NAME lands with branch null while the id keeps the PR rendered — the
  // row shows "Branch: None" alongside a PR. The invariant must gate on the
  // resolved head-branch NAME, so this PR is suppressed even though the id resolves.
  it("suppresses an orphaned PR when the branch link resolves an id but no name", async () => {
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          buildSessionListRecord({
            branch: null,
            baseBranch: null,
            pullRequests: [
              {
                num: 3901,
                title: "Legacy PR, nameless branch link",
                status: SessionPrLifecycleStatus.Unknown,
              },
            ],
            artifact: {
              name: "Session with nameless branch link",
              status: "completed",
              slug: "SES-4188-nameless",
              project: null,
              sourceLinks: [
                sessionBranchLink({
                  id: "branch-artifact-nameless",
                  branchName: null,
                  branchParticipation: BranchParticipationKind.Wrote,
                }),
              ],
            },
          }),
        ]),
        count: vi.fn().mockResolvedValue(1),
      },
    });

    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {},
    });

    // The id still surfaces for navigation, but branch is None and the PR is
    // suppressed — a bare id does not satisfy the invariant.
    expect(result.items[0]?.branch).toBeNull();
    expect(result.items[0]?.branchArtifactId).toBe("branch-artifact-nameless");
    expect(result.items[0]?.prs).toEqual([]);
    expect(result.items[0]?.prsMerged).toBe(0);
  });

  // Thread 2 (converse): a session_branch link that DOES resolve a branch name
  // back-fills the head branch, so a PR alongside it stays visible — the id and
  // the name come from the same link, so the invariant and the branch display
  // never disagree.
  it("keeps a PR when a session_branch link resolves the branch name", async () => {
    installDb({
      sessionDetail: {
        findMany: vi.fn().mockResolvedValue([
          buildSessionListRecord({
            branch: null,
            baseBranch: null,
            pullRequests: [
              {
                num: 3902,
                title: "Legacy PR, named branch link",
                status: SessionPrLifecycleStatus.Unknown,
              },
            ],
            artifact: {
              name: "Session with named branch link",
              status: "completed",
              slug: "SES-4188-named",
              project: null,
              sourceLinks: [
                sessionBranchLink({
                  id: "branch-artifact-named",
                  branchName: "mikeangstadt/fea-4188-branch-link",
                  branchParticipation: BranchParticipationKind.Wrote,
                }),
              ],
            },
          }),
        ]),
        count: vi.fn().mockResolvedValue(1),
      },
    });

    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {},
    });

    expect(result.items[0]?.branch).toBe("mikeangstadt/fea-4188-branch-link");
    expect(result.items[0]?.branchArtifactId).toBe("branch-artifact-named");
    expect(result.items[0]?.prs).toEqual([
      {
        num: 3902,
        title: "Legacy PR, named branch link",
        status: SessionPrLifecycleStatus.Unknown,
      },
    ]);
  });
});
