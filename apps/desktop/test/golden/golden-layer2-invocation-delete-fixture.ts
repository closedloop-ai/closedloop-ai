import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AGENT_COMPONENT_INVOCATION_SYNC_STATE_SESSION_ID } from "../../src/main/agent-sync/agent-component-invocation-sync-constants.js";
import { openTestDb } from "../agent-db-test-utils.js";
import type { GoldenDossier } from "./golden-corpus.js";

const DELETE_FIXTURE_IDS = [
  "3b820c31-7ca8-4096-9f46-913cd580d38e",
  "019ea892-0957-71e2-8052-1f4e717dd2cc",
];

const SESSION_KEYED_TABLES: { table: string; column: string }[] = [
  { table: "sessions", column: "id" },
  { table: "agents", column: "session_id" },
  { table: "events", column: "session_id" },
  { table: "token_usage", column: "session_id" },
  { table: "token_events", column: "session_id" },
  { table: "session_analytics", column: "session_id" },
  { table: "session_tool_analytics", column: "session_id" },
  { table: "session_turn_bucket", column: "session_id" },
  { table: "session_activity_segments", column: "session_id" },
  { table: "session_artifact_links", column: "session_id" },
  { table: "pull_requests", column: "session_id" },
  { table: "agent_component_invocations", column: "session_id" },
  { table: "agent_component_session_usage", column: "session_id" },
];

type Layer2Input = {
  input: Parameters<
    Awaited<ReturnType<typeof openTestDb>>["importer"]["importSession"]
  >[0];
  nowD: string;
  harness: Parameters<
    Awaited<ReturnType<typeof openTestDb>>["importer"]["importSession"]
  >[1];
};

type OracleFact = {
  key: string;
  oracle: unknown;
  inputDerived: unknown;
  actual: unknown;
  l1Keys: string[];
};

type RegisterInvocationDeleteFixtureOptions = {
  nonNull: readonly GoldenDossier[];
  loadLayer2Input: (dossier: GoldenDossier) => Layer2Input;
  checkOracleFact: (
    sessionId: string,
    fact: OracleFact,
    diagnostics: string[],
    failures: string[]
  ) => void;
  normalizeRow: (
    row: Record<string, unknown>,
    maskedColumns: ReadonlyMap<string, string> | undefined
  ) => Record<string, unknown>;
  compareSerializedRows: (
    left: Record<string, unknown>,
    right: Record<string, unknown>
  ) => number;
};

