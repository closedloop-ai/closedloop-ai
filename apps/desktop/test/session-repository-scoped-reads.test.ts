/**
 * @file session-repository-scoped-reads.test.ts
 * @description ISS-5625: the Repository facet's pre-hydration id read resolves
 * identity per DISTINCT `(cwd, repo_full_name)` pair and selects the ids in SQL.
 *
 * Two things the rewrite must not break, and one it adds:
 *
 * - Distinct worktrees of ONE repo must still all match. The pair-key grouping
 *   is the seam where a repo represented by several cwds could silently lose
 *   every cwd but one, so the fixture gives `acme/app` two.
 * - A row with no resolvable identity (null/empty/whitespace `repo_full_name`
 *   with no cwd to live-resolve) renders "Unknown" and must stay out — the
 *   NULL→`''` collapse the pair key performs is only safe because
 *   `resolveRepositoryFullNameStoredFirst` cannot tell those apart either.
 * - `options.limit` bounds the id read itself, in the same order the caller's
 *   own cap is measured in.
 *
 * Every fixture cwd is deliberately absent from disk, so identity comes from
 * the stored name alone and the read never touches git.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import { listSqliteRepositoryScopedSessionIds } from "../src/main/database/session-repository-scoped-reads.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import {
  emptyAttributionCache,
  initGitRepoWithOrigin,
} from "./attribution-test-helpers.js";

const SESSION_ROWS: {
  id: string;
  cwd: string | null;
  repoFullName: string | null;
  updatedAt: string;
}[] = [
  // Newest first — three rows with no resolvable identity, then the two repos.
  {
    id: "s-blank",
    cwd: null,
    repoFullName: "   ",
    updatedAt: "2026-07-08T00:00:00.000Z",
  },
  {
    id: "s-empty",
    cwd: null,
    repoFullName: "",
    updatedAt: "2026-07-07T00:00:00.000Z",
  },
  {
    id: "s-null",
    cwd: null,
    repoFullName: null,
    updatedAt: "2026-07-06T00:00:00.000Z",
  },
  {
    id: "s-other",
    cwd: "/wt/three",
    repoFullName: "acme/other",
    updatedAt: "2026-07-05T00:00:00.000Z",
  },
  {
    id: "s-app-1",
    cwd: "/wt/one",
    repoFullName: "acme/app",
    updatedAt: "2026-07-04T00:00:00.000Z",
  },
  {
    id: "s-app-2",
    cwd: "/wt/one",
    repoFullName: "acme/app",
    updatedAt: "2026-07-03T00:00:00.000Z",
  },
  {
    id: "s-app-3",
    cwd: "/wt/two",
    repoFullName: "acme/app",
    updatedAt: "2026-07-02T00:00:00.000Z",
  },
  {
    id: "s-app-4",
    cwd: "/wt/two",
    repoFullName: "acme/app",
    updatedAt: "2026-07-01T00:00:00.000Z",
  },
];

test("ISS-5625: the repository-scoped id read groups by pair, excludes unresolvable rows, and honors the limit", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5625-repo-scoped-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  try {
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => "2026-07-10T00:00:00.000Z",
    });
    try {
      for (const row of SESSION_ROWS) {
        await db.run(
          "INSERT INTO sessions (id, status, started_at, updated_at, cwd, repo_full_name) VALUES (?, 'inactive', ?, ?, ?, ?)",
          row.id,
          row.updatedAt,
          row.updatedAt,
          row.cwd,
          row.repoFullName
        );
      }
      const listIds = db.syncSource.listRepositoryScopedSessionIds;
      assert.ok(listIds, "source implements listRepositoryScopedSessionIds");

      assert.deepEqual(
        await listIds(["acme/app"], emptyAttributionCache()),
        ["s-app-1", "s-app-2", "s-app-3", "s-app-4"],
        "both worktrees of the selected repo match, newest first; unresolvable rows and the other repo do not"
      );

      assert.deepEqual(
        await listIds(["acme/app"], emptyAttributionCache(), { limit: 2 }),
        ["s-app-1", "s-app-2"],
        "the limit keeps the newest N in the read's own order"
      );

      assert.deepEqual(
        await listIds(["acme/app"], emptyAttributionCache(), { limit: 0 }),
        [],
        "a limit of 0 means no ids, not an unbounded read"
      );

      assert.deepEqual(
        await listIds(["acme/nobody"], emptyAttributionCache()),
        [],
        "a selection nothing resolves to matches no ids"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-5625: a blank stored name is keyed as absent, so the live-resolved row still matches", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5625-blank-stored-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const repoDir = path.join(dir, "worktree");
  try {
    await mkdir(repoDir, { recursive: true });
    initGitRepoWithOrigin(repoDir, "acme/live");
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => "2026-07-10T00:00:00.000Z",
    });
    try {
      // A whitespace-only stored name is what `resolveRepositoryFullNameStoredFirst`
      // treats as ABSENT and what `applyRepoFullNameFillBacks` is entitled to
      // overwrite — so the pair key must normalize it away, or this row keys as
      // its own private worktree and the fill-back silently re-keys it away
      // again on the very next page read.
      await db.run(
        "INSERT INTO sessions (id, status, started_at, updated_at, cwd, repo_full_name) VALUES ('s-blank-stored','inactive',?,?,?,'   ')",
        "2026-07-01T00:00:00.000Z",
        "2026-07-01T00:00:00.000Z",
        repoDir
      );
      const listIds = db.syncSource.listRepositoryScopedSessionIds;
      assert.ok(listIds, "source implements listRepositoryScopedSessionIds");

      assert.deepEqual(
        await listIds(["acme/live"], emptyAttributionCache()),
        ["s-blank-stored"],
        "the live-resolved identity matches through a blank stored name"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const GROUPED_RESOLUTION_SQL = /GROUP BY pair_key/;
const MATCHED_PAIR_SQL = /json_each/;

/**
 * The once-per-distinct-pair property is not observable from the returned ids —
 * resolving per row and resolving per pair select the SAME sessions, which is
 * the whole point of the change — and it must not be measured by timing. What
 * is observable at the store boundary is the shape of the reads the function
 * issues, so this pins that: one grouped statement carrying no session id, then
 * the id selection. A revert to the per-row loop collapses both into a single
 * `s.id`-bearing statement and fails here.
 *
 * The pair keys are opaque to the code under test — it echoes whatever the
 * grouped read returned into the second statement — so the fixture uses plain
 * readable strings rather than reproducing the SQL key encoding.
 */
