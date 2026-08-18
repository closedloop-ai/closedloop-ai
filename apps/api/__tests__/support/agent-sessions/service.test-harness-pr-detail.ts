/**
 * @file service.test-harness-pr-detail.ts
 * @description Harness for the FEA-2732 `pull_request` artifact-ref lane
 * (`service/artifact-links/pull-request-details.ts`).
 *
 * A sibling of `service.test-harness.ts` rather than an extension of it: that
 * file is already ~740 lines against the 1,000 ceiling, and this delegate is a
 * distinct responsibility (the PullRequestDetail identity/ownership matrix)
 * rather than more of the branch-ingest one.
 *
 * The `pullRequestDetail` delegate is backed by an in-memory row store keyed the
 * way the PRODUCTION identity is — `(organizationId, repositoryId, number)` when
 * the repo is resolved, else `(organizationId, repositoryFullName, number)`. It
 * never echoes the query back, so a regression to a `branchArtifactId`-scoped
 * lookup (the FEA-3917 bug) fails the test instead of silently resolving.
 *
 * Two other delegates are stateful for the same reason. `updateMany` applies its
 * `where` to the row store, so the isCurrent demote that keeps one current PR
 * per branch is observable. `branchDetail.findUnique`/`update` are backed by a
 * per-branch-artifact pointer map, so a pointer written for one PR is read back
 * by the next PR in the SAME sync — the desktop-owned-handover branch.
 */

import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
  type SyncedAgentSession,
} from "@repo/api/src/types/agent-session";
import type { SyncedArtifactRef } from "@repo/api/src/types/session-artifact-link";
import { vi } from "vitest";
import { agentSessionsService } from "@/app/agent-sessions/service";
import {
  buildDefaultAgentSessionEventMocks,
  buildDefaultAgentSessionMocks,
  buildSlugCounterMock,
  buildSyncedSession,
  installDb,
  repositoryWithAvailableDefault,
  SESSION_STARTED_AT,
  type TestRepositoryAuthority,
} from "./service.test-harness";

/** A PullRequestDetail row as the lane's reads select it. */
export type SeededPrDetailRow = {
  id: string;
  branchArtifactId: string;
  organizationId?: string;
  repositoryId?: string | null;
  repositoryFullName?: string | null;
  number: number;
  fetchMechanism?: string | null;
  fetchObservedAt?: Date | null;
  githubId?: string | null;
  title?: string | null;
  htmlUrl?: string | null;
  additions?: number | null;
  deletions?: number | null;
  changedFiles?: number | null;
  isCurrent?: boolean;
};

export type PrDetailIngestMocks = {
  prFindFirst: ReturnType<typeof vi.fn>;
  prFindUnique: ReturnType<typeof vi.fn>;
  prCreateMany: ReturnType<typeof vi.fn>;
  prUpdate: ReturnType<typeof vi.fn>;
  prUpdateMany: ReturnType<typeof vi.fn>;
  branchDetailFindUnique: ReturnType<typeof vi.fn>;
  branchDetailUpdate: ReturnType<typeof vi.fn>;
  branchDetailUpdateMany: ReturnType<typeof vi.fn>;
  artifactUpdateMany: ReturnType<typeof vi.fn>;
  artifactCreate: ReturnType<typeof vi.fn>;
  sessionDetailUpdate: ReturnType<typeof vi.fn>;
  /** Live view of the in-memory PullRequestDetail table. */
  rows: SeededPrDetailRow[];
  /**
   * Live view of `BranchDetail.currentPullRequestDetailId`, keyed by branch
   * artifact id. `branchDetail.update` writes here and `branchDetail.findUnique`
   * reads it back, so a pointer moved earlier in a sync is visible to the next
   * PR in the SAME sync — the desktop-owned-handover branch of
   * `maybeSetBranchCurrentPullRequest`.
   */
  branchPointers: Map<string, string | null>;
};

const ORG_ID = "org-1";

function matchesIdentity(
  row: SeededPrDetailRow,
  where: Record<string, unknown>
): boolean {
  if (
    where.organizationId !== undefined &&
    row.organizationId !== where.organizationId
  ) {
    return false;
  }
  if (where.number !== undefined && row.number !== where.number) {
    return false;
  }
  if (where.repositoryId !== undefined) {
    const wanted = where.repositoryId as string | null;
    if ((row.repositoryId ?? null) !== wanted) {
      return false;
    }
  }
  if (
    where.repositoryFullName !== undefined &&
    (row.repositoryFullName ?? null) !== where.repositoryFullName
  ) {
    return false;
  }
  return true;
}

