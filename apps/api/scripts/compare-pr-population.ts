/**
 * ISS-8153 (PRD-683 D3): read-only, per-org comparison of the LEGACY pull
 * request populations against the sanctioned ones, run before the release
 * note ships so the announced number shifts are grounded in real deltas.
 *
 *   cd apps/api
 *   DATABASE_URL=<url> pnpm tsx scripts/compare-pr-population.ts
 *   DATABASE_URL=<url> pnpm tsx scripts/compare-pr-population.ts --org <uuid>
 *
 * Columns, per organization:
 *   mergedOld  — every stored MERGED PR row (the pre-ISS-8153 Insights basis)
 *   mergedNew  — the org-merged population (session-linked AND verified
 *                only, no provenance bypass, exact PR identity admission —
 *                the D1 ruling; `orgMergedPullRequestMembershipSql`)
 *   withPrOld  — non-deleted branches whose current-PR POINTER is set
 *   withPrNew  — non-deleted branches owning any PR row (canonical numerator)
 *   landedOld  — branches whose POINTER is a merged PR (pre-ISS-8153 profile)
 *   landedNew  — branches with an admitted session-linked verified merged PR
 *                (`orgMergedPullRequestMembershipSql` — Kerensa's one-rule ruling)
 *
 * Purely reads; issues no writes. The predicates are imported from the
 * population SSOT modules, never restated here.
 */
import { fileURLToPath } from "node:url";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import { Prisma, withDb } from "@repo/database";
import { branchHasAnyPullRequestWhere } from "../app/branches/branch-canonical-pull-request";
import { orgMergedPullRequestMembershipSql } from "../lib/pull-request-population";

type OrgComparison = {
  organizationId: string;
  mergedOld: number;
  mergedNew: number;
  withPrOld: number;
  withPrNew: number;
  landedOld: number;
  landedNew: number;
};

export async function comparePullRequestPopulations(
  orgId: string | null
): Promise<OrgComparison[]> {
  const orgRows = await withDb((db) =>
    db.pullRequestDetail.groupBy({
      by: ["organizationId"],
      where: orgId ? { organizationId: orgId } : {},
      _count: { _all: true },
    })
  );
  const results: OrgComparison[] = [];
  for (const row of orgRows) {
    const organizationId = row.organizationId;
    const branchScope = {
      deletedAt: null,
      artifact: { is: { organizationId } },
    } as const;
    // Sequential per org (six parallel counts inside) keeps pool pressure bounded.
    const [mergedOld, mergedNew, withPrOld, withPrNew, landedOld, landedNew] =
      await withDb((db) =>
        Promise.all([
          db.pullRequestDetail.count({
            where: {
              organizationId,
              prState: GitHubPRState.Merged,
            },
          }),
          countAdmittedMergedPrRows(db, organizationId),
          db.branchDetail.count({
            where: {
              ...branchScope,
              currentPullRequestDetailId: { not: null },
            },
          }),
          db.branchDetail.count({
            where: {
              ...branchScope,
              AND: [branchHasAnyPullRequestWhere()],
            },
          }),
          db.branchDetail.count({
            where: {
              ...branchScope,
              currentPullRequestDetail: {
                is: { prState: GitHubPRState.Merged, mergedAt: { not: null } },
              },
            },
          }),
          countAdmittedLandedBranches(db, organizationId),
        ])
      );
    results.push({
      organizationId,
      mergedOld,
      mergedNew,
      withPrOld,
      withPrNew,
      landedOld,
      landedNew,
    });
  }
  return results;
}

async function countAdmittedMergedPrRows(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  organizationId: string
): Promise<number> {
  const rows = await db.$queryRaw<{ n: number }[]>(
    Prisma.sql`
      SELECT COUNT(*)::int AS n
      FROM pull_request_detail p
      JOIN artifacts a ON a.id = p.branch_artifact_id
      WHERE a.organization_id = ${organizationId}::uuid
        AND p.pr_state = ${GitHubPRState.Merged}::"GitHubPRState"
        AND p.merged_at IS NOT NULL
        AND ${orgMergedPullRequestMembershipSql(organizationId)}`
  );
  return rows[0]?.n ?? 0;
}

async function countAdmittedLandedBranches(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  organizationId: string
): Promise<number> {
  const rows = await db.$queryRaw<{ n: number }[]>(
    Prisma.sql`
      SELECT COUNT(DISTINCT p.branch_artifact_id)::int AS n
      FROM pull_request_detail p
      JOIN artifacts a ON a.id = p.branch_artifact_id
      JOIN branch_detail b ON b.artifact_id = a.id
      WHERE a.organization_id = ${organizationId}::uuid
        AND b.deleted_at IS NULL
        AND p.pr_state = ${GitHubPRState.Merged}::"GitHubPRState"
        AND p.merged_at IS NOT NULL
        AND ${orgMergedPullRequestMembershipSql(organizationId)}`
  );
  return rows[0]?.n ?? 0;
}

function formatRow(row: OrgComparison): string {
  const delta = (before: number, after: number) =>
    `${before} -> ${after}${after === before ? "" : ` (${after > before ? "+" : ""}${after - before})`}`;
  return [
    row.organizationId,
    `merged ${delta(row.mergedOld, row.mergedNew)}`,
    `withPr ${delta(row.withPrOld, row.withPrNew)}`,
    `landed ${delta(row.landedOld, row.landedNew)}`,
  ].join("  ");
}

async function main(): Promise<void> {
  const orgFlagIndex = process.argv.indexOf("--org");
  const orgId =
    orgFlagIndex === -1 ? null : (process.argv[orgFlagIndex + 1] ?? null);
  if (orgFlagIndex !== -1 && !orgId) {
    throw new Error("--org requires a value");
  }
  const rows = await comparePullRequestPopulations(orgId);
  if (rows.length === 0) {
    process.stdout.write("no organizations with PullRequestDetail rows\n");
    return;
  }
  for (const row of rows) {
    process.stdout.write(`${formatRow(row)}\n`);
  }
  process.stdout.write(`${JSON.stringify(rows)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack : String(error)}\n`
    );
    process.exitCode = 1;
  });
}