test("ISS-5625: identity resolves from one grouped read, ids from a second", async () => {
  const statements: string[] = [];
  const reader = {
    $queryRawUnsafe: (sql: string) => {
      statements.push(sql);
      return Promise.resolve(
        statements.length === 1
          ? [
              {
                pair_key: "pair-one",
                cwd: "/wt/one",
                repo_full_name: "acme/app",
              },
              {
                pair_key: "pair-two",
                cwd: "/wt/two",
                repo_full_name: "acme/app",
              },
            ]
          : [{ id: "a" }, { id: "b" }]
      );
    },
  };
  const prisma = {
    read: (fn: (r: typeof reader) => unknown) => fn(reader),
  } as unknown as DesktopPrisma;

  const ids = await listSqliteRepositoryScopedSessionIds(
    prisma,
    ["acme/app"],
    emptyAttributionCache()
  );

  assert.deepEqual(ids, ["a", "b"], "the ids come from the second read");
  assert.equal(statements.length, 2, "one resolution read, one id read");
  assert.match(statements[0] ?? "", GROUPED_RESOLUTION_SQL);
  assert.ok(
    !statements[0]?.includes("s.id"),
    "the resolution read materializes pairs, never a row per session"
  );
  assert.match(statements[1] ?? "", MATCHED_PAIR_SQL);
});

test("ISS-5625: a zero limit answers without reading the store at all", async () => {
  const prisma = {
    read: () => {
      throw new Error("no read should be issued for a zero limit");
    },
  } as unknown as DesktopPrisma;

  assert.deepEqual(
    await listSqliteRepositoryScopedSessionIds(
      prisma,
      ["acme/app"],
      emptyAttributionCache(),
      { limit: 0 }
    ),
    []
  );
});
