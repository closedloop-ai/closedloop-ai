/**
 * Shared in-memory Prisma stand-in for the exact invocation-generation ingest
 * lane (`component-invocations.ts`). Extracted from
 * `component-invocations.test.ts` (ISS-4923) so the skill-shadow normalization
 * suite drives the SAME stateful generation/part/invocation store instead of
 * re-deriving one, and so that oversize test file shrinks toward the 1,000-line
 * ceiling rather than growing past it.
 *
 * The `vi.mock("@repo/database")` factory itself cannot be shared — Vitest hoists
 * it per test file — so each suite installs its own mock and hands the hoisted
 * `withDb.tx` spy here to be wired to this store.
 */
import { createHash } from "node:crypto";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  AgentComponentInvocationRelationship,
  type AgentComponentInvocationSyncItem,
  type AgentComponentInvocationSyncPart,
  agentComponentInvocationGenerationHashPreimage,
  agentComponentInvocationSyncPartHashPreimage,
} from "@repo/api/src/types/agent-component-invocation";
import type { Mock } from "vitest";
import { vi } from "vitest";

export const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
export const COMPUTE_TARGET_ID = "22222222-2222-4222-8222-222222222222";
export const SESSION_ID = "33333333-3333-4333-8333-333333333333";
export const EXTERNAL_SESSION_ID = "session-1";
export const SOURCE_UPDATED_AT = "2026-07-22T12:00:00.000Z";

export type GenerationRow = {
  id: string;
  agentSessionId: string;
  externalGenerationId: string;
  sourceUpdatedAt: Date;
  dataRevision: number;
  sourceSequence: number;
  expectedPartCount: number;
  activeAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
};

export type PartRow = {
  id: string;
  generationId: string;
  partIndex: number;
  partHash: string;
  itemCount: number;
  payloadBytes: number;
};

export function buildItem(
  overrides: Partial<AgentComponentInvocationSyncItem> = {}
): AgentComponentInvocationSyncItem {
  return {
    externalInvocationId: "invocation-1",
    sourceSessionId: EXTERNAL_SESSION_ID,
    kind: AgentComponentInvocationKind.Skill,
    componentKey: "code-review",
    relationship: AgentComponentInvocationRelationship.Direct,
    invokedAt: "2026-07-22T11:59:00.000Z",
    sequence: 0,
    anchor: { kind: "event", eventId: "event-1" },
    status: AgentComponentInvocationAttributionStatus.Unresolved,
    evidenceClass: AgentComponentInvocationEvidenceClass.None,
    ...overrides,
  };
}

export function generationId(
  items: AgentComponentInvocationSyncItem[]
): string {
  return sha256(
    agentComponentInvocationGenerationHashPreimage({
      externalSessionId: EXTERNAL_SESSION_ID,
      items,
    })
  );
}

export function buildPart(input: {
  allItems: AgentComponentInvocationSyncItem[];
  items?: AgentComponentInvocationSyncItem[];
  partIndex?: number;
  partCount?: number;
  sourceUpdatedAt?: string;
  dataRevision?: number;
  sourceSequence?: number;
}): AgentComponentInvocationSyncPart {
  const withoutHash = {
    protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
    externalSessionId: EXTERNAL_SESSION_ID,
    externalGenerationId: generationId(input.allItems),
    sourceUpdatedAt: input.sourceUpdatedAt ?? SOURCE_UPDATED_AT,
    dataRevision: input.dataRevision ?? 35,
    sourceSequence: input.sourceSequence ?? 1,
    partIndex: input.partIndex ?? 0,
    partCount: input.partCount ?? 1,
    items: input.items ?? input.allItems,
  };
  return {
    ...withoutHash,
    partHash: sha256(agentComponentInvocationSyncPartHashPreimage(withoutHash)),
  };
}

/**
 * The in-memory store's public shape. Declared explicitly (rather than inferred)
 * because `vi.fn()`'s inferred type is not nameable outside `@vitest/spy`, which
 * makes the inferred return type non-portable across the package boundary.
 */
