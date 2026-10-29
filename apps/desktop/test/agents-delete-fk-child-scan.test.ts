/**
 * ISS-11388: deleting an `agents` row must not full-scan a child table.
 *
 * The importer deletes every subagent row of a session on each re-import
 * (`importPhaseEvents`), and `agent_component_invocations` points at `agents`
 * through two ON DELETE SET NULL foreign keys. With no index leading on the
 * child column, SQLite compiles each parent delete into full scans of that
 * table, so a re-import cost subagents x invocation-table size.
 *
 * The assertion reads the program SQLite compiles for the delete (EXPLAIN,
 * which includes the FK action sub-programs) on a store built by the production
 * migration runner: a `Rewind`/`Last` over any opened table or index cursor is a
 * full scan. Index cursors count too, because a full scan of an index that does
 * not lead on the FK column is the same per-row cost. The FK sub-programs do not
 * depend on the WHERE clause, because they are compiled per table; the main
 * program does, and it is counted too, so the probe deletes by primary key.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { openTestDb } from "./agent-db-test-utils.js";

type ExplainRow = {
  addr: number | bigint;
  opcode: string;
  p1: number | bigint;
};

const SCAN_OPCODES = new Set(["Rewind", "Last"]);
const CURSOR_OPEN_OPCODES = new Set(["OpenRead", "OpenWrite"]);

let dir: string;
let db: SqliteAgentDatabase;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "agents-delete-fk-scan-"));
  db = await openTestDb(dir);
});

afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

/**
 * Full scans of table or index cursors across the main program and every
 * sub-program. Ephemeral cursors (`OpenEphemeral`, the delete's rowset) are not
 * opened by `OpenRead`/`OpenWrite`, so they are not counted.
 */
function fullScans(rows: ExplainRow[]): number {
  let scans = 0;
  let cursors = new Set<number>();
  for (const row of rows) {
    if (Number(row.addr) === 0) {
      cursors = new Set();
    }
    const cursor = Number(row.p1);
    if (CURSOR_OPEN_OPCODES.has(row.opcode)) {
      cursors.add(cursor);
    } else if (SCAN_OPCODES.has(row.opcode) && cursors.has(cursor)) {
      scans += 1;
    }
  }
  return scans;
}

describe("deleting an agents row (ISS-11388)", () => {
  it("looks its foreign-key children up by index instead of scanning them", async () => {
    const rows = await db.prisma.client.$queryRawUnsafe<ExplainRow[]>(
      "EXPLAIN DELETE FROM agents WHERE id = $1",
      "agent-probe"
    );

    // FK enforcement is compiled in, so zero scans below is not a program
    // with no foreign-key work at all.
    expect(rows.some((row) => row.opcode === "FkCounter")).toBe(true);
    expect(fullScans(rows)).toBe(0);
  });
});
