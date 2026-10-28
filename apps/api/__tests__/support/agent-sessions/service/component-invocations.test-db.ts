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
  // ISS-12781: the part's redacted items until its generation is applied.
  stagedItems?: unknown;
  // ISS-12781: those items' projected ids, read by the cross-part id probe.
  stagedInvocationIds?: unknown;
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
  /** ISS-5801: target a second seeded session (defaults to the shared one). */
  externalSessionId?: string;
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
    externalSessionId: input.externalSessionId ?? EXTERNAL_SESSION_ID,
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
       * ISS-4923 (whitlockk review): the inventory read no longer filters COMMAND
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
    // ISS-12781: the cross-part id probe reads `staged_invocation_ids`; every
    // other raw read in the ingest (session lock, parent resolution) answers
    // empty here.
    $queryRaw: vi
      .fn()
      .mockImplementation((statement: RawStatement) =>
        stagedIdConflictRows(statement, parts)
      ),
    $executeRaw: vi
      .fn()
      .mockImplementation((statement: RawStatement) =>
        clearStagedItems(statement, parts)
      ),
    sessionDetail: {
      findFirst: vi
        .fn()
        .mockResolvedValue(
          input?.sessionExists === false
            ? null
            : { artifactId: SESSION_ID, computeTargetId: COMPUTE_TARGET_ID }
        ),
      // ISS-5801: activation folds the activated generation's row count onto
      // the parent session; tests assert against this mock's call args.
      update: vi.fn().mockResolvedValue({ artifactId: SESSION_ID }),
    },
    agentComponentInvocationGeneration: {
      // ISS-8267: the ingest's generation write is a findUnique → create /
      // update-by-id pair, never a Prisma `upsert` (the native upsert
      // arbitrates on the partial unique and 42P10s against real Postgres).
      create: vi.fn().mockImplementation(({ data }) => {
        const row: GenerationRow = {
          id: `generation-${nextGeneration++}`,
          ...data,
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
      // ISS-6883: the ingest loads the incoming generation by its full wire
      // identity BEFORE charging the in-flight cap, and the generation write
      // (ISS-8267) re-reads the same compound key to decide create vs update.
      findUnique: vi.fn().mockImplementation(({ where }) => {
        const key =
          where.agentSessionId_externalGenerationId_sourceUpdatedAt_dataRevision_sourceSequence;
        return (
          generations.find(
            (row) =>
              row.agentSessionId === key.agentSessionId &&
              row.externalGenerationId === key.externalGenerationId &&
              row.sourceUpdatedAt.getTime() === key.sourceUpdatedAt.getTime() &&
              row.dataRevision === key.dataRevision &&
              row.sourceSequence === key.sourceSequence
          ) ?? null
        );
      }),
      // ISS-6883: an ABSENT `agentSessionId` means Prisma does not filter on it
      // at all, so it must widen to every session here too. Treating it as a
      // mismatch let a count that dropped its session scope read as zero — the
      // opposite of the cross-session over-count such a drop really causes.
      count: vi
        .fn()
        .mockImplementation(
          ({ where }) =>
            generations.filter(
              (row) =>
                (where.agentSessionId === undefined ||
                  row.agentSessionId === where.agentSessionId) &&
                row.activeAt === (where.activeAt ?? null) &&
                row.completedAt === (where.completedAt ?? null)
            ).length
        ),
      // ISS-6883: honor the `where` it is handed rather than hard-coding the
      // active-generation predicate. Pinning `activeAt !== null` here made this
      // stand-in answer the same row for ANY findFirst, so a lookup that
      // wrongly widened its identity filter still read as "no match" and the
      // suite stayed green under the very mutation it was meant to catch.
      findFirst: vi
        .fn()
        .mockImplementation(
          ({ where }) =>
            generations.find((row) => matchesGenerationFind(row, where)) ?? null
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
      update: vi.fn().mockImplementation(({ where, data }) => {
        const row = parts.find((candidate) => candidate.id === where.id);
        if (!row) {
          throw new Error("missing part fixture");
        }
        Object.assign(row, data);
        return row;
      }),
      deleteMany: vi.fn().mockImplementation(({ where }) => {
        const before = parts.length;
        removeWhere(parts, (row) => where.id.in.includes(row.id));
        return { count: before - parts.length };
      }),
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
        const row = { id: `part-${nextPart++}`, stagedItems: null, ...data };
        parts.push(row);
        return row;
      }),
      // A column Postgres holds NULL reads back as `null`, never `undefined`.
      findMany: vi.fn().mockImplementation(({ where }) =>
        parts
          .filter((row) => row.generationId === where.generationId)
          .sort((left, right) => left.partIndex - right.partIndex)
          .map((row) => ({ ...row, stagedItems: row.stagedItems ?? null }))
      ),
      aggregate: vi.fn().mockImplementation(({ where }) => {
        const generationParts = parts.filter(
          (row) => row.generationId === where.generationId
        );
        return {
          _sum: {
            payloadBytes:
              generationParts.reduce(
                (sum, row) => sum + (row.payloadBytes ?? 0),
                0
              ) || null,
            itemCount:
              generationParts.reduce((sum, row) => sum + row.itemCount, 0) ||
              null,
          },
        };
      }),
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
      findMany: vi.fn().mockImplementation(({ where, select }) =>
        invocations
          .filter(
            (row) =>
              row.generationId === where.generationId &&
              (where.partId === undefined ||
                where.partId.in.includes(row.partId))
          )
          .sort(
            (left, right) =>
              Number(left.sequence) - Number(right.sequence) ||
              String(left.externalInvocationId).localeCompare(
                String(right.externalInvocationId)
              )
          )
          .map((row) => selectedColumns(row, select))
      ),
      createMany: vi.fn().mockImplementation(({ data }) => {
        for (const item of data) {
          invocations.push({ id: `invocation-${nextInvocation++}`, ...item });
        }
        return { count: data.length };
      }),
      // ISS-12781: activation deletes changed/removed rows by id, or a legacy
      // staging generation's rows by generation.
      deleteMany: vi.fn().mockImplementation(({ where }) => {
        const before = invocations.length;
        removeWhere(invocations, (row) =>
          where.id === undefined
            ? row.generationId === where.generationId
            : where.id.in.includes(row.id)
        );
        return { count: before - invocations.length };
      }),
      updateMany: vi.fn().mockImplementation(({ where, data }) => {
        let count = 0;
        for (const row of invocations) {
          if (where.partId.in.includes(row.partId)) {
            Object.assign(row, data);
            count += 1;
          }
        }
        return { count };
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
 * The resolution every activated row was written with — the observable
 * contract of a completed resolution pass. ISS-12781: activation writes each
 * row once with its resolution applied, so it is read off the `createMany` the
 * rows were written with rather than a separate resolution UPDATE.
 */
export function resolutionUpdatesFrom(createMany: Mock) {
  return createMany.mock.calls.flatMap((args) => {
    const input = args[0] as { data: Record<string, unknown>[] };
    return input.data;
  });
}

/**
 * The generation-cleanup predicates the service issues, one named helper per
 * `deleteMany` shape. Split out of the mock (ISS-4923) so the store stays under
 * the cognitive-complexity ceiling and each cleanup reads as its own rule.
 */
type GenerationDeleteWhere = {
  agentSessionId?: string;
  externalGenerationId?: string | { not?: string };
  id?: string | { not?: string };
  activeAt?: Date | null | { not: null };
  completedAt?: { not?: Date | null };
  updatedAt?: { lt?: Date };
  sourceUpdatedAt?: Date;
  dataRevision?: number;
  sourceSequence?: number;
  expectedPartCount?: number;
  OR?: {
    sourceUpdatedAt?: { lt?: Date };
    dataRevision?: { lt?: number };
    sourceSequence?: { lt?: number };
  }[];
};

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
    (typeof where.id !== "object" ||
      where.id.not === undefined ||
      row.id !== where.id.not)
  );
}

/** `deleteStaleIncompleteGenerations`: drop TTL-expired partial generations. */
function isStaleIncompleteCleanup(
  row: GenerationRow,
  where: GenerationDeleteWhere
): boolean {
  return (
    row.agentSessionId === where.agentSessionId &&
    row.externalGenerationId !== excludedExternalGenerationId(where) &&
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

/**
 * The subset of `where` shapes the generation `findFirst` reads: an optional
 * session scope, an optional exact `externalGenerationId`, and the `activeAt`
 * predicate. An absent key does not filter, exactly as Prisma treats it.
 */
function matchesGenerationFind(
  row: GenerationRow,
  where: GenerationDeleteWhere
): boolean {
  if (
    where.agentSessionId !== undefined &&
    row.agentSessionId !== where.agentSessionId
  ) {
    return false;
  }
  if (
    where.externalGenerationId !== undefined &&
    row.externalGenerationId !== where.externalGenerationId
  ) {
    return false;
  }
  if (where.activeAt === undefined) {
    return true;
  }
  return isNotNullFilter(where.activeAt)
    ? row.activeAt !== null
    : row.activeAt === where.activeAt;
}

function matchesGenerationDelete(
  row: GenerationRow,
  where: GenerationDeleteWhere
): boolean {
  return (
    (typeof where.id === "string" && row.id === where.id) ||
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

/** The `{ not }` operand of an `externalGenerationId` filter, if it is one. */
function excludedExternalGenerationId(
  where: GenerationDeleteWhere
): string | undefined {
  const filter = where.externalGenerationId;
  return typeof filter === "object" ? filter.not : undefined;
}

/** True for Prisma's `{ not: null }` filter, false for an exact value. */
function isNotNullFilter(
  value: GenerationDeleteWhere["activeAt"]
): value is { not: null } {
  return (
    value !== null &&
    value !== undefined &&
    !(value instanceof Date) &&
    value.not === null
  );
}

type RawStatement = { strings?: string[]; values?: unknown[] };

function rawText(statement: RawStatement): string {
  return statement.strings?.join("") ?? "";
}

/** ISS-12781: answer the cross-part id probe from the parts' staged ids. */
function stagedIdConflictRows(
  statement: RawStatement,
  parts: readonly PartRow[]
): Array<{ conflict: boolean }> {
  if (!rawText(statement).includes("staged_invocation_ids ?|")) {
    return [];
  }
  const [generationId, incoming] = statement.values ?? [];
  const incomingIds = new Set(Array.isArray(incoming) ? incoming : []);
  const conflict = parts.some(
    (part) =>
      part.generationId === generationId &&
      Array.isArray(part.stagedInvocationIds) &&
      part.stagedInvocationIds.some((id) => incomingIds.has(id))
  );
  return [{ conflict }];
}

/** ISS-12781: an applied generation's parts drop their staged items. */
function clearStagedItems(statement: RawStatement, parts: PartRow[]): number {
  if (
    !rawText(statement).includes(
      "SET staged_items = NULL, staged_invocation_ids = NULL"
    )
  ) {
    return 0;
  }
  const generationId = statement.values?.[0];
  let count = 0;
  for (const part of parts) {
    if (part.generationId === generationId) {
      part.stagedItems = null;
      part.stagedInvocationIds = null;
      count += 1;
    }
  }
  return count;
}

/** Prisma returns only the selected columns; a whole row when none are named. */
function selectedColumns(
  row: Record<string, unknown>,
  select: Record<string, true> | undefined
): Record<string, unknown> {
  if (!select) {
    return row;
  }
  return Object.fromEntries(
    Object.keys(select).map((column) => [column, row[column] ?? null])
  );
}

function removeWhere<T>(rows: T[], predicate: (row: T) => boolean): void {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row !== undefined && predicate(row)) {
      rows.splice(index, 1);
    }
  }
}
