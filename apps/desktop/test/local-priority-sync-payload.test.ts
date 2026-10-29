/**
 * @file local-priority-sync-payload.test.ts
 * @description ISS-10332 / PLN-2086 Milestone 3 steps 17-19 — the desktop half
 * of the upload: a locally set priority rides the session payload and the
 * session's branch ref, and "no priority" is OMITTED from the wire, never sent
 * as a claim.
 *
 * Driven through the real SQLite → `hydrateSyncCandidates` →
 * `prepareAgentSessionPayload` path, so the SQL projection, the head
 * projection and the egress sanitizer are all the ones that ship. The cloud
 * half — the boundary schema and the seed-if-unset write — is pinned in
 * apps/api.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { encodeBranchId } from "@repo/api/src/types/branch";
import { Priority } from "@repo/api/src/types/common";
import { ArtifactRefTargetKind } from "@repo/api/src/types/session-artifact-link";
import { test } from "vitest";
import { hydrateSyncCandidates } from "../src/main/agent-sync/agent-session-hydration-budget.js";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import { prepareAgentSessionPayload } from "../src/main/agent-sync/agent-session-sync-payload.js";
import {
  writeLocalBranchPriority,
  writeLocalSessionPriority,
} from "../src/main/database/local-priority-store.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { makeSession } from "./normalized-session-test-utils.js";

type Db = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

const REPO = "owner/repo";
const BRANCH = "feat/iss-10332-upload";
const SESSION_ID = "iss10332-upload-session";
const IMPORTED_AT = "2026-09-22T12:00:00.000Z";
const WRITTEN_AT = "2026-09-22T13:00:00.000Z";
const MAX_PAYLOAD_BYTES = 256 * 1024;

async function withPushedSession(
  run: (db: Db) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss10332-upload-"));
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

/** The session exactly as the sync lane would send it. */
async function wirePayload(db: Db): Promise<SyncedAgentSession> {
  const {
    sessions: [session],
  } = await hydrateSyncCandidates(db.syncSource, [SESSION_ID], {
    attributionByCwd: new Map(),
    launchMetadataRootByCwd: new Map(),
    repoFullNameByPath: new Map(),
  });
  if (!session) {
    throw new Error("session did not hydrate");
  }
  const prepared = prepareAgentSessionPayload(session, MAX_PAYLOAD_BYTES);
  if (prepared.kind !== "session") {
    throw new Error(`expected one whole session payload, got ${prepared.kind}`);
  }
  return prepared.session;
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

test("ISS-10332: a locally set priority rides the session and its branch ref", async () => {
  await withPushedSession(async (db) => {
    await writeLocalSessionPriority(
      db.prisma,
      { id: SESSION_ID, priority: Priority.Urgent },
      WRITTEN_AT
    );
    await writeLocalBranchPriority(
      db.prisma,
      {
        id: encodeBranchId({ repoFullName: REPO, branchName: BRANCH }),
        priority: Priority.High,
      },
      WRITTEN_AT
    );

    const session = await wirePayload(db);
    assert.equal(session.priority, Priority.Urgent);
    assert.equal(branchRef(session).priority, Priority.High);
  });
});

test("ISS-10332: no priority is omitted from the wire", async () => {
  await withPushedSession(async (db) => {
    // Never set: the stored NULL is "no priority", which the payload omits.
    const unset = await wirePayload(db);
    assert.equal(Object.hasOwn(unset, "priority"), false);
    assert.equal(Object.hasOwn(branchRef(unset), "priority"), false);
  });
});
