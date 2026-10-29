/**
 * @file local-priority-store.test.ts
 * @description ISS-10332 / PLN-2086 Milestone 3 — the local priority columns
 * against a real migrated SQLite store, driven through the production importer.
 *
 * Pins the two properties the local write depends on and only a database shows:
 *
 *  1. NO IMPORT PATH WRITES EITHER COLUMN, NOR ITS UPLOAD MARKER (neither
 *     clearing a pending upload nor re-arming a settled one). A priority set locally survives a
 *     re-import of the same transcript — and the re-import is proven to have run
 *     its update arm (the collector's `name` is rewritten), so a green here is
 *     not an import that skipped the row.
 *  2. THE WRITE ITSELF: the optimistic guard, the forward-only `updated_at`
 *     re-queue, the no-op that causes no sync churn, and a branch write that
 *     lands on every artifact row of one identity.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { encodeBranchId } from "@repo/api/src/types/branch";
import { Priority } from "@repo/api/src/types/common";
import { ArtifactRefRelation } from "@repo/api/src/types/session-artifact-link";
import { test } from "vitest";
import { MonitoredSessionCliRefMethod } from "../src/main/collectors/parsing/monitored-session-activity.js";
import {
  writeLocalBranchPriority,
  writeLocalSessionPriority,
} from "../src/main/database/local-priority-store.js";
import { settlePriorityUploads } from "../src/main/database/priority-upload-marker.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { LocalPriorityWriteStatus } from "../src/shared/local-priority-write-contract.js";
import { makeSession } from "./normalized-session-test-utils.js";

type Db = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

const REPO = "owner/repo";
const BRANCH = "feat/iss-10332-local";
const SESSION_ID = "iss10332-local-session";
const IMPORTED_AT = "2026-09-22T12:00:00.000Z";
const WRITTEN_AT = "2026-09-22T13:00:00.000Z";
const LATER_WRITTEN_AT = "2026-09-22T14:00:00.000Z";
const LATER_WRITTEN_AT_PLUS_1MS = "2026-09-22T14:00:00.001Z";
const BRANCH_ID = encodeBranchId({ repoFullName: REPO, branchName: BRANCH });
const RE_REQUEUE_REFUSED = /iss10332 re-queue refused/;

async function openDb(): Promise<{ db: Db; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss10332-local-priority-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.sqlite"),
    detectBillingMode: () => "metered_api",
    now: () => IMPORTED_AT,
  });
  return {
    db,
    cleanup: async () => {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/**
 * A session that PUSHED `BRANCH`: the extractor turns the `git push` into a
 * branch ref, so the import itself creates the `kind = 'branch'` artifact row
 * and its link — a hand-seeded row would prove nothing about the importer.
 */
function pushingSession(overrides: { sessionId?: string; name?: string } = {}) {
  return makeSession({
    sessionId: overrides.sessionId ?? SESSION_ID,
    name: overrides.name ?? "collected name",
    artifacts: { prs: [], issues: [], repo: REPO },
    toolUses: [
      {
        name: "Bash",
        timestamp: IMPORTED_AT,
        input: { command: `git push -u origin ${BRANCH}` },
      },
    ],
  });
}

async function readSession(
  db: Db,
  sessionId: string
): Promise<{
  name: string | null;
  priority: string | null;
  updated_at: string;
}> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    { name: string | null; priority: string | null; updated_at: string }[]
  >("SELECT name, priority, updated_at FROM sessions WHERE id = $1", sessionId);
  const [row] = rows;
  if (!row) {
    throw new Error(`session ${sessionId} is missing`);
  }
  return row;
}

async function readBranchPriorities(db: Db): Promise<(string | null)[]> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    { priority: string | null }[]
  >(
    `SELECT priority FROM artifacts
     WHERE kind = 'branch' AND repo_full_name = $1 AND branch_name = $2
     ORDER BY id ASC`,
    REPO,
    BRANCH
  );
  return rows.map((row) => row.priority);
}

/** ISS-10332: the session's and its branch rows' `priority_upload_pending`. */
async function readUploadMarkers(
  db: Db
): Promise<{ session: number; branches: number[] }> {
  const sessions = await db.prisma.client.$queryRawUnsafe<
    { pending: number }[]
  >(
    "SELECT priority_upload_pending AS pending FROM sessions WHERE id = $1",
    SESSION_ID
  );
  const branches = await db.prisma.client.$queryRawUnsafe<
    { pending: number }[]
  >(
    `SELECT priority_upload_pending AS pending FROM artifacts
     WHERE kind = 'branch' AND repo_full_name = $1 AND branch_name = $2
     ORDER BY id ASC`,
    REPO,
    BRANCH
  );
  return {
    session: Number(sessions[0]?.pending),
    branches: branches.map((row) => Number(row.pending)),
  };
}

