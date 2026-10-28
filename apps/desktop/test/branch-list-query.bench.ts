/**
 * PRD-721: latency and result size of the DESKTOP Branches list read, for the
 * same query sent as legacy params and as a canonical `listQuery`, at several
 * store sizes. The Branches sibling of `session-list-query.bench.ts`.
 *
 * A measurement, not a gate: nothing here asserts a duration. Each query runs
 * the path one Branches IPC read takes once the store is read: the request
 * coercion (`coerceSharedBranchesQuery`, which compiles `listQuery`), the
 * server-page query mapping, and the shared kernel
 * (`buildBranchServerPageSnapshot`) over synthetic projected rows. Both
 * spellings are measured so the compiler's share of the read is visible, and
 * each prints its latency statistics, the `total` and page size it returned,
 * and the bytes of the page as a JSON line.
 *
 * Run: pnpm -C apps/desktop exec vitest bench --run --config vitest.node.config.ts test/branch-list-query.bench.ts
 */
import { BranchStatus } from "@repo/api/src/types/branch";
import {
  BranchListPullRequestPresence,
  BranchListSortDirection,
  BranchListSortKey,
} from "@repo/api/src/types/branch-list-contract";
import { buildBranchListQueryIpcRequest } from "@repo/api/src/types/list-query-client-requests";
import { buildBranchServerPageSnapshot } from "@repo/lib/branches/branch-list-page.js";
import {
  branchRow,
  branchServerPageQuery,
} from "@repo/lib/branches/branch-list-page.test-fixtures.js";
import { test } from "vitest";
import { toDesktopBranchServerPageQuery } from "../src/main/branch/branch-server-page-query.js";
import { coerceSharedBranchesQuery } from "../src/main/dashboard/agent-dashboard-ipc-coercion.js";

const NOW = "2026-10-22T12:00:00.000Z";
const STORE_BRANCHES = { small: 500, medium: 5000, large: 20_000 } as const;
const REPOSITORIES = ["acme/web", "acme/api", "acme/desktop", "acme/infra"];
const STATUSES = Object.values(BranchStatus);

/** The queries measured, each in its legacy server-page spelling. */
const QUERIES = {
  unfiltered: branchServerPageQuery(),
  repoAndStatus: branchServerPageQuery({
    repositories: ["acme/web", "acme/api"],
    statuses: [BranchStatus.Open, BranchStatus.Review],
    sortKey: BranchListSortKey.Changes,
    sortDir: BranchListSortDirection.Asc,
  }),
  linkedPullRequestWindow: branchServerPageQuery({
    pullRequests: [BranchListPullRequestPresence.Linked],
    startDate: "2026-10-01T00:00:00.000Z",
    locMin: 10,
  }),
} as const;

test.for(Object.entries(STORE_BRANCHES))(
  "desktop Branches list read at the %s store size",
  { timeout: 0 },
  async ([size, branches], { bench }) => {
    const rows = syntheticRows(branches);
    for (const [name, legacy] of Object.entries(QUERIES)) {
      const canonical = buildBranchListQueryIpcRequest(legacy) ?? legacy;
      for (const [spelling, request] of [
        ["legacy", legacy],
        ["listQuery", canonical],
      ] as const) {
        const read = () =>
          buildBranchServerPageSnapshot(
            rows,
            toDesktopBranchServerPageQuery(coerceSharedBranchesQuery(request)),
            NOW
          );
        const { page } = read();
        const result = await bench(`${size} ${name} ${spelling}`, read).run({
          retainSamples: true,
        });
        record({
          storeSize: size,
          rows: rows.length,
          query: name,
          spelling,
          samples: result.latency.samplesCount,
          meanMs: result.latency.mean,
          p50Ms: result.latency.p50,
          p75Ms: result.latency.p75,
          p99Ms: result.latency.p99,
          total: page.total,
          pageItems: page.items.length,
          responseBytes: Buffer.byteLength(JSON.stringify(page)),
        });
      }
    }
  }
);

/** `count` projected rows spread across repositories, statuses and ages. */
function syntheticRows(count: number) {
  return Array.from({ length: count }, (_, index) =>
    branchRow({
      id: `branch-${index}`,
      branchName: `feature/branch-${index}`,
      repoFullName: REPOSITORIES[index % REPOSITORIES.length] ?? null,
      status: STATUSES[index % STATUSES.length],
      prNumber: index % 3 === 0 ? index : null,
      additions: index % 400,
      deletions: index % 50,
      lastActivityAt: new Date(
        Date.parse(NOW) - (index % 60) * 86_400_000
      ).toISOString(),
    })
  );
}

/**
 * One query's measurement, printed as a JSON line as soon as it is taken, so
 * a run stopped part-way still has every query it finished in its output.
 */
function record(entry: Record<string, unknown>): void {
  console.info(JSON.stringify(entry));
}
