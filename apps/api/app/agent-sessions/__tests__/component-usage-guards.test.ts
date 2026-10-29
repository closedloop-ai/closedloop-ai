/**
 * ISS-6659 — WHICH early return fired, not merely that nothing was written.
 *
 * `persistSessionComponentUsage` has three early returns (`!reported`,
 * `reported.length === 0`, `rawUsages.length === 0`) and they all produce the
 * same outcome: no usage row. A test that only asserts "no row was written"
 * therefore stays green for every one of them AND for a guard widened until it
 * swallows a valid payload — which is the regression that actually costs data.
 *
 * So each case here runs beside a DISTINGUISHABLE neighbour session that must
 * still be persisted, and asserts the branch-bucket prune (`deleteMany`,
 * reached only after all three guards pass, and issued nowhere else in
 * `apps/api` outside `service/component-usage.ts`) was never issued for the
 * guarded session. A guard that returns too early loses the neighbour's row.
 *
 * Two of the three are individually pinned, and the third provably cannot be:
 *
 *   - `!reported` — deleting it makes `admitSyncedCommandUsage(undefined)`
 *     throw, and only the absent-components case here goes red.
 *   - `rawUsages.length === 0` — the only guard reachable with a NON-empty
 *     `components[]`, so deleting it leaves a second, empty-`OR` prune behind
 *     that the other two cases cannot produce.
 *   - `reported.length === 0` is DEFENCE IN DEPTH BEHIND the guard above, not
 *     an independently observable one: delete it and `admitSyncedCommandUsage`
 *     maps `[]` to `[]`, so `rawUsages.length === 0` returns at the same point
 *     with the same side effects. No assertion can separate them, here or at
 *     any other boundary — the empty case below pins the observable contract
 *     (nothing written, prune not reached, neighbour untouched) without
 *     claiming to attribute it to one of the two statements.
 */
import {
  AgentComponentKind,
  ComponentResolvedState,
} from "@repo/api/src/types/agent-component";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildComponentUsage,
  buildPayload,
  buildSyncedSession,
  buildUpsertSessionsContext,
  createInstallDb,
  usageUpsertCreates,
} from "@/__tests__/support/agent-sessions/component-usage-sync.test-harness";

const mocks = vi.hoisted(() => ({
  dbNull: Symbol("db-null"),
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  emitTelemetryMetric: vi.fn(),
}));

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
  ArtifactType: {
    DOCUMENT: "DOCUMENT",
    BRANCH: "BRANCH",
    DEPLOYMENT: "DEPLOYMENT",
    SESSION: "SESSION",
  },
  GitHubInstallationStatus: {
    ACTIVE: "ACTIVE",
  },
  Prisma: {
    DbNull: mocks.dbNull,
    sql: sqlTag,
    join: sqlJoin,
  },
  withDb: mocks.withDb,
}));

vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitTelemetryMetric: mocks.emitTelemetryMetric,
}));

import { agentSessionsService } from "../service";

const installDb = createInstallDb(mocks.withDb);

/** A command key that names no command, so `admitSyncedCommandUsage` drops it. */
const INADMISSIBLE_COMMAND_KEY = "/...";
const NEIGHBOUR_KEY = "neighbour-skill";
const NEIGHBOUR_INVOCATIONS = 3;
const SKILL_KEY = "review";
const PHANTOM_KEY = "/review";
const SKILL_EXTERNAL_ID = "skill::review";
const SKILL_COMPONENT_ID = "skill-component-uuid";
const GENUINE_KEY = "/deploy";

/**
 * The session whose usage MUST still be persisted while a sibling session trips
 * a guard. Distinguishable by `componentKey`, so an over-broad guard shows up as
 * this row's absence rather than as an indistinguishable empty write set.
 */
function neighbourSession() {
  return buildSyncedSession({
    components: [
      buildComponentUsage({
        componentKey: NEIGHBOUR_KEY,
        externalComponentId: null,
        invocations: NEIGHBOUR_INVOCATIONS,
      }),
    ],
    externalSessionId: "ext-sess-neighbour",
  });
}

function guardedSession(components: unknown) {
  return buildSyncedSession({
    ...(components === undefined ? {} : { components: components as never }),
    externalSessionId: "ext-sess-guarded",
  });
}

function pruneTargets(deleteMany: ReturnType<typeof vi.fn>) {
  return (deleteMany.mock.calls as [{ where: { OR?: unknown[] } }][]).map(
    ([args]) => args.where.OR
  );
}