export type StatefulDbFixture = {
  db: {
    $queryRaw: Mock;
    $executeRaw: Mock;
    sessionDetail: Record<string, Mock>;
    agentComponentInvocationGeneration: Record<string, Mock>;
    agentComponentInvocationPart: Record<string, Mock>;
    agentComponentInvocation: Record<string, Mock>;
    agentComponent: Record<string, Mock>;
    definitionVersion: Record<string, Mock>;
  };
  generations: GenerationRow[];
  parts: PartRow[];
  invocations: Record<string, unknown>[];
};

export function installStatefulDb(
  txMock: Mock,
  input?: {
    sessionExists?: boolean;
    activeGeneration?: GenerationRow;
    generations?: GenerationRow[];
    components?: Array<{
      id: string;
      componentKind: string;
      componentKey: string | null;
      // ISS-4923: the skill-shadow inventory read selects it alongside `id`.
      externalComponentId?: string;
      /**
       * ISS-4923 (wongk review): the inventory read no longer filters COMMAND
       * rows to `resolved` in SQL — it reads every state and splits them into
       * `resolvedCommandKeys` / `definedCommandKeys` in code. This mock ignores
       * `where`, so a fixture must now carry the two columns the split reads or
       * it presents as an unresolved, definition-less row.
       */
      resolvedState?: string;
      content?: string | null;
    }>;
    definitionVersions?: Array<{
      id: string;
      componentKind: string;
      definitionHash: string;
      normalizerContractVersion: number;
    }>;
  }
): StatefulDbFixture {
  const generations: GenerationRow[] = [
    ...(input?.generations ?? []),
    ...(input?.activeGeneration ? [input.activeGeneration] : []),
  ];
  const parts: PartRow[] = [];
  const invocations: Record<string, unknown>[] = [];
  let nextGeneration = 1;
  let nextPart = 1;
  let nextInvocation = 1;

  const db = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    $executeRaw: vi.fn().mockResolvedValue(0),
    sessionDetail: {
      findFirst: vi
        .fn()
        .mockResolvedValue(
          input?.sessionExists === false ? null : { artifactId: SESSION_ID }
        ),
    },
    agentComponentInvocationGeneration: {
      upsert: vi.fn().mockImplementation(({ where, create, update }) => {
        const key =
          where.agentSessionId_externalGenerationId_sourceUpdatedAt_dataRevision_sourceSequence;
        const existing = generations.find(
          (row) =>
            row.agentSessionId === key.agentSessionId &&
            row.externalGenerationId === key.externalGenerationId &&
            row.sourceUpdatedAt.getTime() === key.sourceUpdatedAt.getTime() &&
            row.dataRevision === key.dataRevision &&
            row.sourceSequence === key.sourceSequence
        );
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const row: GenerationRow = {
          id: `generation-${nextGeneration++}`,
          ...create,
          activeAt: null,
          completedAt: null,
          updatedAt: new Date(),
        };
        generations.push(row);
        return row;
      }),
      deleteMany: vi.fn().mockImplementation(({ where }) => {
        const initialLength = generations.length;
        const deletedIds: string[] = [];
        for (let index = generations.length - 1; index >= 0; index -= 1) {
          const row = generations[index];
          if (row && matchesGenerationDelete(row, where)) {
            deletedIds.push(row.id);
            generations.splice(index, 1);
          }
        }
        cascadeGenerationDelete(deletedIds, parts, invocations);
        return { count: initialLength - generations.length };
      }),
      count: vi
        .fn()
        .mockImplementation(
          ({ where }) =>
            generations.filter(
              (row) =>
                row.agentSessionId === where.agentSessionId &&
                row.activeAt === (where.activeAt ?? null) &&
                row.completedAt === (where.completedAt ?? null)
            ).length
        ),
      findFirst: vi
        .fn()
        .mockImplementation(
          ({ where }) =>
            generations.find(
              (row) =>
                row.agentSessionId === where.agentSessionId &&
                row.activeAt !== null
            ) ?? null
        ),
      updateMany: vi.fn().mockImplementation(({ where, data }) => {
        let count = 0;
        for (const row of generations) {
          if (
            row.agentSessionId === where.agentSessionId &&
            row.activeAt !== null
          ) {
            Object.assign(row, data);
            count += 1;
          }
        }
        return { count };
      }),
      update: vi.fn().mockImplementation(({ where, data }) => {
        const row = generations.find((candidate) => candidate.id === where.id);
        if (!row) {
          throw new Error("missing generation fixture");
        }
        Object.assign(row, data);
        return row;
      }),
    },
    agentComponentInvocationPart: {
      findUnique: vi.fn().mockImplementation(({ where }) => {
        const key = where.generationId_partIndex;
        return (
          parts.find(
            (row) =>
              row.generationId === key.generationId &&
              row.partIndex === key.partIndex
          ) ?? null
        );
      }),
      create: vi.fn().mockImplementation(({ data }) => {
        const row = { id: `part-${nextPart++}`, ...data };
        parts.push(row);
        return row;
      }),
      findMany: vi
        .fn()
        .mockImplementation(({ where }) =>
          parts
            .filter((row) => row.generationId === where.generationId)
            .sort((left, right) => left.partIndex - right.partIndex)
        ),
      aggregate: vi.fn().mockImplementation(({ where }) => ({
        _sum: {
          payloadBytes:
            parts
              .filter((row) => row.generationId === where.generationId)
              .reduce((sum, row) => sum + (row.payloadBytes ?? 0), 0) || null,
        },
      })),
    },
    agentComponentInvocation: {
      count: vi
        .fn()
        .mockImplementation(
          ({ where }) =>
            invocations.filter((row) => row.generationId === where.generationId)
              .length
        ),
      findFirst: vi
        .fn()
        .mockImplementation(
          ({ where }) =>
            invocations.find(
              (row) =>
                row.generationId === where.generationId &&
                where.externalInvocationId.in.includes(row.externalInvocationId)
            ) ?? null
        ),
      findMany: vi
        .fn()
        .mockImplementation(({ where }) =>
          invocations
            .filter((row) => row.generationId === where.generationId)
            .sort(
              (left, right) =>
                Number(left.sequence) - Number(right.sequence) ||
                String(left.externalInvocationId).localeCompare(
                  String(right.externalInvocationId)
                )
            )
        ),
      createMany: vi.fn().mockImplementation(({ data }) => {
        for (const item of data) {
          invocations.push({ id: `invocation-${nextInvocation++}`, ...item });
        }
        return { count: data.length };
      }),
    },
    agentComponent: {
      findMany: vi.fn().mockResolvedValue(input?.components ?? []),
    },
    definitionVersion: {
      findMany: vi.fn().mockResolvedValue(input?.definitionVersions ?? []),
    },
  };
  txMock.mockImplementation((callback: (tx: unknown) => unknown) =>
    callback(db)
  );
  return { db, generations, parts, invocations };
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * The `ResolutionUpdate[]` payload `applyResolutionUpdates` serialized into its
 * `jsonb_to_recordset` statement — the observable contract of a completed
 * resolution pass.
 */
