import { BranchParticipationKind } from "@repo/api/src/types/branch";
import {
  normalizePersistedRepositoryDefaultAuthority,
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultReason,
} from "@repo/api/src/types/repository-default-identity";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  ArtifactRefTargetKind,
  BRANCH_PUSH_METHOD_VALUES,
  type SyncedArtifactRef,
} from "@repo/api/src/types/session-artifact-link";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  installBranchIngestDb,
  repositoryWithAvailableDefault,
  syncBranchRefs,
} from "@/__tests__/support/agent-sessions/branch-ingest.test-harness";
import { buildSyncedSession } from "@/__tests__/support/agent-sessions/service.test-harness";
import { GitHubObservedRepositoryVerificationState } from "@/lib/github/observed-repository-store";
import type { AgentSessionUpsertTx } from "../records";
import { RepositoryIdentitySource } from "./authority-source-queries";
import {
  BranchMaterializationStatus,
  materializeSessionBranchAggregate,
} from "./branch-links";
import { resolveSessionRepositoryIdentity } from "./shared";

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

/**
 * ISS-8148: this file's subject is repository AUTHORITY, not push evidence, so
 * the shared ref carries a push method — otherwise every materialization case
 * here would be deferred by the push gate for a reason the test is not about.
 */
const [GIT_PUSH_METHOD] = BRANCH_PUSH_METHOD_VALUES;

