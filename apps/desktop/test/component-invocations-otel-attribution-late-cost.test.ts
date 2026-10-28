/**
 * @file component-invocations-otel-attribution-late-cost.test.ts
 * @description ISS-10720 (codex P1 on #7731): the attribution join reaches the
 * NORMAL ordering — a cost export that lands AFTER the transcript imported.
 *
 * The sibling wiring suite imports, then stores a counter, then imports AGAIN.
 * That second import is what made the join fire there, and nothing in
 * production performs it: `invocation-sync-canonicalization-repair.ts` states
 * outright that nothing re-derives an already-imported session, and
 * `session-authoritative-cost.ts` states that cost arriving after the import is
 * the normal order. So this suite imports ONCE and then persists the counter
 * through the production `claudeCodeOtel.persistSignals` facade, with no second
 * import anywhere, and asserts the stored row carries the harness attribution.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AgentComponentInvocationAttributionSource,
  AgentComponentInvocationEvidenceClass,
} from "@repo/api/src/types/agent-component-invocation";
import { describe, test } from "vitest";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { ClaudeCodeOtelSignalType } from "../src/main/otel/claude-code-otel-signal-contract.js";
import { makeSession } from "./normalized-session-test-utils.js";

const NOW = "2026-09-21T17:00:00.000Z";
const INVOKED_AT = "2026-09-21T17:00:01.000Z";
const SESSION_ID = "session-otel-late-cost";
/** The command the harness's late counter names. */
const ATTRIBUTED = "/deploy";
/** A sibling command in the SAME session that no counter names. */
const UNATTRIBUTED = "/rollback";

type Db = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

function twoCommandSession(): ReturnType<typeof makeSession> {
  return makeSession({
    sessionId: SESSION_ID,
    startedAt: NOW,
    endedAt: "2026-09-21T17:05:00.000Z",
    messages: [
      { role: "human", timestamp: INVOKED_AT, text: ATTRIBUTED },
      { role: "human", timestamp: INVOKED_AT, text: UNATTRIBUTED },
    ],
    slashCommands: [
      { name: ATTRIBUTED, timestamp: INVOKED_AT },
      { name: UNATTRIBUTED, timestamp: INVOKED_AT },
    ],
  });
}

type StoredAxes = { evidenceClass: string; attributionSource: string | null };

function axesByKey(db: Db): Promise<Record<string, StoredAxes>> {
  return db.prisma.client
    .$queryRawUnsafe<
      {
        component_key: string;
        evidence_class: string;
        attribution_source: string | null;
      }[]
    >(
      `SELECT component_key, evidence_class, attribution_source
         FROM agent_component_invocations
        WHERE session_id = $1
        ORDER BY component_key`,
      SESSION_ID
    )
    .then((rows) =>
      Object.fromEntries(
        rows.map((row) => [
          row.component_key,
          {
            evidenceClass: row.evidence_class,
            attributionSource: row.attribution_source,
          },
        ])
      )
    );
}

function outboxGenerationIds(db: Db): Promise<string[]> {
  return db.prisma.client
    .$queryRawUnsafe<{ external_generation_id: string }[]>(
      `SELECT external_generation_id
         FROM agent_component_invocation_sync_outbox
        WHERE external_session_id = $1`,
      SESSION_ID
    )
    .then((rows) => rows.map((row) => row.external_generation_id));
}

async function withDb(body: (db: Db) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aci-otel-late-cost-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.sqlite"),
    detectBillingMode: () => "metered_api",
    now: () => NOW,
  });
  try {
    await body(db);
  } finally {
    await db.close();
    await rm(dir, { force: true, recursive: true });
  }
}

function lateCostSignal(skillName: string) {
  return {
    type: ClaudeCodeOtelSignalType.CostUsage,
    sessionId: SESSION_ID,
    model: "claude-opus-4",
    observedAt: INVOKED_AT,
    costUsd: 0.25,
    skillName,
  };
}

describe("ISS-10720 late-arriving OTel cost reaches the stored invocation", () => {
  test("a cost export after the import stamps the row it names, with no re-import", async () => {
    await withDb(async (db) => {
      await db.importer.importSession(twoCommandSession(), "claude");
      const beforeCost = await axesByKey(db);
      assert.equal(beforeCost[ATTRIBUTED].attributionSource, null);
      const generationsBefore = await outboxGenerationIds(db);

      const summary = await db.claudeCodeOtel.persistSignals([
        lateCostSignal("deploy"),
      ]);
      assert.deepEqual(summary, { accepted: 1, rejected: 0 });

      const afterCost = await axesByKey(db);
      assert.equal(
        afterCost[ATTRIBUTED].attributionSource,
        AgentComponentInvocationAttributionSource.HarnessOtel,
        "the counter arrived after the only import, which is the normal order"
      );
      // This fixture's command has no definition file, so the row carries no
      // definition evidence — the one case where the class may move.
      assert.equal(
        afterCost[ATTRIBUTED].evidenceClass,
        AgentComponentInvocationEvidenceClass.OtelCounter
      );
      // The sibling proves the refresh is scoped to the name the counter
      // stamped, not applied to every row of a session that captured anything.
      assert.deepEqual(afterCost[UNATTRIBUTED], beforeCost[UNATTRIBUTED]);
      // The stamp has to reach the cloud, which it only does through a NEW
      // generation — a row updated in place with the old generation still
      // queued is a change no reader ever sees.
      const generationsAfter = await outboxGenerationIds(db);
      assert.notDeepEqual(generationsAfter, generationsBefore);
    });
  });

  test("a cost export naming nothing this session holds writes nothing", async () => {
    await withDb(async (db) => {
      await db.importer.importSession(twoCommandSession(), "claude");
      const beforeCost = await axesByKey(db);
      const generationsBefore = await outboxGenerationIds(db);

      await db.claudeCodeOtel.persistSignals([lateCostSignal("not-a-command")]);

      assert.deepEqual(await axesByKey(db), beforeCost);
      // No row moved, so no generation may be enqueued: a re-enqueue per cost
      // batch would amplify sync volume on every session that captures OTel.
      assert.deepEqual(await outboxGenerationIds(db), generationsBefore);
    });
  });
});