describe("persistSessionComponentUsage — ISS-6659 early-return guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns before the prune when components is absent, and still persists a sibling session's usage", async () => {
    const usageUpsert = vi.fn().mockResolvedValue({});
    const usageDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
    installDb({
      agentComponentSessionUsage: {
        deleteMany: usageDeleteMany,
        upsert: usageUpsert,
      },
    });

    await agentSessionsService.upsertSessions(
      buildUpsertSessionsContext(),
      buildPayload([guardedSession(undefined), neighbourSession()])
    );

    expect(usageUpsertCreates(usageUpsert)).toEqual([
      expect.objectContaining({
        componentKey: NEIGHBOUR_KEY,
        invocationCount: NEIGHBOUR_INVOCATIONS,
      }),
    ]);
    // Exactly one prune — the neighbour's. A guard that stopped guarding would
    // add a second call carrying an empty `OR`.
    expect(pruneTargets(usageDeleteMany)).toEqual([
      [
        expect.objectContaining({
          componentKey: NEIGHBOUR_KEY,
          componentKind: AgentComponentKind.Skill,
        }),
      ],
    ]);
  });

  it("returns before the prune when components is empty, and still persists a sibling session's usage", async () => {
    const usageUpsert = vi.fn().mockResolvedValue({});
    const usageDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
    installDb({
      agentComponentSessionUsage: {
        deleteMany: usageDeleteMany,
        upsert: usageUpsert,
      },
    });

    await agentSessionsService.upsertSessions(
      buildUpsertSessionsContext(),
      buildPayload([guardedSession([]), neighbourSession()])
    );

    expect(usageUpsertCreates(usageUpsert)).toEqual([
      expect.objectContaining({
        componentKey: NEIGHBOUR_KEY,
        invocationCount: NEIGHBOUR_INVOCATIONS,
      }),
    ]);
    // Pins the observable contract only. Per the header, nothing can attribute
    // this to `reported.length === 0` rather than to the `rawUsages.length === 0`
    // guard standing behind it.
    expect(pruneTargets(usageDeleteMany)).toHaveLength(1);
  });

  it("returns before the prune when every reported row is an inadmissible command key, and still persists a sibling session's usage", async () => {
    const usageUpsert = vi.fn().mockResolvedValue({});
    const usageDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
    installDb({
      agentComponentSessionUsage: {
        deleteMany: usageDeleteMany,
        upsert: usageUpsert,
      },
    });

    await agentSessionsService.upsertSessions(
      buildUpsertSessionsContext(),
      buildPayload([
        guardedSession([
          buildComponentUsage({
            componentKey: INADMISSIBLE_COMMAND_KEY,
            componentKind: AgentComponentKind.Command,
            externalComponentId: null,
            invocations: 2,
          }),
        ]),
        neighbourSession(),
      ])
    );

    expect(usageUpsertCreates(usageUpsert)).toEqual([
      expect.objectContaining({
        componentKey: NEIGHBOUR_KEY,
        invocationCount: NEIGHBOUR_INVOCATIONS,
      }),
    ]);
    // The distinguishing assertion: this guard is the only one that can be
    // reached with a NON-empty `session.components[]`, so deleting it leaves a
    // second, empty-`OR` prune behind that the two guards above cannot produce.
    expect(pruneTargets(usageDeleteMany)).toHaveLength(1);
  });

  it("drops only the inadmissible command row when an admissible row shares the same session", async () => {
    const usageUpsert = vi.fn().mockResolvedValue({});
    installDb({
      agentComponentSessionUsage: { upsert: usageUpsert },
    });

    await agentSessionsService.upsertSessions(
      buildUpsertSessionsContext(),
      buildPayload([
        guardedSession([
          buildComponentUsage({
            componentKey: INADMISSIBLE_COMMAND_KEY,
            componentKind: AgentComponentKind.Command,
            externalComponentId: null,
            invocations: 2,
          }),
          buildComponentUsage({
            componentKey: NEIGHBOUR_KEY,
            externalComponentId: null,
            invocations: NEIGHBOUR_INVOCATIONS,
          }),
        ]),
      ])
    );

    // Row-scoped, not payload-scoped: a guard widened to "some row was dropped"
    // would take the surviving row down with the placeholder.
    expect(usageUpsertCreates(usageUpsert)).toEqual([
      expect.objectContaining({
        componentKey: NEIGHBOUR_KEY,
        invocationCount: NEIGHBOUR_INVOCATIONS,
      }),
    ]);
  });
});

