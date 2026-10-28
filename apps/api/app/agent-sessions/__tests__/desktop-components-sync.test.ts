import {
  AgentComponentKind,
  ComponentResolvedState,
} from "@repo/api/src/types/agent-component";
import type { SyncedComponentUsage } from "@repo/api/src/types/agent-session";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildComponentUsage,
  buildPayload,
  buildSyncedSession,
  buildUpsertSessionsContext,
  createInstallDb,
  PERSISTED_SESSION_ID,
  SESSION_STARTED_AT,
  SESSION_UPDATED_AT,
  usageUpsertCreates,
} from "@/__tests__/support/agent-sessions/component-usage-sync.test-harness";
import {
  INDEX_KEY_MAX_BYTES,
  projectIndexKey,
} from "@/lib/index-key-projection";

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

describe("upsertSessions — persistSessionComponentUsage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes AgentComponentSessionUsage rows for session.components[]", async () => {
    const usageUpsert = vi.fn().mockResolvedValue({});
    const db = installDb({
      agentComponentSessionUsage: {
        upsert: usageUpsert,
      },
    });

    const usage = buildComponentUsage({
      componentKind: "skill",
      componentKey: "my-skill",
      invocations: 7,
      errorCount: 1,
    });
    const session = buildSyncedSession({ components: [usage] });

    await agentSessionsService.upsertSessions(
      buildUpsertSessionsContext(),
      buildPayload([session])
    );

    expect(usageUpsert).toHaveBeenCalledTimes(1);
    const upsertArgs = usageUpsert.mock.calls[0]?.[0];
    // FEA-2990: keyed by (agentSessionId, componentKind, componentKey, gitBranch).
    // A usage row with no per-event branch upserts under the '' sentinel.
    expect(upsertArgs?.where).toMatchObject({
      agentSessionId_componentKind_componentKey_gitBranch: {
        agentSessionId: PERSISTED_SESSION_ID,
        componentKind: "skill",
        componentKey: "my-skill",
        gitBranch: "",
      },
    });
    expect(upsertArgs?.create).toMatchObject({
      agentSessionId: PERSISTED_SESSION_ID,
      componentKind: "skill",
      componentKey: "my-skill",
      gitBranch: "",
      invocationCount: 7,
      errorCount: 1,
    });
    expect(db.sessionTranscript.findMany).not.toHaveBeenCalled();
  });

  it("second call with the same usage row is idempotent (upsert on-conflict update)", async () => {
    const usageUpsert = vi.fn().mockResolvedValue({});
    installDb({
      agentComponentSessionUsage: {
        upsert: usageUpsert,
      },
    });

    const usage = buildComponentUsage({ invocations: 5 });
    const session = buildSyncedSession({ components: [usage] });
    const context = buildUpsertSessionsContext();
    const payload = buildPayload([session]);

    await agentSessionsService.upsertSessions(context, payload);
    const firstCallCount = usageUpsert.mock.calls.length;

    await agentSessionsService.upsertSessions(context, payload);
    const secondCallCount = usageUpsert.mock.calls.length;

    // Both calls should succeed; upsert is called the same number of times
    // each round — confirms idempotent behavior (update-on-conflict)
    expect(secondCallCount).toBe(firstCallCount * 2);
  });

  it("resolves agentComponentId FK when a matching AgentComponent row exists", async () => {
    const EXISTING_COMPONENT_ID = "existing-component-uuid";
    const usageUpsert = vi.fn().mockResolvedValue({});
    installDb({
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: EXISTING_COMPONENT_ID,
            componentKind: "skill",
            externalComponentId: "skill::my-skill",
          },
        ]),
      },
      agentComponentSessionUsage: {
        upsert: usageUpsert,
      },
    });

    const usage = buildComponentUsage({
      externalComponentId: "skill::my-skill",
      componentKind: "skill",
      componentKey: "my-skill",
    });
    const session = buildSyncedSession({ components: [usage] });

    await agentSessionsService.upsertSessions(
      buildUpsertSessionsContext(),
      buildPayload([session])
    );

    const upsertArgs = usageUpsert.mock.calls[0]?.[0];
    // agentComponentId should be resolved to the existing inventory row's ID
    expect(upsertArgs?.create?.agentComponentId).toBe(EXISTING_COMPONENT_ID);
    expect(upsertArgs?.update?.agentComponentId).toBe(EXISTING_COMPONENT_ID);
  });

  /**
   * ISS-8200 (review): driven through the PRODUCTION entry point, because the
   * narrow `loadComponentInventoryRows` cases pin only the bind shape. Two
   * production edits live between that helper and the FK that lands on the row
   * — which usages the lookup is built from, and how the returned rows are
   * keyed — and reverting either leaves those narrow cases green.
   *
   * The inventory double FILTERS on what the statement actually asked for, so
   * it cannot answer the same way regardless of the candidates under test.
   */
  it("resolves agentComponentId against an inventory row still stored under its RAW key", async () => {
    const LEGACY_COMPONENT_ID = "legacy-raw-component-uuid";
    const rawExternalId = `skill::${"e".repeat(INDEX_KEY_MAX_BYTES)}`;
    const usageUpsert = vi.fn().mockResolvedValue({});
    const findMany = vi.fn(
      async (input: {
        where: {
          OR: Array<{ componentKind: string; externalComponentId: string }>;
        };
      }) =>
        input.where.OR.some(
          (pair) =>
            pair.componentKind === "skill" &&
            pair.externalComponentId === rawExternalId
        )
          ? [
              {
                id: LEGACY_COMPONENT_ID,
                componentKind: "skill",
                externalComponentId: rawExternalId,
              },
            ]
          : []
    );
    installDb({
      agentComponent: { findMany },
      agentComponentSessionUsage: { upsert: usageUpsert },
    });

    await agentSessionsService.upsertSessions(
      buildUpsertSessionsContext(),
      buildPayload([
        buildSyncedSession({
          components: [
            buildComponentUsage({
              componentKind: "skill",
              componentKey: "my-skill",
              externalComponentId: rawExternalId,
            }),
          ],
        }),
      ])
    );

    // The raw candidate really was asked for — otherwise this passes on a
    // double that would have answered anything.
    expect(
      findMany.mock.calls[0]?.[0].where.OR.map(
        (pair) => pair.externalComponentId
      )
    ).toContain(rawExternalId);
    // And the FK actually landed on the legacy row.
    expect(usageUpsertCreates(usageUpsert)[0]?.agentComponentId).toBe(
      LEGACY_COMPONENT_ID
    );
  });

  it("prefers the PROJECTED inventory row when a legacy raw sibling also exists", async () => {
    // ISS-8200 (review): both rows fold onto one lookup key and the statement
    // has no ORDER BY, so without a deterministic tie-break the FK is decided
    // by whatever order Postgres returned — the same component resolving to a
    // different inventory row between syncs. Asserted in BOTH return orders, so
    // a fold that merely happens to take the last row cannot pass.
    const rawExternalId = `skill::${"e".repeat(INDEX_KEY_MAX_BYTES)}`;
    const projectedExternalId = projectIndexKey(rawExternalId).value;
    const legacyRow = {
      id: "legacy-raw-uuid",
      componentKind: "skill",
      externalComponentId: rawExternalId,
    };
    const projectedRow = {
      id: "projected-uuid",
      componentKind: "skill",
      externalComponentId: projectedExternalId,
    };

    for (const rows of [
      [legacyRow, projectedRow],
      [projectedRow, legacyRow],
    ]) {
      const usageUpsert = vi.fn().mockResolvedValue({});
      installDb({
        agentComponent: { findMany: vi.fn().mockResolvedValue(rows) },
        agentComponentSessionUsage: { upsert: usageUpsert },
      });

      await agentSessionsService.upsertSessions(
        buildUpsertSessionsContext(),
        buildPayload([
          buildSyncedSession({
            components: [
              buildComponentUsage({
                componentKind: "skill",
                componentKey: "my-skill",
                externalComponentId: rawExternalId,
              }),
            ],
          }),
        ])
      );

      expect(usageUpsertCreates(usageUpsert)[0]?.agentComponentId).toBe(
        projectedRow.id
      );
    }
  });

  it("resolves agentComponentId to null when no matching AgentComponent row exists", async () => {
    const usageUpsert = vi.fn().mockResolvedValue({});
    installDb({
      agentComponent: {
        // No inventory row for this component — built-in tool (e.g. Read)
        findMany: vi.fn().mockResolvedValue([]),
      },
      agentComponentSessionUsage: {
        upsert: usageUpsert,
      },
    });

    const usage = buildComponentUsage({
      componentKind: "tool",
      componentKey: "Read",
      externalComponentId: null, // built-in tools have no external ID
    });
    const session = buildSyncedSession({ components: [usage] });

    await agentSessionsService.upsertSessions(
      buildUpsertSessionsContext(),
      buildPayload([session])
    );

    const upsertArgs = usageUpsert.mock.calls[0]?.[0];
    // agentComponentId must be null for built-in tools without inventory rows
    expect(upsertArgs?.create?.agentComponentId).toBeNull();
    expect(upsertArgs?.update?.agentComponentId).toBeNull();
  });

  // ISS-6659: the `components` absent / empty no-ops moved to
  // `component-usage-guards.test.ts`. Asserting only "no row was written" for a
  // session that reports nothing stays green for an early return that fires on a
  // VALID payload too, so those cases now run beside a neighbour session that
  // must still be persisted.

  it("writes usage rows for multiple components in a single session", async () => {
    const usageUpsert = vi.fn().mockResolvedValue({});
    installDb({
      agentComponentSessionUsage: {
        upsert: usageUpsert,
      },
    });

    const usages: SyncedComponentUsage[] = [
      buildComponentUsage({
        componentKind: "skill",
        componentKey: "skill-a",
        invocations: 3,
      }),
      buildComponentUsage({
        componentKind: "command",
        componentKey: "cmd-b",
        externalComponentId: "command::cmd-b",
        invocations: 10,
      }),
      buildComponentUsage({
        componentKind: "mcp",
        componentKey: "mcp-c",
        externalComponentId: "mcp::mcp-c",
        invocations: 1,
      }),
    ];
    const session = buildSyncedSession({ components: usages });

    await agentSessionsService.upsertSessions(
      buildUpsertSessionsContext(),
      buildPayload([session])
    );

    // One upsert per component
    expect(usageUpsert).toHaveBeenCalledTimes(3);
    const calledKinds = usageUpsert.mock.calls.map(
      (call: unknown[]) =>
        (call[0] as { create?: { componentKind?: string } })?.create
          ?.componentKind
    );
    expect(calledKinds).toContain("skill");
    expect(calledKinds).toContain("command");
    expect(calledKinds).toContain("mcp");
  });

  it("FEA-2990: splits one component across branches into distinct branch-keyed upserts", async () => {
    const usageUpsert = vi.fn().mockResolvedValue({});
    installDb({
      agentComponentSessionUsage: {
        upsert: usageUpsert,
      },
    });

    // The same component (tool/Bash) invoked on two branches within one session
    // arrives as two usage rows differing only by gitBranch — the desktop's
    // per-(component, branch) split. Each must upsert under its own branch key.
    const usages: SyncedComponentUsage[] = [
      buildComponentUsage({
        componentKind: "tool",
        componentKey: "Bash",
        externalComponentId: null,
        invocations: 4,
        gitBranch: "feat/a",
      }),
      buildComponentUsage({
        componentKind: "tool",
        componentKey: "Bash",
        externalComponentId: null,
        invocations: 9,
        gitBranch: "feat/b",
      }),
    ];
    const session = buildSyncedSession({ components: usages });

    await agentSessionsService.upsertSessions(
      buildUpsertSessionsContext(),
      buildPayload([session])
    );

    expect(usageUpsert).toHaveBeenCalledTimes(2);
    const keys = usageUpsert.mock.calls.map(
      (call: unknown[]) =>
        (
          call[0] as {
            where?: {
              agentSessionId_componentKind_componentKey_gitBranch?: {
                gitBranch?: string;
              };
            };
          }
        )?.where?.agentSessionId_componentKind_componentKey_gitBranch?.gitBranch
    );
    // Two DISTINCT branch keys — a branch-dropping implementation would collapse
    // these into ONE upsert (same key), so this assertion fails against it.
    expect(new Set(keys)).toEqual(new Set(["feat/a", "feat/b"]));

    const invByBranch = new Map(
      usageUpsert.mock.calls.map((call: unknown[]) => {
        const arg = call[0] as {
          where?: {
            agentSessionId_componentKind_componentKey_gitBranch?: {
              gitBranch?: string;
            };
          };
          create?: { invocationCount?: number };
        };
        return [
          arg.where?.agentSessionId_componentKind_componentKey_gitBranch
            ?.gitBranch,
          arg.create?.invocationCount,
        ];
      })
    );
    expect(invByBranch.get("feat/a")).toBe(4);
    expect(invByBranch.get("feat/b")).toBe(9);
  });

  it("FEA-2990: a usage row with null gitBranch upserts under the '' sentinel (legacy/Codex fallback)", async () => {
    const usageUpsert = vi.fn().mockResolvedValue({});
    installDb({
      agentComponentSessionUsage: {
        upsert: usageUpsert,
      },
    });

    const usage = buildComponentUsage({
      componentKind: "tool",
      componentKey: "Read",
      externalComponentId: null,
      invocations: 2,
      gitBranch: null,
    });
    const session = buildSyncedSession({ components: [usage] });

    await agentSessionsService.upsertSessions(
      buildUpsertSessionsContext(),
      buildPayload([session])
    );

    expect(usageUpsert).toHaveBeenCalledTimes(1);
    const upsertArgs = usageUpsert.mock.calls[0]?.[0];
    expect(
      upsertArgs?.where?.agentSessionId_componentKind_componentKey_gitBranch
        ?.gitBranch
    ).toBe("");
    expect(upsertArgs?.create?.gitBranch).toBe("");
  });

  it("FEA-2990: prunes superseded branch buckets for a resynced component (no double-count)", async () => {
    const usageUpsert = vi.fn().mockResolvedValue({});
    const usageDeleteMany = vi.fn().mockResolvedValue({ count: 1 });
    installDb({
      agentComponentSessionUsage: {
        upsert: usageUpsert,
        deleteMany: usageDeleteMany,
      },
    });

    // A newer desktop build now reports (tool, Bash) split across feat/a + feat/b.
    const usages: SyncedComponentUsage[] = [
      buildComponentUsage({
        componentKind: "tool",
        componentKey: "Bash",
        externalComponentId: null,
        invocations: 4,
        gitBranch: "feat/a",
      }),
      buildComponentUsage({
        componentKind: "tool",
        componentKey: "Bash",
        externalComponentId: null,
        invocations: 9,
        gitBranch: "feat/b",
      }),
    ];
    const session = buildSyncedSession({ components: usages });

    await agentSessionsService.upsertSessions(
      buildUpsertSessionsContext(),
      buildPayload([session])
    );

    expect(usageDeleteMany).toHaveBeenCalledTimes(1);
    const deleteArgs = usageDeleteMany.mock.calls[0]?.[0];
    expect(deleteArgs?.where).toMatchObject({
      agentSessionId: PERSISTED_SESSION_ID,
      OR: [{ componentKind: "tool", componentKey: "Bash" }],
    });
    const notIn: string[] = deleteArgs?.where?.OR?.[0]?.gitBranch?.notIn ?? [];
    expect(new Set(notIn)).toEqual(new Set(["feat/a", "feat/b"]));
    expect(usageUpsert).toHaveBeenCalledTimes(2);
  });

  it("FEA-2990: preserves a branchless row that is still present in the payload", async () => {
    const usageUpsert = vi.fn().mockResolvedValue({});
    const usageDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
    installDb({
      agentComponentSessionUsage: {
        upsert: usageUpsert,
        deleteMany: usageDeleteMany,
      },
    });

    // A genuinely branchless component (Codex/legacy) still reported under ''.
    // The prune keep-set must include '' so it is NOT deleted, and its own upsert
    // re-writes it.
    const usage = buildComponentUsage({
      componentKind: "tool",
      componentKey: "Read",
      externalComponentId: null,
      invocations: 3,
      gitBranch: null,
    });
    const session = buildSyncedSession({ components: [usage] });

    await agentSessionsService.upsertSessions(
      buildUpsertSessionsContext(),
      buildPayload([session])
    );

    expect(usageDeleteMany).toHaveBeenCalledTimes(1);
    const notIn: string[] =
      usageDeleteMany.mock.calls[0]?.[0]?.where?.OR?.[0]?.gitBranch?.notIn ??
      [];
    // '' is in the keep-set → the branchless row survives the prune.
    expect(notIn).toContain("");
    expect(usageUpsert).toHaveBeenCalledTimes(1);
  });

  it("does not perform transcript re-parse (no transcript data in payload)", async () => {
    const usageUpsert = vi.fn().mockResolvedValue({});
    const sessionTranscriptFindMany = vi.fn().mockResolvedValue([]);
    installDb({
      agentComponentSessionUsage: {
        upsert: usageUpsert,
      },
      sessionTranscript: {
        findMany: sessionTranscriptFindMany,
      },
    });

    const usage = buildComponentUsage();
    // Payload contains only pre-materialized usage counts — no raw transcript/events
    const session = buildSyncedSession({
      components: [usage],
      events: [], // No raw event data to re-parse
    });

    await agentSessionsService.upsertSessions(
      buildUpsertSessionsContext(),
      buildPayload([session])
    );

    // The sync handler must NOT fetch transcript rows (no server-side re-parse)
    expect(sessionTranscriptFindMany).not.toHaveBeenCalled();
    // Usage upsert should still happen (data came pre-materialized from desktop)
    expect(usageUpsert).toHaveBeenCalledTimes(1);
  });

  it("resolves agentComponentId only for entries with a non-null externalComponentId", async () => {
    const COMPONENT_ID = "component-uuid-resolved";
    const agentComponentFindMany = vi.fn().mockResolvedValue([
      {
        id: COMPONENT_ID,
        componentKind: "skill",
        externalComponentId: "skill::has-external-id",
      },
    ]);
    const usageUpsert = vi.fn().mockResolvedValue({});
    installDb({
      agentComponent: {
        findMany: agentComponentFindMany,
      },
      agentComponentSessionUsage: {
        upsert: usageUpsert,
      },
    });

    const usages: SyncedComponentUsage[] = [
      buildComponentUsage({
        componentKind: "skill",
        componentKey: "has-external-id",
        externalComponentId: "skill::has-external-id",
        invocations: 4,
      }),
      buildComponentUsage({
        componentKind: "tool",
        componentKey: "Read",
        externalComponentId: null, // no external ID — should resolve to null
        invocations: 20,
      }),
    ];
    const session = buildSyncedSession({ components: usages });

    await agentSessionsService.upsertSessions(
      buildUpsertSessionsContext(),
      buildPayload([session])
    );

    const calls = usageUpsert.mock.calls as [
      { create: { componentKind: string; agentComponentId: string | null } },
    ][];
    const skillCall = calls.find(
      ([args]) => args.create.componentKind === "skill"
    );
    const toolCall = calls.find(
      ([args]) => args.create.componentKind === "tool"
    );

    // Skill with externalComponentId should be resolved
    expect(skillCall?.[0].create.agentComponentId).toBe(COMPONENT_ID);
    // Built-in tool without externalComponentId should resolve to null
    expect(toolCall?.[0].create.agentComponentId).toBeNull();

    // The inventory fixture should be queried once for the non-null external id,
    // not once per usage row.
    expect(agentComponentFindMany).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// ISS-4778 (Part 2 of ISS-4775) — skill-shadowed phantom command rollups
// ---------------------------------------------------------------------------

const SKILL_KEY = "review";
const PHANTOM_KEY = "/review";
const GENUINE_KEY = "/deploy";
const SKILL_COMPONENT_ID = "skill-component-uuid";
const SKILL_EXTERNAL_ID = "skill::review";
const EARLIER_AT = "2026-05-01T09:00:00.000Z";
const LATER_AT = "2026-05-01T11:00:00.000Z";

function resolvedSkillRow() {
  return {
    componentKey: SKILL_KEY,
    componentKind: AgentComponentKind.Skill,
    externalComponentId: SKILL_EXTERNAL_ID,
    id: SKILL_COMPONENT_ID,
  };
}

function resolvedSkillIdRow() {
  return {
    componentKind: AgentComponentKind.Skill,
    externalComponentId: SKILL_EXTERNAL_ID,
    id: SKILL_COMPONENT_ID,
  };
}

describe("upsertSessions — ISS-4778 skill-shadowed command usage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sums a phantom command rollup into the colliding skill rollup", async () => {
    const usageUpsert = vi.fn().mockResolvedValue({});
    const agentComponentFindMany = vi
      .fn()
      // 1st call: the skill-shadow inventory lookup.
      .mockResolvedValueOnce([resolvedSkillRow()])
      // 2nd call: the raw FK lookup fixture decoded by the test harness.
      .mockResolvedValueOnce([resolvedSkillIdRow()]);
    installDb({
      agentComponent: { findMany: agentComponentFindMany },
      agentComponentSessionUsage: { upsert: usageUpsert },
    });

    const session = buildSyncedSession({
      components: [
        buildComponentUsage({
          componentKey: SKILL_KEY,
          componentKind: AgentComponentKind.Skill,
          errorCount: 1,
          externalComponentId: SKILL_EXTERNAL_ID,
          firstInvokedAt: SESSION_STARTED_AT.toISOString(),
          invocations: 5,
          lastInvokedAt: SESSION_UPDATED_AT.toISOString(),
        }),
        buildComponentUsage({
          componentKey: PHANTOM_KEY,
          componentKind: AgentComponentKind.Command,
          errorCount: 2,
          externalComponentId: "command::/review",
          firstInvokedAt: EARLIER_AT,
          invocations: 3,
          lastInvokedAt: LATER_AT,
        }),
      ],
    });

    await agentSessionsService.upsertSessions(
      buildUpsertSessionsContext(),
      buildPayload([session])
    );

    const created = usageUpsertCreates(usageUpsert);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      agentComponentId: SKILL_COMPONENT_ID,
      componentKey: SKILL_KEY,
      componentKind: AgentComponentKind.Skill,
      errorCount: 3,
      invocationCount: 8,
    });
    // LEAST/GREATEST parity with the backfill migration's step 2a merge.
    expect(created[0].firstInvokedAt).toEqual(new Date(EARLIER_AT));
    expect(created[0].lastInvokedAt).toEqual(new Date(LATER_AT));
  });

  it("re-points a phantom rollup onto the skill identity when nothing collides", async () => {
    const usageUpsert = vi.fn().mockResolvedValue({});
    const agentComponentFindMany = vi
      .fn()
      .mockResolvedValueOnce([resolvedSkillRow()])
      // 2nd call: the raw FK lookup fixture decoded by the test harness.
      .mockResolvedValueOnce([resolvedSkillIdRow()]);
    installDb({
      agentComponent: { findMany: agentComponentFindMany },
      agentComponentSessionUsage: { upsert: usageUpsert },
    });

    const session = buildSyncedSession({
      components: [
        buildComponentUsage({
          componentKey: PHANTOM_KEY,
          componentKind: AgentComponentKind.Command,
          errorCount: 0,
          externalComponentId: "command::/review",
          invocations: 4,
        }),
      ],
    });

    await agentSessionsService.upsertSessions(
      buildUpsertSessionsContext(),
      buildPayload([session])
    );

    const created = usageUpsertCreates(usageUpsert);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      agentComponentId: SKILL_COMPONENT_ID,
      componentKey: SKILL_KEY,
      componentKind: AgentComponentKind.Skill,
      invocationCount: 4,
    });
  });

  it("removes the phantom's own stored rollup rows", async () => {
    const usageDeleteMany = vi.fn().mockResolvedValue({ count: 1 });
    installDb({
      agentComponent: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([resolvedSkillRow()])
          .mockResolvedValueOnce([]),
      },
      agentComponentSessionUsage: {
        deleteMany: usageDeleteMany,
        upsert: vi.fn().mockResolvedValue({}),
      },
    });

    const session = buildSyncedSession({
      components: [
        buildComponentUsage({
          componentKey: PHANTOM_KEY,
          componentKind: AgentComponentKind.Command,
        }),
      ],
    });

    await agentSessionsService.upsertSessions(
      buildUpsertSessionsContext(),
      buildPayload([session])
    );

    expect(usageDeleteMany).toHaveBeenCalledWith({
      where: {
        agentSessionId: PERSISTED_SESSION_ID,
        componentKey: { in: [PHANTOM_KEY] },
        componentKind: AgentComponentKind.Command,
      },
    });
  });

  it("keeps a genuine slash command that resolved against its own definition", async () => {
    const usageUpsert = vi.fn().mockResolvedValue({});
    installDb({
      agentComponent: {
        findMany: vi
          .fn()
          // A `deploy` skill AND a resolved `/deploy` command both exist: the
          // resolved command proves `/deploy` is genuine, so it must survive.
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
              // ISS-4923 (whitlockk review): the inventory read no longer filters
              // COMMAND rows to `resolved` in SQL — it reads every state and
              // splits on `resolvedState` / `content` in code, so the fixture
              // has to carry both columns the split reads.
              content: null,
              externalComponentId: "command::/deploy",
              id: "command-deploy-uuid",
              resolvedState: ComponentResolvedState.Resolved,
            },
          ])
          .mockResolvedValueOnce([]),
      },
      agentComponentSessionUsage: { upsert: usageUpsert },
    });

    const session = buildSyncedSession({
      components: [
        buildComponentUsage({
          componentKey: GENUINE_KEY,
          componentKind: AgentComponentKind.Command,
          externalComponentId: "command::/deploy",
          invocations: 2,
        }),
      ],
    });

    await agentSessionsService.upsertSessions(
      buildUpsertSessionsContext(),
      buildPayload([session])
    );

    const created = usageUpsertCreates(usageUpsert);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      componentKey: GENUINE_KEY,
      componentKind: AgentComponentKind.Command,
      invocationCount: 2,
    });
  });
});
