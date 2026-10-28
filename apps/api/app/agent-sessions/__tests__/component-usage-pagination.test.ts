/**
 * @file component-usage-pagination.test.ts
 * @description ISS-6884 — the CLOUD half of the component-usage pagination
 * contract. The desktop now splits an over-cap usage set across sync parts on
 * whole `(componentKind, componentKey)` boundaries instead of truncating it to a
 * permanent subset. That is only safe because `persistSessionComponentUsage`
 * prunes per GROUP, never per session: for a group PRESENT in a part it drops the
 * branch buckets that part omits, and a group ABSENT from a part is left
 * untouched.
 *
 * These tests pin that property directly, because it is what makes the split
 * lossless on a NEW and an OLD server alike — no capability negotiation, no wire
 * schema change. If the prune ever widened to the session (a replace-all), a
 * later part would silently delete the rows an earlier part just wrote, turning
 * pagination into data loss.
 */
import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import type { SyncedComponentUsage } from "@repo/api/src/types/agent-session";
import { describe, expect, it, vi } from "vitest";
import {
  decodeBranchBucketPrune,
  isBranchBucketPrune,
} from "../../../__tests__/support/agent-sessions/component-usage-sync.test-harness";

function sqlTag(
  strings: TemplateStringsArray | readonly string[],
  ...expressions: unknown[]
): { strings: string[]; values: unknown[] } {
  return {
    strings: [...strings],
    values: expressions.flatMap((expression) =>
      expression && Array.isArray((expression as { values?: unknown[] }).values)
        ? (expression as { values: unknown[] }).values
        : [expression]
    ),
  };
}

function sqlJoin(fragments: readonly unknown[]): { values: unknown[] } {
  return {
    values: fragments.flatMap((fragment) =>
      fragment && Array.isArray((fragment as { values?: unknown[] }).values)
        ? (fragment as { values: unknown[] }).values
        : [fragment]
    ),
  };
}

vi.mock("@repo/database", () => ({
  Prisma: { join: sqlJoin, sql: sqlTag },
}));

import { persistSessionComponentUsage } from "../service/component-usage";

const COMPUTE_TARGET_ID = "target-pagination-1";
const SESSION_ARTIFACT_ID = "session-artifact-pagination-1";
// MIRRORS the column list in `persistSessionComponentUsage`'s raw INSERT. It is
// positional, so a column added there without widening this shifts every field
// by one and the failures read as pagination bugs rather than a stale stride.
// ISS-7259 took it from 12 to 13 (`is_first_attributed_skill`).
const VALUES_PER_ROW = 13;

type PruneClause = {
  componentKind: string;
  componentKey: string;
  gitBranch: { notIn: string[] };
};

type WrittenRow = {
  componentKind: string;
  componentKey: string;
  gitBranch: string;
};

function buildUsage(
  componentKey: string,
  gitBranch: string | null = null
): SyncedComponentUsage {
  return {
    componentKind: AgentComponentKind.Tool,
    componentKey,
    externalComponentId: null,
    harness: "claude",
    invocations: 3,
    errorCount: 0,
    firstInvokedAt: "2026-06-10T10:00:00.000Z",
    lastInvokedAt: "2026-06-10T10:30:00.000Z",
    gitBranch,
    componentVersionHash: null,
  };
}

/**
 * A transaction stub that records what the persist actually asked the database
 * to delete and to write. Only the three surfaces this path touches are
 * implemented; a usage set with no slash-keyed command rows never reads the
 * skill-shadow inventory.
 */
