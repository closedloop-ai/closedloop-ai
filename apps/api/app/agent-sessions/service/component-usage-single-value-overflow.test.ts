/**
 * ISS-8881: a usage count that arrives over the wire ALREADY past the `int4`
 * ceiling drops its bucket instead of throwing.
 *
 * ISS-8330 screened the ADDENDS of a phantom-fold merge, so its guard only ever
 * ran on the fold arm — and the overwhelming majority of usage rows are never
 * folded. `invocations` / `errorCount` are `z.number().int().nonnegative()` on
 * the wire (`lib/desktop-agent-sessions-schema.ts:304-305`) and lack only a
 * `.max()`, and adding a rejecting one there is ruled out:
 * `parseDesktopAgentSessionsPayload` is ONE `safeParse` over a batch of up to
 * 200 sessions, so it would 400 the whole batch (ISS-8051). ISS-8881 moves the
 * test onto the value that actually reaches the column.
 *
 * WHICH ROWS OF THE `it.each` BELOW ARE REACHABLE, stated so they are not read
 * as live defects (marisolashgrove review): only the past-the-ceiling ones. The
 * wire already refuses negative, fractional, and non-finite counts, so those
 * rows pin the write-path predicate as DEFENCE IN DEPTH — the bound holds for a
 * value that arrived some other way — not a hole the route can reach today.
 * `lib/int4-column-bounds.ts` says the same thing about the same predicate.
 *
 * The sum case ISS-8330 covered is pinned by its own file,
 * `component-usage-merge-overflow.test.ts`, which must stay GREEN AND UNMODIFIED
 * — that is the proof this hoist did not lose it.
 *
 * A sibling file rather than more blocks in that one, for the same reason
 * `upsert-sessions-batch-index-keys.test.ts` is a sibling: the file it would
 * join is at the size ceiling.
 */
import {
  AgentComponentKind,
  ComponentResolvedState,
} from "@repo/api/src/types/agent-component";
import type {
  SyncedAgentSession,
  SyncedComponentUsage,
} from "@repo/api/src/types/agent-session";
import { PR_INT_MAX } from "@repo/api/src/types/session-artifact-link";
import type { Prisma } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { INDEX_KEY_MAX_BYTES } from "@/lib/index-key-projection";
import { persistSessionComponentUsage } from "./component-usage";
import type { AgentSessionUpsertTx } from "./records";

const COMPUTE_TARGET_ID = "019fa000-0000-7000-8000-000000000000";
const AGENT_SESSION_ID = "019fa111-1111-7111-8111-111111111111";
const USAGE_INSERT_BIND_PARAMETERS_PER_ROW = 13;
const INVOCATION_COUNT_BIND_OFFSET = 7;
const ERROR_COUNT_BIND_OFFSET = 8;

const SKILL_NAME = "deploy";
const OTHER_SKILL = "review";

/**
 * NO skill-shadow evidence at all: `findMany` returns nothing, so nothing in the
 * payload is a phantom and `foldSkillShadowedCommandUsage` is a pass-through.
 * That is the whole point of this file — it exercises the arm
 * `int4SumOverflows` never reached, so a row here is dropped by the value test
 * rather than by a merge.
 */
function makeTx() {
  const executeRaw = vi.fn().mockResolvedValue(0);
  const queryRaw = vi.fn().mockResolvedValue([]);
  const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
  const findMany = vi.fn().mockResolvedValue([]);
  const tx = {
    $executeRaw: executeRaw,
    $queryRaw: queryRaw,
    agentComponent: { findMany },
    agentComponentSessionUsage: { deleteMany },
  } as unknown as AgentSessionUpsertTx;
  return { deleteMany, executeRaw, findMany, queryRaw, tx };
}

function usage(
  overrides: Partial<SyncedComponentUsage> & { componentKey: string }
): SyncedComponentUsage {
  return {
    componentKind: AgentComponentKind.Skill,
    errorCount: 0,
    externalComponentId: null,
    firstInvokedAt: null,
    gitBranch: null,
    harness: null,
    invocations: 0,
    lastInvokedAt: null,
    ...overrides,
  } as SyncedComponentUsage;
}

