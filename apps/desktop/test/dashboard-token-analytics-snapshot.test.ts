import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSqliteDashboardQueries } from "../src/main/database/dashboard-queries.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";

/**
 * `getTokenAnalytics` must read its three facets from ONE committed snapshot
 * (wongk, PR #4835).
 *
 * The headline totals, the byModel breakdown, and the byDay series are rendered
 * side by side from a single response and are expected to reconcile — byDay sums
 * to the totals, byModel sums to the totals. Dispatched as three separate
 * `prisma.read` calls they land on INDEPENDENT round-robin reader connections,
 * each taking its own WAL snapshot, so a `token_events` commit landing between
 * them (the live hook writer is always running) is counted by some facets and
 * not others, and the card stops adding up. `DesktopPrismaReadClient` documents
 * this exact case as the reason its read-scoped `$transaction` exists.
 *
 * This asserts the DISPATCH SHAPE rather than the values, because the values are
 * identical either way on a quiescent store — which is precisely why the torn
 * read would never show up in the byte-for-byte golden suite.
 */
test("FEA-2345/PR#4835: getTokenAnalytics reads all three facets in ONE read-scoped transaction", async () => {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), "token-analytics-snapshot-")
  );
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const REF = "2026-06-22T00:00:00.000Z";
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => REF,
  });
  try {
    await db.run(
      `INSERT INTO sessions (id, name, status, started_at, updated_at, harness)
       VALUES ($1, $2, $3, $4, $4, $5)`,
      "s1",
      "Session one",
      "inactive",
      "2026-06-20T10:00:00.000Z",
      "claude"
    );
    await db.run(
      `INSERT INTO token_events (session_id, model, created_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd_estimated)
       VALUES ($1, $2, $3, 1000, 500, 200, 50, 1.25)`,
      "s1",
      "claude-sonnet-4-5",
      "2026-06-20T10:00:00.000Z"
    );
    await db.run(
      `INSERT INTO token_events (session_id, model, created_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd_estimated)
       VALUES ($1, $2, $3, 2000, 1000, 300, 100, 2.50)`,
      "s1",
      "claude-sonnet-4-5",
      "2026-06-21T14:00:00.000Z"
    );

    // One entry per `prisma.read` dispatch; each records how many
    // `$queryRawUnsafe` statements ran on that connection, and whether they ran
    // inside a read-scoped `$transaction`.
    const dispatches: { statements: number; transactional: boolean }[] = [];
    const spyReader = (
      reader: Parameters<Parameters<DesktopPrisma["read"]>[0]>[0]
    ) => {
      const record = { statements: 0, transactional: false };
      dispatches.push(record);
      const wrapRaw = (target: object, value: unknown) =>
        typeof value === "function"
          ? (sql: string, ...args: unknown[]) => {
              if (sql.includes("token_events")) {
                record.statements += 1;
              }
              return (value as (...a: unknown[]) => unknown).call(
                target,
                sql,
                ...args
              );
            }
          : value;
      const proxyFor = (target: object): object =>
        new Proxy(target, {
          get(inner, prop) {
            const value = Reflect.get(inner, prop);
            if (prop === "$queryRawUnsafe") {
              return wrapRaw(inner, value);
            }
            if (prop === "$transaction" && typeof value === "function") {
              return (fn: (tx: unknown) => unknown) => {
                record.transactional = true;
                return (value as (f: (tx: unknown) => unknown) => unknown).call(
                  inner,
                  (tx) => fn(proxyFor(tx as object))
                );
              };
            }
            return value;
          },
        });
      return proxyFor(reader) as typeof reader;
    };
    const prisma: DesktopPrisma = {
      ...db.prisma,
      read: (fn) => db.prisma.read((reader) => fn(spyReader(reader))),
    };
    const dashboard = createSqliteDashboardQueries(prisma);

    const analytics = await dashboard.getTokenAnalytics(new Date(REF));

    // The facets still reconcile — the read is correct, not just co-located.
    assert.equal(analytics.totalInputTokens, 3000);
    assert.equal(
      analytics.byDay.reduce((sum, day) => sum + day.inputTokens, 0),
      analytics.totalInputTokens
    );
    assert.equal(
      analytics.byModel.reduce((sum, row) => sum + row.inputTokens, 0),
      analytics.totalInputTokens
    );

    // ONE dispatch, carrying all three token_events statements, inside a
    // transaction. Three dispatches of one statement each is the torn read.
    const reads = dispatches.filter((entry) => entry.statements > 0);
    assert.equal(
      reads.length,
      1,
      `all three facets must share one reader connection; saw ${reads.length} dispatches`
    );
    assert.equal(reads[0]?.statements, 3);
    assert.equal(
      reads[0]?.transactional,
      true,
      "the three facet reads must be pinned by a read-scoped $transaction"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
