/**
 * @file local-priority-read.test.ts
 * @description ISS-10332 / PLN-2086 Milestone 3 step 15 — the local Sessions
 * and Branches reads serve `priority` and order / filter by it the way the cloud
 * reads do, over a real migrated SQLite store.
 *
 * Both stored states per surface: a member and no priority (`null`).
 * Ordering is the cloud comparator's: the wire ordinal, never the enum spelling,
 * with no-priority rows last in BOTH directions.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  BranchListPageMode,
  BranchListSortDirection,
  BranchListSortKey,
} from "@repo/api/src/types/branch-list-contract";
import { Priority } from "@repo/api/src/types/common";
import { PRIORITY_UNSET_VALUE } from "@repo/api/src/types/search-query";
import { test } from "vitest";
import { getSharedBranches } from "../src/main/branch/shared-branches-api.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { getSharedAgentSessions } from "../src/main/session/shared-agent-sessions-api.js";
import type { SharedBranchesListRequest } from "../src/shared/shared-branches-contract.js";
import { makeSession } from "./normalized-session-test-utils.js";

type Db = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

const IMPORTED_AT = "2026-09-22T12:00:00.000Z";

/** Session id → the value stored in `sessions.priority`. */
const STORED: Readonly<Record<string, Priority | null>> = {
  "s-low": Priority.Low,
  "s-high": Priority.High,
  "s-none": null,
};

async function openSeededDb(): Promise<{
  db: Db;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss10332-local-read-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.sqlite"),
    detectBillingMode: () => "metered_api",
    now: () => IMPORTED_AT,
  });
  for (const [sessionId, priority] of Object.entries(STORED)) {
    await db.importer.importSession(makeSession({ sessionId }), "claude");
    await db.run(
      "UPDATE sessions SET priority = $1 WHERE id = $2",
      priority,
      sessionId
    );
  }
  return {
    db,
    cleanup: async () => {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("ISS-10332: the local Sessions list serves each stored priority state", async () => {
  const { db, cleanup } = await openSeededDb();
  try {
    const list = await getSharedAgentSessions(db.syncSource, {});
    const byId = new Map(list.items.map((item) => [item.id, item]));

    assert.equal(byId.get("s-low")?.priority, Priority.Low);
    assert.equal(byId.get("s-high")?.priority, Priority.High);
    assert.equal(byId.get("s-none")?.priority, null);
  } finally {
    await cleanup();
  }
});

test("ISS-10332: the local Sessions list sorts by priority with unset rows last in both directions", async () => {
  const { db, cleanup } = await openSeededDb();
  try {
    const order = async (sortDir: "asc" | "desc") =>
      (
        await getSharedAgentSessions(db.syncSource, {
          sorts: [`priority:${sortDir}`],
        })
      ).items.map((item) => item.id);

    const ascending = await order("asc");
    const descending = await order("desc");
    // LOW before HIGH ascending: the ordinal, where the spelling sorts HIGH first.
    assert.deepEqual(ascending.slice(0, 2), ["s-low", "s-high"]);
    assert.deepEqual(descending.slice(0, 2), ["s-high", "s-low"]);
    for (const ids of [ascending, descending]) {
      assert.deepEqual(ids.slice(2), ["s-none"]);
    }
  } finally {
    await cleanup();
  }
});

test("ISS-10332: the local Sessions priority facet matches the cloud's arms", async () => {
  const { db, cleanup } = await openSeededDb();
  try {
    const ids = async (priorities: string[]) =>
      (await getSharedAgentSessions(db.syncSource, { priorities })).items
        .map((item) => item.id)
        .sort();

    assert.deepEqual(await ids([Priority.High]), ["s-high"]);
    assert.deepEqual(await ids([PRIORITY_UNSET_VALUE]), ["s-none"]);
    assert.deepEqual(await ids([Priority.Low, PRIORITY_UNSET_VALUE]), [
      "s-low",
      "s-none",
    ]);
    await assert.rejects(() =>
      getSharedAgentSessions(db.syncSource, { priorities: ["CRITICAL"] })
    );
  } finally {
    await cleanup();
  }
});

/** Branch name → the value stored on its `kind = 'branch'` artifact row. */
const BRANCH_STORED: Readonly<Record<string, Priority | null>> = {
  "feat/low": Priority.Low,
  "feat/high": Priority.High,
  "feat/none": null,
};
const BRANCH_REPO = "owner/repo";

async function openBranchSeededDb(): Promise<{
  db: Db;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss10332-local-branch-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.sqlite"),
    detectBillingMode: () => "metered_api",
    now: () => IMPORTED_AT,
  });
  for (const [branchName, priority] of Object.entries(BRANCH_STORED)) {
    // A pushed branch: the importer creates its artifact row from the ref.
    await db.importer.importSession(
      makeSession({
        sessionId: `session-${branchName}`,
        artifacts: { prs: [], issues: [], repo: BRANCH_REPO },
        toolUses: [
          {
            name: "Bash",
            timestamp: IMPORTED_AT,
            input: { command: `git push -u origin ${branchName}` },
          },
        ],
      }),
      "claude"
    );
    await db.run(
      "UPDATE artifacts SET priority = $1 WHERE kind = 'branch' AND branch_name = $2",
      priority,
      branchName
    );
  }
  return {
    db,
    cleanup: async () => {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function serverPage(
  overrides: Partial<SharedBranchesListRequest>
): SharedBranchesListRequest {
  return {
    pageMode: BranchListPageMode.Server,
    sortKey: BranchListSortKey.Priority,
    sortDir: BranchListSortDirection.Asc,
    ...overrides,
  };
}

test("ISS-10332: the local Branches page serves, sorts and filters by priority", async () => {
  const { db, cleanup } = await openBranchSeededDb();
  try {
    const page = await getSharedBranches(db, serverPage({}));
    const byName = new Map(page.items.map((item) => [item.branchName, item]));
    assert.equal(byName.get("feat/low")?.priority, Priority.Low);
    assert.equal(byName.get("feat/none")?.priority, null);

    const names = async (overrides: Partial<SharedBranchesListRequest>) =>
      (await getSharedBranches(db, serverPage(overrides))).items.map(
        (item) => item.branchName
      );
    assert.deepEqual((await names({})).slice(0, 2), ["feat/low", "feat/high"]);
    assert.deepEqual(
      (await names({ sortDir: BranchListSortDirection.Desc })).slice(0, 2),
      ["feat/high", "feat/low"]
    );
    // A priority filter saved in cloud mode reaches the local page.
    assert.deepEqual(await names({ priorities: [Priority.High] }), [
      "feat/high",
    ]);
    assert.deepEqual(await names({ priorities: [PRIORITY_UNSET_VALUE] }), [
      "feat/none",
    ]);
  } finally {
    await cleanup();
  }
});
