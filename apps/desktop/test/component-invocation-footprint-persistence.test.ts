/**
 * @file component-invocation-footprint-persistence.test.ts
 * @description ISS-10736 at the PERSISTENCE boundary, against a real SQLite
 * database rather than a pure function.
 *
 * Three things only a real row can prove, and none of them was covered:
 *
 *  1. `footprint_tokens` lands in its own COLUMN. The writer's INSERT is a
 *     38-slot POSITIONAL tuple whose values array and SQL column list are kept in
 *     step by hand; a transposition between the two would write every row's
 *     footprint into a neighbour and no pure-function test would notice. Each row
 *     below carries a DISTINCT value and is read back BY COLUMN NAME, so an
 *     off-by-one reads a neighbour's number and fails.
 *  2. A withheld footprint persists as NULL while the row KEEPS the measured
 *     label it earned — the ISS-7795 signal this ticket must not demote.
 *  3. `reportWithheldFootprints` actually fires. Its branch had never executed:
 *     without it `footprintRefusedUnlabelled` is a dead flag and the stored NULL
 *     becomes indistinguishable from "nothing ever computed one", which is the
 *     whole justification for withholding.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  AgentComponentInvocationRelationship,
  AgentComponentInvocationUsageMeasurement,
} from "@repo/api/src/types/agent-component-invocation";
import { describe, test } from "vitest";
import type { AgentComponentInvocationCandidate } from "../src/main/database/component-invocation-row-writer.js";
import { insertInvocationRows } from "../src/main/database/component-invocation-row-writer.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { makeSession } from "./normalized-session-test-utils.js";

const NOW = "2026-09-23T17:00:00.000Z";

type Db = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

function openDb(dir: string): Promise<Db> {
  return openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.sqlite"),
    detectBillingMode: () => "metered_api",
    now: () => NOW,
  });
}

function candidate(
  overrides: Partial<AgentComponentInvocationCandidate> &
    Pick<AgentComponentInvocationCandidate, "externalInvocationId">
): AgentComponentInvocationCandidate {
  return {
    externalSourceId: null,
    childSessionId: null,
    agentId: null,
    parentAgentId: null,
    componentKind: AgentComponentInvocationKind.Tool,
    componentKey: "component",
    rawName: "Read",
    normalizedName: "Read",
    relationship: AgentComponentInvocationRelationship.Direct,
    invokedAt: NOW,
    sourceOrder: 0,
    sequence: 0,
    anchorKind: AgentComponentInvocationAnchorKind.Timestamp,
    anchorValue: "anchor",
    providerToolUseId: null,
    attributionStatus: AgentComponentInvocationAttributionStatus.Unresolved,
    evidenceClass: AgentComponentInvocationEvidenceClass.None,
    evidencePointer: null,
    definitionHash: null,
    normalizerContractVersion: null,
    definitionContent: null,
    localComponentId: null,
    localComponentVersionId: null,
    gitBranch: null,
    repositoryFullName: null,
    succeeded: null,
    model: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    estimatedCost: null,
    usageMeasurement: null,
    footprintTokens: null,
    linesAdded: null,
    linesRemoved: null,
    findingsEmitted: null,
    findingsInvalidated: null,
    findingsDisposition: null,
    attributionSource: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function storedRows(db: Db, sessionId: string) {
  return db.prisma.client.$queryRawUnsafe<
    {
      external_invocation_id: string;
      component_key: string;
      footprint_tokens: bigint | null;
      usage_measurement: string | null;
      input_tokens: bigint | null;
      created_at: string;
    }[]
  >(
    `SELECT external_invocation_id, component_key, footprint_tokens,
            usage_measurement, input_tokens, created_at
       FROM agent_component_invocations
      WHERE session_id = $1
      ORDER BY external_invocation_id`,
    sessionId
  );
}

describe("ISS-10736 footprint persistence boundary", () => {
  test("each row's footprint lands in its own column, read back by name", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aci-10736-cols-"));
    const db = await openDb(dir);
    try {
      const sessionId = "session-10736-columns";
      await db.importer.importSession(
        makeSession({ sessionId, startedAt: NOW, endedAt: NOW }),
        "claude"
      );
      await db.run(
        "DELETE FROM agent_component_invocations WHERE session_id = $1",
        sessionId
      );

      const logged: string[] = [];
      /* Distinct per row: a values/column transposition reads a neighbour's
         number, so equal values would hide exactly the defect this pins. */
      const batch = [
        candidate({
          externalInvocationId: "inv-a",
          componentKey: "a",
          footprintTokens: 11,
          usageMeasurement: AgentComponentInvocationUsageMeasurement.Estimated,
          sequence: 0,
        }),
        candidate({
          externalInvocationId: "inv-b",
          componentKey: "b",
          footprintTokens: 2222,
          usageMeasurement: AgentComponentInvocationUsageMeasurement.Estimated,
          sequence: 1,
        }),
        candidate({
          externalInvocationId: "inv-c",
          componentKey: "c",
          componentKind: AgentComponentInvocationKind.Subagent,
          footprintTokens: 333_333,
          usageMeasurement: AgentComponentInvocationUsageMeasurement.Estimated,
          sequence: 2,
        }),
      ];
      await db.prisma.write((client) =>
        insertInvocationRows(client, sessionId, batch, (message) =>
          logged.push(message)
        )
      );

      const rows = await storedRows(db, sessionId);
      assert.deepEqual(
        rows.map((row) => [
          row.external_invocation_id,
          row.footprint_tokens === null ? null : Number(row.footprint_tokens),
          row.usage_measurement,
        ]),
        [
          ["inv-a", 11, AgentComponentInvocationUsageMeasurement.Estimated],
          ["inv-b", 2222, AgentComponentInvocationUsageMeasurement.Estimated],
          [
            "inv-c",
            333_333,
            AgentComponentInvocationUsageMeasurement.Estimated,
          ],
        ]
      );
      // A column shifted by one would land the footprint here instead.
      assert.deepEqual(
        rows.map((row) => row.created_at),
        [NOW, NOW, NOW]
      );
      assert.deepEqual(
        rows.map((row) => row.input_tokens),
        [null, null, null]
      );
      // Nothing was withheld, so the reporter must stay quiet.
      assert.deepEqual(
        logged.filter((message) => message.includes("context footprint")),
        []
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a withheld footprint persists as NULL, keeps its measured label, and is reported", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aci-10736-withheld-"));
    const db = await openDb(dir);
    try {
      const sessionId = "session-10736-withheld";
      await db.importer.importSession(
        makeSession({ sessionId, startedAt: NOW, endedAt: NOW }),
        "claude"
      );
      await db.run(
        "DELETE FROM agent_component_invocations WHERE session_id = $1",
        sessionId
      );

      const logged: string[] = [];
      await db.prisma.write((client) =>
        insertInvocationRows(
          client,
          sessionId,
          [
            candidate({
              externalInvocationId: "inv-withheld",
              componentKind: AgentComponentInvocationKind.Subagent,
              model: "claude-opus-5",
              inputTokens: 41,
              footprintTokens: null,
              usageMeasurement:
                AgentComponentInvocationUsageMeasurement.Measured,
              footprintRefusedUnlabelled: true,
            }),
          ],
          (message) => logged.push(message)
        )
      );

      const rows = await storedRows(db, sessionId);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.footprint_tokens, null);
      // The provider-reported counts keep the label they earned.
      assert.equal(
        rows[0]?.usage_measurement,
        AgentComponentInvocationUsageMeasurement.Measured
      );
      assert.equal(Number(rows[0]?.input_tokens), 41);
      assert.deepEqual(
        logged.filter((message) =>
          message.includes("withheld context footprint on 1 row(s)")
        ).length,
        1
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
