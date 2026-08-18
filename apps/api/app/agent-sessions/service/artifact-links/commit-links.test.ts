import {
  ArtifactRefRelation,
  ArtifactRefTargetKind,
} from "@repo/api/src/types/session-artifact-link";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  installBranchIngestDb,
  syncBranchRefs,
} from "@/__tests__/support/agent-sessions/service.test-harness";

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
  it("resolves multiple commit refs' branches in one batched read (ISS-4440)", async () => {
    const m = installBranchIngestDb({
      branches: [
        {
          artifactId: "branch-x",
          repositoryId: "repo-1",
          branchName: "feat/x",
        },
        {
          artifactId: "branch-y",
          repositoryId: "repo-1",
          branchName: "feat/y",
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
      },
      {
        kind: ArtifactRefTargetKind.Commit,
        repositoryFullName: "acme/web",
        branchName: "feat/x",
        sha: "5d6e7f8",
        method: "git_command",
        relation: ArtifactRefRelation.Created,
      },
      {
        kind: ArtifactRefTargetKind.Commit,
        repositoryFullName: "acme/web",
        branchName: "feat/y",
        sha: "9a0b1c2",
        method: "git_command",
        relation: ArtifactRefRelation.Created,
      },
    ]);

    // ONE findMany for the whole ref set — not a findFirst per ref.
    expect(m.branchFindMany).toHaveBeenCalledTimes(1);
    // The old per-ref branch lookup this PR replaced must be gone entirely:
    // if any branchFindFirst survived, the batched findMany would coexist with
    // the N+1 it was meant to eliminate. Lock the regression at zero calls.
    expect(m.branchFindFirst).not.toHaveBeenCalled();
    // Each commit still reconciles onto its resolved branch.
    expect(m.commitDetailCreate).toHaveBeenCalledTimes(3);
    const created = m.commitDetailCreate.mock.calls.map((call) => ({
      sha: call[0].data.sha,
      branchArtifactId: call[0].data.branchArtifactId,
    }));
    expect(created).toContainEqual({
      sha: "1a2b3c4",
      branchArtifactId: "branch-x",
    });
    expect(created).toContainEqual({
      sha: "5d6e7f8",
      branchArtifactId: "branch-x",
    });
    expect(created).toContainEqual({
      sha: "9a0b1c2",
      branchArtifactId: "branch-y",
    });
  });
  it("keeps two (repo, branch) pairs that collide under a newline separator on DISTINCT branches (ISS-4440 key-collision)", async () => {
    // These two pairs both flatten to the same string under a naive
    // `${repo}\n${branch}` key:
    //   ("acme/web",      "feat\nx") -> "acme/web\nfeat\nx"
    //   ("acme/web\nfeat", "x")      -> "acme/web\nfeat\nx"
    // A collision would attach BOTH commits to whichever branch won the map
    // write. The composite key must keep them apart, so each commit lands on
    // its own branch artifact.
    const m = installBranchIngestDb({
      repos: [
        { id: "repo-1", fullName: "acme/web" },
        { id: "repo-2", fullName: "acme/web\nfeat" },
      ],
      branches: [
        {
          artifactId: "branch-a",
          repositoryId: "repo-1",
          repositoryFullName: "acme/web",
          branchName: "feat\nx",
        },
        {
          artifactId: "branch-b",
          repositoryId: "repo-2",
          repositoryFullName: "acme/web\nfeat",
          branchName: "x",
        },
      ],
    });

    await syncBranchRefs([
      {
        kind: ArtifactRefTargetKind.Commit,
        repositoryFullName: "acme/web",
        branchName: "feat\nx",
        sha: "aaa1111",
        method: "git_command",
        relation: ArtifactRefRelation.Created,
      },
      {
        kind: ArtifactRefTargetKind.Commit,
        repositoryFullName: "acme/web\nfeat",
        branchName: "x",
        sha: "bbb2222",
        method: "git_command",
        relation: ArtifactRefRelation.Created,
      },
    ]);

    expect(m.branchFindMany).toHaveBeenCalledTimes(1);
    expect(m.commitDetailCreate).toHaveBeenCalledTimes(2);
    const created = m.commitDetailCreate.mock.calls.map((call) => ({
      sha: call[0].data.sha,
      branchArtifactId: call[0].data.branchArtifactId,
    }));
    // Each commit lands on ITS OWN branch — never collapsed onto one.
    expect(created).toContainEqual({
      sha: "aaa1111",
      branchArtifactId: "branch-a",
    });
    expect(created).toContainEqual({
      sha: "bbb2222",
      branchArtifactId: "branch-b",
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