export function resolutionUpdatesFrom(executeRaw: Mock) {
  const call = executeRaw.mock.calls.find((args) => {
    const statement = args[0] as { strings?: string[] } | undefined;
    return statement?.strings?.join("").includes("jsonb_to_recordset");
  });
  const statement = call?.[0] as { values?: unknown[] } | undefined;
  const json = statement?.values?.find(
    (value): value is string =>
      typeof value === "string" && value.startsWith("[")
  );
  return json ? JSON.parse(json) : [];
}

/**
 * The generation-cleanup predicates the service issues, one named helper per
 * `deleteMany` shape. Split out of the mock (ISS-4923) so the store stays under
 * the cognitive-complexity ceiling and each cleanup reads as its own rule.
 */
type GenerationDeleteWhere = Record<
  string, // biome-ignore lint/suspicious/noExplicitAny: a Prisma `where` is an arbitrary nested filter object in this stand-in.
  any
>;

/** `deleteCompletedInactiveGenerations`: drop completed, non-active siblings. */
function isCompletedInactiveCleanup(
  row: GenerationRow,
  where: GenerationDeleteWhere
): boolean {
  return (
    where.completedAt?.not === null &&
    row.agentSessionId === where.agentSessionId &&
    row.activeAt === null &&
    row.completedAt !== null &&
    (where.id?.not === undefined || row.id !== where.id.not)
  );
}

