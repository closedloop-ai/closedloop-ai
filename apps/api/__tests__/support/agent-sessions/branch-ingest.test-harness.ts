import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
  type SyncedAgentSession,
} from "@repo/api/src/types/agent-session";
import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
} from "@repo/api/src/types/github-read-model";
import {
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultSource,
} from "@repo/api/src/types/repository-default-identity";
import type { SyncedArtifactRef } from "@repo/api/src/types/session-artifact-link";
import { vi } from "vitest";
import { agentSessionsService } from "@/app/agent-sessions/service";
import { branchBatchObserver } from "./branch-batch-observer";
import { routeExistingBranchRows } from "./existing-branch-rows-double";
import {
  buildDefaultAgentSessionEventMocks,
  buildDefaultAgentSessionMocks,
  buildSlugCounterMock,
  buildSyncedSession,
  installDb,
  SESSION_STARTED_AT,
  withPersistedSessionArtifactId,
} from "./service.test-harness";

export type BranchIngestMocks = {
  linkRow: ReturnType<typeof vi.fn>;
  pushRow: ReturnType<typeof vi.fn>;
  artifactCreateMany: ReturnType<typeof vi.fn>;
  branchCreateMany: ReturnType<typeof vi.fn>;
  artifactLinkUpsert: ReturnType<typeof vi.fn>;
  artifactLinkFindFirst: ReturnType<typeof vi.fn>;
  installationFindFirst: ReturnType<typeof vi.fn>;
  repoFindMany: ReturnType<typeof vi.fn>;
  publicRepoFindMany: ReturnType<typeof vi.fn>;
  authorityQueryRaw: ReturnType<typeof vi.fn>;
  authorityExecuteRaw: ReturnType<typeof vi.fn>;
  branchFindFirst: ReturnType<typeof vi.fn>;
  branchFindMany: ReturnType<typeof vi.fn>;
  branchDetailUpdateMany: ReturnType<typeof vi.fn>;
  artifactCreate: ReturnType<typeof vi.fn>;
  sessionDetailUpdate: ReturnType<typeof vi.fn>;
  commitDetailFindMany: ReturnType<typeof vi.fn>;
  commitDetailCreate: ReturnType<typeof vi.fn>;
  commitDetailCreateMany: ReturnType<typeof vi.fn>;
  commitDetailUpdate: ReturnType<typeof vi.fn>;
};