function buildTx() {
  const pruneClauses: PruneClause[] = [];
  const writtenRows: WrittenRow[] = [];
  const deleteMany = vi.fn((input: { where?: { OR?: PruneClause[] } }) => {
    pruneClauses.push(...(input.where?.OR ?? []));
    return Promise.resolve({ count: 0 });
  });
  const executeRaw = vi.fn(
    (
      strings: TemplateStringsArray | readonly string[],
      ...expressions: unknown[]
    ) => {
      // ISS-8062: the FEA-2990 prune is a raw DELETE now, not a `deleteMany`.
      // Route it back through the same recorder so the prune assertions below
      // keep reading the clauses they always did — the SHARED decoder, so this
      // stub and the sync harness can never disagree about the statement's
      // meaning.
      if (isBranchBucketPrune(strings)) {
        deleteMany(decodeBranchBucketPrune(expressions));
        return Promise.resolve(0);
      }
      const values = expressions.flatMap((expression) =>
        expression &&
        Array.isArray((expression as { values?: unknown[] }).values)
          ? (expression as { values: unknown[] }).values
          : [expression]
      );
      for (let index = 0; index < values.length; index += VALUES_PER_ROW) {
        const [, , componentKind, componentKey, gitBranch] = values.slice(
          index,
          index + VALUES_PER_ROW
        );
        if (componentKind === undefined) {
          continue;
        }
        writtenRows.push({
          componentKind: componentKind as string,
          componentKey: componentKey as string,
          gitBranch: gitBranch as string,
        });
      }
      return Promise.resolve(0);
    }
  );
  const tx = {
    $executeRaw: executeRaw,
    agentComponent: { findMany: vi.fn().mockResolvedValue([]) },
    agentComponentSessionUsage: { deleteMany },
  };
  return { deleteMany, pruneClauses, tx, writtenRows };
}

async function applyPart(
  tx: ReturnType<typeof buildTx>["tx"],
  components: SyncedComponentUsage[]
): Promise<void> {
  await persistSessionComponentUsage(
    // The persist only reaches the three surfaces the stub implements.
    tx as never,
    COMPUTE_TARGET_ID,
    SESSION_ARTIFACT_ID,
    { components } as never
  );
}

describe("ISS-6884: component-usage pagination is lossless cloud-side", () => {
  it("prunes only the groups a part actually carries, never a group it omits", async () => {
    const partOne = [buildUsage("tool-a"), buildUsage("tool-b")];
    const partTwo = [buildUsage("tool-c"), buildUsage("tool-d")];
    const harness = buildTx();

    await applyPart(harness.tx, partOne);
    await applyPart(harness.tx, partTwo);

    expect(harness.deleteMany).toHaveBeenCalledTimes(2);
    const prunedKeys = harness.pruneClauses.map(
      (clause) => clause.componentKey
    );
    // Part two's prune must not name part one's groups — otherwise the later
    // part deletes the rows the earlier part just wrote.
    expect(prunedKeys.sort()).toEqual(["tool-a", "tool-b", "tool-c", "tool-d"]);
    for (const clause of harness.pruneClauses) {
      expect(clause.gitBranch.notIn).toEqual([""]);
    }
  });

  it("writes the union of two disjoint parts, each row exactly once", async () => {
    const partOne = [buildUsage("tool-a"), buildUsage("tool-b", "feat/one")];
    const partTwo = [buildUsage("tool-c"), buildUsage("tool-b2", "feat/two")];
    const harness = buildTx();

    await applyPart(harness.tx, partOne);
    await applyPart(harness.tx, partTwo);

    const written = harness.writtenRows.map(
      (row) => `${row.componentKey}|${row.gitBranch}`
    );
    expect(written.sort()).toEqual([
      "tool-a|",
      "tool-b2|feat/two",
      "tool-b|feat/one",
      "tool-c|",
    ]);
    expect(new Set(written).size).toBe(written.length);
  });

  it("keeps every branch bucket of a group carried whole in one part", async () => {
    const wholeGroup = [
      buildUsage("tool-multi", "feat/one"),
      buildUsage("tool-multi", "feat/two"),
      buildUsage("tool-multi", "feat/three"),
    ];
    const harness = buildTx();

    await applyPart(harness.tx, wholeGroup);

    // The prune keeps exactly the branch set the part declared: a group split
    // across parts would have declared a SUBSET here and deleted the rest.
    expect(harness.pruneClauses).toHaveLength(1);
    expect(harness.pruneClauses[0]?.gitBranch.notIn.sort()).toEqual([
      "feat/one",
      "feat/three",
      "feat/two",
    ]);
    expect(harness.writtenRows).toHaveLength(3);
  });
});
