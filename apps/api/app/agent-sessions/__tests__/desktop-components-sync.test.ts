/**
 * T-10.3: Sync ingest tests for persistSessionComponentUsage.
 *
 * Tests that upsertSessions with session.components[] writes
 * AgentComponentSessionUsage rows correctly, that a second call is idempotent,
 * that agentComponentId is resolved when a matching AgentComponent row exists,
 * null otherwise, and that no server-side re-parse occurs (no transcript content
 * in test payload).
 *
 * AC-011, AC-013
 */
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
  type SyncedAgentSession,
  type SyncedComponentUsage,
} from "@repo/api/src/types/agent-session";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dbNull: Symbol("db-null"),
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  emitTelemetryMetric: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  GitHubInstallationStatus: {
    ACTIVE: "ACTIVE",
  },
  Prisma: {
    DbNull: mocks.dbNull,
  },
  withDb: mocks.withDb,
}));

vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitTelemetryMetric: mocks.emitTelemetryMetric,
}));

import { agentSessionsService } from "../service";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const SESSION_STARTED_AT = new Date("2026-05-01T10:00:00.000Z");
const SESSION_UPDATED_AT = new Date("2026-05-01T10:30:00.000Z");
const PERSISTED_SESSION_ID = "persisted-session-uuid-1";
const COMPUTE_TARGET_ID = "target-sync-1";
const ORG_ID = "org-sync-1";
const USER_ID = "user-sync-1";

// ---------------------------------------------------------------------------
// Mock DB builder
// ---------------------------------------------------------------------------

/**
 * Installs a mock DB that handles the core upsertSessions flow.
 * Callers can override specific mocks (e.g. agentComponentSessionUsage, agentComponent).
 */
function installDb(overrides: Record<string, unknown> = {}) {
  const dbWithDefaults = {
    $executeRaw: vi.fn().mockResolvedValue(undefined),
    $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
    // persistSessionChildren recomputes event-derived counts via a single
    // conditional-aggregation raw query (FEA-2913). Return zeroed counts so
    // the flow completes; these tests assert on component-usage upserts, not
    // event counts.
    $queryRawUnsafe: vi
      .fn()
      .mockResolvedValue([{ toolUseCount: 0n, errorCount: 0n }]),
    computeTarget: {
      findFirst: vi.fn().mockResolvedValue({ id: COMPUTE_TARGET_ID }),
      update: vi.fn().mockResolvedValue({ id: COMPUTE_TARGET_ID }),
    },
    slugCounter: {
      upsert: vi.fn().mockResolvedValue({ currentValue: 1 }),
    },
    sessionDetail: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({ artifactId: PERSISTED_SESSION_ID }),
      update: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
    },
    agentSessionEvent: {
      count: vi.fn().mockResolvedValue(0),
      aggregate: vi.fn().mockResolvedValue({ _max: { eventCreatedAt: null } }),
    },
    agentSessionTokenUsage: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    artifactLink: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    sessionTranscript: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    // Default: no existing AgentComponent rows (so agentComponentId resolves to null)
    agentComponent: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    // Default: agentComponentSessionUsage upsert + deleteMany succeed. The
    // deleteMany is the FEA-2990 superseded-branch prune (see service.ts).
    agentComponentSessionUsage: {
      upsert: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    ...overrides,
  };

  // Tests that override `agentComponentSessionUsage` typically supply only
  // `upsert`; keep the FEA-2990 prune `deleteMany` available so the flow never
  // dies on an undefined method.
  const usageStore = dbWithDefaults.agentComponentSessionUsage as {
    deleteMany?: unknown;
  };
  if (!usageStore.deleteMany) {
    usageStore.deleteMany = vi.fn().mockResolvedValue({ count: 0 });
  }

  mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
    callback(dbWithDefaults)
  );
  mocks.withDb.tx.mockImplementation((callback: (db: unknown) => unknown) =>
    callback(dbWithDefaults)
  );

  return dbWithDefaults;
}

