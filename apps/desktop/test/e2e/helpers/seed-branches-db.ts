/**
 * Direct SQLite seeding for the Branches E2E tests.
 *
 * Unlike `seedClaudeTranscripts` (which drives the real importer, but can only
 * ever produce a net-new Draft branch — the local importer captures PR creation,
 * not a MERGED lifecycle), some Branches assertions need a corpus the importer
 * cannot synthesize on its own: a MERGED, single-PR branch with NO LOC enrichment
 * (FEA-2159's "Median PR size" case). That requires a `pull_requests` row with
 * `merged_at` set plus a `kind='branch'` artifact whose `lines_added/removed/
 * files_changed` are NULL and NO matching `kind='pull_request'` artifact to fall
 * back to.
 *
 * The desktop store is a single libSQL/SQLite file (`agent-dashboard.sqlite`) in
 * the app's `--user-data-dir`, opened in WAL mode. WAL supports multi-process
 * access, so this helper opens a SECOND `@libsql/client` connection on the SAME
 * file — exactly the connection type the app's own `openMigrationDatabase` uses —
 * and inserts the four real rows the Branches read path projects from:
 * `sessions`, `artifacts` (kind='branch'), `session_artifact_links`, and
 * `pull_requests`. These are the REAL tables `getSharedBranchAnalytics` reads, so
 * the app's real projection runs over them — no test-only code path.
 *
 * The db host opens + migrates the schema ASYNCHRONOUSLY after launch, so
 * `seedMergedUnenrichedSinglePrBranch` first polls `sqlite_master` until the
 * tables exist, then commits the rows in one batch (FK-ordered: parents first).
 * Applies the same WAL/busy-timeout/foreign-keys PRAGMAs every desktop connection
 * applies (see connection-pragmas.ts) so the write behaves identically.
 */

import path from "node:path";
import { createClient } from "@libsql/client";

/** The single-file libSQL store the desktop opens in the app's user-data dir. */
export const AGENT_DB_FILENAME = "agent-dashboard.sqlite";

/** Absolute path to the branches/agent SQLite store inside a launch's data dir. */
export function branchesDbPath(userDataDir: string): string {
  return path.join(userDataDir, AGENT_DB_FILENAME);
}

/** Real tables the Branches read path projects from or queries. */
const REQUIRED_TABLES = [
  "sessions",
  "artifacts",
  "session_artifact_links",
  "pull_requests",
] as const;
const REQUIRED_SESSION_COLUMNS = ["last_activity_at"] as const;
const BRANCH_SCHEMA_POLL_INTERVAL_MS = 250;
const SQLITE_BUSY_ERROR = "SQLITE_BUSY";
const SQLITE_LOCKED_MESSAGE = "database is locked";

export type MergedUnenrichedBranchSeed = {
  /** GitHub-style "owner/repo" (matched null-safely to the PR row). */
  repoFullName: string;
  /** The branch name (NOT a default branch — those are hidden by the read). */
  branchName: string;
  /** External session id the branch is linked through. */
  sessionId: string;
  /** The single linked PR's number. */
  prNumber: number;
  /** ISO merge instant — makes the PR state MERGED (status → Merged). */
  mergedAt: string;
};