describe("persistSessionComponentUsage — ISS-6659 skill-shadow fold", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("elides the phantom-rollup deleteMany entirely for a genuine slash command", async () => {
    const usageDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
    installDb({
      agentComponent: {
        findMany: vi
          .fn()
          // A `deploy` skill AND a resolved `/deploy` command both exist, so
          // `/deploy` is genuine and `shadowedCommandKeys` stays empty.
          .mockResolvedValueOnce([
            {
              componentKey: "deploy",
              componentKind: AgentComponentKind.Skill,
              externalComponentId: "skill::deploy",
              id: "skill-deploy-uuid",
            },
            {
              componentKey: GENUINE_KEY,
              componentKind: AgentComponentKind.Command,
              content: null,
              externalComponentId: "command::/deploy",
              id: "command-deploy-uuid",
              resolvedState: ComponentResolvedState.Resolved,
            },
          ])
          .mockResolvedValueOnce([]),
      },
      agentComponentSessionUsage: {
        deleteMany: usageDeleteMany,
        upsert: vi.fn().mockResolvedValue({}),
      },
    });

    await agentSessionsService.upsertSessions(
      buildUpsertSessionsContext(),
      buildPayload([
        buildSyncedSession({
          components: [
            buildComponentUsage({
              componentKey: GENUINE_KEY,
              componentKind: AgentComponentKind.Command,
              externalComponentId: "command::/deploy",
              invocations: 2,
            }),
          ],
        }),
      ])
    );

    // Query-elision coverage, NOT destructive-delete protection. With no
    // phantom in the payload `shadowedCommandKeys` is empty, so ungating the
    // `shadowedCommandKeys.length > 0` check emits a second `deleteMany` whose
    // where is `componentKey: { in: [] }` — an empty `in` matches no rows, so it
    // deletes nothing and could never reach the genuine `/deploy` rollup. What
    // is pinned here is only that the gate elides that pointless query: exactly
    // one `deleteMany` survives (the FEA-2990 branch-bucket prune, which is
    // gate-independent) and none is scoped to a Command kind.
    const deleteCalls = usageDeleteMany.mock.calls as [
      { where: { componentKind?: string } },
    ][];
    expect(
      deleteCalls.filter(
        ([args]) => args.where.componentKind === AgentComponentKind.Command
      )
    ).toEqual([]);
    expect(deleteCalls).toHaveLength(1);
  });

  it("re-points a phantom into its own branch bucket without absorbing a same-skill neighbour on another branch", async () => {
    const usageUpsert = vi.fn().mockResolvedValue({});
    installDb({
      agentComponent: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([
            {
              componentKey: SKILL_KEY,
              componentKind: AgentComponentKind.Skill,
              externalComponentId: SKILL_EXTERNAL_ID,
              id: SKILL_COMPONENT_ID,
            },
          ])
          .mockResolvedValueOnce([
            {
              componentKind: AgentComponentKind.Skill,
              externalComponentId: SKILL_EXTERNAL_ID,
              id: SKILL_COMPONENT_ID,
            },
          ]),
      },
      agentComponentSessionUsage: { upsert: usageUpsert },
    });

    await agentSessionsService.upsertSessions(
      buildUpsertSessionsContext(),
      buildPayload([
        buildSyncedSession({
          components: [
            buildComponentUsage({
              componentKey: SKILL_KEY,
              componentKind: AgentComponentKind.Skill,
              externalComponentId: SKILL_EXTERNAL_ID,
              gitBranch: "feat/a",
              invocations: 9,
            }),
            buildComponentUsage({
              componentKey: PHANTOM_KEY,
              componentKind: AgentComponentKind.Command,
              externalComponentId: "command::/review",
              gitBranch: "feat/b",
              invocations: 4,
            }),
          ],
        }),
      ])
    );

    // The phantom's rewritten bucket does not collide with the survivor's, so it
    // takes the `survivorIndex === undefined` push rather than the merge. With a
    // survivor present in the payload, "pushed a new bucket" and "summed into the
    // existing one" are finally distinguishable: 9 and 4 stay apart.
    expect(usageUpsertCreates(usageUpsert)).toEqual([
      expect.objectContaining({
        agentComponentId: SKILL_COMPONENT_ID,
        componentKey: SKILL_KEY,
        componentKind: AgentComponentKind.Skill,
        gitBranch: "feat/a",
        invocationCount: 9,
      }),
      expect.objectContaining({
        agentComponentId: SKILL_COMPONENT_ID,
        componentKey: SKILL_KEY,
        componentKind: AgentComponentKind.Skill,
        gitBranch: "feat/b",
        invocationCount: 4,
      }),
    ]);
  });
});
