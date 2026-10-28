import { writeFile } from "node:fs/promises";
import { LinkDirection } from "@repo/api/src/types/artifact";
import { withDb } from "@repo/database";
import { Pool } from "pg";
import { afterAll, beforeAll, test } from "vitest";
import { seedPagedTree } from "@/__tests__/support/artifact-links/tree-pages.test-fixtures";
import { windowForCursor } from "./resolved-page";
import { artifactLinksService } from "./service";

const databaseUrl = process.env.DATABASE_URL;
if (
  !(
    databaseUrl &&
    ["localhost", "127.0.0.1"].includes(new URL(databaseUrl).hostname)
  )
) {
  throw new Error(
    "This benchmark requires an explicitly configured disposable local database"
  );
}
const stats = new Pool({ connectionString: databaseUrl });
let graph: Awaited<ReturnType<typeof seedPagedTree>>;

beforeAll(async () => {
  graph = await seedPagedTree(Number(process.env.TREE_BENCH_WIDTH ?? 7500), 5);
}, 120_000);

afterAll(async () => {
  if (graph) {
    await withDb((db) =>
      db.artifactLink.deleteMany({
        where: { organizationId: graph.organizationId },
      })
    );
    await withDb((db) =>
      db.artifact.deleteMany({
        where: { organizationId: graph.organizationId },
      })
    );
    await withDb((db) =>
      db.organization.delete({ where: { id: graph.organizationId } })
    );
  }
  await stats.end();
}, 120_000);

// Vitest 5 runs bench files under a 60s-minimum testTimeout; `bench()` in
// Vitest 4 had none, and a 7500-wide tree can take longer.
test("two concurrent complete tree readers", { timeout: 0 }, async ({
  bench,
}) => {
  await bench("two concurrent complete tree readers", async () => {
    await stats.query("SELECT pg_stat_statements_reset()");
    const started = performance.now();
    const readers = await Promise.all([readAll(), readAll()]);
    const elapsedMs = performance.now() - started;
    const { rows } = await stats.query<{
      query: string;
      calls: string;
      total_exec_time: number;
      rows: string;
    }>(
      "SELECT query, calls, total_exec_time, rows FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database()) AND query NOT LIKE '%pg_stat_statements%'"
    );
    const traversal = rows.filter(
      (row) =>
        row.query.includes('"artifact_links"') &&
        (row.query.includes('"source_id" IN (') ||
          row.query.includes('"target_id" IN ('))
    );
    const report = {
      links: graph.expected.length,
      readers,
      elapsedMs,
      sqlCount: rows.reduce((sum, row) => sum + Number(row.calls), 0),
      databaseMs: rows.reduce((sum, row) => sum + row.total_exec_time, 0),
      traversalSqlCount: traversal.reduce(
        (sum, row) => sum + Number(row.calls),
        0
      ),
      traversalDatabaseMs: traversal.reduce(
        (sum, row) => sum + row.total_exec_time,
        0
      ),
      traversalRows: traversal.reduce((sum, row) => sum + Number(row.rows), 0),
      statements: rows,
    };
    if (process.env.TREE_BENCH_REPORT) {
      await writeFile(
        process.env.TREE_BENCH_REPORT,
        JSON.stringify(report, null, 2)
      );
    }
    console.info(JSON.stringify({ ...report, statements: undefined }));
  }).run({ iterations: 1, time: 0, warmupTime: 0, warmupIterations: 0 });
});

async function readAll() {
  let cursor: number | undefined;
  let snapshotId: string | undefined;
  const pageMs: number[] = [];
  const ids: string[] = [];
  do {
    const started = performance.now();
    const page = await artifactLinksService.findResolvedLinkTreePage(
      graph.organizationId,
      graph.root,
      LinkDirection.Both,
      5,
      windowForCursor(cursor, snapshotId)
    );
    JSON.stringify(page);
    pageMs.push(performance.now() - started);
    ids.push(...page.items.map((link) => link.id));
    cursor =
      page.nextCursor === undefined ? undefined : Number(page.nextCursor);
    snapshotId = page.snapshotId;
  } while (cursor !== undefined);
  if (JSON.stringify(ids) !== JSON.stringify(graph.expected)) {
    throw new Error("Concatenated pages differ from the seeded ordered graph");
  }
  return {
    pages: pageMs.length,
    links: ids.length,
    cumulativePageMs: pageMs.reduce((sum, value) => sum + value, 0),
    pageMs,
  };
}
