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
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  ArtifactRefTargetKind,
  type SyncedArtifactRef,
} from "@repo/api/src/types/session-artifact-link";
import { vi } from "vitest";
import { agentSessionsService } from "@/app/agent-sessions/service";
import {
  repositoryWithAvailableDefault,
  type TestRepositoryAuthority,
} from "./branch-ingest.test-harness";
import {
  buildDefaultAgentSessionEventMocks,
  buildDefaultAgentSessionMocks,
  buildSlugCounterMock,
  buildSyncedSession,
  installDb,
  SESSION_STARTED_AT,
  withPersistedSessionArtifactId,
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
  baseRefName?: string | null;
  isCurrent?: boolean;
};

export type PrDetailIngestMocks = {
  prFindFirst: ReturnType<typeof vi.fn>;
  prFindMany: ReturnType<typeof vi.fn>;
  prFindUnique: ReturnType<typeof vi.fn>;
  prCreateMany: ReturnType<typeof vi.fn>;
  prUpdate: ReturnType<typeof vi.fn>;
  prUpdateMany: ReturnType<typeof vi.fn>;
  queryRaw: ReturnType<typeof vi.fn>;
  branchDetailFindUnique: ReturnType<typeof vi.fn>;
  branchDetailUpdate: ReturnType<typeof vi.fn>;
  branchDetailUpdateMany: ReturnType<typeof vi.fn>;
  artifactUpdateMany: ReturnType<typeof vi.fn>;
  artifactCreate: ReturnType<typeof vi.fn>;
  artifactLinkUpsert: ReturnType<typeof vi.fn>;
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
  /**
   * Live view of `BranchDetail.baseBranch`/`baseBranchSource`, keyed by branch
   * artifact id (ISS-8175). Seeded, read back by `branchDetail.findFirst`, and
   * written by `branchDetail.updateMany`, so the base-provenance decider sees a
   * real stored source instead of a mock that answers the same either way.
   */
  branchBases: Map<string, SeededBranchBase>;
};

/** A branch's stored base provenance, as the ISS-8175 write reads it. */
export type SeededBranchBase = {
  baseBranch: string | null;
  baseBranchSource: string | null;
};

const ORG_ID = "org-1";

function matchesIdentity(
  row: SeededPrDetailRow,
  where: Record<string, unknown>
): boolean {
  if (
    Array.isArray(where.OR) &&
    !where.OR.some((arm) => matchesIdentity(row, arm))
  ) {
    return false;
  }
  if (where.id !== undefined && row.id !== where.id) {
    return false;
  }
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
  // ISS-8175 review: the out-of-order base gap-fill is fill-only IN THE
  // PREDICATE (`baseRefName: null`), which is its ONLY guard — it is not also
  // read-checked before the call. Honour it here or the mock would apply that
  // update to a row that already has a base and the "leaves a stored base
  // alone" case could not fail.
  if (
    where.baseRefName !== undefined &&
    (row.baseRefName ?? null) !== where.baseRefName
  ) {
    return false;
  }
  return matchesIdPredicate(row, where.id);
}

/**
 * Apply a `branchDetail.updateMany` predicate to the live pointer/base maps.
 * Only the compare-and-swap keys the two branch writers actually pin are
 * honored; `artifactId`/`organizationId` scope the row and are matched by the
 * caller's map lookup.
 */
