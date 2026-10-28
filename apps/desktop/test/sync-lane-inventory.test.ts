/**
 * @file sync-lane-inventory.test.ts
 * @description ISS-10375 AC4: every lane owned by the lane table in
 * `main/sync/AGENTS.md` appears in `SYNC_LANE_IDS`, and vice versa. Lanes with
 * an exported, feature-owned composition contract are classified explicitly.
 *
 * {@link AGENTS_MD_LANE_ROW} is a `Record<SyncLaneId, …>`, so a new lane id fails
 * `tsc` until it names its table row. The comparison fails a lane id with no
 * row, and a row with no lane id.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  SYNC_LANE_IDS,
  SyncLaneId,
} from "../src/shared/sync-burndown-contract.js";

const AGENTS_MD_LANE_ROW: Record<SyncLaneId, string | null> = {
  [SyncLaneId.SessionMetadata]: "Session metadata",
  [SyncLaneId.InvocationParts]: "Invocation parts",
  [SyncLaneId.TranscriptArchive]: "Transcript archive",
  [SyncLaneId.ComponentInventory]: "Component inventory",
};

const SYNC_AGENTS_MD = path.resolve(
  import.meta.dirname,
  "../src/main/sync/AGENTS.md"
);
const LANE_TABLE_HEADER = "| Lane | Store | Shape | Status vocabulary |";
const TABLE_ROW_FIRST_CELL_RE = /^\|\s*([^|]+?)\s*\|/;

/** The first cell of every row in the lane table, in document order. */
function agentsMdLaneRows(): string[] {
  const lines = readFileSync(SYNC_AGENTS_MD, "utf8").split("\n");
  const header = lines.indexOf(LANE_TABLE_HEADER);
  if (header === -1) {
    throw new Error(
      `no lane table in ${SYNC_AGENTS_MD}: expected the header row "${LANE_TABLE_HEADER}"`
    );
  }
  const rows: string[] = [];
  // +2 skips the header and its `| --- |` separator.
  for (const line of lines.slice(header + 2)) {
    const cell = TABLE_ROW_FIRST_CELL_RE.exec(line)?.[1];
    if (cell === undefined) {
      break;
    }
    rows.push(cell);
  }
  return rows;
}

describe("sync lane inventory (ISS-10375)", () => {
  it("documented lane ids and the main/sync/AGENTS.md lane table name the same lanes", () => {
    const rows = agentsMdLaneRows();
    expect(rows.length, "the lane table parsed to no rows").toBeGreaterThan(0);
    expect(new Set(rows).size, "a lane table row is duplicated").toBe(
      rows.length
    );
    expect(
      new Set(rows),
      "a lane is in SYNC_LANE_IDS without a main/sync/AGENTS.md row, or has a row and is missing from SYNC_LANE_IDS"
    ).toEqual(
      new Set(
        SYNC_LANE_IDS.map((lane) => AGENTS_MD_LANE_ROW[lane]).filter(
          (row): row is string => row !== null
        )
      )
    );
  });
});
