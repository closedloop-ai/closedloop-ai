/**
 * ISS-6757: the predicate `loadAgentComponentInvocationReadPage` hands to BOTH
 * of its reads.
 *
 * The fallback arm — the one that picks up invocations no inventory row has
 * claimed — used to filter `componentKey` with `mode: "insensitive"`, which
 * Prisma compiles to ILIKE. No btree can serve ILIKE, so the arm's only
 * sargable predicate was `agent_component_id IS NULL`: every unattributed
 * invocation in the table, across every tenant, since that table carries no
 * `organization_id` column. It now filters the persisted `componentKeyNormalized`
 * projection with an equality, served by
 * `idx_aci_kind_key_normalized_unattributed`.
 *
 * The `where` is asserted where it is DECIDED, not through a mocked service:
 * this drives the real reader against a fake client and reads back what each
 * delegate was actually called with. That the paired `groupBy` — which has no
 * `take` to bound it — carries the SAME predicate is the half a `findMany`-only
 * assertion would miss.
 */
import type { AgentComponentInvocationAttributionStatus } from "@repo/api/src/types/agent-component-invocation";
import { describe, expect, it, vi } from "vitest";
import { loadAgentComponentInvocationReadPage } from "../service/invocation-read";

const ORGANIZATION_ID = "org-1";
const KIND = "subagent";
/** The provider's raw case, which is what a detail slug can still carry. */
const RAW_CASE_KEY = "Explore";
const FOLDED_KEY = "explore";
const INVENTORY_IDS = ["component-1", "component-2"];

type CapturedArgs = { where?: Record<string, unknown> };

type ReadCapture = {
  findMany: CapturedArgs[];
  groupBy: CapturedArgs[];
};

describe("loadAgentComponentInvocationReadPage fallback predicate", () => {
  it("matches the persisted folded key instead of an ILIKE on componentKey", async () => {
    const captured = await runRead({ inventoryIds: INVENTORY_IDS });
    const fallback = fallbackArm(captured.findMany[0]);

    expect(fallback).toEqual({
      agentComponentId: null,
      componentKind: KIND,
      componentKeyNormalized: FOLDED_KEY,
    });
    // Stated as its own assertion: the arm having the new key is not the same
    // claim as it no longer carrying the old one, and only the second is what
    // stops the ILIKE scan coming back alongside it.
    expect(fallback).not.toHaveProperty("componentKey");
  });

  it("applies the same predicate to the UNCAPPED groupBy, not only the capped findMany", async () => {
    const captured = await runRead({ inventoryIds: INVENTORY_IDS });

    // `findMany` carries AGENT_COMPONENT_INVOCATION_READ_MAX_ROWS; the status
    // counts have no `take` at all, so an unindexed predicate here could not
    // early-terminate the way the capped read implies.
    expect(captured.groupBy[0].where).toEqual(captured.findMany[0].where);
  });

  it("keeps the inventory arm intact beside the fallback", async () => {
    const captured = await runRead({ inventoryIds: INVENTORY_IDS });

    expect(orClauses(captured.findMany[0])[0]).toEqual({
      agentComponentId: { in: INVENTORY_IDS },
    });
    expect(orClauses(captured.findMany[0])).toHaveLength(2);
  });

  it("collapses to the fallback alone for an orphan-only component", async () => {
    // `buildOrphanOnlyDetail` passes an empty `inventoryIds`, so this arm is the
    // whole predicate — the shape the pre-index plan seq-scanned the table for.
    const captured = await runRead({ inventoryIds: [] });

    expect(orClauses(captured.findMany[0])).toHaveLength(1);
    expect(fallbackArm(captured.findMany[0])).toEqual({
      agentComponentId: null,
      componentKind: KIND,
      componentKeyNormalized: FOLDED_KEY,
    });
  });

  it("still scopes every read to the requesting organization", async () => {
    const captured = await runRead({ inventoryIds: INVENTORY_IDS });

    // The table has no `organization_id`, so this relation filter is the ONLY
    // tenant boundary on the read. Narrowing the key predicate must not have
    // moved it.
    expect(captured.findMany[0].where?.generation).toEqual({
      activeAt: { not: null },
      completedAt: { not: null },
      session: { artifact: { organizationId: ORGANIZATION_ID } },
    });
  });
});

async function runRead(options: {
  inventoryIds: string[];
}): Promise<ReadCapture> {
  const capture: ReadCapture = { findMany: [], groupBy: [] };
  const findMany = vi.fn((args: CapturedArgs) => {
    capture.findMany.push(args);
    return Promise.resolve([]);
  });
  const groupBy = vi.fn((args: CapturedArgs) => {
    capture.groupBy.push(args);
    return Promise.resolve(
      [] as {
        attributionStatus: AgentComponentInvocationAttributionStatus;
        _count: { _all: number };
      }[]
    );
  });
  const db = {
    agentComponentInvocation: { findMany, groupBy },
    sourceOccurrence: { findMany: vi.fn(() => Promise.resolve([])) },
  };

  await loadAgentComponentInvocationReadPage(
    // A partial client: this reader touches only the two delegates above plus
    // `sourceOccurrence`, and a full PrismaClient double would obscure that.
    db as unknown as Parameters<typeof loadAgentComponentInvocationReadPage>[0],
    {
      organizationId: ORGANIZATION_ID,
      kind: KIND,
      key: RAW_CASE_KEY,
      inventoryIds: options.inventoryIds,
    }
  );

  // A precondition, not an assertion: every case below indexes [0] on both
  // captures, so a reader that stopped issuing one of the two would otherwise
  // read `undefined` and fail somewhere less legible.
  if (capture.findMany.length !== 1 || capture.groupBy.length !== 1) {
    throw new Error(
      `invocation read: expected one findMany and one groupBy, got ${capture.findMany.length} and ${capture.groupBy.length}`
    );
  }
  return capture;
}

function orClauses(args: CapturedArgs): Record<string, unknown>[] {
  const or = args.where?.OR;
  if (!Array.isArray(or)) {
    throw new Error(
      `invocation read: expected an OR predicate, got ${JSON.stringify(args.where)}`
    );
  }
  return or;
}

/** The arm keyed on `agentComponentId: null` — the unattributed fallback. */
function fallbackArm(args: CapturedArgs): Record<string, unknown> {
  const arm = orClauses(args).find(
    (clause) => clause.agentComponentId === null
  );
  if (!arm) {
    throw new Error(
      `invocation read: no fallback arm in ${JSON.stringify(args.where)}`
    );
  }
  return arm;
}
