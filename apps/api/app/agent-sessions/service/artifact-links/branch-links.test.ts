import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
} from "@repo/api/src/types/agent-session";
import { BranchPushSource, LinkType } from "@repo/api/src/types/artifact";
import {
  ArtifactRefRelation,
  ArtifactRefTargetKind,
  SessionArtifactLinkKind,
  type SyncedArtifactRef,
} from "@repo/api/src/types/session-artifact-link";
import { GitHubInstallationStatus } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentSessionsService } from "../../service";
import {
  buildSyncedSession,
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

  it("upserts a SESSION→BRANCH link carrying method/relation/observedAt (FEA-2729)", async () => {
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
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName: "acme/web",
        branchName: "feat/x",
        method: "git_command",
        relation: ArtifactRefRelation.Created,
        observedAt: "2026-05-20T17:03:00.000Z",
      },
    ]);

    expect(m.artifactLinkUpsert).toHaveBeenCalledTimes(1);
    const arg = m.artifactLinkUpsert.mock.calls[0][0];
    // Idempotent: keyed on the (sourceId,targetId,linkType) unique constraint.
    expect(arg.where.sourceId_targetId_linkType).toEqual({
      sourceId: "persisted-session-1",
      targetId: "branch-x",
      linkType: LinkType.RelatesTo,
    });
    expect(arg.create.metadata).toMatchObject({
      linkKind: SessionArtifactLinkKind.SessionBranch,
      linkKinds: [SessionArtifactLinkKind.SessionBranch],
      method: "git_command",
      relation: ArtifactRefRelation.Created,
      observedAt: "2026-05-20T17:03:00.000Z",
      branchName: "feat/x",
      branchRepositoryFullName: "acme/web",
      branchLinked: true,
      branchSource: "desktop_sync",
    });
    // Same metadata on the update branch → re-sync converges in place.
    expect(arg.update.metadata).toEqual(arg.create.metadata);
  });
  it("distinguishes a written-to branch (created) from a started-on branch (workspace) (FEA-2729 AC)", async () => {
    const m = installBranchIngestDb({
      branches: [
        {
          artifactId: "branch-x",
          repositoryId: "repo-1",
          branchName: "feat/x",
        },
        {
          artifactId: "branch-main",
          repositoryId: "repo-1",
          branchName: "main",
        },
      ],
    });

    await syncBranchRefs([
      {
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName: "acme/web",
        branchName: "feat/x",
        method: "git_command",
        relation: ArtifactRefRelation.Created,
      },
      {
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName: "acme/web",
        branchName: "main",
        method: "git_command",
        relation: ArtifactRefRelation.Workspace,
      },
    ]);

    expect(m.artifactLinkUpsert).toHaveBeenCalledTimes(2);
    const relationByTarget = new Map(
      m.artifactLinkUpsert.mock.calls.map((call) => [
        call[0].where.sourceId_targetId_linkType.targetId,
        call[0].create.metadata.relation,
      ])
    );
    expect(relationByTarget.get("branch-x")).toBe(ArtifactRefRelation.Created);
    expect(relationByTarget.get("branch-main")).toBe(
      ArtifactRefRelation.Workspace
    );
  });
  it("picks the strongest relation when one branch is touched several ways", async () => {
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
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName: "acme/web",
        branchName: "feat/x",
        method: "git_checkout",
        relation: ArtifactRefRelation.Workspace,
      },
      {
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName: "acme/web",
        branchName: "feat/x",
        method: "git_command",
        relation: ArtifactRefRelation.Created,
      },
    ]);

    expect(m.artifactLinkUpsert).toHaveBeenCalledTimes(1);
    expect(m.artifactLinkUpsert.mock.calls[0][0].create.metadata).toMatchObject(
      {
        relation: ArtifactRefRelation.Created,
        method: "git_command",
      }
    );
  });
  it("stamps firstPushedAt + pushSource=session for a C1-verified in-session push (git_push) (PLN-1099 Phase 2b)", async () => {
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
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName: "acme/web",
        branchName: "feat/x",
        method: "git_push",
        relation: ArtifactRefRelation.Created,
        observedAt: "2026-05-20T17:03:00.000Z",
      },
    ]);

    // A synced push-method ref is C1-verified upstream (the desktop extractor
    // drops failed pushes), so the session lane stamps push state. The
    // set-once / earliest-wins DB behavior itself is covered by the
    // branch-artifact-flows integration suite against a real database.
    expect(m.branchDetailUpdateMany).toHaveBeenCalledTimes(1);
    const call = m.branchDetailUpdateMany.mock.calls[0][0];
    expect(call.where.artifactId).toBe("branch-x");
    expect(call.data).toEqual({
      firstPushedAt: new Date("2026-05-20T17:03:00.000Z"),
      pushSource: BranchPushSource.Session,
    });
  });
  it("does NOT stamp push state for an observation-only ref (no push method) (PLN-1099 Phase 2b)", async () => {
    const m = installBranchIngestDb({
      branches: [
        {
          artifactId: "branch-x",
          repositoryId: "repo-1",
          branchName: "feat/x",
        },
      ],
    });

    // A checkout/workspace touch is "observed", not "pushed" (PRD-510 D3): the
    // row exists but stays firstPushedAt-null, so no org list surfaces it (FR12).
    await syncBranchRefs([
      {
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName: "acme/web",
        branchName: "feat/x",
        method: "git_checkout",
        relation: ArtifactRefRelation.Workspace,
        observedAt: "2026-05-20T17:03:00.000Z",
      },
    ]);

    expect(m.artifactLinkUpsert).toHaveBeenCalledTimes(1);
    expect(m.branchDetailUpdateMany).not.toHaveBeenCalled();
  });
  it("stamps the EARLIEST observed push across multiple push refs (earliest-wins) (PLN-1099 Phase 2b)", async () => {
    const m = installBranchIngestDb({
      branches: [
        {
          artifactId: "branch-x",
          repositoryId: "repo-1",
          branchName: "feat/x",
        },
      ],
    });

    // Two pushes on one branch in a session, later delivered before earlier.
    await syncBranchRefs([
      {
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName: "acme/web",
        branchName: "feat/x",
        method: "git_push",
        relation: ArtifactRefRelation.Created,
        observedAt: "2026-05-20T18:00:00.000Z",
      },
      {
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName: "acme/web",
        branchName: "feat/x",
        method: "git_push",
        relation: ArtifactRefRelation.Output,
        observedAt: "2026-05-20T17:00:00.000Z",
      },
    ]);

    expect(m.branchDetailUpdateMany).toHaveBeenCalledTimes(1);
    expect(
      m.branchDetailUpdateMany.mock.calls[0][0].data.firstPushedAt
    ).toEqual(new Date("2026-05-20T17:00:00.000Z"));
  });
  it("artifact-first CREATES a non-App branch row when the session resolves a project (PLN-1099 FR8)", async () => {
    const SOURCE_ARTIFACT_ID = "11111111-1111-4111-8111-111111111111";
    const m = installBranchIngestDb({
      // Non-App: no installation → repositoryId enrichment is null.
      installation: null,
      repos: [],
      // No existing row for the D2 key → the lane creates it.
      branches: [],
      // The session attributes to a source artifact that resolves a project,
      // so the (project-parented) branch artifact can be created.
      artifactProjects: [{ id: SOURCE_ARTIFACT_ID, projectId: "project-1" }],
    });

    await syncBranchRefs(
      [
        {
          kind: ArtifactRefTargetKind.Branch,
          // Mixed-case + `.git` — must normalize into the stored D2 key.
          repositoryFullName: "Acme/Web.git",
          branchName: "feat/x",
          method: "git_command",
          relation: ArtifactRefRelation.Created,
        },
      ],
      { sourceArtifactId: SOURCE_ARTIFACT_ID }
    );

    // Branch created artifact-first: org from the caller (never the payload),
    // parented to the resolved project, keyed by the normalized full name, with
    // repositoryId null (non-App).
    expect(m.artifactCreate).toHaveBeenCalledTimes(1);
    const data = m.artifactCreate.mock.calls[0][0].data;
    expect(data.type).toBe("BRANCH");
    expect(data.organization.connect.id).toBe("org-1");
    expect(data.project.connect.id).toBe("project-1");
    expect(data.branch.create).toMatchObject({
      organizationId: "org-1",
      repositoryId: null,
      repositoryFullName: "acme/web",
      branchName: "feat/x",
    });
    // The session is linked to the freshly-created branch.
    expect(m.artifactLinkUpsert).toHaveBeenCalledTimes(1);
    expect(
      m.artifactLinkUpsert.mock.calls[0][0].where.sourceId_targetId_linkType
        .targetId
    ).toBe("created-branch-1");
  });
  it("enriches a created App-repo branch with repositoryId despite a .git/mixed-case ref (PLN-1099 D2 normalization)", async () => {
    const SOURCE_ARTIFACT_ID = "11111111-1111-4111-8111-111111111111";
    const m = installBranchIngestDb({
      // App repo: the installation repo's stored full_name uses GitHub's
      // canonical casing and carries no `.git` suffix.
      installation: { id: "install-1" },
      repos: [{ id: "repo-1", fullName: "acme/web" }],
      branches: [],
      artifactProjects: [{ id: SOURCE_ARTIFACT_ID, projectId: "project-1" }],
    });

    await syncBranchRefs(
      [
        {
          kind: ArtifactRefTargetKind.Branch,
          // Desktop ref from an SSH remote: `.git` suffix + different casing.
          repositoryFullName: "Acme/Web.git",
          branchName: "feat/x",
          method: "git_command",
          relation: ArtifactRefRelation.Created,
        },
      ],
      { sourceArtifactId: SOURCE_ARTIFACT_ID }
    );

    // Enrichment resolves through the normalized name, so the branch is created
    // as an App branch (repositoryId set) rather than misclassified non-App.
    expect(m.artifactCreate).toHaveBeenCalledTimes(1);
    expect(m.artifactCreate.mock.calls[0][0].data.branch.create).toMatchObject({
      repositoryId: "repo-1",
      repositoryFullName: "acme/web",
      branchName: "feat/x",
    });
  });
  it("defers a branch ref whose branch artifact has not synced yet (late-target tolerance)", async () => {
    const m = installBranchIngestDb({ branches: [] });

    await syncBranchRefs([
      {
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName: "acme/web",
        branchName: "feat/x",
        method: "git_command",
        relation: ArtifactRefRelation.Created,
      },
    ]);

    expect(m.artifactLinkUpsert).not.toHaveBeenCalled();
    const deferralUpdate = m.sessionDetailUpdate.mock.calls.find(
      (call) =>
        (
          call[0] as {
            data?: { metadata?: Record<string, unknown> };
          }
        ).data?.metadata?._unresolvedBranchRefs !== undefined
    );
    expect(deferralUpdate).toBeDefined();
    const deferralUpdateArgs = deferralUpdate?.[0];
    expect(deferralUpdateArgs).toBeDefined();
    expect(
      (
        deferralUpdateArgs as {
          data: { metadata: Record<string, unknown> };
        }
      ).data.metadata._unresolvedBranchRefs
    ).toEqual([{ repositoryFullName: "acme/web", branchName: "feat/x" }]);
  });
  it("resolves branches only within the caller's org (isolation, PRD-510 FR11)", async () => {
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
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName: "acme/web",
        branchName: "feat/x",
        method: "git_command",
        relation: ArtifactRefRelation.Created,
      },
    ]);

    // Installation resolved by the caller's org.
    expect(m.installationFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: "org-1" } })
    );
    // Repos scoped to that installation, active + not removed.
    const repoWhere = m.repoFindMany.mock.calls[0][0].where;
    expect(repoWhere.installationId).toBe("install-1");
    expect(repoWhere.removedAt).toBeNull();
    expect(repoWhere.installation).toEqual({
      status: GitHubInstallationStatus.ACTIVE,
    });
    // Branch resolved/created on the org-scoped D2 key (organizationId,
    // normalized repositoryFullName, branchName) — a same-named branch in
    // another org is a different organizationId and never matches.
    const branchWhere = m.branchFindFirst.mock.calls[0][0].where;
    expect(branchWhere).toEqual({
      organizationId: "org-1",
      repositoryFullName: "acme/web",
      branchName: "feat/x",
    });
  });
  it("defers a non-App-repo branch until the session attributes to a project", async () => {
    const m = installBranchIngestDb({ repos: [], branches: [] });

    await syncBranchRefs([
      {
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName: "other-org/private",
        branchName: "feat/x",
        method: "git_command",
        relation: ArtifactRefRelation.Created,
      },
    ]);

    // D3: a repo outside the org's installation still syncs as a non-App branch
    // (repositoryId enrichment is simply null). But this unit session resolves
    // no project, so the project-parented branch artifact cannot be created yet:
    // no create, no link — the ref is deferred and retried on a later sync.
    expect(m.artifactCreate).not.toHaveBeenCalled();
    expect(m.artifactLinkUpsert).not.toHaveBeenCalled();
    const deferralUpdate = m.sessionDetailUpdate.mock.calls.find(
      (call) =>
        (call[0] as { data?: { metadata?: Record<string, unknown> } }).data
          ?.metadata?._unresolvedBranchRefs !== undefined
    );
    expect(deferralUpdate).toBeDefined();
  });
  it("ignores pull_request-kind refs in the branch lane (FEA-2732 owns PR persistence)", async () => {
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
        kind: ArtifactRefTargetKind.PullRequest,
        repositoryFullName: "acme/web",
        prNumber: 7,
        method: "pr_create_output",
        relation: ArtifactRefRelation.Created,
      },
    ]);

    // No branch-kind refs → the branch lane resolves/creates nothing and writes
    // no link.
    expect(m.branchFindFirst).not.toHaveBeenCalled();
    expect(m.artifactLinkUpsert).not.toHaveBeenCalled();
  });
  it("resolves org + repos once per batch, not per session (N+1 hoist, FEA-2729)", async () => {
    const m = installBranchIngestDb({
      branches: [
        {
          artifactId: "branch-x",
          repositoryId: "repo-1",
          branchName: "feat/x",
        },
      ],
    });
    const branchRef = {
      kind: ArtifactRefTargetKind.Branch,
      repositoryFullName: "acme/web",
      branchName: "feat/x",
      method: "git_command",
      relation: ArtifactRefRelation.Created,
    } satisfies SyncedArtifactRef;

    await agentSessionsService.upsertSessions(
      {
        organizationId: "org-1",
        userId: "user-1",
        computeTargetId: "target-1",
      },
      {
        schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
        batchId: "branch-batch",
        syncMode: AgentSessionSyncMode.Incremental,
        sessionCount: 2,
        sessions: [
          buildSyncedSession({
            externalSessionId: "s1",
            artifactRefs: [branchRef],
          }),
          buildSyncedSession({
            externalSessionId: "s2",
            artifactRefs: [branchRef],
          }),
        ],
      }
    );

    // Org installation + repo lookups are hoisted to the batch: one call each
    // regardless of session count.
    expect(m.installationFindFirst).toHaveBeenCalledTimes(1);
    expect(m.repoFindMany).toHaveBeenCalledTimes(1);
    // Branch resolution stays per-session (one findFirst per branch ref).
    expect(m.branchFindFirst).toHaveBeenCalledTimes(2);
  });
});