/** `deleteStaleIncompleteGenerations`: drop TTL-expired partial generations. */
function isStaleIncompleteCleanup(
  row: GenerationRow,
  where: GenerationDeleteWhere
): boolean {
  return (
    row.agentSessionId === where.agentSessionId &&
    row.externalGenerationId !== where.externalGenerationId?.not &&
    row.activeAt === null &&
    row.completedAt === null &&
    row.updatedAt < (where.updatedAt?.lt ?? row.updatedAt)
  );
}

/** `deleteSupersededIncompleteGeneration`: drop the exact-identity partial. */
function isSupersededCurrentCleanup(
  row: GenerationRow,
  where: GenerationDeleteWhere
): boolean {
  return (
    row.agentSessionId === where.agentSessionId &&
    typeof where.externalGenerationId === "string" &&
    row.externalGenerationId === where.externalGenerationId &&
    row.sourceUpdatedAt.getTime() === where.sourceUpdatedAt?.getTime() &&
    row.dataRevision === where.dataRevision &&
    row.sourceSequence === where.sourceSequence &&
    row.expectedPartCount === where.expectedPartCount &&
    row.activeAt === null
  );
}

/** True when `row` is strictly older than the incoming freshness triple. */
function isOlderThanIncoming(
  row: GenerationRow,
  where: GenerationDeleteWhere
): boolean {
  const incomingUpdatedAt = where.OR?.[0]?.sourceUpdatedAt?.lt;
  if (!(incomingUpdatedAt instanceof Date)) {
    return false;
  }
  if (row.sourceUpdatedAt < incomingUpdatedAt) {
    return true;
  }
  if (row.sourceUpdatedAt.getTime() !== incomingUpdatedAt.getTime()) {
    return false;
  }
  const incomingRevision = Number(
    where.OR?.[1]?.dataRevision?.lt ?? Number.NaN
  );
  const incomingSequence = Number(
    where.OR?.[2]?.sourceSequence?.lt ?? Number.NaN
  );
  if (row.dataRevision < incomingRevision) {
    return true;
  }
  return (
    row.dataRevision === incomingRevision &&
    row.sourceSequence < incomingSequence
  );
}

/** The same-id-but-older incomplete generation the newer part supersedes. */
function isOlderSameIdIncomplete(
  row: GenerationRow,
  where: GenerationDeleteWhere
): boolean {
  return (
    row.agentSessionId === where.agentSessionId &&
    typeof where.externalGenerationId === "string" &&
    row.externalGenerationId === where.externalGenerationId &&
    row.activeAt === null &&
    row.completedAt === null &&
    isOlderThanIncoming(row, where)
  );
}

function matchesGenerationDelete(
  row: GenerationRow,
  where: GenerationDeleteWhere
): boolean {
  return (
    isCompletedInactiveCleanup(row, where) ||
    isStaleIncompleteCleanup(row, where) ||
    isSupersededCurrentCleanup(row, where) ||
    isOlderSameIdIncomplete(row, where)
  );
}

/** Mirror the FK cascade: a deleted generation takes its parts + rows with it. */
function cascadeGenerationDelete(
  deletedIds: readonly string[],
  parts: PartRow[],
  invocations: Record<string, unknown>[]
): void {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (deletedIds.includes(parts[index]?.generationId ?? "")) {
      parts.splice(index, 1);
    }
  }
  for (let index = invocations.length - 1; index >= 0; index -= 1) {
    if (deletedIds.includes(String(invocations[index]?.generationId))) {
      invocations.splice(index, 1);
    }
  }
}
