/**
 * @file foreign-key-integrity.test.ts
 * @description ISS-5102 — the referential-integrity store-health check: a
 * bounded `PRAGMA foreign_key_check` plus the ISS-5098 FK-less orphan counter
 * (`events.agent_id` with no `agents` row, invisible to `foreign_key_check`
 * because that column deliberately has no FK). Covers the real-store read (both
 * counters, exact totals), the probe integration through the injected
 * `extraChecks` seam, the pure classifier, and the version-skew degradations
 * (missing method / unreadable shape → omitted from `checksRun`, never a
 * fabricated tally).
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { createStoreIntegrityProbe } from "../src/main/database/database-integrity/store-integrity-probe.js";
import {
  classifyForeignKeyIntegrity,
  FK_VIOLATION_TABLE_CAP,
  FOREIGN_KEY_INTEGRITY_SCHEMA,
  type ForeignKeyIntegrityReader,
  type ForeignKeyIntegrityResult,
  foreignKeyIntegrityCheck,
} from "../src/main/database/foreign-key-integrity.js";
import type {
  StoreIntegrityDiagnostics,
  StoreIntegrityIssue,
} from "../src/main/telemetry/telemetry-protocol.js";
import { openTestDb } from "./agent-db-test-utils.js";
import { makeSession } from "./normalized-session-test-utils.js";

const NOW = "2026-08-04T17:00:00.000Z";
const MISSING_AGENT_ID = "agent-id-with-no-agents-row";
const noopEmit = (_: StoreIntegrityDiagnostics): void => {};

function toolSession(sessionId: string): ReturnType<typeof makeSession> {
  return makeSession({
    sessionId,
    startedAt: NOW,
    endedAt: "2026-08-04T17:05:00.000Z",
    toolUses: [
      {
        id: "toolu_read_1",
        providerToolUseId: "toolu_read_1",
        name: "Read",
        kind: "builtin",
        timestamp: "2026-08-04T17:00:01.000Z",
      },
    ],
  });
}

describe("ISS-5102: foreign key integrity check — real store", () => {
  test("a clean freshly-imported store reports zero on both counters and runs the check", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fk-5102-clean-"));
    const db = await openTestDb(dir);
    try {
      await db.importer.importSession(
        toolSession("session-5102-clean"),
        "claude"
      );

      const result = await db.runForeignKeyIntegrityCheck();
      assert.deepEqual(result, {
        violationTotal: 0,
        violationTables: [],
        orphanEventAgentRows: 0,
      });

      const probe = createStoreIntegrityProbe(db, {
        emit: noopEmit,
        extraChecks: [foreignKeyIntegrityCheck(db)],
      });
      const diag = await probe.runOnce();
      assert.equal(diag.healthy, true);
      assert.ok(diag.checksRun.includes("foreign_key_check"));
      assert.equal(
        diag.issues.some((i) => i.check === "foreign_key_check"),
        false
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a seeded dangling FK row and an orphan events.agent_id report both counters", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fk-5102-dirty-"));
    // skipIntegrityCheck: deliberately-seeded dangling rows ARE the subject —
    // the ISS-5100 teardown assertion would otherwise fail this fixture.
    const db = await openTestDb(dir, undefined, { skipIntegrityCheck: true });
    try {
      const sessionId = "session-5102-dirty";
      await db.importer.importSession(toolSession(sessionId), "claude");

      // The ISS-5098 orphan shape: `events.agent_id` has no FK, so this write
      // succeeds with `PRAGMA foreign_keys=ON` — exactly how real stores reach
      // the state. The imported session has exactly one tool event.
      await db.run(
        "UPDATE events SET agent_id = $1 WHERE session_id = $2 AND tool_name IS NOT NULL",
        MISSING_AGENT_ID,
        sessionId
      );

      // A genuinely dangling FK row: `agent_component_invocations.agent_id`
      // carries a real FK to agents(id), so the enforcement pragma must be off
      // for the write — mirroring the legacy stores this probe exists to find.
      await db.run("PRAGMA foreign_keys=OFF");
      await db.run(
        `UPDATE agent_component_invocations SET agent_id = $1
          WHERE id = (SELECT id FROM agent_component_invocations WHERE session_id = $2 LIMIT 1)`,
        MISSING_AGENT_ID,
        sessionId
      );
      await db.run("PRAGMA foreign_keys=ON");

      const result = await db.runForeignKeyIntegrityCheck();
      assert.equal(result.violationTotal, 1, "exact store-wide dangle total");
      assert.deepEqual(result.violationTables, [
        { table: "agent_component_invocations", rows: 1 },
      ]);
      assert.equal(result.orphanEventAgentRows, 1);

      const probe = createStoreIntegrityProbe(db, {
        emit: noopEmit,
        extraChecks: [foreignKeyIntegrityCheck(db)],
      });
      const diag = await probe.runOnce();
      assert.equal(diag.healthy, false);
      assert.ok(diag.checksRun.includes("foreign_key_check"));
      const fkIssues = diag.issues.filter(
        (i) => i.check === "foreign_key_check"
      );
      assert.ok(
        fkIssues.some(
          (i) =>
            i.category === "foreign_key_violation" &&
            i.object === "agent_component_invocations" &&
            i.objectType === "table"
        ),
        "the dangling FK row surfaces as foreign_key_violation"
      );
      assert.ok(
        fkIssues.some(
          (i) =>
            i.category === "orphaned_row" &&
            i.object === "events" &&
            i.objectType === "table"
        ),
        "the FK-less orphan surfaces as orphaned_row"
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("ISS-5102: classifyForeignKeyIntegrity", () => {
  function classify(result: ForeignKeyIntegrityResult): StoreIntegrityIssue[] {
    const issues: StoreIntegrityIssue[] = [];
    classifyForeignKeyIntegrity(result, issues);
    return issues;
  }

  test("zero counts produce no issues", () => {
    assert.deepEqual(
      classify({
        violationTotal: 0,
        violationTables: [],
        orphanEventAgentRows: 0,
      }),
      []
    );
  });

  test("one issue per offending child table, plus one for the orphan shape", () => {
    const issues = classify({
      violationTotal: 7,
      violationTables: [
        { table: "agent_component_invocations", rows: 5 },
        { table: "agents", rows: 2 },
      ],
      orphanEventAgentRows: 3,
    });
    assert.equal(issues.length, 3);
    assert.deepEqual(
      issues
        .filter((i) => i.category === "foreign_key_violation")
        .map((i) => i.object)
        .sort(),
      ["agent_component_invocations", "agents"]
    );
    assert.deepEqual(
      issues.filter((i) => i.category === "orphaned_row"),
      [
        {
          check: "foreign_key_check",
          category: "orphaned_row",
          object: "events",
          objectType: "table",
        },
      ]
    );
  });

  test("a zero-row table entry is not reported", () => {
    // Defense in depth: the wire schema below now rejects a zero-row group
    // outright, so this only pins the classifier's own guard.
    const issues = classify({
      violationTotal: 0,
      violationTables: [{ table: "agents", rows: 0 }],
      orphanEventAgentRows: 0,
    });
    assert.deepEqual(issues, []);
  });
});

describe("ISS-5102: the wire schema rejects contradictory counts", () => {
  function parses(value: unknown): boolean {
    return FOREIGN_KEY_INTEGRITY_SCHEMA.safeParse(value).success;
  }

  test("a positive total with no table groups is rejected", () => {
    // The dangerous shape: the classifier only iterates groups, so this would
    // emit NO issue and let a store with dangling rows report healthy.
    assert.equal(
      parses({
        violationTotal: 1,
        violationTables: [],
        orphanEventAgentRows: 0,
      }),
      false
    );
  });

  test("group rows that do not reconcile with the total are rejected", () => {
    assert.equal(
      parses({
        violationTotal: 9,
        violationTables: [{ table: "agents", rows: 2 }],
        orphanEventAgentRows: 0,
      }),
      false
    );
  });

  test("a zero-row group is rejected (GROUP BY cannot produce one)", () => {
    assert.equal(
      parses({
        violationTotal: 0,
        violationTables: [{ table: "agents", rows: 0 }],
        orphanEventAgentRows: 0,
      }),
      false
    );
  });

  test("a duplicated table is rejected (GROUP BY cannot repeat one)", () => {
    assert.equal(
      parses({
        violationTotal: 4,
        violationTables: [
          { table: "agents", rows: 2 },
          { table: "agents", rows: 2 },
        ],
        orphanEventAgentRows: 0,
      }),
      false
    );
  });

  test("a non-safe integer count is rejected", () => {
    assert.equal(
      parses({
        violationTotal: Number.MAX_SAFE_INTEGER + 2,
        violationTables: [],
        orphanEventAgentRows: 0,
      }),
      false
    );
  });

  test("reconciling counts parse, and may fall short only AT the cap", () => {
    assert.equal(
      parses({
        violationTotal: 7,
        violationTables: [
          { table: "agent_component_invocations", rows: 5 },
          { table: "agents", rows: 2 },
        ],
        orphanEventAgentRows: 3,
      }),
      true
    );
    // At the cap the group list is LIMITed, so the window SUM legitimately
    // exceeds what the reported groups account for.
    assert.equal(
      parses({
        violationTotal: FK_VIOLATION_TABLE_CAP + 25,
        violationTables: Array.from(
          { length: FK_VIOLATION_TABLE_CAP },
          (_, index) => ({ table: `t_${index}`, rows: 1 })
        ),
        orphanEventAgentRows: 0,
      }),
      true
    );
  });
});

describe("ISS-5102: version-skew degradation", () => {
  const cleanBuiltins = {
    runStoreIntegrityCheck: () =>
      Promise.resolve({
        quickRows: [{ quick_check: "ok" }] as Record<string, unknown>[],
        indexRows: [] as { name: string }[],
      }),
  };

  function probeWith(reader: ForeignKeyIntegrityReader) {
    return createStoreIntegrityProbe(
      { ...cleanBuiltins },
      { emit: noopEmit, extraChecks: [foreignKeyIntegrityCheck(reader)] }
    );
  }

  test("a host without the read omits the check from checksRun", async () => {
    const diag = await probeWith({}).runOnce();
    // Not evaluated is NOT the same as clean: the check is left out of
    // `checksRun` rather than reported as having passed.
    assert.equal(diag.checksRun.includes("foreign_key_check"), false);
    assert.equal(diag.healthy, true);
  });

  test("a non-identifier table name fails the parse and drops the check", async () => {
    // The table name becomes an issue `object` bound for Datadog, so a value
    // that is not a plain schema identifier must never classify.
    const diag = await probeWith({
      runForeignKeyIntegrityCheck: () =>
        Promise.resolve({
          violationTotal: 1,
          violationTables: [{ table: "evil; DROP--", rows: 1 }],
          orphanEventAgentRows: 0,
        }),
    }).runOnce();
    assert.equal(diag.checksRun.includes("foreign_key_check"), false);
    assert.equal(
      diag.issues.some((i) => i.check === "foreign_key_check"),
      false
    );
    assert.equal(diag.healthy, true);
  });

  test("a group list past the cap fails the parse and drops the check", async () => {
    // The read LIMITs at the cap, so an over-cap list can only be a corrupt or
    // hostile payload — degrade to "not evaluated", never a partial tally.
    const diag = await probeWith({
      runForeignKeyIntegrityCheck: () =>
        Promise.resolve({
          violationTotal: FK_VIOLATION_TABLE_CAP + 1,
          violationTables: Array.from(
            { length: FK_VIOLATION_TABLE_CAP + 1 },
            (_, index) => ({ table: `t_${index}`, rows: 1 })
          ),
          orphanEventAgentRows: 0,
        }),
    }).runOnce();
    assert.equal(diag.checksRun.includes("foreign_key_check"), false);
    assert.equal(diag.healthy, true);
  });
});
