/**
 * @file local-priority-upload-settlement.test.ts
 * @description ISS-10332 review (PR #7794): a locally set priority is sent to
 * the cloud until a sync the cloud CONFIRMED has carried it, and not after.
 *
 * The cloud adopts a synced priority only while it holds none, and a clear on
 * the web leaves it holding none, so a desktop that kept sending its value would
 * undo that clear on every re-sync. Driven through the real SQLite store and the
 * real sync lane (`AgentSessionSyncService`) with a fake transport, so the
 * upload read, the payload, the ack and the settle are the ones that ship.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { encodeBranchId } from "@repo/api/src/types/branch";
import { Priority } from "@repo/api/src/types/common";
import { ArtifactRefTargetKind } from "@repo/api/src/types/session-artifact-link";
import { test } from "vitest";
import type {
  AgentSessionSyncTransportPayload,
  SyncedAgentSession,
} from "../src/main/agent-sync/agent-session-sync-contract.js";
import { AgentSessionSyncService } from "../src/main/agent-sync/agent-session-sync-service.js";
import type { DesktopAgentSessionsAck } from "../src/main/cloud/cloud-protocol.js";
import {
  writeLocalBranchPriority,
  writeLocalSessionPriority,
} from "../src/main/database/local-priority-store.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import {
  pumpSyncDrainTurn,
  settleSelfContinuedDrain,
} from "./agent-session-sync-service-fixtures.js";
import { makeSession } from "./normalized-session-test-utils.js";

type Db = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;
type SendBatch = (
  batch: AgentSessionSyncTransportPayload
) => Promise<DesktopAgentSessionsAck>;

const REPO = "owner/repo";
const BRANCH = "feat/iss-10332-settle";
const BRANCH_ID = encodeBranchId({ repoFullName: REPO, branchName: BRANCH });
const SESSION_ID = "iss10332-settle-session";
const COMPUTE_TARGET_ID = "compute-target-iss10332-settle";
const IMPORTED_AT = "2026-09-22T12:00:00.000Z";
const WRITTEN_AT = "2026-09-22T13:00:00.000Z";
const EDITED_AT = "2026-09-22T14:00:00.000Z";
const RESYNC_AT = "2026-09-22T15:00:00.000Z";
const MAX_POST_TURNS = 200;

async function withPushedSession(
  run: (db: Db) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss10332-settle-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.sqlite"),
    detectBillingMode: () => "metered_api",
    now: () => IMPORTED_AT,
  });
  try {
    await db.importer.importSession(
      makeSession({
        sessionId: SESSION_ID,
        artifacts: { prs: [], issues: [], repo: REPO },
        toolUses: [
          {
            name: "Bash",
            timestamp: IMPORTED_AT,
            input: { command: `git push -u origin ${BRANCH}` },
          },
        ],
      }),
      "claude"
    );
    await run(db);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function setPriorities(
  db: Db,
  session: Priority,
  branch: Priority,
  writtenAt: string
): Promise<void> {
  await writeLocalSessionPriority(
    db.prisma,
    { id: SESSION_ID, priority: session },
    writtenAt
  );
  await writeLocalBranchPriority(
    db.prisma,
    { id: BRANCH_ID, priority: branch },
    writtenAt
  );
}

function syncService(db: Db, sendBatch: SendBatch) {
  const posted: AgentSessionSyncTransportPayload[] = [];
  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => db.syncSource,
    getSyncComputeTargetId: () => COMPUTE_TARGET_ID,
    sendBatch: (batch) => {
      posted.push(batch);
      return sendBatch(batch);
    },
  });
  return { service, posted };
}

/** Run the lane until the queue is caught up (every POST accepted). */
async function drainToCaughtUp(
  db: Db,
  sendBatch: SendBatch
): Promise<AgentSessionSyncTransportPayload[]> {
  const { service, posted } = syncService(db, sendBatch);
  service.start();
  try {
    await settleSelfContinuedDrain(service);
  } finally {
    service.stop();
  }
  return posted;
}

/** Run the lane through exactly its first POST and that pass's ack handling. */
async function firstPostOnly(
  db: Db,
  sendBatch: SendBatch
): Promise<AgentSessionSyncTransportPayload[]> {
  const { service, posted } = syncService(db, sendBatch);
  service.start();
  try {
    for (let turn = 0; turn < MAX_POST_TURNS && posted.length === 0; turn++) {
      await pumpSyncDrainTurn();
    }
    await service.whenSessionSyncSettled();
  } finally {
    service.stop();
  }
  if (posted.length !== 1) {
    throw new Error(`expected exactly one POST, got ${posted.length}`);
  }
  return posted;
}

function postedSession(
  posted: readonly AgentSessionSyncTransportPayload[]
): SyncedAgentSession {
  const sessions = posted.flatMap((batch) =>
    batch.sessions.filter((session) => session.externalSessionId === SESSION_ID)
  );
  const [session] = sessions;
  if (!session || sessions.length !== 1) {
    throw new Error(`the session rode ${sessions.length} POSTs, not one`);
  }
  return session;
}

