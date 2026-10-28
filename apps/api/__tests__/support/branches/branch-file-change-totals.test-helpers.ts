import type { Mock } from "vitest";
import type { BranchFileChangeTotals } from "@/app/branches/branch-read-service/file-change-totals-read";

export type SeededFileChange = {
  additions: number | null;
  deletions: number | null;
};

/**
 * The per-file rows a fixture branch's cache holds, kept OFF the row.
 *
 * ISS-10298 moved the fold into SQL, so `applyBranchFileChangeTotals` is the
 * only thing in production that can put `fileChangeTotals` on a row. A fixture
 * that stamped the finished totals onto the mocked artifact row would answer for
 * it: deleting the production attach would leave every LOC assertion in the
 * suite green off the fixture's own value. Registering the files here by row
 * identity instead means the mocked `branchFileChange.groupBy` is the ONLY
 * source of totals, exactly as the database is in production.
 */
const seededFileChanges = new WeakMap<object, readonly SeededFileChange[]>();

/**
 * The value a fixture row carries BEFORE production attaches the real thing. A
 * local literal on purpose rather than the production constant: a fixture that
 * followed that constant wherever it went could not tell the two apart.
 */
export const EMPTY_BRANCH_FILE_CHANGE_TOTALS_FIXTURE: BranchFileChangeTotals = {
  additions: null,
  deletions: null,
  fileCount: 0,
  headSha: null,
};

/** Record what one fixture branch's file-change cache holds. */
export function seedRowFileChanges(
  row: object,
  changes: readonly SeededFileChange[]
): void {
  seededFileChanges.set(row, changes);
}

/**
 * Fold per-file fixture rows the way `getBranchFileChangeTotals` folds them in
 * SQL, for the tests that assert on totals directly rather than through a
 * mocked read.
 *
 * Test-support only: production reads the totals from the database and never
 * materializes the rows. This is the reference implementation the grouped
 * statement reproduces — `file-change-totals-read.integration.test.ts` is what
 * pins the two to the same answers against real Postgres.
 */
export function toBranchFileChangeTotals(
  changes: readonly SeededFileChange[],
  headSha: string | null = null
): BranchFileChangeTotals {
  // An empty cache is UNAVAILABLE LOC, not a measured zero — the same exit
  // `getBranchFileChangeTotals` takes by emitting no group for the branch.
  if (changes.length === 0) {
    return { additions: null, deletions: null, fileCount: 0, headSha: null };
  }
  return {
    additions: sumOrNullWhenPartial(changes.map((change) => change.additions)),
    deletions: sumOrNullWhenPartial(changes.map((change) => change.deletions)),
    fileCount: changes.length,
    headSha,
  };
}

function sumOrNullWhenPartial(
  values: readonly (number | null)[]
): number | null {
  let total = 0;
  for (const value of values) {
    if (value == null) {
      return null;
    }
    total += value;
  }
  return total;
}

/**
 * The file-change groups a real database would return for the branch rows this
 * mock is currently configured to serve, read back off the artifact mocks so a
 * fixture states its cache in ONE place — `makeBranchRow({ fileChanges })`.
 */
export async function seededFileChangeGroups(
  artifactMocks: { findMany: Mock; findFirst: Mock },
  args: unknown
) {
  const requested = new Set(requestedBranchIds(args));
  const rows = await seededBranchRows(artifactMocks);
  return [...rows.values()].flatMap((row) => {
    const changes = seededFileChanges.get(row) ?? [];
    return requested.has(row.id) && changes.length > 0
      ? [fileChangeGroupFor(row, changes)]
      : [];
  });
}

function requestedBranchIds(args: unknown): string[] {
  const ids = (
    args as { where?: { branchArtifactId?: { in?: unknown } } } | undefined
  )?.where?.branchArtifactId?.in;
  return Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : [];
}

type SeededBranchRow = {
  id: string;
  branch: { fileCacheHeadSha?: string | null };
};

async function seededBranchRows(artifactMocks: {
  findMany: Mock;
  findFirst: Mock;
}): Promise<Map<string, SeededBranchRow>> {
  const rows = new Map<string, SeededBranchRow>();
  for (const mock of [artifactMocks.findMany, artifactMocks.findFirst]) {
    for (const result of mock.mock.results) {
      if (result.type !== "return") {
        continue;
      }
      const resolved = await Promise.resolve(result.value).catch(() => null);
      for (const row of Array.isArray(resolved) ? resolved : [resolved]) {
        if (isSeededBranchRow(row)) {
          rows.set(row.id, row);
        }
      }
    }
  }
  return rows;
}

function isSeededBranchRow(row: unknown): row is SeededBranchRow {
  const candidate = row as SeededBranchRow | null;
  return Boolean(candidate?.id && candidate.branch);
}

/**
 * The `_sum`/`_count` shape Prisma's `groupBy` emits, as PostgreSQL emits it:
 * `SUM` SKIPS nulls, so a partial dimension comes back as the sum over only the
 * files that DID enrich, with a non-null `_count` SHORT of `_all`. Emitting a
 * null `_sum` instead would hand `getBranchFileChangeTotals` the answer its
 * completeness rule exists to derive, and deleting that rule would stay green.
 */
function fileChangeGroupFor(
  row: SeededBranchRow,
  changes: readonly SeededFileChange[]
) {
  const additions = changes.map((change) => change.additions);
  const deletions = changes.map((change) => change.deletions);
  return {
    branchArtifactId: row.id,
    headSha: row.branch.fileCacheHeadSha ?? null,
    _sum: {
      additions: postgresSum(additions),
      deletions: postgresSum(deletions),
    },
    _count: {
      _all: changes.length,
      additions: additions.filter((value) => value !== null).length,
      deletions: deletions.filter((value) => value !== null).length,
    },
  };
}

function postgresSum(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0
    ? null
    : present.reduce((total, value) => total + value, 0);
}
