/**
 * @file session-sweep-fixtures.ts
 * @description Shared seed/read helpers for the session-sweep suites. Extracted
 * (ISS-5182) when `maintenance-write-txs.test.ts` reached the 1,000-line
 * ceiling: per `test/AGENTS.md` new scenarios go in a focused sibling suite and
 * shared setup moves to a fixture module, rather than growing one file or
 * re-declaring the same seeds twice.
 */
import type { Prisma } from "../src/main/database/generated/client.js";
import type { OpenTestPrisma } from "./prisma-test-utils.js";

export const NOW = "2026-06-22T12:00:00.000Z";
// cutoff = NOW - 180min = 2026-06-22T09:00:00.000Z
export const STALE_UPDATED_AT = "2026-06-22T08:00:00.000Z"; // before cutoff → stale
export const FRESH_UPDATED_AT = "2026-06-22T11:30:00.000Z"; // after cutoff → fresh

export type Store = OpenTestPrisma["db"];

export async function seedSession(
  store: Store,
  id: string,
  status: string,
  updatedAt: string,
  // FEA-3580: last_activity_at (the true last-activity anchor the sweep now
  // stamps into ended_at) defaults to updated_at so existing callers that don't
  // care keep behaving as before; started_at defaults to null.
  lastActivityAt: string = updatedAt,
  startedAt: string | null = null,
  // ISS-4586: the durable ends_with_error flag the reaper reads to declare a
  // swept session `error` (1) vs `inactive` (0/NULL). Defaults to NULL so
  // existing callers keep the not-error → inactive behavior.
  endsWithError: number | null = null
): Promise<void> {
  await store.query(
    "INSERT INTO sessions (id, status, updated_at, last_activity_at, started_at, data_revision, ends_with_error) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [id, status, updatedAt, lastActivityAt, startedAt, 1, endsWithError]
  );
}

export async function seedAgent(
  store: Store,
  id: string,
  sessionId: string,
  status: string,
  // FEA-3266: started_at is the floor the sweep stamps into ended_at when an
  // agent has no events; defaults to null so existing callers are unchanged.
  startedAt: string | null = null,
  // ISS-4586: the agent `type` — `main` agents of an error-ending swept session
  // are set to `error`; subagents stay `completed`. Defaults to null (subagent).
  type: string | null = null
): Promise<void> {
  await store.query(
    "INSERT INTO agents (id, session_id, status, started_at, type) VALUES ($1, $2, $3, $4, $5)",
    [id, sessionId, status, startedAt, type]
  );
}

// FEA-3266: seed an agent-attributed event so the sweep can derive the agent's
// true last activity from MAX(events.created_at) exactly as sessions do.
export async function seedAgentEvent(
  store: Store,
  id: string,
  sessionId: string,
  agentId: string,
  createdAt: string
): Promise<void> {
  await store.query(
    "INSERT INTO events (id, session_id, agent_id, event_type, created_at) VALUES ($1, $2, $3, $4, $5)",
    [id, sessionId, agentId, "ToolUse", createdAt]
  );
}

export async function getSession(store: Store, id: string) {
  const result = await store.query<{
    status: string;
    ended_at: string | null;
    updated_at: string | null;
    started_at: string | null;
    last_activity_at: string | null;
  }>(
    "SELECT status, ended_at, updated_at, started_at, last_activity_at FROM sessions WHERE id = $1",
    [id]
  );
  return result.rows[0];
}

export async function getAgent(store: Store, id: string) {
  const result = await store.query<{
    status: string;
    ended_at: string | null;
    updated_at: string | null;
  }>("SELECT status, ended_at, updated_at FROM agents WHERE id = $1", [id]);
  return result.rows[0];
}

/**
 * ISS-5182: rows per bulk INSERT. The over-`SWEEP_ID_CHUNK` suite seeds ~900
 * sessions plus their main agents, so seeding them one statement at a time is
 * ~1,800 round-trips through the write queue. 100 rows × 7 columns is 700 bound
 * parameters — inside the same conservative `EVENT_INSERT_PARAM_CAP` budget the
 * production import path chunks against.
 */
const SEED_ROWS_PER_INSERT = 100;

export type SeedSessionRow = {
  id: string;
  status: string;
  updatedAt: string;
  lastActivityAt: string;
  startedAt: string | null;
  endsWithError: number | null;
};

export type SeedAgentRow = {
  id: string;
  sessionId: string;
  status: string;
  startedAt: string | null;
  type: string | null;
};