export function installBranchIngestDb(overrides: {
  existingLink?: unknown;
  repos?: TestRepositoryAuthority[];
  pullRequestRepositories?: TestRepositoryAuthority[];
  /**
   * PLN-1775 M4: verified `github_observed_repository` rows — the fourth
   * authority source, and the only one an org with no App installation can
   * produce. The production query filters to `verified` rows carrying a
   * provider id, so rows supplied here stand for ones that already passed it.
   */
  observedRepositories?: TestRepositoryAuthority[];
  publicRepositories?: Array<{
    id: string;
    githubRepoId: string;
    fullName: string;
    defaultBranchName?: string;
  }>;
  branches?: Array<{
    artifactId: string;
    repositoryId: string;
    branchName: string;
    // Optional explicit stored repo full name. When omitted, the row's
    // composite identity resolves `repositoryId` through the repo mock (below).
    // Supply this directly to model cross-repo / same-branch-name rows whose
    // identity the batched commit-lane read must keep distinct.
    repositoryFullName?: string;
  }>;
  installation?: { id: string } | null;
  // Source artifact → project mapping used to resolve the session's project
  // (attribution.sourceArtifactId). Present only in the create-path test.
  artifactProjects?: Array<{ id: string; projectId: string }>;
  // ISS-4946: the persisted row's freshness watermark. Defaults to a value
  // strictly OLDER than the synced session's `updatedAt`, so both PR lanes are
  // ON by default and a test that does not care about freshness exercises the
  // real write path. Pass `SESSION_UPDATED_AT` to opt into the equal-watermark
  // tie, or a later date for a stale redelivery.
  storedSessionUpdatedAt?: Date;
}): BranchIngestMocks {
  const artifactLinkUpsert = vi.fn().mockResolvedValue({});
  const artifactLinkFindFirst = vi
    .fn()
    .mockResolvedValue(overrides.existingLink ?? null);
  const installationFindFirst = vi
    .fn()
    .mockResolvedValue(
      overrides.installation === undefined
        ? { id: "install-1" }
        : overrides.installation
    );
  const repos = (
    overrides.repos ?? [{ id: "repo-1", fullName: "acme/web" }]
  ).map((repo) => repositoryWithAvailableDefault(repo));
  const repoFindMany = vi.fn().mockResolvedValue(repos);
  const publicRepositories = (overrides.publicRepositories ?? []).map((repo) =>
    repositoryWithAvailableDefault(repo)
  );
  const publicRepoFindMany = vi.fn().mockResolvedValue(publicRepositories);
  const pullRequestRepositories = (overrides.pullRequestRepositories ?? []).map(
    (repository) => repositoryWithAvailableDefault(repository)
  );
  const observedRepositories = (overrides.observedRepositories ?? []).map(
    (repository) => repositoryWithAvailableDefault(repository)
  );
  const authorityQueryRaw = vi
    .fn()
    .mockImplementation((query: { sql?: string }) => {
      if (query.sql?.includes("github_installation_repositories")) {
        return Promise.resolve(
          overrides.installation === null
            ? []
            : repos.filter(
                (repository) => repository.installationStatus !== "INACTIVE"
              )
        );
      }
      if (query.sql?.includes("public_repositories")) {
        return Promise.resolve(publicRepositories);
      }
      if (query.sql?.includes("pull_request_detail")) {
        return Promise.resolve(pullRequestRepositories);
      }
      if (query.sql?.includes("github_observed_repository")) {
        return Promise.resolve(observedRepositories);
      }
      return Promise.resolve([]);
    });
  const {
    linkRow,
    pushRow,
    executeRaw: authorityExecuteRaw,
  } = branchBatchObserver();
  const artifactCreateMany = vi.fn().mockResolvedValue({ count: 1 });
  const branchCreateMany = vi.fn().mockResolvedValue({ count: 1 });
  const repoFullNameById = new Map(repos.map((r) => [r.id, r.fullName]));
  // The stored composite identity of a branch row is its (repositoryFullName,
  // branchName) pair — the real D2 unique key. A row may pin repositoryFullName
  // directly (to model cross-repo cases) or resolve it from repositoryId via the
  // repo mock. This is what a batched read genuinely selects; the mock must key
  // on it (not echo the query) so a cross-repo attach is caught.
  const storedRepoFullName = (b: {
    repositoryId: string;
    repositoryFullName?: string;
  }): string =>
    b.repositoryFullName ??
    repoFullNameById.get(b.repositoryId) ??
    repos[0]?.fullName ??
    "";
  // The single-row retry lane still resolves D2 through findFirst; inline
  // branch and commit lanes use the scoped set read below.
  const branches = overrides.branches ?? [];
  const branchFindFirst = vi
    .fn()
    .mockImplementation((args: { where?: { branchName?: string } }) => {
      const branchName = args?.where?.branchName;
      const match = branches.find((b) => b.branchName === branchName);
      return Promise.resolve(match ? { artifactId: match.artifactId } : null);
    });
  // ISS-4440 commit lane: branches are now resolved in one batched findMany over
  // the distinct (repo, branch) pairs. The mock matches each OR pair against the
  // row's STORED composite identity (repo full name AND branch name) and returns
  // the STORED identity — it never echoes the query. That is what lets a
  // cross-repo attach (right branch name, wrong repo) fail the test instead of
  // silently resolving. It also asserts the read stays org-scoped and that every
  // OR pair carries the full composite key, so a regression to an unscoped or
  // branch-name-only query is caught.
  const branchFindMany = vi.fn().mockImplementation(
    (args: {
      where?: {
        organizationId?: string;
        OR?: Array<{ repositoryFullName: string; branchName: string }>;
      };
    }) => {
      const where = args?.where ?? {};
      // Guard the scoped read shape so a regression to an unscoped or
      // branch-name-only query fails the test (throwing rejects the mocked
      // call, surfacing in the awaiting assertion).
      if (where.organizationId === undefined) {
        throw new Error("batched branch read must be org-scoped");
      }
      const pairs = where.OR ?? [];
      const rows: Array<{
        artifactId: string;
        repositoryFullName: string;
        branchName: string;
      }> = [];
      for (const pair of pairs) {
        if (
          typeof pair.repositoryFullName !== "string" ||
          typeof pair.branchName !== "string"
        ) {
          throw new Error(
            "each batched branch pair must scope both repositoryFullName and branchName"
          );
        }
        const match = branches.find(
          (b) =>
            storedRepoFullName(b) === pair.repositoryFullName &&
            b.branchName === pair.branchName
        );
        if (match) {
          rows.push({
            artifactId: match.artifactId,
            repositoryFullName: storedRepoFullName(match),
            branchName: match.branchName,
          });
        }
      }
      return Promise.resolve(rows);
    }
  );
  const artifactCreate = vi.fn().mockResolvedValue({ id: "created-branch-1" });
  // PLN-1099 Phase 2b: the set-once/earliest-wins push-state stamp
  // (`stampBranchFirstPush`) issues a guarded branchDetail.updateMany.
  const branchDetailUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
  const sessionDetailUpdate = vi.fn().mockResolvedValue({});

  // FEA-2731 commit lane: an in-memory CommitDetail delegate exercising the
  // (org, repo, sha-prefix) findMany + createMany + update-by-id that
  // `reconcileCommitsOnTx` uses. ISS-8145 batched that path, so the findMany
  // understands the `OR` form a call carrying several distinct prefixes emits,
  // and inserts arrive through `createMany` rather than one `create` per row.
  const commitRows: Record<string, unknown>[] = [];
  let commitSeq = 0;
  const commitDetailFindMany = vi.fn().mockImplementation(
    (args: {
      where?: {
        organizationId?: string;
        repositoryFullName?: string;
        sha?: { startsWith?: string };
        OR?: { sha: { startsWith: string } }[];
      };
    }) => {
      const where = args?.where ?? {};
      const prefixes =
        where.OR?.map((clause) => clause.sha.startsWith) ??
        (where.sha?.startsWith === undefined
          ? undefined
          : [where.sha.startsWith]);
      return Promise.resolve(
        commitRows.filter(
          (r) =>
            r.organizationId === where.organizationId &&
            r.repositoryFullName === where.repositoryFullName &&
            (prefixes === undefined ||
              prefixes.some((prefix) => String(r.sha).startsWith(prefix)))
        )
      );
    }
  );
  const commitDetailCreate = vi
    .fn()
    .mockImplementation((args: { data: Record<string, unknown> }) => {
      const row = { ...args.data, id: `commit-${++commitSeq}` };
      commitRows.push(row);
      return Promise.resolve(row);
    });
  const commitDetailCreateMany = vi
    .fn()
    .mockImplementation(
      (args: { data: Record<string, unknown>[]; skipDuplicates?: boolean }) => {
        for (const data of args.data) {
          const duplicate = commitRows.some(
            (r) =>
              r.organizationId === data.organizationId &&
              r.repositoryFullName === data.repositoryFullName &&
              r.sha === data.sha
          );
          if (args.skipDuplicates && duplicate) {
            continue;
          }
          commitRows.push({ ...data, id: `commit-${++commitSeq}` });
        }
        return Promise.resolve({ count: args.data.length });
      }
    );
  const commitDetailUpdate = vi
    .fn()
    .mockImplementation(
      (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = commitRows.find((r) => r.id === args.where.id);
        if (row) {
          Object.assign(row, args.data);
        }
        return Promise.resolve(row);
      }
    );

  installDb({
    $queryRaw: routeExistingBranchRows(branchFindMany, authorityQueryRaw),
    $executeRaw: authorityExecuteRaw,
    computeTarget: {
      findFirst: vi.fn().mockResolvedValue({ id: "target-1" }),
      update: vi.fn().mockResolvedValue({ id: "target-1" }),
    },
    slugCounter: buildSlugCounterMock(),
    sessionDetail: buildDefaultAgentSessionMocks({
      // ISS-4946: `sessionUpdatedAt` is a non-null column that the upsert reads
      // as its freshness watermark, so a persisted-row stub must carry it.
      // The DEFAULT is deliberately older than the synced session's `updatedAt`
      // (an ordinary in-order resync that advances the row), which puts both PR
      // lanes ON. Defaulting to the equal watermark instead would silently make
      // every PR-lane write conditional on the fixture happening to carry PR
      // evidence — a new test could then assert nothing and still pass.
      findUnique: vi.fn().mockResolvedValue(
        withPersistedSessionArtifactId({
          metadata: null,
          sessionStartedAt: SESSION_STARTED_AT,
          sessionUpdatedAt:
            overrides.storedSessionUpdatedAt ?? SESSION_STARTED_AT,
          sessionEndedAt: null,
        })
      ),
      update: sessionDetailUpdate,
    }),
    artifact: {
      create: artifactCreate,
      createMany: artifactCreateMany,
      findMany: vi.fn().mockResolvedValue(overrides.artifactProjects ?? []),
    },
    artifactLink: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      findFirst: artifactLinkFindFirst,
      findMany: vi.fn().mockImplementation(({ where }) =>
        Promise.resolve(
          overrides.existingLink
            ? (where.targetId?.in ?? []).map((targetId: string) => ({
                targetId,
                ...(overrides.existingLink as object),
              }))
            : []
        )
      ),
      upsert: artifactLinkUpsert,
    },
    agentSessionEvent: buildDefaultAgentSessionEventMocks(),
    // ISS-12552: implementation evidence derivation reads and replaces these.
    agentSessionOperationEvidence: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    agentSessionTokenUsage: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    gitHubInstallation: { findFirst: installationFindFirst },
    gitHubInstallationRepository: { findMany: repoFindMany },
    publicRepository: {
      findMany: publicRepoFindMany,
    },
    branchDetail: {
      createMany: branchCreateMany,
      findFirst: branchFindFirst,
      findMany: branchFindMany,
      updateMany: branchDetailUpdateMany,
    },
    commitDetail: {
      findMany: commitDetailFindMany,
      create: commitDetailCreate,
      createMany: commitDetailCreateMany,
      update: commitDetailUpdate,
    },
  });

  return {
    linkRow,
    pushRow,
    artifactCreateMany,
    branchCreateMany,
    artifactLinkUpsert,
    artifactLinkFindFirst,
    installationFindFirst,
    repoFindMany,
    publicRepoFindMany,
    authorityQueryRaw,
    authorityExecuteRaw,
    branchFindFirst,
    branchFindMany,
    branchDetailUpdateMany,
    artifactCreate,
    sessionDetailUpdate,
    commitDetailFindMany,
    commitDetailCreate,
    commitDetailCreateMany,
    commitDetailUpdate,
  };
}