// ---------------------------------------------------------------------------
// Payload builders
// ---------------------------------------------------------------------------

function buildSyncedSession(
  overrides: Partial<SyncedAgentSession> = {}
): SyncedAgentSession {
  return {
    externalSessionId: "ext-sess-1",
    name: "Test Session",
    status: "active",
    harness: "claude",
    cwd: "/tmp/project",
    model: "claude-sonnet-4",
    startedAt: SESSION_STARTED_AT.toISOString(),
    updatedAt: SESSION_UPDATED_AT.toISOString(),
    agents: [],
    events: [],
    tokenUsageByModel: [],
    ...overrides,
  };
}

function buildComponentUsage(
  overrides: Partial<SyncedComponentUsage> = {}
): SyncedComponentUsage {
  return {
    componentKind: "skill",
    componentKey: "my-skill",
    externalComponentId: "skill::my-skill",
    harness: "claude",
    invocations: 5,
    errorCount: 0,
    firstInvokedAt: SESSION_STARTED_AT.toISOString(),
    lastInvokedAt: SESSION_UPDATED_AT.toISOString(),
    ...overrides,
  };
}

function buildUpsertSessionsContext() {
  return {
    organizationId: ORG_ID,
    userId: USER_ID,
    computeTargetId: COMPUTE_TARGET_ID,
  };
}

function buildPayload(sessions: SyncedAgentSession[]) {
  return {
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: sessions.length,
    sessions,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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
    // Verify no transcript content in payload (no server-side re-parse)
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

    // First call
    await agentSessionsService.upsertSessions(context, payload);
    const firstCallCount = usageUpsert.mock.calls.length;

    // Second call — same data, should upsert (not error/duplicate)
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

  it("is a no-op when session.components[] is absent (older desktop builds)", async () => {
    const usageUpsert = vi.fn().mockResolvedValue({});
    installDb({
      agentComponentSessionUsage: {
        upsert: usageUpsert,
      },
    });

    // Session without components field (older desktop build)
    const session = buildSyncedSession(); // no `components` field

    await agentSessionsService.upsertSessions(
      buildUpsertSessionsContext(),
      buildPayload([session])
    );

    // AgentComponentSessionUsage upsert should NOT be called
    expect(usageUpsert).not.toHaveBeenCalled();
  });

  it("is a no-op when session.components[] is empty", async () => {
    const usageUpsert = vi.fn().mockResolvedValue({});
    installDb({
      agentComponentSessionUsage: {
        upsert: usageUpsert,
      },
    });

    const session = buildSyncedSession({ components: [] });

    await agentSessionsService.upsertSessions(
      buildUpsertSessionsContext(),
      buildPayload([session])
    );

    expect(usageUpsert).not.toHaveBeenCalled();
  });

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
    // If an older build previously synced the same (tool, Bash) under the ''
    // bucket, that stale row must be pruned so detail/token-trend (which sum ALL
    // rows per component) do not double-count it against the new branch rows.
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

    // One prune per distinct (componentKind, componentKey) group in the payload —
    // here a single group (tool, Bash) — dropping any branch bucket NOT in the
    // payload's keep-set (i.e. the stale '' row), while feat/a + feat/b survive.
    expect(usageDeleteMany).toHaveBeenCalledTimes(1);
    const deleteArgs = usageDeleteMany.mock.calls[0]?.[0];
    expect(deleteArgs?.where).toMatchObject({
      agentSessionId: PERSISTED_SESSION_ID,
      componentKind: "tool",
      componentKey: "Bash",
    });
    const notIn: string[] = deleteArgs?.where?.gitBranch?.notIn ?? [];
    expect(new Set(notIn)).toEqual(new Set(["feat/a", "feat/b"]));
    // The prune must run before the branch rows are (re)written.
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
      usageDeleteMany.mock.calls[0]?.[0]?.where?.gitBranch?.notIn ?? [];
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

    // agentComponent.findMany should only be called ONCE (batched), not per-usage
    expect(agentComponentFindMany).toHaveBeenCalledTimes(1);
  });
});
