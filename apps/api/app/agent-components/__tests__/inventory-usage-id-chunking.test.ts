/**
 * ISS-8239 item 2: `INVENTORY_USAGE_ID_CHUNK_SIZE` was modelled against the
 * width a Prisma-BUILT statement is REFUSED at (32,767) rather than the last
 * width it is ACCEPTED at (32,766), so a FULL chunk plus the per-statement reserve
 * came to exactly 32,767 — one parameter over the line. The identical fencepost
 * ISS-8185 shipped and #6093 fixed in the sibling writers.
 *
 * WHY THERE WAS NO COVERAGE, and why it has to be written this way. A short
 * final chunk satisfies the budget no matter how the constant is sized, so any
 * fixture whose id count is NOT a multiple of the chunk size passes under the
 * broken constant too — the tail's remainder hides the fencepost. #6093 found
 * the activity-segment path was safe only by that accident (32,767 mod 11 = 9).
 * The fixture below is therefore sized at an exact multiple of the chunk size —
 * derived from the constant rather than written as a number, so it stays
 * adversarial if the constant ever moves — which forces at least one chunk to
 * come out exactly FULL. That full chunk is the only one that can be over.
 *
 * The assertion is on the widths the production call actually EMITTED, read off
 * the double after `loadUsageGroupsForInventory` returns, not on arithmetic over
 * the constants. Under the old constant the first emitted chunk is 32,000 wide
 * and 32,000 + 767 = 32,767 exceeds the accepted ceiling, so this suite fails;
 * under the fix it is 31,999 and 31,999 + 767 = 32,766 exactly fits.
 */
import { describe, expect, it, vi } from "vitest";

// The module imports `@repo/database` only for a `typeof withDb` type and is
// called with a caller-supplied `db`; mock it so the module loads without a
// real client.
vi.mock("@repo/database", () => ({
  Prisma: {},
  withDb: vi.fn(),
}));

import { POSTGRES_MAX_ACCEPTED_BIND_PARAMETERS } from "@/lib/postgres-bind-parameters";
import { loadUsageGroupsForInventory } from "../org-population";
import {
  BIND_PARAMETERS_RESERVED_PER_STATEMENT,
  INVENTORY_USAGE_ID_CHUNK_SIZE,
} from "../usage-bind-budget";

const ORG = "org-1";

type GroupByArgs = {
  where: { agentComponentId: { in: string[] } };
};

/**
 * An `agentComponentSessionUsage.groupBy` double that records the id width of
 * every chunk the read issues and answers each with no groups — the widths are
 * the contract under test, and an empty answer keeps
 * `resolveDefinitionHashes` from issuing a second, unrelated read.
 */
function makeFakeDb() {
  // `vi.fn` records the args; the double only has to answer, not read them.
  const groupBy = vi.fn((_args: GroupByArgs) => Promise.resolve([]));
  return {
    db: {
      agentComponentSessionUsage: { groupBy },
      definitionVersion: { findMany: vi.fn() },
    } as unknown as Parameters<typeof loadUsageGroupsForInventory>[0],
    groupBy,
  };
}

function emittedChunkWidths(
  groupBy: ReturnType<typeof makeFakeDb>["groupBy"]
): number[] {
  return groupBy.mock.calls.map(
    ([args]) => args.where.agentComponentId.in.length
  );
}

/**
 * Exactly two chunks' worth, so the FIRST chunk is full whatever the chunk size
 * is. A count that merely "looks large" would leave a short tail and pass under
 * the defect.
 */
const ADVERSARIAL_ID_COUNT = INVENTORY_USAGE_ID_CHUNK_SIZE * 2;

function inventoryIds(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `component-${index}`);
}

describe("loadUsageGroupsForInventory id chunking (ISS-8239)", () => {
  it("keeps a FULL chunk plus the per-statement reserve within the accepted bind ceiling", async () => {
    const { db, groupBy } = makeFakeDb();

    await loadUsageGroupsForInventory(
      db,
      ORG,
      inventoryIds(ADVERSARIAL_ID_COUNT)
    );

    const widths = emittedChunkWidths(groupBy);
    expect(widths.length).toBeGreaterThan(0);
    const widest = Math.max(...widths);
    // The full chunk is what the adversarial width exists to produce; assert it
    // is actually present, or the budget check below would be vacuous.
    expect(widest).toBe(INVENTORY_USAGE_ID_CHUNK_SIZE);
    expect(widest + BIND_PARAMETERS_RESERVED_PER_STATEMENT).toBeLessThanOrEqual(
      POSTGRES_MAX_ACCEPTED_BIND_PARAMETERS
    );
  });

  it("covers the whole id set across chunks without dropping a tail", async () => {
    const { db, groupBy } = makeFakeDb();
    const ids = inventoryIds(ADVERSARIAL_ID_COUNT + 1);

    await loadUsageGroupsForInventory(db, ORG, ids);

    const seen = groupBy.mock.calls.flatMap(
      ([args]) => args.where.agentComponentId.in
    );
    expect(seen).toEqual(ids);
  });

  it("issues no query for an empty id list", async () => {
    const { db, groupBy } = makeFakeDb();

    const result = await loadUsageGroupsForInventory(db, ORG, []);

    expect(result).toEqual([]);
    expect(groupBy).not.toHaveBeenCalled();
  });
});
