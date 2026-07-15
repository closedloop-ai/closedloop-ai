import {
  ArtifactRefRelation,
  ArtifactRefTargetKind,
} from "@repo/api/src/types/session-artifact-link";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  installBranchIngestDb,
  syncBranchRefs,
} from "../../service.test-harness";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import("../../service.test-mocks");
  return databaseModuleMock();
});

vi.mock("@repo/observability/telemetry/metrics", async () => {
  const { telemetryModuleMock } = await import("../../service.test-mocks");
  return telemetryModuleMock();
});

describe("agentSessionsService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reconciles a commit ref onto the resolved branch (FEA-2731)", async () => {
    const m = installBranchIngestDb({
      branches: [
        {
          artifactId: "branch-x",
          repositoryId: "repo-1",
          branchName: "feat/x",
        },
      ],
    });

    await syncBranchRefs([
      {
        kind: ArtifactRefTargetKind.Commit,
        repositoryFullName: "acme/web",
        branchName: "feat/x",
        sha: "1a2b3c4",
        method: "git_command",
        relation: ArtifactRefRelation.Created,
        message: "wip",
        committedAt: "2026-05-20T17:03:00.000Z",
        linesAdded: 5,
      },
    ]);

    expect(m.commitDetailCreate).toHaveBeenCalledTimes(1);
    expect(m.commitDetailCreate.mock.calls[0][0].data).toMatchObject({
      organizationId: "org-1",
      repositoryFullName: "acme/web",
      sha: "1a2b3c4",
      branchArtifactId: "branch-x",
      source: "desktop_sync",
      message: "wip",
      linesAdded: 5,
    });
  });
  it("defers a commit ref whose branch row hasn't synced yet (FEA-2731 late-target tolerance)", async () => {
    const m = installBranchIngestDb({ branches: [] });

    await syncBranchRefs([
      {
        kind: ArtifactRefTargetKind.Commit,
        repositoryFullName: "acme/web",
        branchName: "feat/x",
        sha: "1a2b3c4",
        method: "git_command",
        relation: ArtifactRefRelation.Created,
      },
    ]);

    // Branch absent → no CommitDetail write; the ref is parked for a later tick.
    expect(m.commitDetailCreate).not.toHaveBeenCalled();
    const deferralUpdate = m.sessionDetailUpdate.mock.calls.find(
      (call) =>
        (call[0] as { data?: { metadata?: Record<string, unknown> } }).data
          ?.metadata?._unresolvedCommitRefs !== undefined
    );
    expect(deferralUpdate).toBeDefined();
    const deferralUpdateArgs = deferralUpdate?.[0];
    expect(deferralUpdateArgs).toBeDefined();
    expect(
      (
        deferralUpdateArgs as {
          data: { metadata: Record<string, unknown> };
        }
      ).data.metadata._unresolvedCommitRefs
    ).toEqual([
      { repositoryFullName: "acme/web", branchName: "feat/x", sha: "1a2b3c4" },
    ]);
  });
});
