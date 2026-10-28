import { vi } from "vitest";

type BranchIdentityPair = { repositoryFullName: string; branchName: string };

type BranchDetailFindManyDouble = (args: {
  where: { organizationId: string; OR: BranchIdentityPair[] };
}) => Promise<Array<BranchIdentityPair & { artifactId: string }>>;

/** Only `readExistingBranchRows` projects this column. */
const EXISTING_BRANCH_ROWS_MARKER = 'AS "assigned"';

/**
 * A `$queryRaw` double that answers `readExistingBranchRows` (ISS-12463), the
 * raw lookup that replaced the branch lane's `branchDetail.findMany`, from the
 * suite's existing `branchDetail.findMany` double, and hands every other raw
 * query to `otherQueries` so that spy still sees only what it saw before. Rows
 * read as unassigned.
 */
export function routeExistingBranchRows(
  branchDetailFindMany: BranchDetailFindManyDouble,
  otherQueries: (...args: unknown[]) => unknown
): ReturnType<typeof vi.fn> {
  return vi.fn((query: unknown, ...rest: unknown[]) => {
    const statement = query as { sql?: unknown; values?: unknown[] };
    if (
      typeof statement?.sql !== "string" ||
      !statement.sql.includes(EXISTING_BRANCH_ROWS_MARKER)
    ) {
      return otherQueries(query, ...rest);
    }
    const [organizationId, repositoryFullNames, branchNames] =
      statement.values as [string, string[], string[]];
    return branchDetailFindMany({
      where: {
        organizationId,
        OR: repositoryFullNames.map((repositoryFullName, index) => ({
          repositoryFullName,
          branchName: branchNames[index],
        })),
      },
    }).then((rows) => rows.map((row) => ({ ...row, assigned: false })));
  });
}
