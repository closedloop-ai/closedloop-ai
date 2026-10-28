/**
 * Shared fake-Prisma helpers for the repo sync-tier suites.
 *
 * `github-repo-sync-state.test.ts` covers what the reconciler DECIDES (tier
 * classification, the verdict reads, the bootstrap selector);
 * `github-repo-sync-tier-write.test.ts` covers how it WRITES (the set-based
 * statement, its chunking, and its failure isolation). Both drive the same fake
 * client and read binds out of the same fragment tree, so the modelling lives
 * here rather than being re-derived in each file and drifting.
 *
 * Not a test file: the vitest include pattern only collects `*.test.ts`.
 */

import { vi } from "vitest";

/**
 * Structural stand-ins for `Prisma.sql` / `Prisma.join`, shaped so the fragment
 * tree survives: `sql` keeps its template's static `strings` alongside its
 * un-flattened `values`, and `join` records its `separator`. Flattening either
 * would make a nested VALUES fragment indistinguishable from a scalar bind, and
 * the assertions read the per-row binds straight out of that tree.
 */
export function mockPrismaSql(
  strings: TemplateStringsArray | readonly string[],
  ...values: unknown[]
): MockSqlNode {
  return { strings: [...strings], values };
}

export function mockPrismaJoin(
  fragments: readonly unknown[],
  separator = ","
): MockSqlNode {
  return { values: [...fragments], separator };
}

export type MockSqlNode = {
  strings?: string[];
  values: unknown[];
  separator?: string;
};

export type MockDb = {
  gitHubInstallation: { findUnique: ReturnType<typeof vi.fn> };
  gitHubUserConnection: { findMany: ReturnType<typeof vi.fn> };
  gitHubAccessCapability: { findMany: ReturnType<typeof vi.fn> };
  gitHubInstallationRepository: { findMany: ReturnType<typeof vi.fn> };
  gitHubObservedRepository: { findMany: ReturnType<typeof vi.fn> };
  pullRequestDetail: {
    findMany: ReturnType<typeof vi.fn>;
    groupBy: ReturnType<typeof vi.fn>;
  };
  gitHubRepoSyncState: { upsert: ReturnType<typeof vi.fn> };
  organization: {
    findMany: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
  $executeRaw: ReturnType<typeof vi.fn>;
};

export function makeDb(): MockDb {
  return {
    gitHubInstallation: { findUnique: vi.fn().mockResolvedValue(null) },
    gitHubUserConnection: { findMany: vi.fn().mockResolvedValue([]) },
    gitHubAccessCapability: { findMany: vi.fn().mockResolvedValue([]) },
    gitHubInstallationRepository: { findMany: vi.fn().mockResolvedValue([]) },
    // Verified observed rows are a repo-sync target source; default empty keeps
    // unrelated cases from implicitly opting into that lane.
    gitHubObservedRepository: { findMany: vi.fn().mockResolvedValue([]) },
    pullRequestDetail: {
      findMany: vi.fn().mockResolvedValue([]),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    gitHubRepoSyncState: { upsert: vi.fn().mockResolvedValue({}) },
    organization: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    $executeRaw: vi.fn().mockResolvedValue(0),
  };
}

/**
 * Binds one VALUES row of the tier upsert carries, in order: id,
 * organization_id, repository_full_name, tier, last_tier_evaluated_at,
 * updated_at. Pinned here because the production chunk size is DERIVED from
 * this width — if a column is added without moving the derivation, the
 * assertions go red rather than the statement silently drifting toward
 * Postgres's 65,535-bind ceiling.
 */
export const BINDS_PER_UPSERT_ROW = 6;
export const REPO_FULL_NAME_BIND_OFFSET = 2;
export const TIER_BIND_OFFSET = 3;
export const LAST_TIER_EVALUATED_AT_BIND_OFFSET = 4;
export const UPDATED_AT_BIND_OFFSET = 5;

/** Every bind of one `$executeRaw` statement, flattened depth-first. */
export function bindsOf(statement: unknown): unknown[] {
  if (!isMockSqlNode(statement)) {
    return [statement];
  }
  return statement.values.flatMap((value) => bindsOf(value));
}

/** The statement's literal SQL — the parts no bind is interpolated into. */
export function staticSqlOf(statement: unknown): string {
  return isMockSqlNode(statement) ? (statement.strings ?? []).join(" ") : "";
}

function isMockSqlNode(value: unknown): value is MockSqlNode {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { values?: unknown }).values)
  );
}

/** Tier written per repo, read back out of the bulk upsert's binds. */
export function tiersByRepoFrom(db: MockDb): Map<unknown, unknown> {
  const tiers = new Map<unknown, unknown>();
  for (const call of db.$executeRaw.mock.calls) {
    const binds = bindsOf(call[0]);
    for (let row = 0; row < binds.length; row += BINDS_PER_UPSERT_ROW) {
      tiers.set(
        binds[row + REPO_FULL_NAME_BIND_OFFSET],
        binds[row + TIER_BIND_OFFSET]
      );
    }
  }
  return tiers;
}

/**
 * Fail exactly the chunk that carries `repositoryFullName` and let the other
 * chunks land. Chunk granularity is the honest unit for the STATEMENT: it is
 * all-or-nothing, so no repo inside a rejected one landed.
 */
export function failChunkCarrying(
  db: MockDb,
  repositoryFullName: string
): void {
  db.$executeRaw.mockImplementation((statement: unknown) =>
    bindsOf(statement).includes(repositoryFullName)
      ? Promise.reject(new Error("pool acquire timeout"))
      : Promise.resolve(0)
  );
}

/**
 * Reject the bulk statement outright, so every chunk takes the per-repo
 * fallback, and fail exactly one repo inside it.
 */
export function failOneRepoThroughFallback(
  db: MockDb,
  repositoryFullName: string
): void {
  db.$executeRaw.mockRejectedValue(new Error("statement timeout"));
  db.gitHubRepoSyncState.upsert.mockImplementation(
    (args: {
      where: {
        organizationId_repositoryFullName: { repositoryFullName: string };
      };
    }) =>
      args.where.organizationId_repositoryFullName.repositoryFullName ===
      repositoryFullName
        ? Promise.reject(new Error("pool acquire timeout"))
        : Promise.resolve({})
  );
}

/** Reject both the bulk statement and its per-repo fallback. */
export function failEveryWrite(db: MockDb, message: string): void {
  db.$executeRaw.mockRejectedValue(new Error(message));
  db.gitHubRepoSyncState.upsert.mockRejectedValue(new Error(message));
}

/** `count` repo full names, enough of them to span more than one chunk. */
export function repoRows(count: number): { repositoryFullName: string }[] {
  return Array.from({ length: count }, (_unused, index) => ({
    repositoryFullName: `acme/repo-${index}`,
  }));
}
