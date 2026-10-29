/**
 * ISS-9483 (PRD-721 R10-S08) — latency and result size of the CLOUD Sessions
 * list read, per parity-corpus query.
 *
 * A measurement, not a gate: nothing here asserts a duration. Each conform
 * query of the parity corpus's conform scenario is sent the way
 * `GET /agent-sessions` receives it (`listQuery` in the query string, parsed
 * by the route's `parseQueryParams`) and read with `findSessions`, against
 * the conform rows replicated to each of `DESKTOP_STORE_SESSIONS`' sizes. The
 * cloud has no measured per-organization size of its own here; the desktop
 * store sizes are reused so both hosts are measured over the same
 * populations. Each query's latency statistics, the `total` and page size it
 * returned, and the bytes of the response are printed as JSON lines.
 *
 * Run against a disposable local database:
 *   pnpm -C apps/api exec vitest bench --run --config vitest.config.integration.mts app/agent-sessions/service/session-list-query.bench.ts
 */
import {
  LIST_QUERY_EXPRESSION_PARAM,
  serializeListQueryExpression,
} from "@repo/api/src/types/list-query-expression";
import {
  baselineP95Of,
  p95Of,
  SessionListBenchHost,
} from "@repo/lib/sessions/__tests__/session-list-bench-baseline";
import {
  DESKTOP_STORE_SESSIONS,
  replicateParityRows,
} from "@repo/lib/sessions/__tests__/session-list-parity-bench-scale";
import { SESSION_LIST_PARITY_CONFORM_SCENARIO } from "@repo/lib/sessions/__tests__/session-list-parity-conform";
import {
  bindParityOwners,
  parityCasesOf,
  SessionListParityCaseKind,
} from "@repo/lib/sessions/__tests__/session-list-parity-model";
import { afterAll, test } from "vitest";
import {
  readParityResponse,
  seedParityHost,
} from "@/__tests__/support/agent-sessions/session-list-parity.test-helpers";
import { createCommittedTestOrganizationTracker } from "@/__tests__/utils/db-helpers";

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

const scenario = SESSION_LIST_PARITY_CONFORM_SCENARIO;
const cases = parityCasesOf(scenario, SessionListParityCaseKind.Conform);
const organizations = createCommittedTestOrganizationTracker();

afterAll(async () => {
  await organizations.cleanup();
});

test.for(Object.entries(DESKTOP_STORE_SESSIONS))(
  "cloud Sessions list read at the desktop %s store size",
  { timeout: 0 },
  async ([percentile, sessions], { bench }) => {
    const rows = replicateParityRows(scenario.rows, sessions);
    const host = await seedParityHost(organizations, rows);
    for (const parityCase of cases) {
      const params = {
        [LIST_QUERY_EXPRESSION_PARAM]: serializeListQueryExpression(
          bindParityOwners(parityCase.expression, host.ownerIds)
        ),
        ...parityCase.page,
      };
      const response = await readParityResponse(host.organizationId, params);
      const result = await bench(`${percentile} ${parityCase.name}`, () =>
        readParityResponse(host.organizationId, params)
      ).run({ retainSamples: true });
      const p95Ms = p95Of(result.latency.samples ?? []);
      record({
        host: SessionListBenchHost.Cloud,
        storePercentile: percentile,
        rows: rows.length,
        query: parityCase.name,
        samples: result.latency.samplesCount,
        meanMs: result.latency.mean,
        p50Ms: result.latency.p50,
        p75Ms: result.latency.p75,
        p95Ms,
        baselineP95Ms: baselineP95Of(
          SessionListBenchHost.Cloud,
          percentile,
          parityCase.name
        ),
        p99Ms: result.latency.p99,
        total: response.total,
        pageItems: response.items.length,
        responseBytes: Buffer.byteLength(JSON.stringify(response)),
      });
    }
  }
);

/**
 * One query's measurement, printed as a JSON line as soon as it is taken, so
 * a run stopped part-way still has every query it finished in its output.
 */
function record(entry: Record<string, unknown>): void {
  console.info(JSON.stringify(entry));
}
