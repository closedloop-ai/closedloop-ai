/**
 * Shared harness for the `persistSessionComponentUsage` ingest tests.
 *
 * Two suites drive the same production entry point (`upsertSessions`) against a
 * mocked transaction client: `desktop-components-sync.test.ts` (write shape,
 * FK resolution, FEA-2990 branch buckets, ISS-4778 skill-shadow fold) and
 * `component-usage-guards.test.ts` (ISS-6659 — which early return actually
 * fired). The `vi.mock("@repo/database")` factory itself has to stay in each
 * test file, but the db double and payload builders are shared so the two
 * suites can never disagree about the fixture they are asserting against.
 */
import type {
  SyncedAgentSession,
  SyncedComponentUsage,
} from "@repo/api/src/types/agent-session";
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
} from "@repo/api/src/types/agent-session";
import { type Mock, vi } from "vitest";
import { persistedSessionDetail } from "./service.test-harness";

export const SESSION_STARTED_AT = new Date("2026-05-01T10:00:00.000Z");
export const SESSION_UPDATED_AT = new Date("2026-05-01T10:30:00.000Z");
export const PERSISTED_SESSION_ID = "persisted-session-uuid-1";
export const COMPUTE_TARGET_ID = "target-sync-1";
export const ORG_ID = "org-sync-1";
export const USER_ID = "user-sync-1";

/** The mocked `withDb` export the calling suite installed on `@repo/database`. */
export type WithDbMock = Mock & {
  tx: Mock;
};

/**
 * The transaction double `installDb` returns. Annotated rather than inferred:
 * the inferred shape names `Procedure` from `@vitest/spy`'s internals, which
 * `tsc` rejects as unportable across the package boundary (TS2883).
 */
export type UpsertSessionsDbDouble = Record<string, unknown> & {
  sessionTranscript: { findMany: Mock };
};

export type UsageCreateArgs = {
  componentKind: string;
  componentKey: string;
  gitBranch: string;
  invocationCount: number;
  errorCount: number;
  agentComponentId: string | null;
  /** ISS-7259: TRUE on the session's first attributed skill, else null. */
  isFirstAttributedSkill: boolean | null;
  firstInvokedAt: Date | null;
  lastInvokedAt: Date | null;
};

/**
 * Build the `installDb(overrides)` helper bound to a suite's `withDb` mock.
 *
 * The returned installer stands up a transaction double covering every model
 * `upsertSessions` touches, and — unless the caller overrides `$executeRaw` —
 * decodes the component-usage `INSERT … ON CONFLICT` statement back into one
 * `agentComponentSessionUsage.upsert(...)` call per row, so assertions can read
 * the persisted row shape instead of raw SQL bind values.
 */