export function syncBranchRefs(
  artifactRefs: SyncedArtifactRef[],
  attribution?: SyncedAgentSession["attribution"]
) {
  return agentSessionsService.upsertSessions(
    {
      organizationId: "org-1",
      userId: "user-1",
      computeTargetId: "target-1",
    },
    {
      schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
      batchId: "branch-batch",
      syncMode: AgentSessionSyncMode.Incremental,
      sessionCount: 1,
      sessions: [
        buildSyncedSession({
          artifactRefs,
          ...(attribution ? { attribution } : {}),
        }),
      ],
    }
  );
}

export type TestRepositoryAuthority = {
  id: string;
  fullName: string;
  githubRepoId?: string;
  defaultBranchName?: string | null;
  installationStatus?: "ACTIVE" | "INACTIVE";
  [key: string]: unknown;
};

export function repositoryWithAvailableDefault<
  T extends TestRepositoryAuthority,
>(repository: T) {
  return {
    defaultBranchName: "main",
    defaultBranchAvailability: RepositoryDefaultAvailability.Available,
    defaultBranchCompleteness: RepositoryDefaultCompleteness.Complete,
    defaultBranchReason: null,
    defaultBranchSource: RepositoryDefaultSource.RepositoryRest,
    defaultBranchMechanism: GitHubFetchMechanism.Rest,
    defaultBranchTrigger: GitHubFetchTrigger.Backfill,
    defaultBranchCredentialType: GitHubFetchCredentialType.GitHubApp,
    defaultBranchCredentialOwnerId: null,
    defaultBranchObservationKey: "test-observation",
    defaultBranchObservedAt: new Date("2026-08-11T00:00:00.000Z"),
    defaultBranchEventAt: null,
    ...repository,
    githubRepoId: repository.githubRepoId ?? repository.id,
  };
}
