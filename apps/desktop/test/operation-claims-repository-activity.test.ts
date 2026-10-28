/**
 * @file operation-claims-repository-activity.test.ts
 * @description ISS-12552 (PRD-800): the production
 * importer runs the write-to-commit join on the Desktop and keeps only its
 * per-branch result: the branch and its request keys. No file path is stored
 * in the session's claims or reaches the sync payload, at any data-sync level
 * (Daveth Oakhurst, 2026-10-20).
 */
import "./support/attribution-parse-policy.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import {
  type OperationClaim,
  OperationClaimSource,
} from "@repo/api/src/types/operation-claims";
import { afterEach, beforeEach, describe, test } from "vitest";
import { inProcessAgentSessionPayloadPreparer } from "../src/main/agent-sync/agent-session-payload-preparation.js";
import type { PreparedAgentSessionPayload } from "../src/main/agent-sync/agent-session-sync-payload.js";
import type { SqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { dataSyncLevelToMetadataContentPolicy } from "../src/shared/data-sync-level.js";
import { openTestDb } from "./agent-db-test-utils.js";
import { emptyAttributionCache } from "./attribution-test-helpers.js";
import { makePopulatedSession } from "./normalized-session-test-utils.js";

const SESSION_ID = "iss12552-repository-activity";
const CLOCK = "2026-06-07T12:00:00.000Z";
const WRITTEN_FILE = "/repo/src/strength-meter.ts";
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

function session() {
  return makePopulatedSession({
    sessionId: SESSION_ID,
    toolUses: [
      {
        name: "Write",
        id: "toolu_write",
        timestamp: "2026-06-07T10:00:10.000Z",
        input: { file_path: WRITTEN_FILE, content: "a" },
        output: "File created",
        requestKey: "req-write",
      },
      {
        name: "Bash",
        id: "toolu_commit",
        timestamp: "2026-06-07T10:00:20.000Z",
        input: { command: "git commit -m add" },
        output:
          "[feat/x abc1234] add\n 1 file changed, 1 insertion(+)\n create mode 100644 src/strength-meter.ts\n",
        requestKey: "req-commit",
      },
      {
        name: "Bash",
        id: "toolu_push",
        timestamp: "2026-06-07T10:00:30.000Z",
        input: { command: "git push -u origin feat/x" },
        output: "branch 'feat/x' set up to track 'origin/feat/x'.\n",
      },
    ],
  });
}

describe("ISS-12552 implementation join on import", () => {
  let dir: string;
  let db: SqliteAgentDatabase;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "iss12552-activity-"));
    db = await openTestDb(dir, { now: () => CLOCK });
  });

  afterEach(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("stores one join claim per branch with its requests, and no file path", async () => {
    await db.importer.importSession(session(), "claude");

    const [row] = await db.prisma.client.$queryRawUnsafe<{ claims: string }[]>(
      "SELECT claims FROM session_operation_claims WHERE session_id = $1",
      SESSION_ID
    );
    const claims: OperationClaim[] = JSON.parse(row?.claims ?? "[]");

    assert.deepEqual(
      claims.filter(
        (claim) => claim.source === OperationClaimSource.ImplementationJoin
      ),
      [
        {
          claimKey: "claude:implementation:feat/x",
          source: OperationClaimSource.ImplementationJoin,
          branch: "feat/x",
          requestKeys: ["req-commit", "req-write"],
        },
      ]
    );
    assert.equal(row?.claims.includes("strength-meter.ts"), false);
  });

  test("syncs the same evidence, with no file path, at the full and the metadata data-sync level", async () => {
    await db.importer.importSession(session(), "claude");
    const [synced] = await db.syncSource.loadSyncedSessions(
      [SESSION_ID],
      emptyAttributionCache()
    );
    assert.ok(synced);

    const wire = async (level: DataSyncLevel) => {
      const [prepared] = await inProcessAgentSessionPayloadPreparer(
        [synced],
        MAX_PAYLOAD_BYTES,
        false,
        false,
        dataSyncLevelToMetadataContentPolicy(level),
        false
      );
      assert.equal(prepared?.kind, "session");
      return shippedSession(prepared);
    };
    const full = await wire(DataSyncLevel.Full);
    const metadata = await wire(DataSyncLevel.Metadata);

    assert.equal(JSON.stringify(full).includes("strength-meter.ts"), false);
    assert.equal(JSON.stringify(metadata).includes("strength-meter.ts"), false);
    assert.deepEqual(metadata.operationEvidence, full.operationEvidence);
    assert.ok(
      full.operationEvidence?.claims.some(
        (claim) => claim.source === OperationClaimSource.ImplementationJoin
      )
    );
  });
});

/** The one session a single-part payload ships; a chunked one is not expected here. */
function shippedSession(prepared: PreparedAgentSessionPayload | undefined) {
  if (prepared?.kind !== "session") {
    throw new Error(`expected one unchunked session, got ${prepared?.kind}`);
  }
  return prepared.session;
}
