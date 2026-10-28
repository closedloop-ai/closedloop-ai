/**
 * ISS-8330 Section 4 (apply half): the phantom fold SUMS two rollups before the
 * insert, and the sum is bound into `AgentComponentSessionUsage.invocation_count`
 * / `error_count` — both Postgres `int4`.
 *
 * No bound on the wire fields can close this: each addend is legal on its own,
 * and only their sum overflows. Left unhandled the raw INSERT throws "integer
 * out of range", which fails the session's slice deterministically, so the
 * desktop re-sends the identical payload on every retry.
 *
 * The bucket is DROPPED, not clamped (whitlockk + codex review, #6370): a stored
 * `PR_INT_MAX` is indistinguishable from a real count, and these columns are
 * `_sum`-ed into org rollups. 2^31 invocations of one component in one session
 * is unreachable, so a sum past the ceiling means an addend is already corrupt
 * and the bucket has no trustworthy content to preserve.
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
import { persistSessionComponentUsage } from "./component-usage";
import type { AgentSessionUpsertTx } from "./records";

const COMPUTE_TARGET_ID = "019fa000-0000-7000-8000-000000000000";
const AGENT_SESSION_ID = "019fa111-1111-7111-8111-111111111111";
const USAGE_INSERT_BIND_PARAMETERS_PER_ROW = 13;
const INVOCATION_COUNT_BIND_OFFSET = 7;
const ERROR_COUNT_BIND_OFFSET = 8;

const SKILL_NAME = "deploy";
const SLASH_KEY = `/${SKILL_NAME}`;

/**
 * One RESOLVED skill and NO command row vouching for the slash key — the exact
 * evidence shape that makes `/deploy` a phantom, so its rollup is rewritten
 * onto the `deploy` skill bucket and merged into the survivor.
 */
function makeTx() {
  const executeRaw = vi.fn().mockResolvedValue(0);
  const queryRaw = vi.fn().mockResolvedValue([
    {
      componentKind: AgentComponentKind.Skill,
      externalComponentId: "ext-skill-deploy",
      id: "skill-row-1",
    },
  ]);
  const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
  const findMany = vi.fn().mockResolvedValue([
    {
      componentKey: SKILL_NAME,
      componentKind: AgentComponentKind.Skill,
      content: null,
      externalComponentId: "ext-skill-deploy",
      id: "skill-row-1",
      resolvedState: ComponentResolvedState.Resolved,
    },
  ]);
  const tx = {
    $executeRaw: executeRaw,
    $queryRaw: queryRaw,
    agentComponent: { findMany },
    agentComponentSessionUsage: { deleteMany },
  } as unknown as AgentSessionUpsertTx;
  return { deleteMany, executeRaw, findMany, queryRaw, tx };
}

function usage(
  overrides: Partial<SyncedComponentUsage> & {
    componentKind: string;
    componentKey: string;
  }
): SyncedComponentUsage {
  return {
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

describe("phantom-fold usage sums that overflow int4 drop their bucket (ISS-8330)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("drops the bucket instead of binding a value int4 refuses", async () => {
    const { tx, executeRaw } = makeTx();

    // Each addend is individually legal — well inside int4 — so no wire bound
    // could have rejected either one. Only the sum overflows.
    const tally = await persistSessionComponentUsage(
      tx,
      COMPUTE_TARGET_ID,
      AGENT_SESSION_ID,
      sessionWith([
        usage({
          componentKind: AgentComponentKind.Skill,
          componentKey: SKILL_NAME,
          invocations: PR_INT_MAX - 10,
          errorCount: PR_INT_MAX - 10,
        }),
        usage({
          componentKind: AgentComponentKind.Command,
          componentKey: SLASH_KEY,
          invocations: 100,
          errorCount: 100,
        }),
      ])
    );

    // No row at all for the overflowed bucket. A clamp to PR_INT_MAX passes
    // "the INSERT does not throw" while still binding a fabricated measurement,
    // so the assertion is on ABSENCE, not on the bound value.
    expect(boundCounts(executeRaw, INVOCATION_COUNT_BIND_OFFSET)).toEqual([]);
    expect(boundCounts(executeRaw, ERROR_COUNT_BIND_OFFSET)).toEqual([]);
    // A dropped bucket is a hole nothing downstream can tell from a component
    // that was never used, so it must be reported. Handed UP rather than
    // emitted here: the batch owns the one emission per request, proved in
    // `upsert-sessions-batch-usage-drops.test.ts`.
    //
    // The SKILL bucket, not the phantom's slash key: the fold rewrites the
    // phantom onto `deploy`, and `deploy` is the row that went missing, so it
    // is the one an operator has to go look at.
    expect(tally.droppedOverflowUsageBuckets).toEqual([SKILL_NAME]);
  });

  it("drops ONLY the overflowed bucket — the session's other components still persist", async () => {
    const { tx, executeRaw } = makeTx();

    // The mutation this kills: dropping the whole session's usage set, or
    // failing the slice, on one corrupt bucket. Either turns a payload whose
    // other components are perfectly good into a total loss — and because the
    // overflow is deterministic, into a loss that repeats on every retry. That
    // is the poison-retry shape ISS-8330 exists to remove.
    const tally = await persistSessionComponentUsage(
      tx,
      COMPUTE_TARGET_ID,
      AGENT_SESSION_ID,
      sessionWith([
        usage({
          componentKind: AgentComponentKind.Skill,
          componentKey: SKILL_NAME,
          invocations: PR_INT_MAX - 10,
          errorCount: 0,
        }),
        usage({
          componentKind: AgentComponentKind.Command,
          componentKey: SLASH_KEY,
          invocations: 100,
          errorCount: 0,
        }),
        usage({
          componentKind: AgentComponentKind.Skill,
          componentKey: "unaffected",
          invocations: 42,
          errorCount: 3,
        }),
      ])
    );

    expect(boundCounts(executeRaw, INVOCATION_COUNT_BIND_OFFSET)).toEqual([42]);
    expect(boundCounts(executeRaw, ERROR_COUNT_BIND_OFFSET)).toEqual([3]);
    expect(tally.droppedOverflowUsageBuckets).toEqual([SKILL_NAME]);
  });

  it("leaves a merged sum that fits int4 exactly as summed", async () => {
    const { tx, executeRaw } = makeTx();

    // The control the drop needs: an overflow predicate that always fired
    // (dropping every merged bucket), or a merge that discarded the phantom's
    // counts, both pass the test above and fail this one.
    const tally = await persistSessionComponentUsage(
      tx,
      COMPUTE_TARGET_ID,
      AGENT_SESSION_ID,
      sessionWith([
        usage({
          componentKind: AgentComponentKind.Skill,
          componentKey: SKILL_NAME,
          invocations: 7,
          errorCount: 2,
        }),
        usage({
          componentKind: AgentComponentKind.Command,
          componentKey: SLASH_KEY,
          invocations: 5,
          errorCount: 3,
        }),
      ])
    );

    expect(boundCounts(executeRaw, INVOCATION_COUNT_BIND_OFFSET)).toEqual([12]);
    expect(boundCounts(executeRaw, ERROR_COUNT_BIND_OFFSET)).toEqual([5]);
    // Silence is the default: a merge with nothing to drop reports nothing, so
    // the metric measures the defect and not ordinary phantom folding.
    expect(tally.droppedOverflowUsageBuckets).toEqual([]);
  });
});
