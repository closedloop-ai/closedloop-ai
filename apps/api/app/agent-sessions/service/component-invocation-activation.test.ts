import { AgentComponentInvocationAttributionStatus } from "@repo/api/src/types/agent-component-invocation";
import { Prisma } from "@repo/database";
import { describe, expect, it } from "vitest";
import { buildItem } from "@/__tests__/support/agent-sessions/service/component-invocations.test-db";
import {
  type ActivationRow,
  type ActiveInvocationRow,
  type PersistedInvocation,
  persistedInvocation,
  planActiveRowDelta,
} from "./component-invocation-activation";
import { persistedAnchor } from "./component-invocation-helpers";
import { stagedInvocationRow } from "./component-invocation-wire-row";

/** A resolved incoming row, as activation builds it from a staged wire item. */
function incoming(
  overrides: Parameters<typeof buildItem>[0] = {}
): PersistedInvocation {
  const row = stagedInvocationRow("staged-1", buildItem(overrides));
  return persistedInvocation(row, {
    id: row.id,
    agentComponentId: null,
    attributionStatus: AgentComponentInvocationAttributionStatus.Unresolved,
    definitionHash: row.definitionHash,
    normalizerContractVersion: row.normalizerContractVersion,
    definitionVersionId: null,
    sourceOccurrenceId: null,
  });
}

/**
 * The same row as Postgres hands it back: a fresh Date instance, the cost as a
 * Decimal, jsonb with its keys reordered, and every column present.
 */
function stored(columns: PersistedInvocation, id: string): ActiveInvocationRow {
  const anchor = JSON.parse(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(persistedAnchor(columns.anchor)).reverse()
      )
    )
  );
  return {
    ...columns,
    id,
    partId: "part-1",
    durationMs: columns.durationMs ?? null,
    invokedAt:
      columns.invokedAt === null ? null : new Date(columns.invokedAt.getTime()),
    estimatedCost:
      columns.estimatedCost === null
        ? null
        : new Prisma.Decimal(Number(columns.estimatedCost).toFixed(6)),
    anchor,
  };
}

function next(columns: PersistedInvocation, partIndex = 0): ActivationRow {
  return { partIndex, columns };
}

describe("ISS-12781 planActiveRowDelta", () => {
  it("leaves a row whose stored columns all match untouched", () => {
    const columns = incoming({
      externalInvocationId: "a",
      estimatedCost: 0.123_456,
      inputTokens: 1200,
      model: "claude-opus",
      anchor: { kind: "event", eventId: "event-a" },
    });

    const delta = planActiveRowDelta(
      [stored(columns, "row-a")],
      [next(columns)]
    );

    expect(delta).toEqual({
      deleteIds: [],
      inserts: [],
      delta: {
        activeRows: 1,
        unchanged: 1,
        rewritten: 0,
        inserted: 0,
        deleted: 0,
      },
    });
  });

  it.each([
    ["sequence", { sequence: 5 }],
    ["rawName", { rawName: "renamed" }],
    ["invokedAt", { invokedAt: "2026-07-22T11:59:00.001Z" }],
    ["estimatedCost", { estimatedCost: 0.123_457 }],
    ["anchor", { anchor: { kind: "event", eventId: "event-b" } }],
  ] as const)("rewrites a row whose %s changed", (_column, change) => {
    const before = incoming({
      externalInvocationId: "a",
      estimatedCost: 0.123_456,
    });
    const after = incoming({
      externalInvocationId: "a",
      estimatedCost: 0.123_456,
      ...change,
    });
    const update = next(after);

    const delta = planActiveRowDelta([stored(before, "row-a")], [update]);

    expect(delta).toEqual({
      deleteIds: ["row-a"],
      inserts: [update],
      delta: {
        activeRows: 1,
        unchanged: 0,
        rewritten: 1,
        inserted: 0,
        deleted: 0,
      },
    });
  });

  it("rewrites a row whose resolution changed even when its wire item did not", () => {
    const before = incoming({ externalInvocationId: "a" });
    const after = { ...before, agentComponentId: "component-1" };

    const delta = planActiveRowDelta([stored(before, "row-a")], [next(after)]);

    expect(delta.deleteIds).toEqual(["row-a"]);
  });

  it("inserts a new row and deletes one the generation no longer holds", () => {
    const kept = incoming({ externalInvocationId: "a" });
    const added = next(incoming({ externalInvocationId: "b", sequence: 1 }), 1);

    const delta = planActiveRowDelta(
      [
        stored(kept, "row-a"),
        stored(incoming({ externalInvocationId: "gone" }), "row-gone"),
      ],
      [next(kept), added]
    );

    expect(delta).toEqual({
      deleteIds: ["row-gone"],
      inserts: [added],
      delta: {
        activeRows: 2,
        unchanged: 1,
        rewritten: 0,
        inserted: 1,
        deleted: 1,
      },
    });
  });

  it("counts each kind of change separately", () => {
    const columns = (id: string, sequence: number) =>
      incoming({ externalInvocationId: id, sequence });
    const kept = ["a", "b"].map((id, sequence) => columns(id, sequence));
    const changed = columns("c", 2);
    const gone = ["d", "h", "i"].map((id, index) => columns(id, 3 + index));
    const added = ["e", "f", "g", "j"].map((id, index) =>
      next(columns(id, 3 + index))
    );

    const plan = planActiveRowDelta(
      [...kept, changed, ...gone].map((row, index) =>
        stored(row, `row-${index}`)
      ),
      [
        ...kept.map((row) => next(row)),
        next({ ...changed, rawName: "new" }),
      ].concat(added)
    );

    expect(plan.delta).toEqual({
      activeRows: 6,
      unchanged: 2,
      rewritten: 1,
      inserted: 4,
      deleted: 3,
    });
  });

  it("refuses a generation that carries one id twice instead of keeping either", () => {
    const row = incoming({ externalInvocationId: "a" });

    expect(() => planActiveRowDelta([], [next(row), next(row)])).toThrow(
      "Duplicate invocation id"
    );
  });
});