function sessionWith(components: SyncedComponentUsage[]): SyncedAgentSession {
  return { components } as unknown as SyncedAgentSession;
}

/** The bind values of the emitted `INSERT ... VALUES` statements, flattened. */
function insertBindValues(executeRaw: ReturnType<typeof vi.fn>): unknown[] {
  const values: unknown[] = [];
  for (const [strings, joined] of executeRaw.mock.calls as [
    TemplateStringsArray,
    Prisma.Sql,
  ][]) {
    if (strings.join("").includes("INSERT INTO")) {
      values.push(...joined.values);
    }
  }
  return values;
}

/** The count bound at `offset` within each emitted row tuple. */
function boundCounts(
  executeRaw: ReturnType<typeof vi.fn>,
  offset: number
): number[] {
  const values = insertBindValues(executeRaw);
  const counts: number[] = [];
  for (
    let index = offset;
    index < values.length;
    index += USAGE_INSERT_BIND_PARAMETERS_PER_ROW
  ) {
    counts.push(values[index] as number);
  }
  return counts;
}

/**
 * The `keepBranches` array bound into the prune's DELETE. Bind order is
 * `[agentSessionId, groupKinds, groupKeys, keepKinds, keepKeys, keepBranches]`
 * — see `pruneStaleBranchBuckets` in `component-usage-writes.ts`.
 */
function pruneKeepBranches(
  executeRaw: ReturnType<typeof vi.fn>
): string[] | null {
  for (const [strings, ...rest] of executeRaw.mock.calls as [
    TemplateStringsArray,
    ...unknown[],
  ][]) {
    if (
      strings.join("").includes("DELETE FROM agent_component_session_usage")
    ) {
      return rest.at(-1) as string[];
    }
  }
  return null;
}