export function registerInvocationDeleteFixture(
  options: RegisterInvocationDeleteFixtureOptions
): void {
  test("golden layer2 fixture: session delete leaves no orphan rollups (FEA-2347)", async () => {
    const targets = options.nonNull.filter((d) =>
      DELETE_FIXTURE_IDS.includes(d.sessionId)
    );
    assert.equal(
      targets.length,
      DELETE_FIXTURE_IDS.length,
      `delete-fixture dossiers missing from corpus: wanted ${DELETE_FIXTURE_IDS.join(", ")}`
    );
    const diagnostics: string[] = [];
    const failures: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), "golden-l2-2347-"));
    const inputs = targets.map((d) => options.loadLayer2Input(d));
    const nowD = inputs
      .map((input) => input.nowD)
      .sort()
      .at(-1)!;
    const db = await openTestDb(dir, { now: () => nowD });
    try {
      for (const [index, dossier] of targets.entries()) {
        const { input, harness } = inputs[index];
        const result = await db.importer.importSession(input, harness);
        assert.ok(
          !(result.skipped || result.failed) && result.incomplete !== true,
          `${dossier.sessionId}: seed import failed`
        );
      }
      const sessionRowCounts = async (sessionId: string) => {
        const counts: Record<string, number> = {};
        for (const { table, column } of SESSION_KEYED_TABLES) {
          const rows = await db.prisma.client.$queryRawUnsafe<
            { n: number | bigint }[]
          >(
            `SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = $1`,
            sessionId
          );
          counts[table] = Number(rows[0]?.n ?? 0);
        }
        return counts;
      };
      const invocationTransportState = async () => {
        const [outbox, cursors] = await Promise.all([
          db.prisma.client.$queryRawUnsafe<Record<string, unknown>[]>(
            "SELECT * FROM agent_component_invocation_sync_outbox"
          ),
          db.prisma.client.$queryRawUnsafe<Record<string, unknown>[]>(
            "SELECT * FROM agent_component_invocation_sync_cursors"
          ),
        ]);
        const normalizedOutbox = outbox.map((row) =>
          options.normalizeRow(row, undefined)
        );
        const normalizedCursors = cursors.map((row) =>
          options.normalizeRow(row, undefined)
        );
        normalizedOutbox.sort(options.compareSerializedRows);
        normalizedCursors.sort(options.compareSerializedRows);
        return {
          agent_component_invocation_sync_outbox: normalizedOutbox,
          agent_component_invocation_sync_cursors: normalizedCursors,
        } satisfies Record<string, Record<string, unknown>[]>;
      };
      const sessionBaselines = new Map(
        await Promise.all(
          targets.map(
            async (dossier) =>
              [
                dossier.sessionId,
                await sessionRowCounts(dossier.sessionId),
              ] as const
          )
        )
      );
      assert.ok(
        [...sessionBaselines.values()].every(
          (counts) => counts.agent_component_invocations > 0
        ),
        "every delete fixture session must seed component invocations"
      );
      assert.ok(
        [...sessionBaselines.values()].every(
          (counts) => counts.agent_component_session_usage > 0
        ),
        "every delete fixture session must seed component session usage"
      );
      const transportBaseline = await invocationTransportState();
      assert.ok(
        transportBaseline.agent_component_invocation_sync_outbox.length > 0,
        "delete fixture must seed durable invocation outbox state"
      );
      assert.ok(
        transportBaseline.agent_component_invocation_sync_cursors.some(
          (row) =>
            row.external_session_id ===
            AGENT_COMPONENT_INVOCATION_SYNC_STATE_SESSION_ID
        ),
        "delete fixture must seed the global invocation sync cursor"
      );
      const globalComponentState = async () => {
        const [components, versions] = await Promise.all([
          db.prisma.client.$queryRawUnsafe<Record<string, unknown>[]>(
            "SELECT * FROM agent_components"
          ),
          db.prisma.client.$queryRawUnsafe<Record<string, unknown>[]>(
            "SELECT * FROM agent_component_versions"
          ),
        ]);
        const normalizedComponents = components.map((row) =>
          options.normalizeRow(row, undefined)
        );
        const normalizedVersions = versions.map((row) =>
          options.normalizeRow(row, undefined)
        );
        normalizedComponents.sort(options.compareSerializedRows);
        normalizedVersions.sort(options.compareSerializedRows);
        return {
          agent_components: normalizedComponents,
          agent_component_versions: normalizedVersions,
        } satisfies Record<string, Record<string, unknown>[]>;
      };
      const globalComponentBaseline = await globalComponentState();
      assert.ok(
        globalComponentBaseline.agent_components.length > 0,
        "delete fixture must seed durable component inventory"
      );
      assert.ok(
        globalComponentBaseline.agent_component_versions.length > 0,
        "delete fixture must seed durable component version history"
      );
      const survivorBaseline = sessionBaselines.get(targets[1].sessionId);
      assert.ok(
        survivorBaseline,
        `${targets[1].sessionId}: survivor baseline missing`
      );
      for (const [index, dossier] of targets.entries()) {
        await db.deleteSessionRow(dossier.sessionId);
        const orphanTables: string[] = [];
        for (const { table, column } of SESSION_KEYED_TABLES) {
          const rows = await db.prisma.client.$queryRawUnsafe<
            { n: number | bigint }[]
          >(
            `SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = $1`,
            dossier.sessionId
          );
          if (Number(rows[0]?.n ?? 0) > 0) {
            orphanTables.push(table);
          }
        }
        options.checkOracleFact(
          dossier.sessionId,
          {
            key: "store.delete.orphans",
            oracle: [],
            inputDerived: [],
            actual: orphanTables.sort(),
            l1Keys: [],
          },
          diagnostics,
          failures
        );
        options.checkOracleFact(
          dossier.sessionId,
          {
            key: "store.delete.invocation_sync_survives",
            oracle: transportBaseline,
            inputDerived: transportBaseline,
            actual: await invocationTransportState(),
            l1Keys: [],
          },
          diagnostics,
          failures
        );
        options.checkOracleFact(
          dossier.sessionId,
          {
            key: "store.delete.global_components_survive",
            oracle: globalComponentBaseline,
            inputDerived: globalComponentBaseline,
            actual: await globalComponentState(),
            l1Keys: [],
          },
          diagnostics,
          failures
        );
        if (index === 0) {
          options.checkOracleFact(
            dossier.sessionId,
            {
              key: "store.delete.survivor_unchanged",
              oracle: survivorBaseline,
              inputDerived: survivorBaseline,
              actual: await sessionRowCounts(targets[1].sessionId),
              l1Keys: [],
            },
            diagnostics,
            failures
          );
        }
      }
    } finally {
      await db.close();
      rmSync(dir, { recursive: true, force: true });
    }
    for (const line of diagnostics) {
      console.log(`  [layer2-divergence] ${line}`);
    }
    assert.ok(
      failures.length === 0,
      `FEA-2347 fixture: ${failures.length} fact(s) diverged:\n  - ${failures.join("\n  - ")}`
    );
  });
}