async function setSessionUpdatedAt(
  db: Db,
  sessionId: string,
  updatedAt: string
): Promise<void> {
  await db.run(
    "UPDATE sessions SET updated_at = $1 WHERE id = $2",
    updatedAt,
    sessionId
  );
}

test("ISS-10332: no import path writes the priority columns or their upload marker", async () => {
  const { db, cleanup } = await openDb();
  try {
    await db.importer.importSession(pushingSession(), "claude");
    assert.deepEqual(await readBranchPriorities(db), [null]);
    assert.deepEqual(await readUploadMarkers(db), {
      session: 0,
      branches: [0],
    });

    await writeLocalSessionPriority(
      db.prisma,
      { id: SESSION_ID, priority: Priority.Urgent },
      WRITTEN_AT
    );
    await writeLocalBranchPriority(
      db.prisma,
      { id: BRANCH_ID, priority: Priority.Low },
      WRITTEN_AT
    );

    const reimported = await db.importer.importSession(
      pushingSession({ name: "re-derived name" }),
      "claude"
    );
    assert.notEqual(reimported.failed, true);

    const session = await readSession(db, SESSION_ID);
    // The update arm really ran: the collector's name is fresh-wins.
    assert.equal(session.name, "re-derived name");
    assert.equal(session.priority, Priority.Urgent);
    assert.deepEqual(await readBranchPriorities(db), [Priority.Low]);
    // A re-import neither clears a pending upload…
    assert.deepEqual(await readUploadMarkers(db), {
      session: 1,
      branches: [1],
    });

    // …nor re-arms one the sync ack already settled.
    await settlePriorityUploads(db.prisma, [
      {
        sessionId: SESSION_ID,
        priority: Priority.Urgent,
        branches: [
          {
            repositoryFullName: REPO,
            branchName: BRANCH,
            priority: Priority.Low,
          },
        ],
      },
    ]);
    const again = await db.importer.importSession(
      pushingSession({ name: "re-derived again" }),
      "claude"
    );
    assert.notEqual(again.failed, true);
    assert.equal((await readSession(db, SESSION_ID)).name, "re-derived again");
    assert.deepEqual(await readUploadMarkers(db), {
      session: 0,
      branches: [0],
    });
  } finally {
    await cleanup();
  }
});

test("ISS-10332: a session write stores the value and moves updated_at forward only", async () => {
  const { db, cleanup } = await openDb();
  try {
    await db.importer.importSession(pushingSession(), "claude");
    await setSessionUpdatedAt(db, SESSION_ID, IMPORTED_AT);

    const written = await writeLocalSessionPriority(
      db.prisma,
      { id: SESSION_ID, priority: Priority.High },
      WRITTEN_AT
    );
    assert.deepEqual(written, {
      status: LocalPriorityWriteStatus.Written,
      priority: Priority.High,
    });
    assert.deepEqual(
      {
        priority: (await readSession(db, SESSION_ID)).priority,
        updatedAt: (await readSession(db, SESSION_ID)).updated_at,
      },
      { priority: Priority.High, updatedAt: WRITTEN_AT }
    );

    assert.equal((await readUploadMarkers(db)).session, 1);

    // Re-sending the value it already holds writes nothing — no re-queue churn,
    // and no second upload of a value the cloud already confirmed.
    await settlePriorityUploads(db.prisma, [
      { sessionId: SESSION_ID, priority: Priority.High, branches: [] },
    ]);
    await writeLocalSessionPriority(
      db.prisma,
      { id: SESSION_ID, priority: Priority.High },
      LATER_WRITTEN_AT
    );
    assert.equal((await readSession(db, SESSION_ID)).updated_at, WRITTEN_AT);
    assert.equal((await readUploadMarkers(db)).session, 0);

    // A session already at or ahead of the write still moves forward, by one
    // millisecond, so the change re-queues (#7794 review); it never moves back.
    await setSessionUpdatedAt(db, SESSION_ID, LATER_WRITTEN_AT);
    await writeLocalSessionPriority(
      db.prisma,
      { id: SESSION_ID, priority: null },
      WRITTEN_AT
    );
    const cleared = await readSession(db, SESSION_ID);
    assert.equal(cleared.priority, null);
    assert.equal(cleared.updated_at, LATER_WRITTEN_AT_PLUS_1MS);
  } finally {
    await cleanup();
  }
});

