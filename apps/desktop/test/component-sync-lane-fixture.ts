/**
 * @file component-sync-lane-fixture.ts
 * @description Shared fixtures for the `agent_components` sync-lane suites
 * (`component-tombstone-keyset-cursor.test.ts`, `component-tombstone-repair.test.ts`,
 * `component-pack-link-keyset-cursor.test.ts`).
 *
 * Every suite turns on the same three things — what the REAL cursor query yields from
 * a given keyset position, what a row's ordering key and tombstone state actually
 * are, and what the live lane would have delivered — so they share one copy. The
 * ordering-key advance these suites exist to police was itself lost by being derived
 * once and copied nowhere; duplicating its oracle would be the same mistake on the
 * test side.
 */

import { componentCursorRank } from "../src/main/database/component-cursor-rank.js";
import { listAgentComponentCursorRows } from "../src/main/database/component-sync-source.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";

/** Comfortably wider than any fixture here, so a miss is never a paging artifact. */
export const CURSOR_PAGE_SIZE = 50;

/**
 * A row's ordering key + tombstone state, read directly. `last_seen_at` is NULLABLE,
 * so the shape keeps `null` distinguishable from a stamped value — an assertion that
 * only checked "changed" could not tell an absent key from a written one.
 */
export type InventoryRow = {
  id: string;
  lastSeenAt: string | null;
  uninstalledAt: string | null;
};

const READ_ROW_SQL = `SELECT id,
        last_seen_at AS "lastSeenAt",
        uninstalled_at AS "uninstalledAt"
   FROM agent_components
  WHERE external_id = $1`;

/** Read one component's ordering key and tombstone state by external id. */
export async function readRow(
  prisma: DesktopPrisma,
  externalId: string
): Promise<InventoryRow> {
  const rows = await prisma.read((reader) =>
    reader.$queryRawUnsafe<InventoryRow[]>(READ_ROW_SQL, externalId)
  );
  const row = rows[0];
  if (rows.length !== 1 || row === undefined) {
    throw new Error(
      `expected exactly one agent_components row for ${externalId}, got ${rows.length}`
    );
  }
  return row;
}

/** Ids the production cursor query yields from the given keyset position. */
export async function idsFromCursor(
  prisma: DesktopPrisma,
  sinceTs: string,
  sinceId: string
): Promise<string[]> {
  const rows = await listAgentComponentCursorRows(
    prisma,
    sinceTs,
    sinceId,
    CURSOR_PAGE_SIZE
  );
  return rows.map((row) => row.id);
}

/**
 * Stand-in for the live component-sync lane, which runs independently of the scan
 * on its own interval. It does exactly what `AgentComponentSyncLane.run` does with
 * the cursor: page `listAgentComponentCursorRows` from its keyset position, load the
 * selected rows, and advance the cursor onto the last row of the batch. A row whose
 * `uninstalled_at` is set when the lane loads it is an uninstall the cloud received.
 *
 * `uninstallsDelivered` is APPEND-ONLY across drains, which is what lets a caller
 * assert delivery happened EXACTLY once rather than merely at least once: a repair
 * that re-keyed an already-delivered row would push its id a second time.
 */
export function createSyncLaneSimulator(prisma: DesktopPrisma) {
  let cursorTs = "";
  let cursorId = "";
  const uninstallsDelivered: string[] = [];

  async function drain(): Promise<void> {
    for (;;) {
      const rows = await listAgentComponentCursorRows(
        prisma,
        cursorTs,
        cursorId,
        CURSOR_PAGE_SIZE
      );
      const last = rows.at(-1);
      if (last === undefined) {
        return;
      }
      const ids = rows.map((row) => row.id);
      const loaded = await prisma.read((reader) =>
        reader.$queryRawUnsafe<InventoryRow[]>(
          `SELECT id,
                  last_seen_at AS "lastSeenAt",
                  uninstalled_at AS "uninstalledAt"
             FROM agent_components
            WHERE id IN (${ids.map((_, index) => `$${index + 1}`).join(", ")})`,
          ...ids
        )
      );
      for (const row of loaded) {
        if (row.uninstalledAt !== null) {
          uninstallsDelivered.push(row.id);
        }
      }
      // ISS-11327: the production lane advances onto the row's projected RANKING
      // KEY, so this simulator must too — advancing on the raw `last_seen_at` here
      // would be a fixture comparing a different order than the lane it stands in for.
      cursorTs = last.cursor_key ?? componentCursorRank(last.last_seen_at);
      cursorId = last.id;
    }
  }

  return { drain, uninstallsDelivered };
}
