import "server-only";

import type { SourceOccurrence } from "@repo/api/src/types/agent-component";
import { normalizeSourceOccurrenceType } from "@repo/api/src/types/agent-component";
import type {
  AgentComponentInvocationAnchor,
  AgentComponentInvocationReadPage,
  AgentComponentInvocationReadRow,
} from "@repo/api/src/types/agent-component-invocation";
import {
  AGENT_COMPONENT_INVOCATION_READ_MAX_ROWS,
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  AgentComponentInvocationRelationship,
} from "@repo/api/src/types/agent-component-invocation";
import type { Prisma, withDb } from "@repo/database";

type InvocationReadInput = {
  organizationId: string;
  kind: string;
  key: string;
  inventoryIds: string[];
};

type InvocationReadDbRow = Prisma.AgentComponentInvocationGetPayload<{
  select: typeof INVOCATION_READ_SELECT;
}>;

type InvocationSourceOccurrenceDbRow = Prisma.SourceOccurrenceGetPayload<{
  select: typeof INVOCATION_SOURCE_OCCURRENCE_SELECT;
}>;

export async function loadAgentComponentInvocationReadPage(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  input: InvocationReadInput
): Promise<AgentComponentInvocationReadPage> {
  const where = invocationReadWhere(input);
  const [rows, statusCounts] = await Promise.all([
    db.agentComponentInvocation.findMany({
      where,
      select: INVOCATION_READ_SELECT,
      orderBy: [
        { invokedAt: { sort: "desc", nulls: "last" } },
        { generationId: "asc" },
        { sequence: "asc" },
        { externalInvocationId: "asc" },
        { id: "asc" },
      ],
      take: AGENT_COMPONENT_INVOCATION_READ_MAX_ROWS,
    }),
    db.agentComponentInvocation.groupBy({
      by: ["attributionStatus"],
      where,
      _count: { _all: true },
    }),
  ]);
  const countByStatus = new Map(
    statusCounts.map((group) => [group.attributionStatus, group._count._all])
  );
  const total = statusCounts.reduce(
    (count, group) => count + group._count._all,
    0
  );
  const sourceOccurrenceIds = Array.from(
    new Set(
      rows.flatMap((row) =>
        row.sourceOccurrenceId === null ? [] : [row.sourceOccurrenceId]
      )
    )
  );
  const sourceOccurrences =
    sourceOccurrenceIds.length === 0
      ? []
      : await db.sourceOccurrence.findMany({
          where: {
            organizationId: input.organizationId,
            id: { in: sourceOccurrenceIds },
          },
          select: INVOCATION_SOURCE_OCCURRENCE_SELECT,
        });
  const sourceOccurrenceById = new Map(
    sourceOccurrences.map((occurrence) => [occurrence.id, occurrence])
  );
  return {
    items: rows.map((row) => toInvocationReadRow(row, sourceOccurrenceById)),
    total,
    hasMore: total > rows.length,
    unmatchedCount:
      countByStatus.get(AgentComponentInvocationAttributionStatus.Unmatched) ??
      0,
    ambiguousCount:
      countByStatus.get(AgentComponentInvocationAttributionStatus.Ambiguous) ??
      0,
  };
}

function invocationReadWhere(
  input: InvocationReadInput
): Prisma.AgentComponentInvocationWhereInput {
  const fallback = {
    agentComponentId: null,
    componentKind: input.kind,
    componentKey: { equals: input.key, mode: "insensitive" as const },
  };
  return {
    generation: {
      activeAt: { not: null },
      completedAt: { not: null },
      session: { artifact: { organizationId: input.organizationId } },
    },
    OR:
      input.inventoryIds.length === 0
        ? [fallback]
        : [{ agentComponentId: { in: input.inventoryIds } }, fallback],
  };
}

function toInvocationReadRow(
  row: InvocationReadDbRow,
  sourceOccurrenceById: ReadonlyMap<string, InvocationSourceOccurrenceDbRow>
): AgentComponentInvocationReadRow {
  const sourceOccurrence = row.sourceOccurrenceId
    ? sourceOccurrenceById.get(row.sourceOccurrenceId)
    : undefined;
  return {
    id: row.id,
    externalInvocationId: row.externalInvocationId,
    sessionId: row.generation.agentSessionId,
    externalSessionId: row.generation.session.externalSessionId,
    sourceSessionId: row.sourceSessionId,
    ...(row.childSessionId === null
      ? {}
      : { childSessionId: row.childSessionId }),
    ...(row.parentExternalInvocationId === null
      ? {}
      : { parentExternalInvocationId: row.parentExternalInvocationId }),
    ...(row.externalAgentId === null
      ? {}
      : { externalAgentId: row.externalAgentId }),
    kind: invocationContractValue(
      row.componentKind,
      AgentComponentInvocationKind,
      "kind"
    ),
    componentKey: row.componentKey,
    ...(row.rawName === null ? {} : { rawName: row.rawName }),
    ...(row.normalizedName === null
      ? {}
      : { normalizedName: row.normalizedName }),
    relationship: invocationContractValue(
      row.relationship,
      AgentComponentInvocationRelationship,
      "relationship"
    ),
    invokedAt: row.invokedAt?.toISOString() ?? null,
    sequence: row.sequence,
    anchor: invocationReadAnchor(row.anchor),
    ...(row.providerInvocationId === null
      ? {}
      : { providerInvocationId: row.providerInvocationId }),
    status: invocationContractValue(
      row.attributionStatus,
      AgentComponentInvocationAttributionStatus,
      "status"
    ),
    evidenceClass: invocationContractValue(
      row.evidenceClass,
      AgentComponentInvocationEvidenceClass,
      "evidenceClass"
    ),
    ...(row.definitionHash === null
      ? {}
      : { definitionHash: row.definitionHash }),
    ...(row.normalizerContractVersion === null
      ? {}
      : { normalizerContractVersion: row.normalizerContractVersion }),
    ...(row.definitionVersionId === null
      ? {}
      : { definitionVersionId: row.definitionVersionId }),
    ...(sourceOccurrence
      ? { sourceOccurrence: invocationSourceOccurrence(sourceOccurrence) }
      : {}),
    ...(row.sourcePath === null ? {} : { sourcePath: row.sourcePath }),
    ...(row.sourceModifiedAt === null
      ? {}
      : { sourceModifiedAt: row.sourceModifiedAt.toISOString() }),
    ...(row.capturedAt === null
      ? {}
      : { capturedAt: row.capturedAt.toISOString() }),
    ...(row.repositoryFullName === null
      ? {}
      : { repositoryFullName: row.repositoryFullName }),
    ...(row.repositoryCommit === null
      ? {}
      : { repositoryCommit: row.repositoryCommit }),
    ...(row.packId === null ? {} : { packId: row.packId }),
    ...(row.branchName === null ? {} : { branchName: row.branchName }),
  };
}