export function createInstallDb(
  withDb: WithDbMock
): (overrides?: Record<string, unknown>) => UpsertSessionsDbDouble {
  return function installDb(
    overrides: Record<string, unknown> = {}
  ): UpsertSessionsDbDouble {
    const hasExecuteRawOverride = Object.hasOwn(overrides, "$executeRaw");
    const hasQueryRawOverride = Object.hasOwn(overrides, "$queryRaw");
    const dbWithDefaults = {
      $executeRaw: vi.fn().mockResolvedValue(undefined),
      $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
      $queryRaw: vi.fn().mockResolvedValue([]),
      $queryRawUnsafe: vi
        .fn()
        .mockResolvedValue([{ toolUseCount: 0n, errorCount: 0n }]),
      computeTarget: {
        findFirst: vi.fn().mockResolvedValue({ id: COMPUTE_TARGET_ID }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      organization: {
        findUnique: vi.fn().mockResolvedValue({ settings: null }),
      },
      slugCounter: {
        upsert: vi.fn().mockResolvedValue({ currentValue: 1 }),
      },
      sessionDetail: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi
          .fn()
          .mockResolvedValue(persistedSessionDetail(PERSISTED_SESSION_ID)),
        update: vi.fn().mockResolvedValue({}),
        findMany: vi.fn().mockResolvedValue([]),
      },
      agentSessionEvent: {
        count: vi.fn().mockResolvedValue(0),
        aggregate: vi
          .fn()
          .mockResolvedValue({ _max: { eventCreatedAt: null } }),
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
      agentComponent: {
        findMany: vi.fn().mockResolvedValue([]),
      },
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
      deleteMany?: (input: unknown) => unknown;
      upsert?: (input: unknown) => unknown;
    };
    if (!usageStore.deleteMany) {
      usageStore.deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    }
    if (!hasQueryRawOverride) {
      dbWithDefaults.$queryRaw = vi.fn(
        async (
          strings: TemplateStringsArray | readonly string[],
          ...expressions: unknown[]
        ) => {
          if (!isComponentInventoryLookup(strings)) {
            return [];
          }

          const agentComponentStore = dbWithDefaults.agentComponent as {
            findMany?: (input: unknown) => Promise<unknown[]>;
          };
          return (
            (await agentComponentStore.findMany?.(
              decodeComponentInventoryLookup(expressions)
            )) ?? []
          );
        }
      );
    }
    if (!hasExecuteRawOverride) {
      dbWithDefaults.$executeRaw = vi.fn(
        async (
          strings: TemplateStringsArray | readonly string[],
          ...expressions: unknown[]
        ) => {
          // ISS-8062: TWO raw statements reach this double now, so it has to
          // route on the statement instead of assuming every one is the INSERT.
          // Decoding the prune's DELETE with the INSERT's 13-column stride
          // produced a garbage extra "row" and failed 18 cases in ways that
          // named the wrong contract.
          if (isBranchBucketPrune(strings)) {
            await usageStore.deleteMany?.(decodeBranchBucketPrune(expressions));
            return;
          }
          const values = expressions.flatMap((expression) =>
            expression &&
            Array.isArray((expression as { values?: unknown[] }).values)
              ? (expression as { values: unknown[] }).values
              : [expression]
          );
          // ISS-7259: the stride and the destructure MIRROR the column list in
          // `persistSessionComponentUsage`'s raw INSERT, positionally. Adding a
          // column there without widening both here silently shifts every field
          // by one and the suite fails in ways that look unrelated to the column.
          for (let index = 0; index < values.length; index += 13) {
            const [
              ,
              agentSessionId,
              componentKind,
              componentKey,
              gitBranch,
              agentComponentId,
              harness,
              invocationCount,
              errorCount,
              componentVersionHash,
              isFirstAttributedSkill,
              firstInvokedAt,
              lastInvokedAt,
            ] = values.slice(index, index + 13);
            if (componentKind === undefined) {
              continue;
            }
            await usageStore.upsert?.({
              create: {
                agentComponentId,
                agentSessionId,
                componentKind,
                componentKey,
                componentVersionHash,
                errorCount,
                firstInvokedAt,
                gitBranch,
                harness,
                invocationCount,
                isFirstAttributedSkill,
                lastInvokedAt,
              },
              update: {
                agentComponentId,
                componentVersionHash,
                errorCount,
                firstInvokedAt,
                harness,
                invocationCount,
                isFirstAttributedSkill,
                lastInvokedAt,
              },
              where: {
                agentSessionId_componentKind_componentKey_gitBranch: {
                  agentSessionId,
                  componentKind,
                  componentKey,
                  gitBranch,
                },
              },
            });
          }
        }
      );
    }

    withDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback(dbWithDefaults)
    );
    withDb.tx.mockImplementation((callback: (db: unknown) => unknown) =>
      callback(dbWithDefaults)
    );

    return dbWithDefaults;
  };
}

/** ISS-8391: the component-usage FK resolver is the only raw inventory read here. */
export function isComponentInventoryLookup(
  strings: TemplateStringsArray | readonly string[]
): boolean {
  return [...strings].join(" ").includes("FROM agent_components");
}

/**
 * Translate the FK lookup's constant-bind raw SQL back into the equivalent
 * delegate read used by the component-usage unit doubles.
 */
export function decodeComponentInventoryLookup(
  expressions: readonly unknown[]
): {
  select: {
    componentKind: boolean;
    externalComponentId: boolean;
    id: boolean;
  };
  where: {
    computeTargetId: unknown;
    OR: Array<{
      componentKind: string;
      externalComponentId: string;
    }>;
  };
} {
  const [componentKinds, externalComponentIds, computeTargetId] =
    expressions as [string[], string[], unknown];

  return {
    select: {
      componentKind: true,
      externalComponentId: true,
      id: true,
    },
    where: {
      computeTargetId,
      OR: componentKinds.map((componentKind, index) => ({
        componentKind,
        externalComponentId: externalComponentIds[index],
      })),
    },
  };
}

/** ISS-8062: the FEA-2990 prune is the only raw DELETE this writer issues. */
export function isBranchBucketPrune(
  strings: TemplateStringsArray | readonly string[]
): boolean {
  return [...strings].join(" ").includes("DELETE FROM");
}

/**
 * ISS-8062: translate the prune's constant-bind statement back into the
 * `deleteMany` argument the equivalent per-group `notIn` would have been called
 * with, so every suite that asserts the FEA-2990 prune keeps asserting the same
 * OUTCOME rather than the SQL that happens to implement it.
 *
 * Whether that SQL is a faithful implementation of this predicate is NOT what
 * this double establishes — that is the job of the real-Postgres coverage in
 * `__tests__/integration/ingest-writer-bind-parameter-ceiling.integration.test.ts`.
 */
export function decodeBranchBucketPrune(expressions: readonly unknown[]): {
  where: {
    agentSessionId: unknown;
    OR: Array<{
      componentKind: string;
      componentKey: string;
      gitBranch: { notIn: string[] };
    }>;
  };
} {
  const [
    agentSessionId,
    groupKinds,
    groupKeys,
    keepKinds,
    keepKeys,
    keepBranches,
  ] = expressions as [
    unknown,
    string[],
    string[],
    string[],
    string[],
    string[],
  ];

  const branchesByGroup = new Map<string, string[]>();
  for (const [index, kind] of keepKinds.entries()) {
    const groupKey = `${kind}\u0000${keepKeys[index]}`;
    const existing = branchesByGroup.get(groupKey);
    if (existing) {
      existing.push(keepBranches[index]);
    } else {
      branchesByGroup.set(groupKey, [keepBranches[index]]);
    }
  }

  return {
    where: {
      agentSessionId,
      OR: groupKinds.map((componentKind, index) => ({
        componentKey: groupKeys[index],
        componentKind,
        gitBranch: {
          notIn:
            branchesByGroup.get(`${componentKind}\u0000${groupKeys[index]}`) ??
            [],
        },
      })),
    },
  };
}

export function buildSyncedSession(
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

export function buildComponentUsage(
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

export function buildUpsertSessionsContext() {
  return {
    organizationId: ORG_ID,
    userId: USER_ID,
    computeTargetId: COMPUTE_TARGET_ID,
  };
}

export function buildPayload(sessions: SyncedAgentSession[]) {
  return {
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: sessions.length,
    sessions,
  };
}

/** The `create` payload of every decoded component-usage upsert, in call order. */
export function usageUpsertCreates(upsert: ReturnType<typeof vi.fn>) {
  return (upsert.mock.calls as [{ create: UsageCreateArgs }][]).map(
    ([args]) => args.create
  );
}
