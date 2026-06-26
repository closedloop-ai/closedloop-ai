// Build a minimal OpenCode-shaped SQLite DB for parser testing.
// The OpenCode parser reads session/message/part tables; this constructs
// them with one session, two messages (user + assistant), and one tool part.

import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export function buildOpenCodeFixtureDb(targetPath) {
  if (existsSync(targetPath)) {
    unlinkSync(targetPath);
  }
  mkdirSync(dirname(targetPath), { recursive: true });

  const db = new DatabaseSync(targetPath);
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      slug TEXT,
      directory TEXT,
      title TEXT,
      version TEXT,
      agent TEXT,
      model TEXT,
      permission TEXT,
      time_created INTEGER,
      time_updated INTEGER,
      tokens_input INTEGER DEFAULT 0,
      tokens_output INTEGER DEFAULT 0,
      tokens_reasoning INTEGER DEFAULT 0,
      tokens_cache_read INTEGER DEFAULT 0,
      tokens_cache_write INTEGER DEFAULT 0
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      time_created INTEGER,
      time_updated INTEGER,
      data TEXT
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      time_created INTEGER,
      time_updated INTEGER,
      data TEXT
    );
  `);

  const created = new Date("2026-05-20T12:00:00.000Z").getTime();
  const updated = new Date("2026-05-20T12:00:30.000Z").getTime();
  const SID = "cc33";

  db.prepare(
    `INSERT INTO session
     (id, slug, directory, title, version, agent, model, permission,
      time_created, time_updated,
      tokens_input, tokens_output, tokens_reasoning,
      tokens_cache_read, tokens_cache_write)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    SID,
    "fixture-opencode-slug",
    "/Users/dev/repo",
    "Fixture OpenCode session",
    "0.3.0",
    "default",
    JSON.stringify({ modelID: "claude-sonnet-4" }),
    "default",
    created,
    updated,
    900,
    280,
    50,
    3000,
    400
  );

  // Messages: user + assistant
  db.prepare(
    `INSERT INTO message (id, session_id, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    "msg-1",
    SID,
    created,
    created,
    JSON.stringify({
      role: "user",
      time: { created },
    })
  );
  db.prepare(
    `INSERT INTO message (id, session_id, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    "msg-2",
    SID,
    created + 10_000,
    created + 10_000,
    JSON.stringify({
      role: "assistant",
      time: { created: created + 10_000 },
    })
  );

  // Parts: one tool invocation
  db.prepare(
    `INSERT INTO part (id, session_id, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    "part-1",
    SID,
    created + 5000,
    created + 5000,
    JSON.stringify({
      type: "tool",
      tool: "read_file",
      state: { status: "completed" },
    })
  );

  db.close();
  return { dbPath: targetPath, sessionId: SID };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const target = join(HERE, "opencode-fixture-cc33.db");
  const result = buildOpenCodeFixtureDb(target);
  console.log("Built:", result.dbPath);
}