/** Honour an `{ id: { not } }` predicate the way the demote's `where` writes it. */
function matchesIdPredicate(
  row: SeededPrDetailRow,
  predicate: unknown
): boolean {
  if (predicate === undefined) {
    return true;
  }
  if (typeof predicate === "string") {
    return row.id === predicate;
  }
  const excluded = (predicate as { not?: string }).not;
  return excluded === undefined || row.id !== excluded;
}

/**
 * Predicate for `pullRequestDetail.updateMany` — the isCurrent demote in
 * `maybeSetBranchCurrentPullRequest`. Applied to `rows` so dropping the demote,
 * or widening/narrowing its `where`, is observable instead of silently green.
 */
function matchesUpdateManyWhere(
  row: SeededPrDetailRow,
  where: Record<string, unknown>
): boolean {
  if (
    where.branchArtifactId !== undefined &&
    row.branchArtifactId !== where.branchArtifactId
  ) {
    return false;
  }
  if (
    where.isCurrent !== undefined &&
    (row.isCurrent ?? false) !== where.isCurrent
  ) {
    return false;
  }
  return matchesIdPredicate(row, where.id);
}

/**
 * Install a db mock for the PR-detail lane.
 *
 * @param overrides.pullRequestDetails rows already in the table
 * @param overrides.branchCurrentPrId the seeded current PR pointer for every
 *   seeded branch artifact; the pointer is then live (updates are read back)
 * @param overrides.repos installation repos, resolving repositoryId by full name
 * @param overrides.branches existing branch artifacts keyed by branch name
 */
