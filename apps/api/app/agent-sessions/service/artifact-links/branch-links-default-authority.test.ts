import {
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultReason,
} from "@repo/api/src/types/repository-default-identity";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  ArtifactRefTargetKind,
  type SyncedArtifactRef,
} from "@repo/api/src/types/session-artifact-link";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSyncedSession,
  installBranchIngestDb,
  repositoryWithAvailableDefault,
  syncBranchRefs,
} from "@/__tests__/support/agent-sessions/service.test-harness";
import type { AgentSessionUpsertTx } from "../records";
import { resolveBranchRepoMap } from "./shared";

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

const FEATURE_REF: SyncedArtifactRef = {
  kind: ArtifactRefTargetKind.Branch,
  repositoryFullName: "acme/web",
  branchName: "feat/x",
  method: ArtifactRefMethod.GitCommand,
  relation: ArtifactRefRelation.Created,
};

describe("Session branch materialization default authority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates and links an eligible org-scoped PublicRepository branch", async () => {
    const sourceArtifactId = "11111111-1111-4111-8111-111111111111";
    const m = installBranchIngestDb({
      installation: null,
      repos: [],
      publicRepositories: [
        {
          id: "public-repo-1",
          githubRepoId: "987",
          fullName: "acme/web",
        },
      ],
      branches: [],
      artifactProjects: [{ id: sourceArtifactId, projectId: "project-1" }],
    });

    await syncBranchRefs(
      [{ ...FEATURE_REF, repositoryFullName: "Acme/Web.git" }],
      { sourceArtifactId }
    );

    expect(m.artifactCreate).toHaveBeenCalledTimes(1);
    expect(m.artifactCreate.mock.calls[0][0].data).toMatchObject({
      organization: { connect: { id: "org-1" } },
      project: { connect: { id: "project-1" } },
      branch: {
        create: {
          organizationId: "org-1",
          repositoryId: null,
          repositoryFullName: "acme/web",
          branchName: "feat/x",
        },
      },
    });
    expect(m.artifactLinkUpsert).toHaveBeenCalledTimes(1);
    expect(m.authorityQueryRaw).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining("public_repositories"),
      })
    );
  });

  it("fails closed for a non-App PublicRepository default branch", async () => {
    const m = installBranchIngestDb({
      repos: [],
      publicRepositories: [
        {
          id: "public-repo-2",
          githubRepoId: "988",
          fullName: "acme/web",
          defaultBranchName: "trunk",
        },
      ],
      branches: [],
    });

    await syncBranchRefs([
      {
        ...FEATURE_REF,
        branchName: "trunk",
        relation: ArtifactRefRelation.Workspace,
      },
    ]);

    expect(m.artifactCreate).not.toHaveBeenCalled();
    expect(m.artifactLinkUpsert).not.toHaveBeenCalled();
    expect(m.branchDetailUpdateMany).not.toHaveBeenCalled();
  });

  it("uses persisted PR-head authority for an uninstalled fork branch", async () => {
    const m = installBranchIngestDb({
      repos: [],
      publicRepositories: [],
      pullRequestRepositories: [
        {
          id: "fork-pr-detail",
          githubRepoId: "fork-provider-id",
          fullName: "contributor/web",
        },
      ],
      branches: [],
    });

    await syncBranchRefs([
      { ...FEATURE_REF, repositoryFullName: "contributor/web" },
    ]);

    expect(m.artifactCreate).toHaveBeenCalledTimes(1);
    expect(m.artifactCreate.mock.calls[0][0].data.branch.create).toMatchObject({
      repositoryId: null,
      repositoryFullName: "contributor/web",
      branchName: "feat/x",
    });
    expect(m.authorityQueryRaw).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining("pull_request_detail"),
      })
    );
    const pullRequestQuery = m.authorityQueryRaw.mock.calls.find((call) =>
      call[0]?.sql?.includes("candidate_authorities")
    )?.[0];
    expect(pullRequestQuery?.sql).toContain("latest_authority_at");
    expect(pullRequestQuery?.sql).toContain(
      "candidate.authority_at = candidate.latest_authority_at"
    );
    expect(pullRequestQuery?.sql).toContain(
      "head_repository_default_branch_observed_at IS NOT NULL"
    );
    expect(pullRequestQuery?.sql).toContain("FOR SHARE OF pull_request");
  });

  it("uses fresh PR-head authority when installed authority is migration-era absence", async () => {
    const m = installBranchIngestDb({
      repos: [
        {
          id: "legacy-installed-repo",
          githubRepoId: "fork-provider-id",
          fullName: "contributor/web",
          defaultBranchName: null,
          defaultBranchAvailability: null,
          defaultBranchCompleteness: null,
          defaultBranchReason: null,
          defaultBranchSource: null,
          defaultBranchMechanism: null,
          defaultBranchTrigger: null,
          defaultBranchCredentialType: null,
          defaultBranchObservationKey: null,
          defaultBranchObservedAt: null,
        },
      ],
      publicRepositories: [],
      pullRequestRepositories: [
        {
          id: "fresh-pr-detail",
          githubRepoId: "fork-provider-id",
          fullName: "contributor/web",
        },
      ],
      branches: [],
    });

    await syncBranchRefs([
      { ...FEATURE_REF, repositoryFullName: "contributor/web" },
    ]);

    expect(m.artifactCreate).toHaveBeenCalledTimes(1);
    expect(m.artifactLinkUpsert).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "all-null legacy authority",
      authority: {
        defaultBranchName: null,
        defaultBranchAvailability: null,
        defaultBranchCompleteness: null,
        defaultBranchReason: null,
        defaultBranchSource: null,
        defaultBranchMechanism: null,
        defaultBranchTrigger: null,
        defaultBranchCredentialType: null,
        defaultBranchObservationKey: null,
        defaultBranchObservedAt: null,
      },
    },
    {
      name: "unavailable authority",
      authority: {
        defaultBranchName: null,
        defaultBranchAvailability: RepositoryDefaultAvailability.Unavailable,
        defaultBranchCompleteness: RepositoryDefaultCompleteness.Unavailable,
        defaultBranchReason: RepositoryDefaultReason.PermissionDenied,
      },
    },
    {
      name: "stale partial authority",
      authority: {
        defaultBranchAvailability: RepositoryDefaultAvailability.Stale,
        defaultBranchCompleteness: RepositoryDefaultCompleteness.Partial,
        defaultBranchReason: RepositoryDefaultReason.ProviderError,
      },
    },
    {
      name: "malformed newer-peer authority",
      authority: { defaultBranchAvailability: "newer_peer_value" },
    },
  ])("does not materialize for $name", async ({ authority }) => {
    const m = installBranchIngestDb({
      repos: [{ id: "repo-1", fullName: "acme/web", ...authority }],
      branches: [],
    });

    await syncBranchRefs([FEATURE_REF]);

    expect(m.artifactCreate).not.toHaveBeenCalled();
    expect(m.artifactLinkUpsert).not.toHaveBeenCalled();
    expect(m.branchDetailUpdateMany).not.toHaveBeenCalled();
  });

  it("fails closed when installed and public authority identities disagree", async () => {
    const m = installBranchIngestDb({
      repos: [{ id: "repo-1", githubRepoId: "100", fullName: "acme/web" }],
      publicRepositories: [
        {
          id: "public-repo-1",
          githubRepoId: "200",
          fullName: "acme/web",
        },
      ],
      branches: [],
    });

    await syncBranchRefs([FEATURE_REF]);

    expect(m.artifactCreate).not.toHaveBeenCalled();
    expect(m.artifactLinkUpsert).not.toHaveBeenCalled();
    expect(m.branchDetailUpdateMany).not.toHaveBeenCalled();
  });

  it("reconciles every active installation and fails closed on duplicate provider identities", async () => {
    const m = installBranchIngestDb({
      repos: [
        { id: "install-a-repo", githubRepoId: "100", fullName: "acme/web" },
        { id: "install-b-repo", githubRepoId: "200", fullName: "acme/web" },
      ],
      branches: [],
    });

    await syncBranchRefs([FEATURE_REF]);

    expect(m.artifactCreate).not.toHaveBeenCalled();
    expect(m.artifactLinkUpsert).not.toHaveBeenCalled();
    const installedQuery = m.authorityQueryRaw.mock.calls.find((call) =>
      call[0]?.sql?.includes("github_installation_repositories")
    )?.[0];
    expect(installedQuery?.sql).toContain("installation.organization_id");
    expect(installedQuery?.sql).not.toContain("WHERE installation.id");
  });

  it("fails closed when two active installation rows duplicate one provider identity", async () => {
    const m = installBranchIngestDb({
      repos: [
        { id: "install-a-repo", githubRepoId: "100", fullName: "acme/web" },
        { id: "install-b-repo", githubRepoId: "100", fullName: "acme/web" },
      ],
      branches: [],
    });

    await syncBranchRefs([FEATURE_REF]);

    expect(m.artifactCreate).not.toHaveBeenCalled();
    expect(m.artifactLinkUpsert).not.toHaveBeenCalled();
  });

  it("ignores inactive installation authority when active authority is eligible", async () => {
    const m = installBranchIngestDb({
      repos: [
        {
          id: "inactive-repo",
          githubRepoId: "200",
          fullName: "acme/web",
          defaultBranchName: "feat/x",
          installationStatus: "INACTIVE",
        },
        {
          id: "active-repo",
          githubRepoId: "100",
          fullName: "acme/web",
          installationStatus: "ACTIVE",
        },
      ],
      branches: [],
    });

    await syncBranchRefs([FEATURE_REF]);

    expect(m.artifactCreate).toHaveBeenCalledTimes(1);
    expect(m.artifactLinkUpsert).toHaveBeenCalledTimes(1);
  });

  it("binds a monitored-activity-only PR ref's repo so its detail row resolves on an index (ISS-6450)", async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);

    await resolveBranchRepoMap({ $queryRaw: queryRaw } as never, "org-1", [
      buildSyncedSession({
        artifactRefs: [
          {
            kind: ArtifactRefTargetKind.PullRequest,
            repositoryFullName: "acme/monitored-only",
            prNumber: 7,
            method: ArtifactRefMethod.UrlInMessage,
            relation: ArtifactRefRelation.Referenced,
            monitoredActivityOnly: true,
          } as SyncedArtifactRef,
        ],
      }),
    ]);

    // The PR lane skips this ref, so without the binding no name is collected,
    // no query runs at all, and the monitored lane has no repositoryId —
    // falling back to the unindexed org-wide identity.
    expect(queryRaw.mock.calls.length).toBeGreaterThan(0);
    for (const [query] of queryRaw.mock.calls) {
      expect(query.values).toContain("acme/monitored-only");
    }
  });

  it("resolves a monitored-only PR ref's repo without putting it through the authority queries", async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);

    await resolveBranchRepoMap({ $queryRaw: queryRaw } as never, "org-1", [
      buildSyncedSession({
        artifactRefs: [
          { ...FEATURE_REF, repositoryFullName: "acme/web" },
          {
            kind: ArtifactRefTargetKind.PullRequest,
            repositoryFullName: "acme/monitored-only",
            prNumber: 7,
            method: ArtifactRefMethod.UrlInMessage,
            relation: ArtifactRefRelation.Referenced,
            monitoredActivityOnly: true,
          } as SyncedArtifactRef,
        ],
      }),
    ]);

    // The monitored-only name needs `repositoryId` and nothing else. The
    // PR-head authority query is served only by the organization index on
    // LOWER(head_repository_full_name), so each name it carries costs another
    // filter over the org's PR history inside the write transaction.
    const queriesNaming = (name: string) =>
      queryRaw.mock.calls.filter(([query]) => query.values.includes(name));
    const prHeadQueries = queryRaw.mock.calls.filter(([query]) =>
      query.strings.join("").includes("head_repository_full_name")
    );
    expect(prHeadQueries).toHaveLength(1);
    expect(prHeadQueries[0][0].values).toContain("acme/web");
    expect(prHeadQueries[0][0].values).not.toContain("acme/monitored-only");
    // It is still read — on the installation lookup alone.
    expect(queriesNaming("acme/monitored-only")).toHaveLength(1);
  });

  it("chunks the maximum 200x500 accepted ref envelope to at most 100 names per authority query", async () => {
    const sessions = Array.from({ length: 200 }, (_, sessionIndex) =>
      buildSyncedSession({
        externalSessionId: `session-${sessionIndex}`,
        artifactRefs: Array.from({ length: 500 }, (_, refIndex) => ({
          ...FEATURE_REF,
          repositoryFullName: `owner-${sessionIndex}/repo-${refIndex}`,
        })),
      })
    );
    const queryRaw = vi.fn().mockResolvedValue([]);
    const tx: Pick<AgentSessionUpsertTx, "$queryRaw"> = {
      $queryRaw: queryRaw,
    };

    await resolveBranchRepoMap(tx, "org-1", sessions);

    expect(queryRaw).toHaveBeenCalledTimes(3000);
    for (const [query] of queryRaw.mock.calls) {
      // Installed queries bind org + status + at most 100 names; public and
      // PR-head queries bind org + at most 100 names.
      expect(query.values.length).toBeLessThanOrEqual(102);
    }
  }, 20_000);

  it("re-evaluates current authority on retry without deleting historical evidence", async () => {
    const m = installBranchIngestDb({
      branches: [
        {
          artifactId: "branch-x",
          repositoryId: "repo-1",
          branchName: "feat/x",
        },
      ],
    });

    await syncBranchRefs([FEATURE_REF]);
    expect(m.artifactLinkUpsert).toHaveBeenCalledTimes(1);

    m.artifactLinkUpsert.mockClear();
    m.authorityQueryRaw.mockImplementation((query: { sql?: string }) =>
      Promise.resolve(
        query.sql?.includes("github_installation_repositories")
          ? [
              repositoryWithAvailableDefault({
                id: "repo-1",
                fullName: "acme/web",
                defaultBranchName: "feat/x",
              }),
            ]
          : []
      )
    );
    await syncBranchRefs([FEATURE_REF]);

    expect(m.artifactLinkUpsert).not.toHaveBeenCalled();
    expect(m.artifactCreate).not.toHaveBeenCalled();
  });
});
