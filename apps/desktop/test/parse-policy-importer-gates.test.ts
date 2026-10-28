/**
 * ISS-12552 (PRD-800 "Rollout"): with the attribution parse policy off
 * the importer stores what it stored before PRD-800: no operation claims (and
 * a session's earlier claims are deleted), no token-event owner, and each
 * folded subagent tool call counted twice as a component invocation.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OperationReceiptOutcome } from "@repo/api/src/types/attribution-evidence";
import { ToolResultState } from "@repo/api/src/types/operation-claims";
import { afterEach, beforeEach, describe, test } from "vitest";
import {
  DATA_REVISION_BASE,
  dataRevisionFor,
} from "../src/main/collectors/engine/data-revision.js";
import {
  Harness,
  type NormalizedSession,
  type NormalizedToolUse,
} from "../src/main/collectors/types.js";
import { collectToolCandidates } from "../src/main/database/component-invocation-tool-candidates.js";
import type { SqliteAgentDatabase } from "../src/main/database/sqlite.js";
import {
  PARSE_POLICY_ATTRIBUTION,
  PARSE_POLICY_BASE,
} from "../src/main/parse-policy/parse-policy.js";
import { openTestDb } from "./agent-db-test-utils.js";
import { makePopulatedSession } from "./normalized-session-test-utils.js";

const SESSION_ID = "iss12552-policy-off-import";
const OPERATION_ID = "clop_01a14224-9b59-77ba-b518-16aaa9880991";

function claimedSession(): NormalizedSession {
  const write: NormalizedToolUse = {
    name: "mcp__closedloop__create-document-version",
    id: "toolu_write",
    timestamp: "2026-06-07T10:00:20.000Z",
    resultTimestamp: "2026-06-07T10:00:21.000Z",
    input: { documentId: "PLN-2191", content: "next" },
    output: "{}",
    resultState: ToolResultState.Present,
    closedloopResultFacts: {
      isError: false,
      operationReceipt: {
        operationId: OPERATION_ID,
        outcome: OperationReceiptOutcome.Committed,
      },
      nestedSlugs: [],
    },
  };
  return makePopulatedSession({
    sessionId: SESSION_ID,
    toolUses: [write],
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

describe("the importer with the attribution policy off", () => {
  let dir: string;
  let clock: string;
  let db: SqliteAgentDatabase;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "iss12552-policy-off-"));
    clock = "2026-06-07T12:00:00.000Z";
    db = await openTestDb(dir, { now: () => clock });
  });

  afterEach(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function claimRows(): Promise<number> {
    const rows = await db.prisma.client.$queryRawUnsafe<{ n: bigint }[]>(
      "SELECT COUNT(*) AS n FROM session_operation_claims WHERE session_id = $1",
      SESSION_ID
    );
    return Number(rows[0]?.n ?? 0);
  }

  async function owners(): Promise<(string | null)[]> {
    const rows = await db.prisma.client.$queryRawUnsafe<
      { agent_id: string | null }[]
    >(
      "SELECT agent_id FROM token_events WHERE session_id = $1 ORDER BY created_at",
      SESSION_ID
    );
    return rows.map((row) => row.agent_id);
  }

  async function updatedAt(): Promise<string | undefined> {
    const rows = await db.prisma.client.$queryRawUnsafe<
      { updated_at: string }[]
    >("SELECT updated_at FROM sessions WHERE id = $1", SESSION_ID);
    return rows[0]?.updated_at;
  }

  test("stores no claims and no token-event owner", async () => {
    await db.importer.importSession(
      claimedSession(),
      Harness.Claude,
      PARSE_POLICY_BASE
    );

    assert.equal(await claimRows(), 0);
    assert.deepEqual(await owners(), [null, null]);
  });

  test("an import under the policy off deletes earlier claims and re-sends the session", async () => {
    await db.importer.importSession(
      claimedSession(),
      Harness.Claude,
      PARSE_POLICY_ATTRIBUTION
    );
    assert.equal(await claimRows(), 1);
    assert.deepEqual(await owners(), [null, "agent-lane"]);
    const before = await updatedAt();

    clock = "2026-06-08T09:30:00.000Z";
    await db.importer.importSession(
      claimedSession(),
      Harness.Claude,
      PARSE_POLICY_BASE
    );

    assert.equal(await claimRows(), 0);
    assert.deepEqual(await owners(), [null, null]);
    assert.notEqual(await updatedAt(), before);
  });

  test("a rebuild under the policy off clears the claims and stamps the base revision", async () => {
    await db.importer.importSession(
      claimedSession(),
      Harness.Claude,
      PARSE_POLICY_ATTRIBUTION
    );
    await db.prisma.client.$queryRawUnsafe("SELECT 1");

    const result = await db.rebuildSessionFromParse(
      claimedSession(),
      Harness.Claude,
      null,
      PARSE_POLICY_BASE
    );

    assert.equal(result.rebuilt, true);
    assert.equal(await claimRows(), 0);
    const [row] = await db.prisma.client.$queryRawUnsafe<
      { data_revision: number }[]
    >("SELECT data_revision FROM sessions WHERE id = $1", SESSION_ID);
    assert.equal(Number(row?.data_revision), DATA_REVISION_BASE);
    assert.notEqual(
      DATA_REVISION_BASE,
      dataRevisionFor(PARSE_POLICY_ATTRIBUTION)
    );
  });

  test("the repair tail's stamp under the policy off clears claims and owners (no transcript left)", async () => {
    await db.importer.importSession(
      claimedSession(),
      Harness.Claude,
      PARSE_POLICY_ATTRIBUTION
    );
    assert.equal(await claimRows(), 1);

    const result = await db.rebuildComponentInvocationsFromStoredRows(
      SESSION_ID,
      DATA_REVISION_BASE,
      PARSE_POLICY_BASE
    );

    assert.equal(result.rebuilt, true);
    assert.equal(result.needsResync, true);
    assert.equal(await claimRows(), 0);
    assert.deepEqual(await owners(), [null, null]);
  });
});

describe("the folded subagent dedupe with the attribution policy off", () => {
  test("counts each folded subagent call twice, as before PRD-800", () => {
    const call: NormalizedToolUse = {
      name: "exec_command",
      timestamp: "2026-06-07T10:00:10.000Z",
      input: { cmd: "ls" },
      subagentId: "child",
    };
    const session = makePopulatedSession({
      sessionId: "folded",
      toolUses: [{ ...call }],
      subagents: [{ id: "child", name: "child", toolUses: [{ ...call }] }],
    });

    const on = collectToolCandidates(
      session,
      (toolUse) => toolUse,
      PARSE_POLICY_ATTRIBUTION
    );
    const off = collectToolCandidates(
      session,
      (toolUse) => toolUse,
      PARSE_POLICY_BASE
    );

    assert.equal(on.length, 1);
    assert.equal(off.length, 2);
  });
});