test("ISS-10332: a stale expectedPriority is refused and writes nothing", async () => {
  const { db, cleanup } = await openDb();
  try {
    await db.importer.importSession(pushingSession(), "claude");
    await writeLocalSessionPriority(
      db.prisma,
      { id: SESSION_ID, priority: Priority.Medium },
      WRITTEN_AT
    );

    const stale = await writeLocalSessionPriority(
      db.prisma,
      {
        id: SESSION_ID,
        priority: Priority.Urgent,
        expectedPriority: null,
      },
      LATER_WRITTEN_AT
    );
    assert.deepEqual(stale, { status: LocalPriorityWriteStatus.Stale });
    assert.equal((await readSession(db, SESSION_ID)).priority, Priority.Medium);

    const missing = await writeLocalSessionPriority(
      db.prisma,
      { id: "no-such-session", priority: Priority.Low },
      LATER_WRITTEN_AT
    );
    assert.deepEqual(missing, { status: LocalPriorityWriteStatus.NotFound });
  } finally {
    await cleanup();
  }
});

test("ISS-10332: a branch write lands on every row of the identity and re-queues its newest session", async () => {
  const { db, cleanup } = await openDb();
  try {
    await db.importer.importSession(pushingSession(), "claude");
    await db.importer.importSession(
      pushingSession({ sessionId: "iss10332-other-session" }),
      "claude"
    );
    // A second artifact row for the same (repo, branch) — a new worktree of the
    // branch — which the list groups into the same branch id.
    await db.run(
      `INSERT INTO artifacts (id, identity_key, kind, repo_full_name, branch_name, created_at, last_seen_at)
       VALUES ('iss10332-second-branch-row', 'iss10332-second-identity', 'branch', $1, $2, $3, $3)`,
      REPO,
      BRANCH,
      IMPORTED_AT
    );
    await setSessionUpdatedAt(db, SESSION_ID, IMPORTED_AT);
    await setSessionUpdatedAt(
      db,
      "iss10332-other-session",
      "2026-09-22T11:00:00.000Z"
    );

    const written = await writeLocalBranchPriority(
      db.prisma,
      { id: BRANCH_ID, priority: Priority.Urgent, expectedPriority: null },
      WRITTEN_AT
    );
    assert.deepEqual(written, {
      status: LocalPriorityWriteStatus.Written,
      priority: Priority.Urgent,
    });
    assert.deepEqual(await readBranchPriorities(db), [
      Priority.Urgent,
      Priority.Urgent,
    ]);
    // Only the most recently updated linked session carries the change up.
    assert.equal((await readSession(db, SESSION_ID)).updated_at, WRITTEN_AT);
    assert.equal(
      (await readSession(db, "iss10332-other-session")).updated_at,
      "2026-09-22T11:00:00.000Z"
    );

    // A newest session already ahead of the write still moves forward.
    await setSessionUpdatedAt(db, SESSION_ID, LATER_WRITTEN_AT);
    await writeLocalBranchPriority(
      db.prisma,
      { id: BRANCH_ID, priority: Priority.High },
      WRITTEN_AT
    );
    assert.equal(
      (await readSession(db, SESSION_ID)).updated_at,
      LATER_WRITTEN_AT_PLUS_1MS
    );

    const stale = await writeLocalBranchPriority(
      db.prisma,
      { id: BRANCH_ID, priority: Priority.Low, expectedPriority: null },
      LATER_WRITTEN_AT
    );
    assert.deepEqual(stale, { status: LocalPriorityWriteStatus.Stale });

    const missing = await writeLocalBranchPriority(
      db.prisma,
      {
        id: encodeBranchId({ repoFullName: REPO, branchName: "no-such" }),
        priority: Priority.Low,
      },
      LATER_WRITTEN_AT
    );
    assert.deepEqual(missing, { status: LocalPriorityWriteStatus.NotFound });
  } finally {
    await cleanup();
  }
});

