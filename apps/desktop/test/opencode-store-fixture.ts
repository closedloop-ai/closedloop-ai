/**
 * @file opencode-store-fixture.ts
 * @description A real `opencode.db` store, built on disk, for the OpenCode
 * collector tests.
 *
 * Extracted (ISS-5266, wongk review) so the withheld-subagent cases and the
 * worker-carry / upgrade-reconciliation cases build their stores from ONE
 * definition. The SQLite/parse ingest boundary is a trust boundary — the whole
 * point of these tests is that real bytes go through the real parser — so a
 * second copy of the DDL is exactly the drift this repo's shared-fixture rule
 * exists to prevent.
 */
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const TIME_CREATED = 1_710_000_000_000;
export const TIME_UPDATED = 1_710_000_060_000;

/** A negative token count raises `InvalidTokenCountError`, dropping that row. */
export const UNPARSEABLE_TOKENS = -5;

/**
 * A timestamp the parser's `noteTimestamp` REFUSES, so a session carrying it
 * everywhere reaches the no-timestamp drop (`if (!acc.firstTimestamp)`).
 *
 * `time_created`/`time_updated` are `INTEGER NOT NULL` in the real OpenCode
 * schema, so that drop is NOT reachable through a null column — it needs a
 * value `toIso` rejects. This one is past `Date`'s ±8.64e15 ms range (so `toIso`
 * yields null) yet inside `Number.MAX_SAFE_INTEGER`, so `node:sqlite` still
 * hands it back as a plain number instead of refusing to represent it. Adding
 * the message row's 30s offset keeps it in that same window.
 */
export const UNPARSEABLE_TIMESTAMP = 8_700_000_000_000_000;

const SCHEMA_DDL = `
  CREATE TABLE session (
    id TEXT PRIMARY KEY, parent_id TEXT, slug TEXT, directory TEXT NOT NULL,
    title TEXT NOT NULL, version TEXT NOT NULL, agent TEXT, model TEXT,
    permission TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
    tokens_input INTEGER DEFAULT 0 NOT NULL, tokens_output INTEGER DEFAULT 0 NOT NULL,
    tokens_reasoning INTEGER DEFAULT 0 NOT NULL, tokens_cache_read INTEGER DEFAULT 0 NOT NULL,
    tokens_cache_write INTEGER DEFAULT 0 NOT NULL,
    summary_additions, summary_deletions, summary_files, summary_diffs
  );
  CREATE TABLE message (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL, data TEXT NOT NULL
  );
  CREATE TABLE part (
    id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
  );
`;

export type SessionSpec = {
  id: string;
  parentId?: string | null;
  tokensInput?: number;
  /** Omit the message rows, so the parser legitimately returns null (no drop). */
  withoutMessages?: boolean;
  /**
   * Override the session row's timestamps AND its message rows' (both the
   * `time_created`/`time_updated` columns and the message `data.time.created`),
   * so a session can be given timestamps the parser refuses everywhere it looks
   * — see {@link UNPARSEABLE_TIMESTAMP}. Omitted = the {@link TIME_CREATED} /
   * {@link TIME_UPDATED} pair every other consumer already relies on.
   */
  timeCreated?: number;
  timeUpdated?: number;
};

export function insertSession(db: DatabaseSync, spec: SessionSpec): void {
  const timeCreated = spec.timeCreated ?? TIME_CREATED;
  const timeUpdated = spec.timeUpdated ?? TIME_UPDATED;
  db.prepare(`
    INSERT INTO session (
      id, parent_id, slug, directory, title, version, agent, model, permission,
      time_created, time_updated, tokens_input, tokens_output,
      tokens_reasoning, tokens_cache_read, tokens_cache_write,
      summary_additions, summary_deletions, summary_files, summary_diffs
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    spec.id,
    spec.parentId ?? null,
    `slug-${spec.id}`,
    "/workspace/my-project",
    `Title ${spec.id}`,
    "1.15.5",
    "build",
    JSON.stringify({ id: "oc-model", providerID: "opencode" }),
    "",
    timeCreated,
    timeUpdated,
    spec.tokensInput ?? 10,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    null
  );
  if (spec.withoutMessages) {
    return;
  }
  const insertMessage = db.prepare(
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)"
  );
  insertMessage.run(
    `${spec.id}-msg-user`,
    spec.id,
    timeCreated,
    timeCreated,
    JSON.stringify({ role: "user", time: { created: timeCreated } })
  );
  insertMessage.run(
    `${spec.id}-msg-assistant`,
    spec.id,
    timeCreated + 30_000,
    timeCreated + 30_000,
    JSON.stringify({
      role: "assistant",
      time: { created: timeCreated + 30_000 },
    })
  );
}

/** Write a real `opencode.db` into `dir` and return its path. */
export function writeOpencodeDb(dir: string, specs: SessionSpec[]): string {
  const dbPath = path.join(dir, "opencode.db");
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA_DDL);
  for (const spec of specs) {
    insertSession(db, spec);
  }
  db.close();
  return dbPath;
}