function invocationSourceOccurrence(
  row: InvocationSourceOccurrenceDbRow
): SourceOccurrence {
  return {
    // FEA-3982: degrade an unknown/skewed persisted occurrence type to `Local`
    // via the contract's documented coercion, so a value written by a newer peer
    // (static_file/distributed/builtin_*) that this reader does not know is never
    // emitted raw — matching `normalizeSourceOccurrenceType`'s stated read-path
    // contract instead of passing the column through untouched (wongk review).
    occurrenceType: normalizeSourceOccurrenceType(row.occurrenceType),
    accessState: row.accessState,
    repoFullName: row.repoFullName,
    repoPath: row.repoPath,
    repoCommit: row.repoCommit,
    computeTargetId: row.computeTargetId,
    localPath: row.localPath,
    packId: row.packId,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
  };
}

function invocationContractValue<T extends string>(
  value: string,
  contract: Record<string, T>,
  field: string
): T {
  const matched = Object.values(contract).find(
    (candidate) => candidate === value
  );
  if (matched === undefined) {
    throw new Error(`Invalid persisted invocation ${field}: ${value}`);
  }
  return matched;
}

function invocationReadAnchor(
  value: Prisma.JsonValue
): AgentComponentInvocationAnchor {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid persisted invocation anchor");
  }
  const record = value as Record<string, Prisma.JsonValue>;
  switch (record.kind) {
    case AgentComponentInvocationAnchorKind.Event:
      return {
        kind: AgentComponentInvocationAnchorKind.Event,
        eventId: requiredAnchorString(record.eventId),
        ...(typeof record.providerToolUseId === "string"
          ? { providerToolUseId: record.providerToolUseId }
          : {}),
      };
    case AgentComponentInvocationAnchorKind.Agent:
      return {
        kind: AgentComponentInvocationAnchorKind.Agent,
        agentId: requiredAnchorString(record.agentId),
        ...(typeof record.externalAgentId === "string"
          ? { externalAgentId: record.externalAgentId }
          : {}),
        ...(typeof record.transcriptFileId === "string"
          ? { transcriptFileId: record.transcriptFileId }
          : {}),
      };
    case AgentComponentInvocationAnchorKind.UserTurn:
      return {
        kind: AgentComponentInvocationAnchorKind.UserTurn,
        userTurnId: requiredAnchorString(record.userTurnId),
      };
    case AgentComponentInvocationAnchorKind.Timestamp:
      return {
        kind: AgentComponentInvocationAnchorKind.Timestamp,
        timestamp: requiredAnchorString(record.timestamp),
        ordinal: requiredAnchorNumber(record.ordinal),
      };
    case AgentComponentInvocationAnchorKind.Session:
      return { kind: AgentComponentInvocationAnchorKind.Session };
    default:
      throw new Error("Invalid persisted invocation anchor kind");
  }
}

function requiredAnchorString(value: Prisma.JsonValue | undefined): string {
  if (typeof value !== "string") {
    throw new Error("Invalid persisted invocation anchor string");
  }
  return value;
}

function requiredAnchorNumber(value: Prisma.JsonValue | undefined): number {
  if (typeof value !== "number") {
    throw new Error("Invalid persisted invocation anchor number");
  }
  return value;
}

const INVOCATION_READ_SELECT = {
  id: true,
  externalInvocationId: true,
  sourceSessionId: true,
  childSessionId: true,
  parentExternalInvocationId: true,
  externalAgentId: true,
  componentKind: true,
  componentKey: true,
  rawName: true,
  normalizedName: true,
  relationship: true,
  invokedAt: true,
  sequence: true,
  anchor: true,
  providerInvocationId: true,
  attributionStatus: true,
  evidenceClass: true,
  definitionHash: true,
  normalizerContractVersion: true,
  definitionVersionId: true,
  sourceOccurrenceId: true,
  sourcePath: true,
  sourceModifiedAt: true,
  capturedAt: true,
  repositoryFullName: true,
  repositoryCommit: true,
  packId: true,
  branchName: true,
  generation: {
    select: {
      agentSessionId: true,
      session: { select: { externalSessionId: true } },
    },
  },
} satisfies Prisma.AgentComponentInvocationSelect;

const INVOCATION_SOURCE_OCCURRENCE_SELECT = {
  id: true,
  occurrenceType: true,
  accessState: true,
  repoFullName: true,
  repoPath: true,
  repoCommit: true,
  computeTargetId: true,
  localPath: true,
  packId: true,
  firstSeenAt: true,
  lastSeenAt: true,
} satisfies Prisma.SourceOccurrenceSelect;
