/**
 * @file agent-db-test-utils.ts
 * @description Shared opener for the SQLite agent database used by collector /
 * importer tests. Centralizes the `openSqliteAgentDatabase` boilerplate
 * (`<dir>/agent-dashboard.pgdata` data dir, metered-API billing, a fixed `now`)
 * that was hand-rolled across fea1459 (21 call sites) and fea1785 (`openTestDb`).
 * Pass `extraOpts` to override any field (e.g. a different `now` or billing mode).
 */
import path from "node:path";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";

type OpenOpts = Parameters<typeof openSqliteAgentDatabase>[0];

/**
 * Open a SQLite agent database rooted at `<dir>/agent-dashboard.pgdata` with the
 * standard test defaults. Returns the same handle as `openSqliteAgentDatabase`;
 * callers own `db.close()`.
 */
export function openTestDb(dir: string, extraOpts?: Partial<OpenOpts>) {
  return openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-07T12:00:00.000Z",
    ...extraOpts,
  });
}
