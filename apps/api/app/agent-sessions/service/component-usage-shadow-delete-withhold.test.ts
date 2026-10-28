/**
 * ISS-8881 (davetho review): the shadowed-`command` DELETE is withheld when
 * the skill row that was supposed to replace it is not being written.
 *
 * ISS-4778 step 2b deletes a phantom's stored `command` rows on the promise
 * that the fold re-inserts their counts under the skill identity. ISS-8881
 * added a way to break that promise: `partitionStorableUsages` drops a bucket
 * whose count cannot be stored, so the delete can fire with no replacement
 * insert. On base the overflowing INSERT raised `22003` and rolled the whole
 * transaction back, deleting nothing; making that write succeed is exactly what
 * turns a wedged sync into SILENT, PERMANENT data loss — the payload is
 * deterministic and re-sent every sync, so the empty insert commits again on
 * every retry.
 *
 * This is the same defect the legacy-group deferral in `partitionStorableUsages`
 * rules out, reached through the OTHER delete on this lane.
 *
 * `deleteShadowedCommandRows` filters on `componentKey` with NO branch
 * predicate, so the third case below is not redundant: one unstorable branch
 * poisons the delete for every branch under that key.
 *
 * A sibling file rather than blocks inside `component-usage-merge-overflow.test.ts`:
 * that file is ISS-8330's, and this PR's evidence that the §2 hoist kept the sum
 * case is that it stays green and unmodified. It also asserts on `$executeRaw`
 * inserts, where this one asserts on the `deleteMany` those inserts were
 * supposed to justify.
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
import { beforeEach, describe, expect, it, vi } from "vitest";
import { persistSessionComponentUsage } from "./component-usage";
import type { AgentSessionUpsertTx } from "./records";

const COMPUTE_TARGET_ID = "019fa000-0000-7000-8000-000000000000";
const AGENT_SESSION_ID = "019fa111-1111-7111-8111-111111111111";
const SKILL_NAME = "deploy";
const SLASH_KEY = `/${SKILL_NAME}`;

/**
 * One RESOLVED skill and no command row vouching for the slash key — the
 * evidence shape that makes `/deploy` a phantom, so its rollup is rewritten onto
 * the `deploy` skill bucket and its stored `command` rows become deletable.
 */
function makeTx() {
  const skillRow = {
    componentKey: SKILL_NAME,
    componentKind: AgentComponentKind.Skill,
    content: null,
    externalComponentId: "ext-skill-deploy",
    id: "skill-row-1",
    resolvedState: ComponentResolvedState.Resolved,
  };
  const executeRaw = vi.fn().mockResolvedValue(0);
  const queryRaw = vi.fn().mockResolvedValue([skillRow]);
  const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
  const findMany = vi.fn().mockResolvedValue([skillRow]);
  const tx = {
    $executeRaw: executeRaw,
    $queryRaw: queryRaw,
    agentComponent: { findMany },
    agentComponentSessionUsage: { deleteMany },
  } as unknown as AgentSessionUpsertTx;
  return { deleteMany, executeRaw, tx };
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

/** The `componentKey.in` lists the shadow delete actually issued, flattened. */
function deletedCommandKeys(deleteMany: ReturnType<typeof vi.fn>): string[] {
  const keys: string[] = [];
  type ShadowDeleteCall = [{ where: { componentKey: { in: string[] } } }];
  for (const [args] of deleteMany.mock.calls as ShadowDeleteCall[]) {
    keys.push(...args.where.componentKey.in);
  }
  return keys;
}

async function persist(components: SyncedComponentUsage[]) {
  const { deleteMany, executeRaw, tx } = makeTx();
  const tally = await persistSessionComponentUsage(
    tx,
    AGENT_SESSION_ID,
    COMPUTE_TARGET_ID,
    sessionWith(components)
  );
  return { deleteMany, executeRaw, tally };
}

describe("the shadowed-command delete waits for its replacement (ISS-8881)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes the stored command row when the skill replacement is written", async () => {
    // ISS-4778's behaviour, unchanged. Without this case the withhold below
    // would pass just as well against a delete that never fires at all.
    const { deleteMany } = await persist([
      usage({
        componentKind: AgentComponentKind.Command,
        componentKey: SLASH_KEY,
        invocations: 3,
      }),
    ]);

    expect(deletedCommandKeys(deleteMany)).toEqual([SLASH_KEY]);
  });

  it("withholds the delete when the phantom's own count cannot be stored", async () => {
    const { deleteMany, tally } = await persist([
      usage({
        componentKind: AgentComponentKind.Command,
        componentKey: SLASH_KEY,
        invocations: PR_INT_MAX + 1,
      }),
    ]);

    // The drop is still REPORTED — withholding the delete is not swallowing it.
    // Under the SKILL name, not the slash key: `partitionStorableUsages` runs
    // AFTER the fold, so the row it screens has already been rewritten onto the
    // skill identity. That is the reported name ISS-8330's phantom-fold arm used
    // and this ticket deliberately kept.
    expect(tally.droppedOverflowUsageBuckets).toEqual([SKILL_NAME]);
    // And the stored measurement survives: nothing was going to replace it.
    expect(deletedCommandKeys(deleteMany)).toEqual([]);
  });

  it("withholds the delete for EVERY branch when one branch overflows", async () => {
    // `deleteShadowedCommandRows` matches on `componentKey` alone, with no
    // branch predicate, so deleting on behalf of the sound branch would take the
    // corrupt branch's stored row with it. The sound branch still INSERTS under
    // the skill identity; only the delete waits.
    const { deleteMany, tally } = await persist([
      usage({
        componentKind: AgentComponentKind.Command,
        componentKey: SLASH_KEY,
        gitBranch: "feat/sound",
        invocations: 7,
      }),
      usage({
        componentKind: AgentComponentKind.Command,
        componentKey: SLASH_KEY,
        gitBranch: "feat/corrupt",
        invocations: PR_INT_MAX + 1,
      }),
    ]);

    expect(tally.droppedOverflowUsageBuckets).toEqual([SKILL_NAME]);
    expect(deletedCommandKeys(deleteMany)).toEqual([]);
  });

  it("still deletes when a DIFFERENT component's bucket is the one dropped", async () => {
    // The withhold is per shadowed key, not a batch-wide kill switch: an
    // unrelated overflow must not defer a migration that has its replacement.
    const { deleteMany, tally } = await persist([
      usage({
        componentKind: AgentComponentKind.Command,
        componentKey: SLASH_KEY,
        invocations: 3,
      }),
      usage({
        componentKind: AgentComponentKind.Skill,
        componentKey: "unrelated",
        invocations: PR_INT_MAX + 1,
      }),
    ]);

    expect(tally.droppedOverflowUsageBuckets).toEqual(["unrelated"]);
    expect(deletedCommandKeys(deleteMany)).toEqual([SLASH_KEY]);
  });
});