function branchRef(session: SyncedAgentSession) {
  const ref = session.artifactRefs?.find(
    (candidate) =>
      candidate.kind === ArtifactRefTargetKind.Branch &&
      candidate.branchName === BRANCH
  );
  if (ref?.kind !== ArtifactRefTargetKind.Branch) {
    throw new Error("the pushed branch did not ride the payload as a ref");
  }
  return ref;
}

/** The wire priorities of the session and its branch ref; absent reads `undefined`. */
function sentPriorities(session: SyncedAgentSession) {
  return { session: session.priority, branch: branchRef(session).priority };
}

async function storedState(db: Db) {
  const [session] = await db.prisma.client.$queryRawUnsafe<
    { priority: string | null; pending: number }[]
  >(
    "SELECT priority, priority_upload_pending AS pending FROM sessions WHERE id = $1",
    SESSION_ID
  );
  const branches = await db.prisma.client.$queryRawUnsafe<
    { priority: string | null; pending: number }[]
  >(
    `SELECT priority, priority_upload_pending AS pending FROM artifacts
     WHERE kind = 'branch' AND repo_full_name = $1 AND branch_name = $2`,
    REPO,
    BRANCH
  );
  return {
    session: { priority: session?.priority, pending: Number(session?.pending) },
    branches: branches.map((row) => ({
      priority: row.priority,
      pending: Number(row.pending),
    })),
  };
}

/** A later local change to the session, so the lane selects it again. */
async function touchSession(db: Db): Promise<void> {
  await db.run(
    "UPDATE sessions SET updated_at = $1 WHERE id = $2",
    RESYNC_AT,
    SESSION_ID
  );
}

const accept: SendBatch = () => Promise.resolve({ accepted: true });

test("ISS-10332: once a sync the cloud confirmed carried the priorities, the next payload omits them", async () => {
  await withPushedSession(async (db) => {
    await setPriorities(db, Priority.Urgent, Priority.High, WRITTEN_AT);

    const first = postedSession(await drainToCaughtUp(db, accept));
    assert.deepEqual(sentPriorities(first), {
      session: Priority.Urgent,
      branch: Priority.High,
    });
    assert.deepEqual(await storedState(db), {
      session: { priority: Priority.Urgent, pending: 0 },
      branches: [{ priority: Priority.High, pending: 0 }],
    });

    await touchSession(db);
    const resent = postedSession(await drainToCaughtUp(db, accept));
    assert.deepEqual(sentPriorities(resent), {
      session: undefined,
      branch: undefined,
    });

    // A local read still serves the stored values whatever the marker says.
    const [local] = await db.syncSource.loadSyncedSessions([SESSION_ID], {
      attributionByCwd: new Map(),
      launchMetadataRootByCwd: new Map(),
      repoFullNameByPath: new Map(),
    });
    assert.ok(local, "the session must hydrate for a local read");
    assert.deepEqual(sentPriorities(local), {
      session: Priority.Urgent,
      branch: Priority.High,
    });
  });
});

test("ISS-10332: a sync that failed, or that the server did not confirm, keeps sending the priorities", async () => {
  await withPushedSession(async (db) => {
    await setPriorities(db, Priority.Urgent, Priority.High, WRITTEN_AT);
    const pending = {
      session: { priority: Priority.Urgent, pending: 1 },
      branches: [{ priority: Priority.High, pending: 1 }],
    };

    const thrown = await firstPostOnly(db, () =>
      Promise.reject(new Error("iss10332 transport down"))
    );
    assert.deepEqual(sentPriorities(postedSession(thrown)), {
      session: Priority.Urgent,
      branch: Priority.High,
    });
    assert.deepEqual(await storedState(db), pending);

    // Accepted, but the row-level echo does not name this session: the server
    // did not persist it, so the cloud has not seen the value either.
    const omitted = await firstPostOnly(db, () =>
      Promise.resolve({ accepted: true, acceptedSessionIds: [] })
    );
    assert.deepEqual(sentPriorities(postedSession(omitted)), {
      session: Priority.Urgent,
      branch: Priority.High,
    });
    assert.deepEqual(await storedState(db), pending);
  });
});

test("ISS-10332: a local edit made after the payload was built survives that payload's ack", async () => {
  await withPushedSession(async (db) => {
    await setPriorities(db, Priority.Urgent, Priority.High, WRITTEN_AT);

    const posted = await firstPostOnly(db, async () => {
      // The payload is already on the wire carrying URGENT / HIGH.
      await setPriorities(db, Priority.Low, Priority.Medium, EDITED_AT);
      return { accepted: true };
    });
    assert.deepEqual(sentPriorities(postedSession(posted)), {
      session: Priority.Urgent,
      branch: Priority.High,
    });
    assert.deepEqual(await storedState(db), {
      session: { priority: Priority.Low, pending: 1 },
      branches: [{ priority: Priority.Medium, pending: 1 }],
    });

    await touchSession(db);
    const next = postedSession(await drainToCaughtUp(db, accept));
    assert.deepEqual(sentPriorities(next), {
      session: Priority.Low,
      branch: Priority.Medium,
    });
  });
});
