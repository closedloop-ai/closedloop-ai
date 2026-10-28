import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { keepSessionsOf } from "../scripts/vibe-profile/keep-sessions";
import {
  openSqliteAgentDatabase,
  type SqliteAgentDatabase,
} from "../src/main/database/sqlite.js";
import { insertSqliteSession } from "./sqlite-session-fixtures.js";

const LOGIN = "dreyes";
const OWN_CWD = "/Users/dreyes/acme-web";
const OTHER_CWD = "/work/elsewhere";
// The store open applies the 90-day retention sweep against the real clock,
// so fixture sessions start now to survive it.
const AT = new Date().toISOString();
const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function storeWith(
  seed: (db: SqliteAgentDatabase) => Promise<void>
): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vibe-keep-sessions-"));
  dirs.push(dir);
  const storePath = path.join(dir, "store");
  const db = await openSqliteAgentDatabase({
    dataDir: storePath,
    detectBillingMode: () => "api",
  });
  try {
    await seed(db);
  } finally {
    await db.close();
  }
  return storePath;
}

async function linkSession(
  db: SqliteAgentDatabase,
  sessionId: string
): Promise<void> {
  await db.run(
    `INSERT INTO artifacts (id, identity_key, kind, branch_name, observed_at, created_at, last_seen_at)
     VALUES ($1, $1, 'branch', 'feat/x', $2, $2, $2)`,
    `artifact-${sessionId}`,
    AT
  );
  await db.run(
    `INSERT INTO session_artifact_links (id, session_id, artifact_id, relation, method, evidence, extractor_version, observed_at, created_at)
     VALUES ($1, $2, $3, 'created', 'git_push', '{}', 1, $4, $4)`,
    `link-${sessionId}`,
    sessionId,
    `artifact-${sessionId}`,
    AT
  );
}

async function readStore(storePath: string) {
  const db = await openSqliteAgentDatabase({
    dataDir: storePath,
    detectBillingMode: () => "api",
  });
  try {
    const sessions = await db.prisma.client.session.findMany({
      select: { id: true },
      orderBy: { id: "asc" },
    });
    const links = await db.prisma.client.$queryRawUnsafe<
      { sessionId: string }[]
    >(
      'SELECT session_id AS "sessionId" FROM session_artifact_links ORDER BY session_id'
    );
    return {
      sessions: sessions.map((row) => row.id),
      links: links.map((row) => row.sessionId),
    };
  } finally {
    await db.close();
  }
}

describe("keepSessionsOf", () => {
  it("removes a teammate's session and every row keyed by its session_id, keeping the login's own", async () => {
    const storePath = await storeWith(async (db) => {
      await insertSqliteSession(db, "own", { cwd: OWN_CWD, startedAt: AT });
      await insertSqliteSession(db, "other", { cwd: OTHER_CWD, startedAt: AT });
      await linkSession(db, "own");
      await linkSession(db, "other");
    });

    const result = await keepSessionsOf(storePath, LOGIN, () => undefined);

    expect(result).toEqual({ kept: 1, removed: 1 });
    expect(await readStore(storePath)).toEqual({
      sessions: ["own"],
      links: ["own"],
    });
  });

  it("touches nothing when every session is the login's own", async () => {
    const storePath = await storeWith(async (db) => {
      await insertSqliteSession(db, "a", { cwd: OWN_CWD, startedAt: AT });
      await insertSqliteSession(db, "b", { cwd: OWN_CWD, startedAt: AT });
      await linkSession(db, "a");
    });

    const result = await keepSessionsOf(storePath, LOGIN, () => undefined);

    expect(result).toEqual({ kept: 2, removed: 0 });
    expect(await readStore(storePath)).toEqual({
      sessions: ["a", "b"],
      links: ["a"],
    });
  });
});