export type SeedEventRow = {
  id: string;
  sessionId: string;
  eventType: string;
  createdAt: string;
};

export type SeedTokenEventRow = {
  sessionId: string;
  model: string;
  createdAt: string;
};

/** Bulk counterpart of {@link seedSession}, for over-chunk-size fixtures. */
export async function seedSessions(
  store: Store,
  rows: readonly SeedSessionRow[]
): Promise<void> {
  await bulkInsert(
    store,
    "INSERT INTO sessions (id, status, updated_at, last_activity_at, started_at, data_revision, ends_with_error) VALUES ",
    7,
    rows,
    (row) => [
      row.id,
      row.status,
      row.updatedAt,
      row.lastActivityAt,
      row.startedAt,
      1,
      row.endsWithError,
    ]
  );
}

/** Bulk counterpart of {@link seedAgent}, for over-chunk-size fixtures. */
export async function seedAgents(
  store: Store,
  rows: readonly SeedAgentRow[]
): Promise<void> {
  await bulkInsert(
    store,
    "INSERT INTO agents (id, session_id, status, started_at, type) VALUES ",
    5,
    rows,
    (row) => [row.id, row.sessionId, row.status, row.startedAt, row.type]
  );
}

/** Count the rows of `table` in each `status`, as a status → count map. */
export async function countByStatus(
  store: Store,
  table: "sessions" | "agents"
): Promise<Record<string, number>> {
  const result = await store.query<{ status: string; n: number }>(
    `SELECT status, COUNT(*) AS n FROM ${table} GROUP BY status`
  );
  const counts: Record<string, number> = Object.create(null);
  for (const row of result.rows) {
    counts[row.status] = Number(row.n);
  }
  return counts;
}

/** Count rows of `table` whose `ended_at` is still unset. */
export async function countMissingEndedAt(
  store: Store,
  table: "sessions" | "agents"
): Promise<number> {
  const result = await store.query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ${table} WHERE ended_at IS NULL`
  );
  return Number(result.rows[0]?.n ?? 0);
}

/**
 * ISS-5492: bulk `events` seed, for the over-`SWEEP_ID_CHUNK` retention fixture.
 * One event per expired session proves the TYPED child deletes ran for every
 * chunk, not only the first.
 */
export async function seedEvents(
  store: Store,
  rows: readonly SeedEventRow[]
): Promise<void> {
  await bulkInsert(
    store,
    "INSERT INTO events (id, session_id, event_type, created_at) VALUES ",
    4,
    rows,
    (row) => [row.id, row.sessionId, row.eventType, row.createdAt]
  );
}

/**
 * ISS-5492: bulk `token_events` seed. This is the table the retention sweep
 * deletes with a RAW statement carrying one placeholder per id, so it is the one
 * that throws on an older libSQL build when the sweep does not chunk.
 */
export async function seedTokenEvents(
  store: Store,
  rows: readonly SeedTokenEventRow[]
): Promise<void> {
  await bulkInsert(
    store,
    "INSERT INTO token_events (session_id, model, created_at) VALUES ",
    3,
    rows,
    (row) => [row.sessionId, row.model, row.createdAt]
  );
}

/**
 * A pass-through proxy over the caller's transaction client that records the
 * bound-parameter count of every `$executeRawUnsafe` the code under test issues.
 * Everything else forwards to the real client, so the sweep's writes still land
 * in the real database and the assertions run against real rows.
 */
export function recordBoundParams(
  tx: Prisma.TransactionClient,
  counts: number[]
): Prisma.TransactionClient {
  return new Proxy(tx, {
    get(target, property) {
      if (property === "$executeRawUnsafe") {
        return (sql: string, ...params: unknown[]) => {
          counts.push(params.length);
          return target.$executeRawUnsafe(sql, ...params);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function bulkInsert<TRow>(
  store: Store,
  prefix: string,
  columnCount: number,
  rows: readonly TRow[],
  toParams: (row: TRow) => unknown[]
): Promise<void> {
  for (let start = 0; start < rows.length; start += SEED_ROWS_PER_INSERT) {
    const batch = rows.slice(start, start + SEED_ROWS_PER_INSERT);
    const tuples = batch
      .map(
        (_, rowIndex) =>
          `(${Array.from(
            { length: columnCount },
            (__, columnIndex) => `$${rowIndex * columnCount + columnIndex + 1}`
          ).join(", ")})`
      )
      .join(", ");
    await store.query(prefix + tuples, batch.flatMap(toParams));
  }
}
