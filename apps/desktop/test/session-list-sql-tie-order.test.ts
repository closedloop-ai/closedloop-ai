/**
 * ISS-9584: the tie order of the two SQL list reads — the cursor page and the
 * repository-scoped id read. The id closes the order DESCENDING whichever way
 * the key sorts, as the cloud's `SESSION_UNIQUE_TIEBREAKER` does (FEA-4329);
 * it used to follow the key, which reversed an ascending tie against the web
 * list.
 *
 * A `lastActivity` tie narrows by start time DESC before the id, in both
 * directions, as the cloud's `SESSION_DEFAULT_ORDER_BY` does (owner ruling on
 * PR #7961, item 4). The Started sort does not take that term.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SESSION_STATUS } from "@repo/api/src/types/session-status.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  type SessionListCursorPageRequest,
  SessionListCursorSortKey,
} from "../src/main/agent-sync/agent-session-read-model.js";
import { openTestDb } from "./agent-db-test-utils.js";
import { emptyAttributionCache } from "./attribution-test-helpers.js";

const REPOSITORY = "acme/tie-order";
const LAST_ACTIVITY = "2026-06-10T00:00:00.000Z";

/** id → start. `t-b` and `t-d` share a start; the rest differ. */
const ROWS: readonly { id: string; startedAt: string }[] = [
  { id: "t-a", startedAt: "2026-06-01T00:00:00.000Z" },
  { id: "t-b", startedAt: "2026-06-03T00:00:00.000Z" },
  { id: "t-c", startedAt: "2026-06-02T00:00:00.000Z" },
  { id: "t-d", startedAt: "2026-06-03T00:00:00.000Z" },
];

/** Start DESC, then id DESC for the `t-b`/`t-d` pair. */
const LAST_ACTIVITY_TIE_ORDER = ["t-d", "t-b", "t-c", "t-a"];

/** The two SQL list reads whose tie order this suite pins. */
const SqlListRead = {
  CursorPage: "cursor page",
  RepositoryScopedIds: "repository-scoped ids",
} as const;
type SqlListRead = (typeof SqlListRead)[keyof typeof SqlListRead];

type TestDb = Awaited<ReturnType<typeof openTestDb>>;
const open: { db: TestDb; dir: string }[] = [];

afterEach(async () => {
  for (const { db, dir } of open.splice(0)) {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

describe("SQL list tie order (ISS-9584)", () => {
  it.each([
    ["asc", SqlListRead.CursorPage],
    ["desc", SqlListRead.CursorPage],
    ["asc", SqlListRead.RepositoryScopedIds],
    ["desc", SqlListRead.RepositoryScopedIds],
  ] as const)(
    "narrows a lastActivity %s tie by start, then id, descending (%s)",
    async (sortDir, read) => {
      const db = await seeded();
      const ids = await readIds(db, read, {
        sortBy: SessionListCursorSortKey.LastActivity,
        sortDir,
      });
      expect(ids).toEqual(LAST_ACTIVITY_TIE_ORDER);
    }
  );

  it.each([
    ["asc", SqlListRead.CursorPage],
    ["asc", SqlListRead.RepositoryScopedIds],
  ] as const)(
    "breaks a started %s tie by id descending (%s)",
    async (sortDir, read) => {
      const db = await seeded();
      const ids = await readIds(db, read, {
        sortBy: SessionListCursorSortKey.Started,
        sortDir,
      });
      // t-a < t-c < {t-b, t-d} by start; the tied pair runs id DESC.
      expect(ids).toEqual(["t-a", "t-c", "t-d", "t-b"]);
    }
  );
});

async function seeded(): Promise<TestDb> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss-9584-tie-order-"));
  const db = await openTestDb(dir);
  open.push({ db, dir });
  for (const row of ROWS) {
    await db.run(
      `INSERT INTO sessions
         (id, status, started_at, updated_at, last_activity_at, cwd, repo_full_name)
       VALUES ($1, $2, $3, $4, $4, '/iss-9584/absent-worktree', $5)`,
      row.id,
      SESSION_STATUS.INACTIVE,
      row.startedAt,
      LAST_ACTIVITY,
      REPOSITORY
    );
  }
  return db;
}

async function readIds(
  db: TestDb,
  read: SqlListRead,
  sort: Pick<SessionListCursorPageRequest, "sortBy" | "sortDir">
): Promise<string[]> {
  const source = db.syncSource;
  if (read === SqlListRead.CursorPage) {
    const page = await source.listSessionCursorPage?.({
      limit: 10,
      offset: 0,
      ...sort,
    });
    return page?.rows.map((row) => row.id) ?? [];
  }
  return (
    (await source.listRepositoryScopedSessionIds?.(
      [REPOSITORY],
      emptyAttributionCache(),
      sort
    )) ?? []
  );
}
