/**
 * ISS-5255: what real SQLite has to prove about an invocation import that a
 * stub or a pure-function test cannot.
 *
 * These two tests replace a 25,001-tool-use fixture that cost a measured 150s
 * (387s on a slow host, past its own 180s timeout) purely to trip the wire item
 * cap, and which took the whole `test:node` runner past its 720s wall-clock cap
 * during the Desktop v0.16.1087 release. The cap DECISION is a pure function of
 * the generation and is covered in `invocation-sync-parts-builder.test.ts`.
 *
 * What is left needs a database:
 *
 * 1. The local projection has to survive more than one insert chunk. The row
 *    writer batches at 30 rows and every other desktop DB test imports 1-5
 *    invocations, so without this the multi-chunk loop runs in no test at all.
 * 2. A local error has to actually land as a dead-lettered outbox ROW. That
 *    INSERT is a distinct statement from the decision that selects it, and it is
 *    driven here by the cheapest reachable local error rather than 25,001 rows.
 *
 * They live in a sibling suite rather than in
 * `component-invocations-materialization.test.ts` because that file is
 * grandfathered shrink-only (see `apps/desktop/test/AGENTS.md`).
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_MAX_ITEM_BYTES,
  AgentComponentInvocationKind,
} from "@repo/api/src/types/agent-component-invocation";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
  AgentComponentInvocationSyncLocalError,
} from "../src/main/agent-sync/agent-component-invocation-sync-constants.js";
import { INVOCATION_ROWS_PER_CHUNK } from "../src/main/database/component-invocation-row-writer.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { OutboxStatus } from "../src/shared/sync-lane-contract.js";
import { makeSession } from "./normalized-session-test-utils.js";

const NOW = "2026-07-22T17:00:00.000Z";
/* Derived from the writer's real chunk width, not a copied literal: a fixture
   pinned at 65 would silently stop spanning chunks if the width ever grew past
   it, and this test would keep passing without exercising the loop it guards
   (Codex review on #4448). Two full chunks plus a partial third. */
const MULTI_CHUNK_INVOCATIONS = INVOCATION_ROWS_PER_CHUNK * 2 + 5;
/** The tool every multi-chunk fixture row invokes. */
const TOOL_COMPONENT_KEY = "Read";

type Db = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

function openDb(dir: string): Promise<Db> {
  return openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.sqlite"),
    detectBillingMode: () => "metered_api",
    now: () => NOW,
  });
}

async function invocationCount(db: Db, sessionId: string): Promise<number> {
  const rows = await db.prisma.client.$queryRawUnsafe<{ n: number }[]>(
    "SELECT COUNT(*) AS n FROM agent_component_invocations WHERE session_id = $1",
    sessionId
  );
  return Number(rows[0]?.n ?? 0);
}

function readOutbox(
  db: Db,
  sessionId: string
): Promise<
  { status: string; last_error: string | null; part_count: number }[]
> {
  return db.prisma.client.$queryRawUnsafe(
    `SELECT status, last_error, part_count
       FROM agent_component_invocation_sync_outbox
      WHERE source_key = $1 AND external_session_id = $2`,
    AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
    sessionId
  );
}

describe("ISS-5255 invocation local projection against real SQLite", () => {
  test("a multi-chunk session projects every invocation and rolls the usage up", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aci-multi-chunk-"));
    const db = await openDb(dir);
    try {
      const sessionId = "session-multi-chunk";
      const result = await db.importer.importSession(
        makeSession({
          sessionId,
          startedAt: NOW,
          endedAt: "2026-07-22T17:05:00.000Z",
          toolUses: Array.from(
            { length: MULTI_CHUNK_INVOCATIONS },
            (_, index) => ({
              id: `toolu_multi_chunk_${index}`,
              name: TOOL_COMPONENT_KEY,
              timestamp: `2026-07-22T17:00:${String(index % 60).padStart(2, "0")}.000Z`,
            })
          ),
        }),
        "claude"
      );

      assert.equal(result.incomplete, undefined);
      // A dropped chunk shows up here as a short count.
      assert.equal(
        await invocationCount(db, sessionId),
        MULTI_CHUNK_INVOCATIONS
      );
      const usage = await db.prisma.client.$queryRawUnsafe<
        { invocations: number }[]
      >(
        `SELECT invocations FROM agent_component_session_usage
          WHERE session_id = $1 AND component_kind = $2
            AND component_key = $3`,
        sessionId,
        AgentComponentInvocationKind.Tool,
        TOOL_COMPONENT_KEY
      );
      assert.equal(Number(usage[0]?.invocations), MULTI_CHUNK_INVOCATIONS);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a generation the wire contract rejects is dead-lettered while the local projection survives", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aci-wire-dead-letter-"));
    const db = await openDb(dir);
    try {
      const sessionId = "session-wire-dead-letter";
      // One tool whose name alone exceeds the per-item wire byte cap. Definition
      // content is stripped before that check, so an oversized component key is
      // the cheapest input that reaches the local dead-letter branch.
      const oversizedToolName = "K".repeat(
        AGENT_COMPONENT_INVOCATION_SYNC_MAX_ITEM_BYTES + 1
      );
      const result = await db.importer.importSession(
        makeSession({
          sessionId,
          startedAt: NOW,
          endedAt: "2026-07-22T17:05:00.000Z",
          toolUses: [
            { id: "toolu_oversized", name: oversizedToolName, timestamp: NOW },
          ],
        }),
        "claude"
      );

      assert.equal(result.incomplete, undefined);
      // The wire rejection must not cost the user their local row.
      assert.equal(await invocationCount(db, sessionId), 1);
      assert.deepEqual(await readOutbox(db, sessionId), [
        {
          status: OutboxStatus.DeadLettered,
          last_error:
            AgentComponentInvocationSyncLocalError.GenerationWireLimitExceeded,
          part_count: 1,
        },
      ]);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
