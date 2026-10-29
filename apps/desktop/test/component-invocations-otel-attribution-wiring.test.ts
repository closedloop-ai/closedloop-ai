/**
 * @file component-invocations-otel-attribution-wiring.test.ts
 * @description ISS-10720: the OTel attribution join is reached from the
 * PRODUCTION import path (`importSession` → `materializeAgentComponentInvocations`)
 * and its result is what the stored row carries.
 *
 * The unit cases beside this one drive the join function directly, which proves
 * the join and nothing about whether anything calls it. This drives the real
 * importer against a real SQLite store, so deleting the call site reddens it.
 *
 * Its own file rather than an addition to
 * `component-invocations-materialization.test.ts`, which is grandfathered
 * shrink-only (root AGENTS.md → File Size and Organization).
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
import { ClaudeCodeAttributionSource } from "../src/main/otel/claude-code-otel-attribution.js";
import { makeSession } from "./normalized-session-test-utils.js";

const NOW = "2026-09-21T17:00:00.000Z";
const INVOKED_AT = "2026-09-21T17:00:01.000Z";
const SESSION_ID = "session-otel-attribution";
/** The command the harness's counter names. */
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

async function insertCostEvent(db: Db, skillName: string): Promise<void> {
  await db.prisma.write((client) =>
    client.$executeRawUnsafe(
      `INSERT INTO claude_code_cost_event
       (id, session_id, model, cost_usd, observed_at, attribution_key,
        attribution_source, skill_name, data_revision, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9)`,
      `cost-${skillName}`,
      SESSION_ID,
      "claude-opus-4",
      0.25,
      INVOKED_AT,
      `skill:${skillName}`,
      ClaudeCodeAttributionSource.HarnessOtel,
      skillName,
      NOW
    )
  );
}

/** A counter naming a SUBAGENT, the one column an unmatched tuple may seat on. */
async function insertAgentCostEvent(db: Db, agentName: string): Promise<void> {
  await db.prisma.write((client) =>
    client.$executeRawUnsafe(
      `INSERT INTO claude_code_cost_event
       (id, session_id, model, cost_usd, observed_at, attribution_key,
        attribution_source, agent_name, data_revision, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9)`,
      `cost-agent-${agentName}`,
      SESSION_ID,
      "claude-opus-4",
      0.5,
      INVOKED_AT,
      `agent:${agentName}`,
      ClaudeCodeAttributionSource.HarnessOtel,
      agentName,
      NOW
    )
  );
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

async function withDb(
  prefix: string,
  body: (db: Db) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
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

describe("ISS-10720 OTel attribution reaches the stored invocation row", () => {
  test("the importer stamps the named component and leaves its sibling alone", async () => {
    await withDb("aci-otel-attribution-", async (db) => {
      // The session must exist before a cost event can name it — OTel lands
      // when Claude exits, which is normally after the transcript imported.
      await db.importer.importSession(twoCommandSession(), "claude");
      const beforeJoin = await axesByKey(db);
      assert.equal(
        beforeJoin[ATTRIBUTED].attributionSource,
        null,
        "the stamp must come from the counter, not from importing at all"
      );

      await insertCostEvent(db, "deploy");
      await db.importer.importSession(twoCommandSession(), "claude");

      const afterJoin = await axesByKey(db);
      assert.equal(
        afterJoin[ATTRIBUTED].attributionSource,
        AgentComponentInvocationAttributionSource.HarnessOtel
      );
      // This fixture's command has no definition file, so its row carries NO
      // definition evidence — the one case where the class is allowed to move,
      // and the case that proves the `otelCounter` member is really emitted
      // end to end. A row that DOES hold definition evidence keeping it is
      // pinned by the unit case beside this one
      // ("recording the harness attribution does not delete the row's
      // definition provenance"), which drives a `collectorSnapshot` row.
      assert.equal(
        beforeJoin[ATTRIBUTED].evidenceClass,
        AgentComponentInvocationEvidenceClass.None
      );
      assert.equal(
        afterJoin[ATTRIBUTED].evidenceClass,
        AgentComponentInvocationEvidenceClass.OtelCounter
      );
      // The sibling proves the join is scoped to the name the harness stamped
      // rather than applied to every row of a session that captured anything.
      assert.deepEqual(afterJoin[UNATTRIBUTED], beforeJoin[UNATTRIBUTED]);
      assert.equal(afterJoin[UNATTRIBUTED].attributionSource, null);
    });
  });

  test("the importer SEATS a subagent the transcript never derived, and re-seats the same row", async () => {
    await withDb("aci-otel-seat-", async (db) => {
      await db.importer.importSession(twoCommandSession(), "claude");
      const beforeSeat = await seatedRows(db);
      assert.deepEqual(
        beforeSeat,
        [],
        "the transcript alone must derive no subagent here"
      );

      // The harness says a subagent ran that the transcript has no record of.
      // Before ISS-10720's seat this only incremented a counter in a log line.
      await insertAgentCostEvent(db, "Reviewer");
      await db.importer.importSession(twoCommandSession(), "claude");

      const afterSeat = await seatedRows(db);
      assert.equal(afterSeat.length, 1);
      assert.equal(afterSeat[0].component_key, "reviewer");
      assert.equal(
        afterSeat[0].attribution_source,
        AgentComponentInvocationAttributionSource.HarnessOtel,
        "the row exists only because OTel said so and must record that"
      );
      assert.equal(
        afterSeat[0].evidence_class,
        AgentComponentInvocationEvidenceClass.OtelCounter
      );
      // A counter carries no occurrence identifier, so the seat claims none.
      assert.equal(afterSeat[0].invoked_at, null);
      assert.equal(afterSeat[0].anchor_kind, "session");

      // Re-deriving must land on the SAME row, not accumulate a second seat:
      // the id is derived from (session, kind, folded name) and nothing else.
      await db.importer.importSession(twoCommandSession(), "claude");
      const afterRerun = await seatedRows(db);
      assert.equal(afterRerun.length, 1);
      assert.equal(
        afterRerun[0].external_invocation_id,
        afterSeat[0].external_invocation_id
      );
    });
  });

  test("an unmatched SKILL tuple seats nothing — one harness key names both a skill and a /command", async () => {
    await withDb("aci-otel-no-seat-", async (db) => {
      await db.importer.importSession(twoCommandSession(), "claude");
      const before = await axesByKey(db);

      await insertCostEvent(db, "nowhere");
      await db.importer.importSession(twoCommandSession(), "claude");

      const after = await axesByKey(db);
      assert.deepEqual(
        Object.keys(after).sort(),
        Object.keys(before).sort(),
        "a skill tuple the transcript missed must stay a counter"
      );
    });
  });
});

/** Every row of this session that only the harness's attribution put there. */
function seatedRows(db: Db): Promise<
  {
    component_key: string;
    external_invocation_id: string;
    attribution_source: string | null;
    evidence_class: string;
    invoked_at: string | null;
    anchor_kind: string;
  }[]
> {
  return db.prisma.client.$queryRawUnsafe(
    `SELECT component_key, external_invocation_id, attribution_source,
            evidence_class, invoked_at, anchor_kind
       FROM agent_component_invocations
      WHERE session_id = $1 AND component_kind = 'subagent'
      ORDER BY component_key`,
    SESSION_ID
  );
}