export type NoPullRequestBranchSeed = {
  /** GitHub-style "owner/repo" stored on the branch artifact. */
  repoFullName: string;
  /** The branch name (NOT a default branch - those are hidden by the read). */
  branchName: string;
  /** External session id the branch is linked through. */
  sessionId: string;
  /** The linked session activity instant that drives the Branches row age. */
  activityAt: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Block until the launched app has migrated the Branches schema into its store —
 * a cross-process read of `sqlite_master` (reading the app's committed schema
 * across processes is reliable; only the reverse — the running app observing a
 * test-process write — is not, which is why seeding happens with the app DOWN).
 * Call while the app is UP so the caller knows migrations finished before it
 * closes the app to seed.
 */
export async function waitForBranchesSchema(
  userDataDir: string,
  timeoutMs = 30_000
): Promise<void> {
  const client = createClient({
    url: `file:${branchesDbPath(userDataDir)}`,
    intMode: "number",
  });
  try {
    await applyDesktopBusyTimeout(client);
    await waitForBranchSchema(client, timeoutMs);
  } finally {
    client.close();
  }
}

/**
 * Seed a MERGED, single-PR, LOC-un-enriched branch straight into the launched
 * app's SQLite store, so the app's real `getSharedBranchAnalytics` projection
 * medians it in as size 0 (FEA-2159). Polls for the migrated schema first (the
 * db host migrates async after launch), then inserts the four rows in one
 * FK-ordered batch.
 */
export async function seedMergedUnenrichedSinglePrBranch(
  userDataDir: string,
  seed: MergedUnenrichedBranchSeed,
  options: {
    schemaTimeoutMs?: number;
    /**
     * The seeded session's `last_activity_at` (retention age anchor). Defaults to
     * "now" so the session survives the boot retention sweep; override only to
     * exercise retention behavior.
     */
    sessionLastActivityAt?: string;
  } = {}
): Promise<void> {
  const dbPath = branchesDbPath(userDataDir);
  const client = createClient({ url: `file:${dbPath}`, intMode: "number" });
  try {
    await applyDesktopSeedPragmas(client);
    await waitForBranchSchema(client, options.schemaTimeoutMs ?? 30_000);

    const artifactId = `artifact-branch-${seed.sessionId}`;
    const now = seed.mergedAt;
    // The session's `last_activity_at` is the retention sweep's age anchor
    // (`sweepExpiredSessions` deletes terminal sessions whose last activity
    // predates the 90-day window, cascading its links + PR rows). Stamp it to a
    // RECENT instant so the seeded session survives the boot retention sweep;
    // this is independent of the branch's own `lastActivityAt` (which the read
    // derives from the PR's merge instant), so the branch still reads as merged.
    const sessionLastActivity =
      options.sessionLastActivityAt ?? new Date().toISOString();
    // One atomic batch, FK-ordered (sessions → artifacts → link → pull_requests).
    // The branch artifact's lines_* are NULL (un-enriched) and there is NO
    // kind='pull_request' artifact, so the read's PR-LOC fallback is also null —
    // the branch is fully un-enriched, the exact FEA-2159 corpus.
    await client.batch(
      [
        {
          sql: `INSERT INTO sessions
                  (id, status, started_at, ended_at, updated_at,
                   last_activity_at, data_revision)
                VALUES (?, 'completed', ?, ?, ?, ?, 1)`,
          args: [
            seed.sessionId,
            seed.mergedAt,
            seed.mergedAt,
            seed.mergedAt,
            sessionLastActivity,
          ],
        },
        {
          sql: `INSERT INTO artifacts
                  (id, identity_key, kind, repo_full_name, branch_name,
                   lines_added, lines_removed, files_changed,
                   enrichment_attempts, created_at, last_seen_at, observed_at)
                VALUES (?, ?, 'branch', ?, ?,
                        NULL, NULL, NULL,
                        0, ?, ?, ?)`,
          args: [
            artifactId,
            `branch:${seed.repoFullName}:${seed.branchName}`,
            seed.repoFullName,
            seed.branchName,
            now,
            now,
            now,
          ],
        },
        {
          // FEA-2531: `git_push` (write + push evidence) so the seeded branch
          // passes the new Branches display gate and the E2E screen stays
          // populated. `seeded` (a non-write method) would now be hidden.
          sql: `INSERT INTO session_artifact_links
                  (id, session_id, artifact_id, relation, method, evidence,
                   is_primary, status, extractor_version, observed_at, created_at)
                VALUES (?, ?, ?, 'authored', 'git_push', '{}',
                        1, 'confirmed', 1, ?, ?)`,
          args: [
            `link-${seed.sessionId}`,
            seed.sessionId,
            artifactId,
            now,
            now,
          ],
        },
        {
          sql: `INSERT INTO pull_requests
                  (id, session_id, pr_url, pr_number, repo_full_name, branch_name,
                   state, closed_at, merged_at, title, observed_at, created_at)
                VALUES (?, ?, ?, ?, ?, ?,
                        'closed', ?, ?, ?, ?, ?)`,
          args: [
            `pr-${seed.sessionId}`,
            seed.sessionId,
            `https://github.com/${seed.repoFullName}/pull/${seed.prNumber}`,
            seed.prNumber,
            seed.repoFullName,
            seed.branchName,
            seed.mergedAt,
            seed.mergedAt,
            `Seeded merged PR #${seed.prNumber}`,
            now,
            now,
          ],
        },
      ],
      "write"
    );

    // Fold the committed rows out of the -wal into the main db file so a later
    // launch reads them straight from the main db, independent of any -wal the
    // prior launch left behind.
    await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    client.close();
  }
}

/**
 * Seed a branch artifact that has no `pull_requests` row. The Branches list
 * should still project it from the real local DB path because the durable branch
 * identity is `sessions` -> `session_artifact_links` -> `artifacts(kind='branch')`.
 */
export async function seedNoPullRequestBranch(
  userDataDir: string,
  seed: NoPullRequestBranchSeed,
  options: {
    schemaTimeoutMs?: number;
    /**
     * Retention-sweep anchor. Defaults to "now" so a deliberately old
     * `activityAt` remains visible after the next desktop boot.
     */
    sessionLastActivityAt?: string;
  } = {}
): Promise<void> {
  const dbPath = branchesDbPath(userDataDir);
  const client = createClient({ url: `file:${dbPath}`, intMode: "number" });
  try {
    await applyDesktopSeedPragmas(client);
    await waitForBranchSchema(client, options.schemaTimeoutMs ?? 30_000);

    const artifactId = `artifact-branch-${seed.sessionId}`;
    const now = new Date().toISOString();
    const sessionLastActivity = options.sessionLastActivityAt ?? now;

    // FK-ordered batch with NO `pull_requests` insert and NO pull_request
    // artifact. This is the net-new local branch corpus FEA-2528 covers.
    await client.batch(
      [
        {
          sql: `INSERT INTO sessions
                  (id, status, started_at, ended_at, updated_at,
                   last_activity_at, data_revision)
                VALUES (?, 'completed', ?, ?, ?, ?, 1)`,
          args: [
            seed.sessionId,
            seed.activityAt,
            seed.activityAt,
            seed.activityAt,
            sessionLastActivity,
          ],
        },
        {
          sql: `INSERT INTO artifacts
                  (id, identity_key, kind, repo_full_name, branch_name,
                   enrichment_attempts, created_at, last_seen_at, observed_at)
                VALUES (?, ?, 'branch', ?, ?,
                        0, ?, ?, ?)`,
          args: [
            artifactId,
            `branch:${seed.repoFullName}:${seed.branchName}`,
            seed.repoFullName,
            seed.branchName,
            now,
            now,
            now,
          ],
        },
        {
          // FEA-2531: `git_push` (write + push evidence) so this net-new local
          // branch passes the new Branches display gate (a non-write `seeded`
          // method would now be hidden).
          sql: `INSERT INTO session_artifact_links
                  (id, session_id, artifact_id, relation, method, evidence,
                   is_primary, status, extractor_version, observed_at, created_at)
                VALUES (?, ?, ?, 'authored', 'git_push', '{}',
                        1, 'confirmed', 1, ?, ?)`,
          args: [
            `link-${seed.sessionId}`,
            seed.sessionId,
            artifactId,
            now,
            now,
          ],
        },
      ],
      "write"
    );

    await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    client.close();
  }
}

export type SessionListSeed = {
  /** The `sessions.id` — the row's detail-nav target and label fallback. */
  sessionId: string;
  /**
   * Visible row label in the Sessions list / Insights table. When omitted the
   * `name` column is NULL and the list falls back to rendering `sessionId`
   * (see `session-table-row.ts`: `name ?? externalSessionId`).
   */
  name?: string;
  /** Session lifecycle status (defaults to `completed`). */
  status?: string;
  /** `started_at` / `ended_at` / `updated_at` instant (defaults to now). */
  at?: string;
  /**
   * `last_activity_at` — the Sessions read's default-window filter AND the
   * retention sweep's age anchor. Defaults to "now" so the row is in-window on
   * every range and survives the boot retention sweep (which deletes terminal
   * sessions whose last activity predates the 90-day window).
   */
  lastActivityAt?: string;
};

/**
 * Seed bare `sessions` rows straight into the launched app's SQLite store so the
 * real Sessions list (and the Insights bounded table) projects them — WITHOUT
 * the transcript importer, whose read-your-writes WAL race quarantined
 * `sessions-flow.spec.ts` (FEA-2187). Unlike Branches, the Sessions read path
 * projects the `sessions` table directly (no artifact/link join), so a bare row
 * with the seven columns the read touches is enough to appear. Seeds while the
 * app is DOWN (no cross-process WAL contention), FK-order-free (single table),
 * then checkpoints so the next boot reads the rows from the main db file.
 */
export async function seedSessionsList(
  userDataDir: string,
  sessions: SessionListSeed[],
  options: { schemaTimeoutMs?: number } = {}
): Promise<void> {
  const dbPath = branchesDbPath(userDataDir);
  const client = createClient({ url: `file:${dbPath}`, intMode: "number" });
  try {
    await applyDesktopSeedPragmas(client);
    await waitForBranchSchema(client, options.schemaTimeoutMs ?? 30_000);

    const now = new Date().toISOString();
    await client.batch(
      sessions.map((session) => {
        const at = session.at ?? now;
        return {
          sql: `INSERT INTO sessions
                  (id, name, status, started_at, ended_at, updated_at,
                   last_activity_at, data_revision)
                VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
          args: [
            session.sessionId,
            session.name ?? null,
            session.status ?? "completed",
            at,
            at,
            at,
            session.lastActivityAt ?? now,
          ],
        };
      }),
      "write"
    );

    await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    client.close();
  }
}

/**
 * Poll until every table and migration-added column the Branches read path
 * needs exists. The db host runs migrations asynchronously after launch, so the
 * file may be present before the full migrated schema lands.
 */
async function waitForBranchSchema(
  client: ReturnType<typeof createClient>,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const placeholders = REQUIRED_TABLES.map(() => "?").join(", ");
  for (;;) {
    let rs: Awaited<ReturnType<typeof client.execute>>;
    let missingColumns: string[] = [...REQUIRED_SESSION_COLUMNS];
    try {
      rs = await client.execute({
        sql: `SELECT name FROM sqlite_master
              WHERE type = 'table' AND name IN (${placeholders})`,
        args: [...REQUIRED_TABLES],
      });
      if (rs.rows.length === REQUIRED_TABLES.length) {
        missingColumns = await getMissingColumns(
          client,
          "sessions",
          REQUIRED_SESSION_COLUMNS
        );
      }
      if (missingColumns.length === 0) {
        return;
      }
    } catch (error) {
      if (!isSqliteBusyError(error) || Date.now() > deadline) {
        throw error;
      }
      await sleep(BRANCH_SCHEMA_POLL_INTERVAL_MS);
      continue;
    }
    if (Date.now() > deadline) {
      const found = rs.rows.map((row) => String(row.name)).join(", ") || "none";
      const missing = missingColumns.join(", ") || "none";
      throw new Error(
        `branches DB schema did not appear within ${timeoutMs}ms (found tables: ${found}; missing session columns: ${missing})`
      );
    }
    await sleep(BRANCH_SCHEMA_POLL_INTERVAL_MS);
  }
}

async function getMissingColumns(
  client: ReturnType<typeof createClient>,
  tableName: string,
  requiredColumns: readonly string[]
): Promise<string[]> {
  const rs = await client.execute(`PRAGMA table_info(${tableName})`);
  const columns = new Set(rs.rows.map((row) => String(row.name)));
  return requiredColumns.filter((column) => !columns.has(column));
}

/**
 * Match the desktop's per-connection PRAGMAs (connection-pragmas.ts): WAL for
 * multi-process concurrency, a generous busy timeout to ride out brief writer
 * locks, and foreign keys enabled so seed batches obey the production schema.
 */
async function applyDesktopSeedPragmas(
  client: ReturnType<typeof createClient>
): Promise<void> {
  for (const pragma of [
    "PRAGMA journal_mode=WAL",
    "PRAGMA busy_timeout=15000",
    "PRAGMA foreign_keys=ON",
  ]) {
    await client.execute(pragma);
  }
}

async function applyDesktopBusyTimeout(
  client: ReturnType<typeof createClient>
): Promise<void> {
  await client.execute("PRAGMA busy_timeout=15000");
}

function isSqliteBusyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes(SQLITE_BUSY_ERROR) ||
    message.includes(SQLITE_LOCKED_MESSAGE)
  );
}