/** The `groupKeys` array bound into the prune's DELETE (second bind). */
function pruneGroupKeys(executeRaw: ReturnType<typeof vi.fn>): string[] | null {
  for (const [strings, ...rest] of executeRaw.mock.calls as [
    TemplateStringsArray,
    ...unknown[],
  ][]) {
    if (
      strings.join("").includes("DELETE FROM agent_component_session_usage")
    ) {
      return rest[2] as string[];
    }
  }
  return null;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("single-value usage counts past int4 drop their bucket (ISS-8881)", () => {
  it("drops a NOT phantom-folded row and reports its key", async () => {
    // The arm ISS-8330 could not reach: one row, no slash-keyed command
    // shadowing it, so `mergeUsage` never runs. Before this change the raw
    // INSERT bound 2^31 into an int4 column, Postgres raised 22003, and the
    // whole chunk plus the enclosing session transaction rolled back — on every
    // retry, because the payload is re-sent unchanged.
    const { executeRaw, tx } = makeTx();

    const tally = await persistSessionComponentUsage(
      tx,
      COMPUTE_TARGET_ID,
      AGENT_SESSION_ID,
      sessionWith([usage({ componentKey: SKILL_NAME, invocations: 2 ** 31 })])
    );

    // Absence, not a stored value. A clamp to PR_INT_MAX would also stop the
    // throw while binding a fabricated measurement, so asserting on the bound
    // number could not tell the two apart.
    expect(boundCounts(executeRaw, INVOCATION_COUNT_BIND_OFFSET)).toEqual([]);
    expect(tally.droppedOverflowUsageBuckets).toEqual([SKILL_NAME]);
  });

  it("keeps every sound bucket in the same payload", async () => {
    // Separates "drop the bucket" from "drop the session". This is what makes
    // the drop preferable to the throw it replaces.
    const { executeRaw, tx } = makeTx();

    const tally = await persistSessionComponentUsage(
      tx,
      COMPUTE_TARGET_ID,
      AGENT_SESSION_ID,
      sessionWith([
        usage({ componentKey: SKILL_NAME, invocations: 2 ** 31 }),
        usage({ componentKey: OTHER_SKILL, errorCount: 3, invocations: 42 }),
      ])
    );

    expect(boundCounts(executeRaw, INVOCATION_COUNT_BIND_OFFSET)).toEqual([42]);
    expect(boundCounts(executeRaw, ERROR_COUNT_BIND_OFFSET)).toEqual([3]);
    expect(tally.droppedOverflowUsageBuckets).toEqual([SKILL_NAME]);
  });

  it("stores the exact int4 ceiling and the value below it", async () => {
    // The boundary. Measured on origin/main, the surviving Stryker mutant at
    // `int4SumOverflows` was EqualityOperator (`>` -> `>=`), i.e. nothing pinned
    // the ceiling itself — a guard written as `>=` would silently refuse a legal
    // count and this is the case that catches it.
    const { executeRaw, tx } = makeTx();

    const tally = await persistSessionComponentUsage(
      tx,
      COMPUTE_TARGET_ID,
      AGENT_SESSION_ID,
      sessionWith([
        usage({ componentKey: SKILL_NAME, invocations: PR_INT_MAX }),
        usage({ componentKey: OTHER_SKILL, invocations: PR_INT_MAX - 1 }),
      ])
    );

    expect(boundCounts(executeRaw, INVOCATION_COUNT_BIND_OFFSET)).toEqual([
      PR_INT_MAX,
      PR_INT_MAX - 1,
    ]);
    expect(tally.droppedOverflowUsageBuckets).toEqual([]);
  });

  it.each([
    ["one past the ceiling", PR_INT_MAX + 1],
    ["negative", -1],
    ["fractional", 1.5],
    ["infinite", Number.POSITIVE_INFINITY],
    ["NaN", Number.NaN],
  ])("drops a %s invocation count", async (_label, invocations) => {
    // The whole impossible set, not just "too big". A fractional or negative
    // count renders as a confident measurement exactly like an overflowed one,
    // and nothing upstream refuses either.
    const { executeRaw, tx } = makeTx();

    const tally = await persistSessionComponentUsage(
      tx,
      COMPUTE_TARGET_ID,
      AGENT_SESSION_ID,
      sessionWith([usage({ componentKey: SKILL_NAME, invocations })])
    );

    expect(boundCounts(executeRaw, INVOCATION_COUNT_BIND_OFFSET)).toEqual([]);
    expect(tally.droppedOverflowUsageBuckets).toEqual([SKILL_NAME]);
  });

  it("screens errorCount as well as invocations", async () => {
    // Both columns are int4; guarding only the headline counter would leave the
    // other one throwing.
    const { executeRaw, tx } = makeTx();

    const tally = await persistSessionComponentUsage(
      tx,
      COMPUTE_TARGET_ID,
      AGENT_SESSION_ID,
      sessionWith([
        usage({
          componentKey: SKILL_NAME,
          errorCount: 2 ** 31,
          invocations: 1,
        }),
      ])
    );

    expect(boundCounts(executeRaw, ERROR_COUNT_BIND_OFFSET)).toEqual([]);
    expect(tally.droppedOverflowUsageBuckets).toEqual([SKILL_NAME]);
  });

  it("never stores the ceiling in place of an unstorable count", async () => {
    // THE ANTI-CLAMP ASSERTION. The mutation it kills is someone replacing the
    // drop with `Math.min(value, PR_INT_MAX)`: that passes "the INSERT does not
    // throw" while persisting a number indistinguishable from a real count, and
    // these columns are `_sum`-ed into org rollups (#6370).
    const { executeRaw, tx } = makeTx();

    await persistSessionComponentUsage(
      tx,
      COMPUTE_TARGET_ID,
      AGENT_SESSION_ID,
      sessionWith([usage({ componentKey: SKILL_NAME, invocations: 2 ** 31 })])
    );

    expect(insertBindValues(executeRaw)).not.toContain(PR_INT_MAX);
  });

  it("reports the RAW component key even when the projection rewrites it", async () => {
    // `projectComponentUsageIndexKeys` hashes an over-long key down before it
    // reaches a column. The REPORTED name must stay the raw one — that is what
    // the phantom-fold arm reported before ISS-8881 moved this check, so a short
    // fixture key would make the two spellings identical and this regression
    // would go unnoticed.
    const longKey = "k".repeat(INDEX_KEY_MAX_BYTES + 1);
    const { tx } = makeTx();

    const tally = await persistSessionComponentUsage(
      tx,
      COMPUTE_TARGET_ID,
      AGENT_SESSION_ID,
      sessionWith([usage({ componentKey: longKey, invocations: 2 ** 31 })])
    );

    expect(tally.droppedOverflowUsageBuckets).toEqual([longKey]);
  });

  it("leaves a sibling branch's stored row in the prune keep-set", async () => {
    // REGRESSION, and the sharpest case in this file. `pruneStaleBranchBuckets`
    // treats the usage set as authoritative for every branch of a (kind, key)
    // group it still contains: it DELETEs any stored branch bucket that group no
    // longer lists. If the dropped bucket were hidden from the prune, then a
    // component reporting branch A (sound) and branch B (corrupt) in one sync
    // would keep group `deploy` alive via A while B vanished from the keep-set —
    // deleting B's previously stored GOOD row and never replacing it. Today the
    // payload throws at the INSERT and deletes nothing, so that would be data
    // loss introduced by this change, on partially corrupt input.
    //
    // The fix is that only the INSERT is narrowed; the prune keeps reading the
    // full set. This asserts branch B is still in the keep-set while only branch
    // A is written.
    const { executeRaw, tx } = makeTx();

    await persistSessionComponentUsage(
      tx,
      COMPUTE_TARGET_ID,
      AGENT_SESSION_ID,
      sessionWith([
        usage({
          componentKey: SKILL_NAME,
          gitBranch: "feat/a",
          invocations: 7,
        }),
        usage({
          componentKey: SKILL_NAME,
          gitBranch: "feat/b",
          invocations: 2 ** 31,
        }),
      ])
    );

    expect(pruneKeepBranches(executeRaw)).toEqual(
      expect.arrayContaining(["feat/a", "feat/b"])
    );
    expect(boundCounts(executeRaw, INVOCATION_COUNT_BIND_OFFSET)).toEqual([7]);
  });

  it("withholds a dropped bucket's legacy group from the prune", async () => {
    // SECOND data-loss hole, narrower than the sibling-branch one above.
    // `legacyGroups` carries the PRE-projection (kind, key) of a group the
    // projection re-keyed, and it is added to the prune's DELETE group set but
    // never to its keep-set — deliberately, so the row stored under the raw key
    // is deleted and re-inserted under the projected one. That promise breaks
    // when the bucket is dropped: the delete fires and no insert replaces it.
    // So a dropped bucket's legacy group is withheld. The mutation this kills is
    // passing `projection.legacyGroups` through unfiltered.
    const longKey = "k".repeat(INDEX_KEY_MAX_BYTES + 1);
    const { executeRaw, tx } = makeTx();

    await persistSessionComponentUsage(
      tx,
      COMPUTE_TARGET_ID,
      AGENT_SESSION_ID,
      sessionWith([usage({ componentKey: longKey, invocations: 2 ** 31 })])
    );

    // Bind order is [agentSessionId, groupKinds, groupKeys, keepKinds,
    // keepKeys, keepBranches]; the raw over-long key must appear in NO group.
    expect(pruneGroupKeys(executeRaw) ?? []).not.toContain(longKey);
  });

  it("withholds a legacy group whose sibling branch was dropped", async () => {
    // The mixed-branch legacy case, and the sharpest of the three. A legacy
    // group enters the prune's DELETE set and NEVER its keep-set — the keep-set
    // is built from PROJECTED keys — so every branch stored under the raw key
    // dies together, on the promise that each is re-inserted under the projected
    // key. Keeping the group because branch A is sound therefore deletes branch
    // B's raw row with nothing to replace it: the same permanent loss the
    // sibling-branch case above rules out, reached through the legacy path
    // instead of the keep-set. Today that payload throws at the INSERT and
    // deletes nothing, so keeping the group would be data loss introduced here.
    //
    // The mutation this kills is scoping the withhold to groups that lost EVERY
    // insertable row (`insertableRawGroups.has(...)`), which is what this file
    // asserted before ISS-8881's review. Deferring the migration one re-sync is
    // the cost; branch A still writes under its projected key meanwhile.
    const longKey = "k".repeat(INDEX_KEY_MAX_BYTES + 1);
    const { executeRaw, tx } = makeTx();

    await persistSessionComponentUsage(
      tx,
      COMPUTE_TARGET_ID,
      AGENT_SESSION_ID,
      sessionWith([
        usage({ componentKey: longKey, gitBranch: "feat/a", invocations: 7 }),
        usage({
          componentKey: longKey,
          gitBranch: "feat/b",
          invocations: 2 ** 31,
        }),
      ])
    );

    expect(pruneGroupKeys(executeRaw) ?? []).not.toContain(longKey);
    // The withhold defers the MIGRATION, not the write: the sound branch is
    // still inserted under the projected key, and only it.
    expect(boundCounts(executeRaw, INVOCATION_COUNT_BIND_OFFSET)).toEqual([7]);
  });

  it("keeps a legacy group whose every claimed branch is storable", async () => {
    // The other half: the withhold must be scoped to groups that actually lost a
    // bucket, or one corrupt component would suppress the ISS-8253 migration for
    // every re-keyed group in the payload. Mutation killed: filtering the legacy
    // set to `[]` outright.
    const longKey = "k".repeat(INDEX_KEY_MAX_BYTES + 1);
    const { executeRaw, tx } = makeTx();

    await persistSessionComponentUsage(
      tx,
      COMPUTE_TARGET_ID,
      AGENT_SESSION_ID,
      sessionWith([
        usage({ componentKey: longKey, gitBranch: "feat/a", invocations: 7 }),
        usage({ componentKey: longKey, gitBranch: "feat/b", invocations: 9 }),
      ])
    );

    expect(pruneGroupKeys(executeRaw) ?? []).toContain(longKey);
  });

  it("writes nothing and reports nothing for an all-sound payload", async () => {
    // Silence is the default: the tally must measure the defect, not sync
    // traffic, or the batch emission below it becomes noise.
    const { executeRaw, tx } = makeTx();

    const tally = await persistSessionComponentUsage(
      tx,
      COMPUTE_TARGET_ID,
      AGENT_SESSION_ID,
      sessionWith([
        usage({ componentKey: SKILL_NAME, errorCount: 1, invocations: 5 }),
      ])
    );

    expect(boundCounts(executeRaw, INVOCATION_COUNT_BIND_OFFSET)).toEqual([5]);
    expect(tally.droppedOverflowUsageBuckets).toEqual([]);
  });
});

describe("the phantom-fold arm still resolves through the same check", () => {
  it("keeps a merged sum that fits", async () => {
    // Guards the hoist from the other side: removing `mergeUsage`'s own overflow
    // branch must not change what a NON-overflowing merge stores.
    const findManyRows = [
      {
        componentKey: SKILL_NAME,
        componentKind: AgentComponentKind.Skill,
        content: null,
        externalComponentId: "ext-skill-deploy",
        id: "skill-row-1",
        resolvedState: ComponentResolvedState.Resolved,
      },
    ];
    const { executeRaw, findMany, queryRaw, tx } = makeTx();
    findMany.mockResolvedValue(findManyRows);
    queryRaw.mockResolvedValue([
      {
        componentKind: AgentComponentKind.Skill,
        externalComponentId: "ext-skill-deploy",
        id: "skill-row-1",
      },
    ]);

    const tally = await persistSessionComponentUsage(
      tx,
      COMPUTE_TARGET_ID,
      AGENT_SESSION_ID,
      sessionWith([
        usage({ componentKey: SKILL_NAME, invocations: 4 }),
        usage({
          componentKey: `/${SKILL_NAME}`,
          componentKind: AgentComponentKind.Command,
          invocations: 6,
        }),
      ])
    );

    expect(boundCounts(executeRaw, INVOCATION_COUNT_BIND_OFFSET)).toEqual([10]);
    expect(tally.droppedOverflowUsageBuckets).toEqual([]);
  });
});
