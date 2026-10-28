import { GitHubCredentialKind } from "@repo/api/src/types/github";
import { vi } from "vitest";

/**
 * Shared doubles for the reconcile-sweep suites. `vi.mock` factories must stay
 * in each test file (they are hoisted per module); only the state and the
 * builders those factories hand back live here.
 */

export const NOW = new Date("2026-08-03T12:00:00.000Z");
export const WATERMARK = new Date("2026-08-01T00:00:00.000Z");

export const INPUT = {
  organizationId: "org-1",
  repositoryFullName: "acme/widgets",
  watermark: WATERMARK,
  cursor: null,
  consecutiveFailureCount: 0,
};

export type SyncStateUpdate = {
  where: unknown;
  data: Record<string, unknown>;
};

export type ReconcileDbState = {
  syncStateUpdates: SyncStateUpdate[];
  selfHealRows: Array<{ number: number }>;
  selfHealWhere: Record<string, unknown> | null;
  debounceCalls: Record<string, unknown>[];
  /**
   * ISS-8919: PR numbers the identity read should find a projection row for.
   * `null` means "every requested number has one", which is what the reconcile
   * suites want by default. Set it to express the opposite — a number with NO
   * tracked row, which the lane must skip rather than create.
   */
  detailRowNumbers: number[] | null;
  /**
   * ISS-12034: rows the installed tier's delivery-coverage GAP arm should find —
   * session-linked PR rows the coverage numerator does not count. Empty by
   * default, which is the healthy repo every other suite here describes.
   */
  coverageGapRows: Array<{
    id: string;
    branchArtifactId: string;
    number: number;
  }>;
  /** Raw SQL the coverage-gap selector issued, for the arm's own assertions. */
  coverageGapQueries: string[];
  /**
   * ISS-12272: rows the installed tier's unverified arm should find — OPEN rows
   * no GitHub read has reached. Empty by default, like the gap arm above.
   */
  unverifiedRows: Array<{ number: number }>;
  /** The unverified selector's `findMany` arguments, for its own assertions. */
  unverifiedArgs: Record<string, unknown> | null;
};

export const dbState: ReconcileDbState = {
  syncStateUpdates: [],
  selfHealRows: [],
  selfHealWhere: null,
  debounceCalls: [],
  detailRowNumbers: null,
  coverageGapRows: [],
  coverageGapQueries: [],
  unverifiedRows: [],
  unverifiedArgs: null,
};

export function resetReconcileDbState(): void {
  dbState.syncStateUpdates = [];
  dbState.selfHealRows = [];
  dbState.selfHealWhere = null;
  dbState.debounceCalls = [];
  dbState.detailRowNumbers = null;
  dbState.coverageGapRows = [];
  dbState.coverageGapQueries = [];
  dbState.unverifiedRows = [];
  dbState.unverifiedArgs = null;
}

export function makeDb(state: ReconcileDbState = dbState) {
  return {
    pullRequestDetail: {
      findMany: vi.fn((args: { where: Record<string, unknown> }) => {
        // ISS-12272: the unverified selector is the only read whose predicate
        // names `githubUpdatedAt`, at whatever depth it nests the shared
        // predicate, so it is routed apart from the self-heal read.
        if (JSON.stringify(args.where).includes('"githubUpdatedAt"')) {
          state.unverifiedArgs = args;
          return Promise.resolve(state.unverifiedRows);
        }
        // ISS-8919: two different reads now land on findMany. The batched
        // identity read carries `number: { in: [...] }` and expects (id, number)
        // rows, each filed under its `readModelPr` head (ISS-12344) — it is
        // what replaced the per-PR findUnique — while the self-heal
        // selection is every other shape. Keying on the filter keeps the
        // self-heal assertions (`selfHealWhere`) measuring the read they name.
        const numberFilter = args.where.number as { in?: number[] } | undefined;
        if (numberFilter?.in) {
          const tracked = state.detailRowNumbers;
          return Promise.resolve(
            numberFilter.in
              .filter((number) => tracked === null || tracked.includes(number))
              .map((number) => ({
                id: `detail-${number}`,
                number,
                branchArtifact: { branch: { branchName: `feature-${number}` } },
              }))
          );
        }
        state.selfHealWhere = args.where;
        return Promise.resolve(state.selfHealRows);
      }),
      updateMany: vi.fn((args: { where: Record<string, unknown> }) => {
        state.debounceCalls.push(args.where);
        return Promise.resolve({ count: state.selfHealRows.length });
      }),
    },
    // ISS-12034: the coverage-gap arm is the lane's only raw-SQL read, so every
    // `$queryRaw` here is that selector. Recording the text lets a suite assert
    // the predicate it issued without a second double.
    $queryRaw: vi.fn((query: { sql?: string; strings?: string[] }) => {
      state.coverageGapQueries.push(
        query.sql ?? query.strings?.join("?") ?? ""
      );
      return Promise.resolve(state.coverageGapRows);
    }),
    gitHubRepoSyncState: {
      updateMany: vi.fn((args: SyncStateUpdate) => {
        state.syncStateUpdates.push(args);
        return Promise.resolve({ count: 1 });
      }),
    },
  };
}

export function makeClient(kind: GitHubCredentialKind) {
  return {
    octokit: {},
    kind,
    actingAs:
      kind === GitHubCredentialKind.Installation
        ? { installationId: "inst-1" }
        : { githubUserId: "gh-1", login: "octocat" },
    credentialOwnerId:
      kind === GitHubCredentialKind.Installation ? null : "user-uuid-1",
    rateLimitTier: null,
    recordRateLimit: vi.fn(() => Promise.resolve()),
    recordRepoAccess: vi.fn(() => Promise.resolve()),
  };
}

export function readModelPr(overrides: {
  number: number;
  updatedAt: string;
  state?: string;
}) {
  return {
    githubId: `pr-${overrides.number}`,
    number: overrides.number,
    title: `PR ${overrides.number}`,
    htmlUrl: `https://github.com/acme/widgets/pull/${overrides.number}`,
    headBranch: `feature-${overrides.number}`,
    baseBranch: "main",
    headSha: `sha-${overrides.number}`,
    state: overrides.state ?? "OPEN",
    isDraft: false,
    additions: 10,
    deletions: 2,
    changedFiles: 1,
    reviewDecision: null,
    checksStatus: null,
    statusCheckRollup: null,
    openedAt: "2026-07-01T00:00:00Z",
    closedAt: null,
    mergedAt: null,
    mergeCommitSha: null,
    updatedAt: overrides.updatedAt,
    author: "octocat",
    source: "provider",
  };
}