test("ISS-10332: a branch write whose sync re-queue fails keeps no priority", async () => {
  const { db, cleanup } = await openDb();
  try {
    await db.importer.importSession(pushingSession(), "claude");
    await setSessionUpdatedAt(db, SESSION_ID, IMPORTED_AT);
    await db.run(
      `CREATE TRIGGER iss10332_refuse_requeue BEFORE UPDATE ON sessions
       BEGIN SELECT RAISE(ABORT, 'iss10332 re-queue refused'); END`
    );

    await assert.rejects(
      writeLocalBranchPriority(
        db.prisma,
        { id: BRANCH_ID, priority: Priority.Urgent },
        WRITTEN_AT
      ),
      // The typed update surfaces the trigger's message on the adapter error.
      (error: unknown) =>
        error instanceof Error &&
        "meta" in error &&
        RE_REQUEUE_REFUSED.test(JSON.stringify(error.meta))
    );

    // A value the cloud can never be told about must not be stored either.
    assert.deepEqual(await readBranchPriorities(db), [null]);
  } finally {
    await cleanup();
  }
});

test("ISS-10332: a repo-less branch identity writes only its own rows and re-queues its session", async () => {
  const { db, cleanup } = await openDb();
  const localSessionId = "iss10332-repo-less-session";
  try {
    // The same branch name under REPO, which a repo-less write must not touch.
    await db.importer.importSession(pushingSession(), "claude");
    await db.importer.importSession(
      makeSession({ sessionId: localSessionId }),
      "claude"
    );
    await db.run(
      `INSERT INTO artifacts (id, identity_key, kind, repo_full_name, branch_name, created_at, last_seen_at)
       VALUES ('iss10332-repo-less-row', 'iss10332-repo-less-identity', 'branch', NULL, $1, $2, $2)`,
      BRANCH,
      IMPORTED_AT
    );
    await db.run(
      `INSERT INTO session_artifact_links
         (id, session_id, artifact_id, relation, method, evidence,
          extractor_version, observed_at, created_at)
       VALUES ('iss10332-repo-less-link', $1, 'iss10332-repo-less-row',
         '${ArtifactRefRelation.Created}',
         '${MonitoredSessionCliRefMethod.GitPush}', '{}', 1, $2, $2)`,
      localSessionId,
      IMPORTED_AT
    );
    await setSessionUpdatedAt(db, localSessionId, IMPORTED_AT);
    await setSessionUpdatedAt(db, SESSION_ID, IMPORTED_AT);

    const written = await writeLocalBranchPriority(
      db.prisma,
      {
        id: encodeBranchId({ repoFullName: null, branchName: BRANCH }),
        priority: Priority.High,
      },
      WRITTEN_AT
    );
    assert.deepEqual(written, {
      status: LocalPriorityWriteStatus.Written,
      priority: Priority.High,
    });

    const rows = await db.prisma.client.$queryRawUnsafe<
      { repo: string | null; priority: string | null; pending: number }[]
    >(
      `SELECT repo_full_name AS repo, priority, priority_upload_pending AS pending
       FROM artifacts WHERE kind = 'branch' AND branch_name = $1
       ORDER BY repo_full_name IS NULL DESC`,
      BRANCH
    );
    assert.deepEqual(
      rows.map((row) => ({ ...row, pending: Number(row.pending) })),
      [
        { repo: null, priority: Priority.High, pending: 1 },
        { repo: REPO, priority: null, pending: 0 },
      ]
    );
    assert.equal(
      (await readSession(db, localSessionId)).updated_at,
      WRITTEN_AT
    );
    assert.equal((await readSession(db, SESSION_ID)).updated_at, IMPORTED_AT);
  } finally {
    await cleanup();
  }
});

// ISS-9486 ruling 2: a write whose requested value is already stored succeeds
// as a no-op whatever it expected, so a retry never refuses its own success.
test("ISS-11197: a same-value session retry succeeds and writes nothing, acked or not", async () => {
  const { db, cleanup } = await openDb();
  try {
    await db.importer.importSession(pushingSession(), "claude");
    await setSessionUpdatedAt(db, SESSION_ID, IMPORTED_AT);
    const request = {
      id: SESSION_ID,
      priority: Priority.High,
      expectedPriority: null,
    };
    const written = {
      status: LocalPriorityWriteStatus.Written,
      priority: Priority.High,
    };
    const retryAndRead = async () => {
      assert.deepEqual(
        await writeLocalSessionPriority(db.prisma, request, LATER_WRITTEN_AT),
        written
      );
      const row = await readSession(db, SESSION_ID);
      return {
        priority: row.priority,
        updatedAt: row.updated_at,
        pending: (await readUploadMarkers(db)).session,
      };
    };
    assert.deepEqual(
      await writeLocalSessionPriority(db.prisma, request, WRITTEN_AT),
      written
    );

    // Before the upload is acked, the retry leaves it queued…
    assert.deepEqual(await retryAndRead(), {
      priority: Priority.High,
      updatedAt: WRITTEN_AT,
      pending: 1,
    });
    // …and after, it re-arms nothing.
    await settlePriorityUploads(db.prisma, [
      { sessionId: SESSION_ID, priority: Priority.High, branches: [] },
    ]);
    assert.deepEqual(await retryAndRead(), {
      priority: Priority.High,
      updatedAt: WRITTEN_AT,
      pending: 0,
    });
  } finally {
    await cleanup();
  }
});

