/**
 * @file operation-claims-import.test.ts
 * @description ISS-12552: the production importer stores a
 * session's operation claims, stamps each token event with its agent, and
 * re-enqueues the session for sync when only its claims changed.
 */
import "./support/attribution-parse-policy.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  OperationKind,
  OperationReceiptOutcome,
} from "@repo/api/src/types/attribution-evidence";
import {
  OPERATION_EVIDENCE_EXTRACTOR_VERSION,
  type OperationClaim,
  ToolResultState,
} from "@repo/api/src/types/operation-claims";
import { afterEach, beforeEach, describe, test } from "vitest";
import type {
  NormalizedSession,
  NormalizedToolUse,
} from "../src/main/collectors/types.js";
import type { SqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { openTestDb } from "./agent-db-test-utils.js";
import { emptyAttributionCache } from "./attribution-test-helpers.js";
import { makePopulatedSession } from "./normalized-session-test-utils.js";

const SESSION_ID = "iss12552-operation-claims";
const IMPORT_CLOCK = "2026-06-07T12:00:00.000Z";
const REIMPORT_CLOCK = "2026-06-08T09:30:00.000Z";
const OPERATION_ID = "clop_01a14224-9b59-77ba-b518-16aaa9880991";
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

function writeTool(withReceipt: boolean): NormalizedToolUse {
  return {
    name: "mcp__closedloop__create-document-version",
    id: "toolu_write",
    timestamp: "2026-06-07T10:00:20.000Z",
    resultTimestamp: "2026-06-07T10:00:21.000Z",
    input: { documentId: "PLN-2191", content: "next" },
    output: "{}",
    resultState: ToolResultState.Present,
    closedloopResultFacts: {
      isError: false,
      ...(withReceipt
        ? {
            operationReceipt: {
              operationId: OPERATION_ID,
              outcome: OperationReceiptOutcome.Committed,
            },
          }
        : {}),
      nestedSlugs: [],
    },
  };
}

function session(withReceipt: boolean): NormalizedSession {
  return makePopulatedSession({
    sessionId: SESSION_ID,
    toolUses: [writeTool(withReceipt)],
    tokenSeries: [
      {
        timestamp: "2026-06-07T10:00:30.000Z",
        model: "claude-sonnet-4-5",
        input: 60,
        output: 30,
        cacheRead: 6,
        cacheWrite: 3,
      },
      {
        timestamp: "2026-06-07T10:00:40.000Z",
        model: "claude-sonnet-4-5",
        input: 40,
        output: 20,
        cacheRead: 4,
        cacheWrite: 2,
        subagentId: "agent-lane",
      },
    ],
  });
}

describe("ISS-12552 operation claims on import", () => {
  let dir: string;
  let clock: string;
  let db: SqliteAgentDatabase;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "iss12552-claims-"));
    clock = IMPORT_CLOCK;
    db = await openTestDb(dir, { now: () => clock });
  });

  afterEach(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function storedClaims() {
    const rows = await db.prisma.client.$queryRawUnsafe<
      { extractor_version: number; claims: string; coverage: string }[]
    >(
      "SELECT extractor_version, claims, coverage FROM session_operation_claims WHERE session_id = $1",
      SESSION_ID
    );
    return rows;
  }

  async function updatedAt(): Promise<string> {
    const [row] = await db.prisma.client.$queryRawUnsafe<
      { updated_at: string }[]
    >("SELECT updated_at FROM sessions WHERE id = $1", SESSION_ID);
    return row.updated_at;
  }

  test("stores the session's claims and each token event's agent", async () => {
    await db.importer.importSession(session(true), "claude");

    const [row] = await storedClaims();
    assert.equal(
      Number(row?.extractor_version),
      OPERATION_EVIDENCE_EXTRACTOR_VERSION
    );
    const claims: OperationClaim[] = JSON.parse(row?.claims ?? "[]");
    assert.deepEqual(
      claims.map((claim) => [
        claim.claimKey,
        claim.operationKind,
        claim.operationIds,
      ]),
      [["claude:toolu_write", OperationKind.CreateVersion, [OPERATION_ID]]]
    );
    assert.equal(JSON.parse(row?.coverage ?? "{}").closedloopMcpCalls, 1);
    const agents = await db.prisma.client.$queryRawUnsafe<
      { agent_id: string | null }[]
    >(
      "SELECT agent_id FROM token_events WHERE session_id = $1 ORDER BY created_at",
      SESSION_ID
    );
    assert.deepEqual(
      agents.map((event) => event.agent_id),
      [null, "agent-lane"]
    );
  });

  test("re-enqueues the session when only its claims changed, and not otherwise", async () => {
    await db.importer.importSession(session(false), "claude");
    const imported = await updatedAt();

    clock = REIMPORT_CLOCK;
    await db.importer.importSession(session(false), "claude");
    assert.equal(
      await updatedAt(),
      imported,
      "an unchanged re-import must not re-enqueue the session"
    );

    await db.importer.importSession(session(true), "claude");
    assert.equal(
      await updatedAt(),
      REIMPORT_CLOCK,
      "a claims-only change must advance the sync watermark"
    );
    const [row] = await storedClaims();
    assert.ok(row?.claims.includes(OPERATION_ID));
  });

  test("sends the stored evidence with the session's sync payload", async () => {
    await db.importer.importSession(session(true), "claude");

    const [synced] = await db.syncSource.loadSyncedSessions(
      [SESSION_ID],
      emptyAttributionCache()
    );

    assert.equal(
      synced?.operationEvidence?.extractorVersion,
      OPERATION_EVIDENCE_EXTRACTOR_VERSION
    );
    assert.deepEqual(
      synced?.operationEvidence?.claims.map((claim) => claim.claimKey),
      ["claude:toolu_write"]
    );
    assert.match(synced?.operationEvidence?.digest ?? "", SHA256_HEX_RE);
  });

  test("omits the field for a session with no stored evidence", async () => {
    await db.importer.importSession(session(false), "claude");
    await db.run(
      "DELETE FROM session_operation_claims WHERE session_id = $1",
      SESSION_ID
    );

    const [synced] = await db.syncSource.loadSyncedSessions(
      [SESSION_ID],
      emptyAttributionCache()
    );

    assert.equal(synced ? "operationEvidence" in synced : true, false);
  });
});