function matchesBranchDetailWhere(
  where: Record<string, unknown> & { artifactId: string },
  branchPointers: Map<string, string | null>,
  branchBases: Map<string, SeededBranchBase>
): boolean {
  if (
    where.currentPullRequestDetailId !== undefined &&
    (branchPointers.get(where.artifactId) ?? null) !==
      where.currentPullRequestDetailId
  ) {
    return false;
  }
  const base = branchBases.get(where.artifactId);
  if (
    where.baseBranch !== undefined &&
    (base?.baseBranch ?? null) !== where.baseBranch
  ) {
    return false;
  }
  return !(
    where.baseBranchSource !== undefined &&
    (base?.baseBranchSource ?? null) !== where.baseBranchSource
  );
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
  branches?: Array<{
    artifactId: string;
    branchName: string;
    repositoryFullName?: string;
  }>;
  /** Stored base provenance for every seeded branch artifact (ISS-8175). */
  branchBase?: SeededBranchBase;
  /**
   * Fired immediately after the artifact-scoped base read returns, so a test can
   * simulate a concurrent producer writing between that read and the
   * compare-and-swap update it feeds.
   */
  onBranchBaseRead?: () => void;
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
  const prFindMany = vi
    .fn()
    .mockImplementation((args: { where?: Record<string, unknown> }) => {
      const where = args?.where ?? {};
      if (where.organizationId === undefined) {
        throw new Error("PullRequestDetail lookup must be org-scoped");
      }
      return Promise.resolve(rows.filter((row) => matchesIdentity(row, where)));
    });

  const prCreateMany = vi
    .fn()
    .mockImplementation((args: { data: SeededPrDetailRow[] }) => {
      const created: SeededPrDetailRow[] = [];
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
        const row = { ...candidate, id: `pr-created-${++prSeq}` };
        rows.push(row);
        created.push(row);
      }
      return Promise.resolve(created);
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
  const branches = (
    overrides.branches ?? [
      {
        artifactId: "branch-artifact-1",
        branchName: "feat/x",
        repositoryFullName: "acme/web",
      },
    ]
  ).map((branch) => ({ repositoryFullName: "acme/web", ...branch }));

  // Real branch pointers: seeded per branch artifact, written by
  // `branchDetail.update`, and read back by `branchDetail.findUnique`. Without
  // the write-back a second PR in the same sync re-reads the seeded value and
  // the desktop-owned-handover branch is never reached.
  const branchPointers = new Map<string, string | null>(
    branches.map((b) => [b.artifactId, overrides.branchCurrentPrId ?? null])
  );
  const branchBases = new Map<string, SeededBranchBase>(
    branches.map((b) => [
      b.artifactId,
      overrides.branchBase ?? { baseBranch: null, baseBranchSource: null },
    ])
  );

  const branchDetailFindUnique = vi.fn().mockImplementation(
    (args: {
      where?: {
        artifactId?: string;
        organizationId_artifactId?: { artifactId?: string };
      };
    }) => {
      const artifactId =
        args?.where?.artifactId ??
        args?.where?.organizationId_artifactId?.artifactId;
      if (artifactId === undefined) {
        throw new Error("BranchDetail lookup must be artifact-scoped");
      }
      return Promise.resolve({
        currentPullRequestDetailId: branchPointers.get(artifactId) ?? null,
      });
    }
  );
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
  const branchDetailUpdateMany = vi
    .fn()
    .mockImplementation(
      (args: {
        where: Record<string, unknown> & { artifactId: string };
        data: Record<string, unknown>;
      }) => {
        // Both branch writers here are compare-and-swap: the promotion helper
        // pins `currentPullRequestDetailId`, and the ISS-8175 base write pins
        // that plus the two base columns it decided from. Apply the predicate to
        // the live maps — a mock that wrote regardless of it would return count 1
        // for a row that moved underneath, and no interleaving case could fail.
        if (
          !matchesBranchDetailWhere(args.where, branchPointers, branchBases)
        ) {
          return Promise.resolve({ count: 0 });
        }
        if ("currentPullRequestDetailId" in args.data) {
          branchPointers.set(
            args.where.artifactId,
            (args.data.currentPullRequestDetailId ?? null) as string | null
          );
        }
        if ("baseBranch" in args.data) {
          branchBases.set(args.where.artifactId, {
            baseBranch: (args.data.baseBranch ?? null) as string | null,
            baseBranchSource: (args.data.baseBranchSource ?? null) as
              | string
              | null,
          });
        }
        return Promise.resolve({ count: 1 });
      }
    );
  const artifactUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
  const artifactCreate = vi.fn().mockResolvedValue({ id: "created-branch-1" });
  const artifactLinkUpsert = vi.fn().mockResolvedValue({});
  const sessionDetailUpdate = vi.fn().mockResolvedValue({});

  installDb({
    $executeRaw: vi.fn().mockResolvedValue(1),
    $queryRaw: authorityQueryRaw,
    computeTarget: {
      findFirst: vi.fn().mockResolvedValue({ id: "target-1" }),
      update: vi.fn().mockResolvedValue({ id: "target-1" }),
    },
    slugCounter: buildSlugCounterMock(),
    sessionDetail: buildDefaultAgentSessionMocks({
      findUnique: vi.fn().mockResolvedValue(
        withPersistedSessionArtifactId({
          metadata: null,
          sessionStartedAt: SESSION_STARTED_AT,
          sessionUpdatedAt: SESSION_STARTED_AT,
          sessionEndedAt: null,
        })
      ),
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
      upsert: artifactLinkUpsert,
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
        .mockImplementation(
          (args: {
            where?: { branchName?: string; artifactId?: string };
            select?: Record<string, unknown>;
          }) => {
            // ISS-8175: the base-provenance read is artifact-scoped, the D2
            // materialization read is name-scoped. Answering the same shape for
            // both would make the base write untestable.
            const artifactId = args?.where?.artifactId;
            if (artifactId !== undefined) {
              const branch = branches.find((b) => b.artifactId === artifactId);
              if (!branch) {
                return Promise.resolve(null);
              }
              if (!(args.select?.baseBranch || args.select?.baseBranchSource)) {
                return Promise.resolve({
                  branchName: branch.branchName,
                  repositoryFullName: branch.repositoryFullName,
                });
              }
              const base = branchBases.get(artifactId);
              // The base read is joined with the current-PR pointer (ISS-8175
              // review): the write only fires for the branch's CURRENT PR, so a
              // mock that omitted the pointer would answer the same either way.
              const row = base
                ? {
                    ...base,
                    branchName: branch.branchName,
                    currentPullRequestDetailId:
                      branchPointers.get(artifactId) ?? null,
                    repositoryFullName: branch.repositoryFullName,
                  }
                : null;
              // Interleaving seam: the base write is a compare-and-swap against
              // exactly this snapshot, so a test lands a concurrent producer's
              // write HERE — after the read, before the update — to exercise the
              // window READ COMMITTED actually leaves open.
              overrides.onBranchBaseRead?.();
              return Promise.resolve(row);
            }
            const match = branches.find(
              (b) => b.branchName === args?.where?.branchName
            );
            return Promise.resolve(
              match ? { artifactId: match.artifactId } : null
            );
          }
        ),
      findMany: vi
        .fn()
        .mockImplementation((args) =>
          Promise.resolve(
            branches.filter(
              (branch) =>
                !args.where.artifactId?.in ||
                args.where.artifactId.in.includes(branch.artifactId)
            )
          )
        ),
      findUnique: branchDetailFindUnique,
      update: branchDetailUpdate,
      updateMany: branchDetailUpdateMany,
    },
    pullRequestDetail: {
      findFirst: prFindFirst,
      findMany: prFindMany,
      findUnique: prFindUnique,
      createManyAndReturn: prCreateMany,
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
    prFindMany,
    prFindUnique,
    prCreateMany,
    prUpdate,
    prUpdateMany,
    queryRaw: authorityQueryRaw,
    branchDetailFindUnique,
    branchDetailUpdate,
    branchDetailUpdateMany,
    artifactUpdateMany,
    artifactCreate,
    artifactLinkUpsert,
    sessionDetailUpdate,
    rows,
    branchPointers,
    branchBases,
  };
}

/** Drive one session sync carrying `artifactRefs` through the real service. */
export function syncPrDetailRefs(
  artifactRefs: SyncedArtifactRef[],
  attribution?: SyncedAgentSession["attribution"],
  sessionOverrides: Partial<SyncedAgentSession> = {}
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
          ...sessionOverrides,
          artifactRefs,
          ...(attribution ? { attribution } : {}),
        }),
      ],
    }
  );
}

export const PR_DETAIL_OBSERVED_AT = "2026-05-20T18:00:00.000Z";
export const PR_DETAIL_BRANCH_ARTIFACT_ID = "branch-artifact-1";

// `method` is the one the extractor really stamps on a CREATED pull-request ref
// (`artifact-ref-extractor.ts`: `pr_create_output`). It was `gh_pr_create` here,
// which is the BRANCH lane's method and never a PR ref's — inert until ISS-8175
// made the base gate read it, so the fixture is corrected rather than relaxed.
export function prDetailRef(
  overrides: Record<string, unknown> = {}
): SyncedArtifactRef {
  return {
    kind: ArtifactRefTargetKind.PullRequest,
    repositoryFullName: "acme/web",
    prNumber: 42,
    method: ArtifactRefMethod.PrCreateOutput,
    relation: ArtifactRefRelation.Created,
    observedAt: PR_DETAIL_OBSERVED_AT,
    branchName: "feat/x",
    ...overrides,
  } as SyncedArtifactRef;
}