test("ISS-11197: a same-value branch retry, of a set or a clear, succeeds and writes nothing", async () => {
  const { db, cleanup } = await openDb();
  try {
    await db.importer.importSession(pushingSession(), "claude");
    await setSessionUpdatedAt(db, SESSION_ID, IMPORTED_AT);
    const set = { id: BRANCH_ID, priority: Priority.Urgent };
    const clear = { id: BRANCH_ID, priority: null };
    const readState = async () => ({
      priorities: await readBranchPriorities(db),
      pending: (await readUploadMarkers(db)).branches,
      updatedAt: (await readSession(db, SESSION_ID)).updated_at,
    });
    await writeLocalBranchPriority(
      db.prisma,
      { ...set, expectedPriority: null },
      WRITTEN_AT
    );

    const setRetried = await writeLocalBranchPriority(
      db.prisma,
      { ...set, expectedPriority: null },
      LATER_WRITTEN_AT
    );
    assert.deepEqual(setRetried, {
      status: LocalPriorityWriteStatus.Written,
      priority: Priority.Urgent,
    });
    assert.deepEqual(await readState(), {
      priorities: [Priority.Urgent],
      pending: [1],
      updatedAt: WRITTEN_AT,
    });

    await writeLocalBranchPriority(
      db.prisma,
      { ...clear, expectedPriority: Priority.Urgent },
      LATER_WRITTEN_AT
    );
    // The clear's retry still expects URGENT; the stored value is its own null.
    const clearRetried = await writeLocalBranchPriority(
      db.prisma,
      { ...clear, expectedPriority: Priority.Urgent },
      "2026-09-22T15:00:00.000Z"
    );
    assert.deepEqual(clearRetried, {
      status: LocalPriorityWriteStatus.Written,
      priority: null,
    });
    assert.deepEqual(await readState(), {
      priorities: [null],
      pending: [1],
      updatedAt: LATER_WRITTEN_AT,
    });
  } finally {
    await cleanup();
  }
});

// Review follow-up (tamsinb, PR #7926): `stored` is the first non-null row
// by lastSeenAt, so a same-value retry is judged against that row only. A
// second artifact row of the same identity that has not yet converged — a
// worktree imported after the first write, still at its priority default —
// is not itself compared, but the pre-existing "every row must agree" write
// still runs against it, because it differs from the request.
test("ISS-11197: a same-value branch retry still converges a divergent row of the same identity", async () => {
  const { db, cleanup } = await openDb();
  try {
    await db.importer.importSession(pushingSession(), "claude");
    await setSessionUpdatedAt(db, SESSION_ID, IMPORTED_AT);
    const request = {
      id: BRANCH_ID,
      priority: Priority.Urgent,
      expectedPriority: null,
    };
    await writeLocalBranchPriority(db.prisma, request, WRITTEN_AT);

    // A second row of the same identity, imported after the first write and
    // still at its own import default of no priority.
    await db.run(
      `INSERT INTO artifacts (id, identity_key, kind, repo_full_name, branch_name, created_at, last_seen_at)
       VALUES ('iss11197-divergent-row', 'iss11197-divergent-identity', 'branch', $1, $2, $3, $3)`,
      REPO,
      BRANCH,
      LATER_WRITTEN_AT
    );

    const retried = await writeLocalBranchPriority(
      db.prisma,
      request,
      LATER_WRITTEN_AT
    );
    assert.deepEqual(retried, {
      status: LocalPriorityWriteStatus.Written,
      priority: Priority.Urgent,
    });
    assert.deepEqual(await readBranchPriorities(db), [
      Priority.Urgent,
      Priority.Urgent,
    ]);
    assert.deepEqual((await readUploadMarkers(db)).branches, [1, 1]);
  } finally {
    await cleanup();
  }
});
