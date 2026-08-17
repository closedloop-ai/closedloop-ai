// FEA-4256: the session→branch link projection (`deriveLinkedBranchArtifactId`,
// surfaced as `AgentSessionListItem.branchArtifactId`). Lets the Sessions table
// and session detail link repo/branch/PR to the session's OWN branch detail page
// instead of GitHub. Kept in its own sibling test so `projections.test.ts` stays
// under the size ceiling; this file owns the session→branch fixture shape.

import { ArtifactType } from "@repo/api/src/types/artifact";
import { BranchParticipationKind } from "@repo/api/src/types/branch";
import {
  SessionArtifactLinkKind,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

// A session→BRANCH sourceLink (branch-links.ts's RELATES_TO edge). `id` on the
// target is the branch artifact id the projection resolves; `branchParticipation`
// controls the WROTE-vs-other precedence.
function branchLink({
  id,
  branchName,
  branchParticipation,
}: {
  id: string;
  branchName: string;
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

// A session→PR sourceLink whose BRANCH target is the PR head branch. `relation`
// controls whether the session AUTHORED (Created) the PR or merely referenced it.
function prLink({
  id,
  branchName,
  prNumber,
  relation,
}: {
  id: string;
  branchName: string;
  prNumber: number;
  relation: SessionPrRelationType;
}) {
  return {
    metadata: {
      linkKind: SessionArtifactLinkKind.SessionPr,
      relationTypes: [relation],
      repositoryFullName: "closedloop-ai/symphony-alpha",
      prNumber,
      source: "DETERMINISTIC",
      confidence: 1.0,
      extractorVersion: 1,
    },
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

async function findFirstSession(sourceLinks: unknown[]) {
  installDb({
    sessionDetail: {
      findMany: vi.fn().mockResolvedValue([
        buildSessionListRecord({
          pullRequests: [],
          artifact: {
            name: "Branch-authoring session",
            status: "completed",
            slug: "SES-BRANCH",
            project: null,
            sourceLinks,
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
  return result.items[0];
}

describe("agentSessionsService branch-link projection (FEA-4256)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves branchArtifactId from a session→branch link", async () => {
    const item = await findFirstSession([
      branchLink({
        id: "branch-artifact-42",
        branchName: "feat/nav-seams",
        branchParticipation: BranchParticipationKind.Wrote,
      }),
    ]);
    expect(item?.branchArtifactId).toBe("branch-artifact-42");
  });

  it("prefers the WROTE branch over a merely-reviewed branch", async () => {
    const item = await findFirstSession([
      branchLink({
        id: "branch-reviewed",
        branchName: "feat/other",
        branchParticipation: BranchParticipationKind.Reviewed,
      }),
      branchLink({
        id: "branch-wrote",
        branchName: "feat/nav-seams",
        branchParticipation: BranchParticipationKind.Wrote,
      }),
    ]);
    expect(item?.branchArtifactId).toBe("branch-wrote");
  });

  it("attributes an authored PR link's branch", async () => {
    const item = await findFirstSession([
      prLink({
        id: "branch-authored",
        branchName: "feat/nav-seams",
        prNumber: 4256,
        relation: SessionPrRelationType.Created,
      }),
    ]);
    expect(item?.branchArtifactId).toBe("branch-authored");
  });

  it("does not attribute a referenced-only PR link's branch", async () => {
    const item = await findFirstSession([
      prLink({
        id: "branch-referenced",
        branchName: "feat/someone-elses",
        prNumber: 4257,
        relation: SessionPrRelationType.Referenced,
      }),
    ]);
    expect(item?.branchArtifactId).toBeNull();
  });

  it("degrades to null when the session has no linked branch", async () => {
    const item = await findFirstSession([]);
    expect(item?.branchArtifactId).toBeNull();
  });
});