export function installPrDetailIngestDb(overrides: {
  pullRequestDetails?: SeededPrDetailRow[];
  branchCurrentPrId?: string | null;
  repos?: TestRepositoryAuthority[];
  publicRepositories?: Array<{
    id: string;
    githubRepoId: string;
    fullName: string;
    defaultBranchName?: string;
  }>;
  branches?: Array<{ artifactId: string; branchName: string }>;
}): PrDetailIngestMocks {
  const rows: SeededPrDetailRow[] = (overrides.pullRequestDetails ?? []).map(
    (r) => ({ organizationId: ORG_ID, repositoryId: null, ...r })
  );
  let prSeq = 0;

  const prFindFirst = vi
    .fn()
    .mockImplementation((args: { where?: Record<string, unknown> }) => {
      const where = args?.where ?? {};
      if (where.organizationId === undefined) {
        throw new Error("PullRequestDetail lookup must be org-scoped");
      }
      // Nulls-last on repositoryId, matching the production orderBy: an adopted
      // row is preferred over a repo-less one.
      const matched = rows
        .filter((r) => matchesIdentity(r, where))
        .sort(
          (a, b) =>
            (a.repositoryId == null ? 1 : 0) - (b.repositoryId == null ? 1 : 0)
        );
      return Promise.resolve(matched[0] ?? null);
    });

  const prCreateMany = vi
    .fn()
    .mockImplementation((args: { data: SeededPrDetailRow[] }) => {
      let created = 0;
      for (const candidate of args.data) {
        // ON CONFLICT DO NOTHING over the same identity the production insert
        // targets — a racing duplicate must no-op, not append a second row.
        const clash = rows.some(
          (r) =>
            r.organizationId === candidate.organizationId &&
            r.number === candidate.number &&
            ((candidate.repositoryId != null &&
              r.repositoryId === candidate.repositoryId) ||
              (candidate.repositoryId == null &&
                r.repositoryId == null &&
                r.repositoryFullName === candidate.repositoryFullName))
        );
        if (clash) {
          continue;
        }
        rows.push({ ...candidate, id: `pr-created-${++prSeq}` });
        created += 1;
      }
      return Promise.resolve({ count: created });
    });

  const prUpdate = vi
    .fn()
    .mockImplementation(
      (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = rows.find((r) => r.id === args.where.id);
        if (row) {
          Object.assign(row, args.data);
        }
        return Promise.resolve(row);
      }
    );

  // The isCurrent demote — the one write keeping isCurrent mutually exclusive
  // per branch. Applied to `rows` so the invariant is assertable.
  const prUpdateMany = vi
    .fn()
    .mockImplementation(
      (args: {
        where?: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const where = args?.where ?? {};
        let count = 0;
        for (const row of rows) {
          if (matchesUpdateManyWhere(row, where)) {
            Object.assign(row, args.data);
            count += 1;
          }
        }
        return Promise.resolve({ count });
      }
    );

  // `maybeSetBranchCurrentPullRequest` reads the branch's existing current PR by
  // id to decide whether an App producer owns the pointer (webhook-wins).
  const prFindUnique = vi
    .fn()
    .mockImplementation((args: { where: { id: string } }) =>
      Promise.resolve(rows.find((r) => r.id === args.where.id) ?? null)
    );

  const repos = (
    overrides.repos ?? [{ id: "repo-1", fullName: "acme/web" }]
  ).map((repository) => repositoryWithAvailableDefault(repository));
  const publicRepositories = (overrides.publicRepositories ?? []).map(
    (repository) => repositoryWithAvailableDefault(repository)
  );
  const authorityQueryRaw = vi
    .fn()
    .mockImplementation((query: { sql?: string }) => {
      if (query.sql?.includes("github_installation_repositories")) {
        return Promise.resolve(repos);
      }
      if (query.sql?.includes("public_repositories")) {
        return Promise.resolve(publicRepositories);
      }
      return Promise.resolve([]);
    });
  const branches = overrides.branches ?? [
    { artifactId: "branch-artifact-1", branchName: "feat/x" },
  ];

  // Real branch pointers: seeded per branch artifact, written by
  // `branchDetail.update`, and read back by `branchDetail.findUnique`. Without
  // the write-back a second PR in the same sync re-reads the seeded value and
  // the desktop-owned-handover branch is never reached.
  const branchPointers = new Map<string, string | null>(
    branches.map((b) => [b.artifactId, overrides.branchCurrentPrId ?? null])
  );

  const branchDetailFindUnique = vi
    .fn()
    .mockImplementation((args: { where?: { artifactId?: string } }) => {
      const artifactId = args?.where?.artifactId;
      if (artifactId === undefined) {
        throw new Error("BranchDetail lookup must be artifact-scoped");
      }
      return Promise.resolve({
        currentPullRequestDetailId: branchPointers.get(artifactId) ?? null,
      });
    });
  const branchDetailUpdate = vi
    .fn()
    .mockImplementation(
      (args: {
        where: { artifactId: string };
        data: Record<string, unknown>;
      }) => {
        if ("currentPullRequestDetailId" in args.data) {
          branchPointers.set(
            args.where.artifactId,
            (args.data.currentPullRequestDetailId ?? null) as string | null
          );
        }
        return Promise.resolve({ artifactId: args.where.artifactId });
      }
    );
  const branchDetailUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
  const artifactUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
  const artifactCreate = vi.fn().mockResolvedValue({ id: "created-branch-1" });
  const sessionDetailUpdate = vi.fn().mockResolvedValue({});

  installDb({
    $queryRaw: authorityQueryRaw,
    computeTarget: {
      findFirst: vi.fn().mockResolvedValue({ id: "target-1" }),
      update: vi.fn().mockResolvedValue({ id: "target-1" }),
    },
    slugCounter: buildSlugCounterMock(),
    sessionDetail: buildDefaultAgentSessionMocks({
      findUnique: vi.fn().mockResolvedValue({
        metadata: null,
        sessionStartedAt: SESSION_STARTED_AT,
        sessionUpdatedAt: SESSION_STARTED_AT,
        sessionEndedAt: null,
      }),
      update: sessionDetailUpdate,
    }),
    artifact: {
      create: artifactCreate,
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: artifactUpdateMany,
    },
    artifactLink: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue({}),
    },
    agentSessionEvent: buildDefaultAgentSessionEventMocks(),
    agentSessionTokenUsage: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    gitHubInstallation: { findFirst: vi.fn().mockResolvedValue({ id: "i-1" }) },
    gitHubInstallationRepository: {
      findMany: vi.fn().mockResolvedValue(repos),
    },
    publicRepository: {
      findMany: vi.fn().mockResolvedValue(publicRepositories),
    },
    branchDetail: {
      findFirst: vi
        .fn()
        .mockImplementation((args: { where?: { branchName?: string } }) => {
          const match = branches.find(
            (b) => b.branchName === args?.where?.branchName
          );
          return Promise.resolve(
            match ? { artifactId: match.artifactId } : null
          );
        }),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: branchDetailFindUnique,
      update: branchDetailUpdate,
      updateMany: branchDetailUpdateMany,
    },
    pullRequestDetail: {
      findFirst: prFindFirst,
      findUnique: prFindUnique,
      createMany: prCreateMany,
      update: prUpdate,
      updateMany: prUpdateMany,
    },
    commitDetail: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    },
  });

  return {
    prFindFirst,
    prFindUnique,
    prCreateMany,
    prUpdate,
    prUpdateMany,
    branchDetailFindUnique,
    branchDetailUpdate,
    branchDetailUpdateMany,
    artifactUpdateMany,
    artifactCreate,
    sessionDetailUpdate,
    rows,
    branchPointers,
  };
}

/** Drive one session sync carrying `artifactRefs` through the real service. */
export function syncPrDetailRefs(
  artifactRefs: SyncedArtifactRef[],
  attribution?: SyncedAgentSession["attribution"]
) {
  return agentSessionsService.upsertSessions(
    {
      organizationId: ORG_ID,
      userId: "user-1",
      computeTargetId: "target-1",
    },
    {
      schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
      batchId: "pr-detail-batch",
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