const FEATURE_REF: SyncedArtifactRef = {
  kind: ArtifactRefTargetKind.Branch,
  repositoryFullName: "acme/web",
  branchName: "feat/x",
  method: GIT_PUSH_METHOD,
  relation: ArtifactRefRelation.Created,
  observedAt: "2026-05-20T17:03:00.000Z",
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

    expect(m.artifactCreateMany).toHaveBeenCalledTimes(1);
    expect(m.artifactCreateMany.mock.calls[0][0].data[0]).toMatchObject({
      organizationId: "org-1",
      projectId: "project-1",
    });
    expect(m.branchCreateMany.mock.calls[0][0].data[0]).toMatchObject({
      artifactId: m.artifactCreateMany.mock.calls[0][0].data[0].id,
      organizationId: "org-1",
      repositoryId: null,
      repositoryFullName: "acme/web",
      branchName: "feat/x",
    });
    expect(m.linkRow).toHaveBeenCalledTimes(1);
    expect(m.authorityQueryRaw).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining("public_repositories"),
      })
    );
  });

  it("materializes a branch from a verified observation for an org with no installation (PLN-1775 M4)", async () => {
    // The ISS-7403 gap end to end: no installation row, no public row, no PR
    // history — every pre-existing authority source is downstream of a GitHub
    // App read, so this ref used to return AuthorityUnavailable forever.
    const sourceArtifactId = "22222222-2222-4222-8222-222222222222";
    const m = installBranchIngestDb({
      installation: null,
      repos: [],
      observedRepositories: [
        { id: "observed-1", githubRepoId: "4242", fullName: "acme/web" },
      ],
      branches: [],
      artifactProjects: [{ id: sourceArtifactId, projectId: "project-1" }],
    });

    await syncBranchRefs([FEATURE_REF], { sourceArtifactId });

    expect(m.artifactCreateMany).toHaveBeenCalledTimes(1);
    expect(m.branchCreateMany.mock.calls[0][0].data[0]).toMatchObject({
      organizationId: "org-1",
      // Observation authority is not an installation repository FK.
      repositoryId: null,
      repositoryFullName: "acme/web",
      branchName: "feat/x",
    });
    expect(m.authorityExecuteRaw).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.stringContaining("DELETE FROM branch_materialization_retries"),
      ]),
      ["acme/web"],
      ["feat/x"],
      "org-1",
      "persisted-session-1"
    );
  });

  it("reads observations only in the verified state and only with a provider id (PLN-1775 M4)", async () => {
    // A pending row is still the desktop's unverified claim and a denied one is
    // a settled negative; an identity-less row cannot produce authority at all
    // (`normalizeSessionAuthority` returns nothing without a provider id). All
    // three are excluded in the predicate, which is the only place they can be.
    const m = installBranchIngestDb({ installation: null, repos: [] });

    await syncBranchRefs([FEATURE_REF]);

    const observationQueries = m.authorityQueryRaw.mock.calls
      .map((call) => call[0] as { sql?: string; values: unknown[] })
      .filter((query) => query.sql?.includes("github_observed_repository"));

    expect(observationQueries).toHaveLength(1);
    expect(observationQueries[0].sql).toContain("verification_state");
    expect(observationQueries[0].sql).toContain("github_repo_id IS NOT NULL");
    expect(observationQueries[0].values).toContain(
      GitHubObservedRepositoryVerificationState.Verified
    );
  });

  it("queues full branch evidence when authority is unavailable instead of writing identity-only unresolved metadata", async () => {
    const m = installBranchIngestDb({
      installation: null,
      repos: [],
      publicRepositories: [],
      observedRepositories: [],
    });

    await syncBranchRefs([
      {
        ...FEATURE_REF,
        method: "git_commit",
        branchParticipation: BranchParticipationKind.Wrote,
        observedAt: "2026-08-25T12:34:00.000Z",
      },
    ]);

    const retryInsert = m.authorityQueryRaw.mock.calls
      .map((call) => call[0] as { sql?: string; values?: unknown[] })
      .find((query) =>
        query.sql?.includes("INSERT INTO branch_materialization_retries")
      );

    expect(retryInsert).toBeDefined();
    const retryPayload = retryInsert?.values?.find(isBranchRetryPayload);
    expect(retryPayload ? JSON.parse(retryPayload) : null).toMatchObject({
      directParticipation: BranchParticipationKind.Wrote,
      directParticipationMethod: "git_commit",
      directParticipationObservedAt: "2026-08-25T12:34:00.000Z",
    });
    expect(m.artifactCreateMany).not.toHaveBeenCalled();
    expect(m.linkRow).not.toHaveBeenCalled();
    const unresolvedWrite = m.sessionDetailUpdate.mock.calls.find(
      (call) =>
        (call[0] as { data?: { metadata?: Record<string, unknown> } }).data
          ?.metadata?._unresolvedBranchRefs !== undefined
    );
    expect(unresolvedWrite).toBeUndefined();
  });

  it("replays a queued aggregate into the Product-visible Wrote link path", async () => {
    const repository = repositoryWithAvailableDefault({
      id: "repo-1",
      githubRepoId: "987",
      fullName: "acme/web",
    });
    const authority = normalizePersistedRepositoryDefaultAuthority(
      {
        provider: VcsProviderKind.GitHub,
        providerRepositoryId: "987",
        fullName: "acme/web",
      },
      repository
    );
    if (!authority) {
      throw new Error("test authority did not normalize");
    }
    const artifactCreate = vi.fn().mockResolvedValue({ id: "branch-created" });
    const artifactLinkUpsert = vi.fn().mockResolvedValue({});
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      $executeRaw: vi.fn().mockResolvedValue(0),
      artifact: { create: artifactCreate },
      artifactLink: {
        findFirst: vi.fn().mockResolvedValue(null),
        upsert: artifactLinkUpsert,
      },
      branchDetail: {
        findFirst: vi.fn().mockResolvedValue(null),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    } as unknown as AgentSessionUpsertTx;

    const result = await materializeSessionBranchAggregate(tx, {
      organizationId: "org-1",
      projectId: "project-1",
      sessionArtifactId: "session-1",
      repositoryAuthority: {
        repositoryId: null,
        providerRepositoryId: "987",
        identitySources: new Set([RepositoryIdentitySource.Public]),
        authorities: [authority],
      },
      aggregate: {
        repositoryFullName: "acme/web",
        branchName: "feat/x",
        method: "git_commit",
        relation: ArtifactRefRelation.Created,
        observedAt: "2026-08-25T12:34:00.000Z",
        // ISS-8148: the queued aggregate must carry push evidence to be
        // replayable at all. `method` stays `git_commit` because the elected
        // method follows relation RANK (Created outranks the push ref's Output),
        // while `pushObserved` is the separate evidence bit — exactly the shape
        // a session that committed and then pushed folds into.
        pushObserved: true,
        branchLifecycleEvents: [],
        directParticipation: BranchParticipationKind.Wrote,
        directParticipationMethod: "git_commit",
        directParticipationObservedAt: "2026-08-25T12:34:00.000Z",
      },
    });

    expect(result.status).toBe(BranchMaterializationStatus.Materialized);
    const linkWrite = artifactLinkUpsert.mock.calls[0][0];
    expect(linkWrite.create.metadata).toMatchObject({
      branchRepositoryFullName: "acme/web",
      branchName: "feat/x",
      method: "git_commit",
      relation: ArtifactRefRelation.Created,
      branchParticipation: BranchParticipationKind.Wrote,
    });
    expect(linkWrite.create.branchParticipation).toBe(
      BranchParticipationKind.Wrote
    );
    expect(linkWrite.create.branchParticipationMethod).toBe("git_commit");
    expect(linkWrite.create.branchParticipationObservedAt).toEqual(
      new Date("2026-08-25T12:34:00.000Z")
    );
  });

  it("keeps installation authority winning over an observation of the same repo (PLN-1775 M4)", async () => {
    const m = installBranchIngestDb({
      repos: [{ id: "repo-1", githubRepoId: "111", fullName: "acme/web" }],
      observedRepositories: [
        { id: "observed-1", githubRepoId: "111", fullName: "acme/web" },
      ],
      branches: [],
    });

    await syncBranchRefs([FEATURE_REF]);

    expect(m.artifactCreateMany).toHaveBeenCalledTimes(1);
    expect(m.branchCreateMany.mock.calls[0][0].data[0]).toMatchObject({
      repositoryId: "repo-1",
    });
  });

  it("fails closed when an observation's identity disagrees with PR-head authority (PLN-1775 M4)", async () => {
    // Two server-owned answers for one name is an unresolvable identity, and a
    // fourth source must not become a way to pick one of them.
    const m = installBranchIngestDb({
      installation: null,
      repos: [],
      pullRequestRepositories: [
        { id: "pr-1", githubRepoId: "999", fullName: "acme/web" },
      ],
      observedRepositories: [
        { id: "observed-1", githubRepoId: "888", fullName: "acme/web" },
      ],
      branches: [],
    });

    await syncBranchRefs([FEATURE_REF]);

    expect(m.artifactCreateMany).not.toHaveBeenCalled();
    expect(m.linkRow).not.toHaveBeenCalled();
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

    expect(m.artifactCreateMany).not.toHaveBeenCalled();
    expect(m.linkRow).not.toHaveBeenCalled();
    expect(m.pushRow).not.toHaveBeenCalled();
    const retryInsert = m.authorityQueryRaw.mock.calls
      .map((call) => call[0] as { sql?: string })
      .find((query) =>
        query.sql?.includes("INSERT INTO branch_materialization_retries")
      );
    expect(retryInsert).toBeUndefined();
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

    expect(m.artifactCreateMany).toHaveBeenCalledTimes(1);
    expect(m.branchCreateMany.mock.calls[0][0].data[0]).toMatchObject({
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

    expect(m.artifactCreateMany).toHaveBeenCalledTimes(1);
    expect(m.linkRow).toHaveBeenCalledTimes(1);
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

    expect(m.artifactCreateMany).not.toHaveBeenCalled();
    expect(m.linkRow).not.toHaveBeenCalled();
    expect(m.pushRow).not.toHaveBeenCalled();
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

    expect(m.artifactCreateMany).not.toHaveBeenCalled();
    expect(m.linkRow).not.toHaveBeenCalled();
    expect(m.pushRow).not.toHaveBeenCalled();
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

    expect(m.artifactCreateMany).not.toHaveBeenCalled();
    expect(m.linkRow).not.toHaveBeenCalled();
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

    expect(m.artifactCreateMany).not.toHaveBeenCalled();
    expect(m.linkRow).not.toHaveBeenCalled();
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

    expect(m.artifactCreateMany).toHaveBeenCalledTimes(1);
    expect(m.linkRow).toHaveBeenCalledTimes(1);
  });

  it("binds a monitored-activity-only PR ref's repo so its detail row resolves on an index (ISS-6450)", async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);

    await resolveSessionRepositoryIdentity(
      { $queryRaw: queryRaw } as never,
      "org-1",
      [
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
      ]
    );

    // The PR lane skips this ref, so without the binding no name is collected,
    // no query runs at all, and the monitored lane has no repositoryId —
    // falling back to the unindexed org-wide identity.
    expect(queryRaw.mock.calls.length).toBeGreaterThan(0);
    for (const [query] of queryRaw.mock.calls) {
      expect(query.values).toContain("acme/monitored-only");
    }
  });

  /**
   * ISS-9181 code review: the identity lane used to be the installation lookup
   * ALONE, and this case pinned that. It is not a lookup that can answer "the
   * organization holds no identity for this repository", which is now an
   * ACKNOWLEDGEMENT that discards the desktop's evidence — an org reaching a
   * repo through a public row, a PR head, or a verified observation holds
   * identity for it with no installation anywhere. What stays true, and is what
   * these two cases now pin, is that the monitored-only name never costs a
   * default-branch AUTHORITY query, and that it costs the other identity
   * sources only when the installation lookup did not already answer it.
   */
  it("resolves a monitored-only PR ref's repo on the installation lookup alone when that answers", async () => {
    const queryRaw = vi.fn().mockResolvedValue([
      {
        repositoryId: "repo-1",
        githubRepoId: "9001",
        fullName: "acme/monitored-only",
      },
    ]);

    await resolveSessionRepositoryIdentity(
      { $queryRaw: queryRaw } as never,
      "org-1",
      [
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
      ]
    );

    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(queryRaw.mock.calls[0][0].strings.join("")).toContain(
      "github_installation_repositories"
    );
  });

  it("keeps a monitored-only PR ref out of the default-branch authority queries", async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);

    await resolveSessionRepositoryIdentity(
      { $queryRaw: queryRaw } as never,
      "org-1",
      [
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
      ]
    );

    // The default-branch group is what the monitored-only name has no use for,
    // and every authority query selects it. Identity is a different question.
    const authorityQueries = queryRaw.mock.calls.filter(([query]) =>
      query.strings.join("").includes("default_branch_name")
    );
    expect(authorityQueries).toHaveLength(4);
    for (const [query] of authorityQueries) {
      expect(query.values).toContain("acme/web");
      expect(query.values).not.toContain("acme/monitored-only");
    }
    // The installation lookup came back empty for it, so the three sources that
    // could still hold an identity are asked — for that name and no other.
    const identityFallbacks = queryRaw.mock.calls.filter(
      ([query]) =>
        !query.strings.join("").includes("default_branch_name") &&
        query.values.includes("acme/monitored-only")
    );
    expect(identityFallbacks).toHaveLength(4);
    for (const [query] of identityFallbacks) {
      expect(query.values).not.toContain("acme/web");
    }
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

    await resolveSessionRepositoryIdentity(tx, "org-1", sessions);

    // 200 sessions x 500 refs = 1000 name chunks, x4 authority sources
    // (PLN-1775 M4 added the fourth). The point of the case is the CHUNK bound
    // below, which no added source may loosen.
    expect(queryRaw).toHaveBeenCalledTimes(4000);
    for (const [query] of queryRaw.mock.calls) {
      // Installed queries bind org + status + at most 100 names; public and
      // PR-head queries bind org + at most 100 names; the observation query
      // binds org + at most 100 names + the verification state.
      expect(query.values.length).toBeLessThanOrEqual(102);
    }
  }, 20_000);

  it("materializes a legacy PR-vouched retry aggregate without prRefs", async () => {
    const repository = repositoryWithAvailableDefault({
      id: "repo-1",
      githubRepoId: "987",
      fullName: "acme/web",
    });
    const authority = normalizePersistedRepositoryDefaultAuthority(
      {
        provider: VcsProviderKind.GitHub,
        providerRepositoryId: "987",
        fullName: "acme/web",
      },
      repository
    );
    if (!authority) {
      throw new Error("test authority did not normalize");
    }
    const artifactCreate = vi.fn().mockResolvedValue({ id: "branch-created" });
    const artifactLinkUpsert = vi.fn().mockResolvedValue({});
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      $executeRaw: vi.fn().mockResolvedValue(0),
      artifact: { create: artifactCreate },
      artifactLink: {
        findFirst: vi.fn().mockResolvedValue(null),
        upsert: artifactLinkUpsert,
      },
      branchDetail: {
        findFirst: vi.fn().mockResolvedValue(null),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    } as unknown as AgentSessionUpsertTx;

    const result = await materializeSessionBranchAggregate(tx, {
      organizationId: "org-1",
      projectId: "project-1",
      sessionArtifactId: "session-1",
      repositoryAuthority: {
        repositoryId: null,
        providerRepositoryId: "987",
        identitySources: new Set([RepositoryIdentitySource.Public]),
        authorities: [authority],
      },
      aggregate: {
        repositoryFullName: "acme/web",
        branchName: "feat/x",
        method: ArtifactRefMethod.PrCreateOutput,
        relation: ArtifactRefRelation.Created,
        observedAt: "2026-08-25T12:34:00.000Z",
        pullRequestObserved: true,
        branchLifecycleEvents: [],
      },
    });

    expect(result.status).toBe(BranchMaterializationStatus.Materialized);
    expect(artifactCreate).toHaveBeenCalledTimes(1);
    expect(artifactLinkUpsert).toHaveBeenCalledTimes(1);
  });

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
    expect(m.linkRow).toHaveBeenCalledTimes(1);

    m.linkRow.mockClear();
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

    expect(m.linkRow).not.toHaveBeenCalled();
    expect(m.artifactCreateMany).not.toHaveBeenCalled();
  });
});

function isBranchRetryPayload(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.includes('"repositoryFullName"') &&
    value.includes('"branchName"') &&
    value.includes('"directParticipation"')
  );
}
