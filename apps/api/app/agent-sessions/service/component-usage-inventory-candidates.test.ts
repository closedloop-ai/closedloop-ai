/**
 * ISS-8200: the usage lane resolving its `agentComponentId` FK against an
 * inventory row written before ISS-8069 projected these columns.
 *
 * The caller's pairs are already projected, so the join matched every row
 * written since. A legacy row still holding the RAW 513-2704-byte value was
 * missed, and the usage row then persisted with `agent_component_id` silently
 * NULL — a measurement that lands unlinked from the inventory it describes, and
 * that nothing ever re-links.
 */
import { describe, expect, it, vi } from "vitest";
import {
  INDEX_KEY_MAX_BYTES,
  projectIndexKey,
} from "@/lib/index-key-projection";
import { loadComponentInventoryRows } from "./component-usage-writes";

const COMPUTE_TARGET_ID = "target-usage-1";
const OVER_BUDGET_EXTERNAL_ID = "e".repeat(INDEX_KEY_MAX_BYTES + 1);
const PROJECTED_EXTERNAL_ID = projectIndexKey(OVER_BUDGET_EXTERNAL_ID).value;

/**
 * Capture the two arrays the statement unnests. `$queryRaw` is a tagged
 * template, so `call[1]` and `call[2]` are the interpolated kind/external-id
 * arrays in the order the SQL binds them.
 */
function capturingTx() {
  const queryRaw = vi.fn().mockResolvedValue([]);
  return {
    tx: { $queryRaw: queryRaw } as never,
    boundPairs(): [string, string][] {
      const [, kinds, externalIds] = queryRaw.mock.calls[0] as [
        unknown,
        string[],
        string[],
      ];
      return kinds.map((kind, index) => [kind, externalIds[index]]);
    },
  };
}

describe("loadComponentInventoryRows", () => {
  it("asks for the legacy RAW identity as well as the projected one", async () => {
    const { tx, boundPairs } = capturingTx();

    // The RAW identity, which is the only value the projected key can be
    // derived FROM — the projection is lossy, so handing this the already
    // projected id could never recover the legacy row.
    await loadComponentInventoryRows(tx, COMPUTE_TARGET_ID, [
      { componentKind: "skill", externalComponentId: OVER_BUDGET_EXTERNAL_ID },
    ]);

    // The projected key is what the caller holds; the raw key is the one a
    // pre-ISS-8069 row is still stored under. Both must reach the unnest, or
    // the FK resolves NULL for exactly the components this ticket is about.
    expect(boundPairs()).toEqual(
      expect.arrayContaining([
        ["skill", PROJECTED_EXTERNAL_ID],
        ["skill", OVER_BUDGET_EXTERNAL_ID],
      ])
    );
  });

  it("binds exactly one pair for an identity inside the byte budget", async () => {
    // Every real component, so the statement's width is unchanged for ordinary
    // traffic — the candidate union must not widen the common payload.
    const { tx, boundPairs } = capturingTx();

    await loadComponentInventoryRows(tx, COMPUTE_TARGET_ID, [
      { componentKind: "skill", externalComponentId: "skill::my-skill" },
    ]);

    expect(boundPairs()).toEqual([["skill", "skill::my-skill"]]);
  });

  it("issues no statement at all when there are no pairs", async () => {
    const { tx } = capturingTx();

    expect(await loadComponentInventoryRows(tx, COMPUTE_TARGET_ID, [])).toEqual(
      []
    );
    expect(
      (tx as { $queryRaw: ReturnType<typeof vi.fn> }).$queryRaw
    ).not.toHaveBeenCalled();
  });
});
