import { createHash } from "node:crypto";
import { computeDefinitionHash } from "@repo/api/src/definition-fingerprint";
import {
  AgentComponentKind,
  type AgentComponentKind as DefinitionComponentKind,
} from "@repo/api/src/types/agent-component";
import {
  type AgentComponentInvocationAnchor,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  AgentComponentInvocationRelationship,
  AgentComponentInvocationSyncAckState,
  type AgentComponentInvocationSyncPart,
  type AgentComponentInvocationAttributionStatus as AttributionStatus,
  agentComponentInvocationSyncPartHashPreimage,
  type AgentComponentInvocationEvidenceClass as EvidenceClass,
  type AgentComponentInvocationKind as InvocationKind,
  type AgentComponentInvocationRelationship as InvocationRelationship,
  type AgentComponentInvocationSyncAckState as SyncAckState,
  type AgentComponentInvocationSyncRejectReason as SyncRejectReason,
} from "@repo/api/src/types/agent-component-invocation";
import {
  type Prisma,
  SourceAccessState,
  SourceOccurrenceType,
  type TransactionClient,
} from "@repo/database";

export function hasValidPartHash(
  part: AgentComponentInvocationSyncPart
): boolean {
  const { partHash: _partHash, ...withoutHash } = part;
  return (
    sha256Hex(agentComponentInvocationSyncPartHashPreimage(withoutHash)) ===
    part.partHash
  );
}

export function hasUniqueInvocationIds(
  part: AgentComponentInvocationSyncPart
): boolean {
  return (
    new Set(part.items.map((item) => item.externalInvocationId)).size ===
    part.items.length
  );
}

export function generationMatchesPart(
  generation: GenerationRecord,
  part: AgentComponentInvocationSyncPart
): boolean {
  return (
    generation.sourceUpdatedAt.getTime() ===
      new Date(part.sourceUpdatedAt).getTime() &&
    generation.dataRevision === part.dataRevision &&
    generation.sourceSequence === part.sourceSequence &&
    generation.expectedPartCount === part.partCount
  );
}

export function partLedgerMatches(
  existing: PartLedgerRecord,
  part: AgentComponentInvocationSyncPart,
  payloadBytes: number
): boolean {
  return (
    existing.partHash === part.partHash &&
    existing.itemCount === part.items.length &&
    existing.payloadBytes === payloadBytes
  );
}

export function hasEveryPart(
  rows: readonly PartSequenceRecord[],
  expectedPartCount: number
): boolean {
  return (
    rows.length === expectedPartCount &&
    rows.every((row, index) => row.partIndex === index)
  );
}

export function ackStateForGeneration(
  generation: GenerationRecord
): SyncAckState {
  if (generation.activeAt !== null) {
    return AgentComponentInvocationSyncAckState.Activated;
  }
  return generation.completedAt === null
    ? AgentComponentInvocationSyncAckState.Staged
    : AgentComponentInvocationSyncAckState.Stale;
}

export function compareFreshness(
  left: GenerationRecord,
  right: GenerationRecord
): number {
  const byUpdatedAt =
    left.sourceUpdatedAt.getTime() - right.sourceUpdatedAt.getTime();
  if (byUpdatedAt !== 0) {
    return byUpdatedAt;
  }
  const byRevision = left.dataRevision - right.dataRevision;
  return byRevision === 0
    ? left.sourceSequence - right.sourceSequence
    : byRevision;
}

export function resolveComponent(
  componentMap: ReadonlyMap<string, ComponentResolution>,
  row: StagedInvocationRow
): ComponentResolution {
  return (
    componentMap.get(
      componentLookupKey(row.componentKind, row.componentKey)
    ) ?? { kind: "none" }
  );
}

export function resolvedAttributionStatus(
  original: AttributionStatus,
  component: ComponentResolution,
  hasVersion: boolean
): AttributionStatus {
  if (component.kind === "ambiguous") {
    return AgentComponentInvocationAttributionStatus.Ambiguous;
  }
  if (hasVersion && component.kind === "single") {
    return AgentComponentInvocationAttributionStatus.Matched;
  }
  if (
    hasVersion ||
    original === AgentComponentInvocationAttributionStatus.Unmatched
  ) {
    return AgentComponentInvocationAttributionStatus.Unmatched;
  }
  return AgentComponentInvocationAttributionStatus.Unresolved;
}

export function buildResolutionUpdate(
  row: StagedInvocationRow,
  values: Omit<ResolutionUpdate, "id">
): ResolutionUpdate {
  return { id: row.id, ...values };
}

export function genuineSourceOccurrence(
  row: StagedInvocationRow,
  computeTargetId: string
): GenuineSourceOccurrence | null {
  const observedAt = preferredObservedAt(row);
  if (
    row.evidenceClass ===
      AgentComponentInvocationEvidenceClass.CollectorSnapshot &&
    row.sourcePath !== null
  ) {
    return {
      occurrenceType: SourceOccurrenceType.local,
      accessState: SourceAccessState.accessible,
      computeTargetId,
      installPath: row.sourcePath,
      observedAt,
    };
  }
  if (
    row.evidenceClass ===
      AgentComponentInvocationEvidenceClass.RepositoryCommit &&
    row.repositoryFullName !== null &&
    row.repositoryCommit !== null &&
    row.sourcePath !== null
  ) {
    return {
      occurrenceType: SourceOccurrenceType.repository,
      accessState: SourceAccessState.accessible,
      computeTargetId: null,
      installPath: null,
      repoFullName: row.repositoryFullName,
      repoPath: row.sourcePath,
      repoCommit: row.repositoryCommit,
      observedAt,
    };
  }
  if (
    row.evidenceClass ===
      AgentComponentInvocationEvidenceClass.PackMembership &&
    row.packId !== null
  ) {
    return {
      occurrenceType: SourceOccurrenceType.pack,
      accessState: SourceAccessState.accessible,
      computeTargetId: null,
      installPath: null,
      packId: row.packId,
      observedAt,
    };
  }
  return null;
}

export function preferredObservedAt(row: StagedInvocationRow): Date {
  return row.capturedAt ?? row.sourceModifiedAt ?? row.invokedAt ?? new Date();
}

export function isNonVersionable(componentKind: string): boolean {
  return (
    componentKind === AgentComponentInvocationKind.Tool ||
    componentKind === AgentComponentInvocationKind.Mcp ||
    componentKind === AgentComponentInvocationKind.Orchestration ||
    // FEA-4093: a Hook firing has no definition file (the materializer captures
    // it from an `attachment` record with no `.md` snapshot), so it is
    // non-versionable exactly like Tool/Mcp/Orchestration. This also fails-safe
    // a version-skewed sync payload: an item that arrives tagged `hook` with
    // definition evidence takes the no-definition/no-source-links path instead
    // of reaching `toDefinitionComponentKind` (which has no Hook mapping) and
    // throwing during activation.
    componentKind === AgentComponentInvocationKind.Hook
  );
}

export function toDefinitionComponentKind(
  value: string
): DefinitionComponentKind {
  switch (value) {
    case AgentComponentInvocationKind.Command:
      return AgentComponentKind.Command;
    case AgentComponentInvocationKind.Skill:
      return AgentComponentKind.Skill;
    case AgentComponentInvocationKind.Subagent:
      return AgentComponentKind.Subagent;
    default:
      throw new Error(
        `Unsupported definition-backed invocation kind: ${value}`
      );
  }
}

export function toInvocationKind(value: string): InvocationKind {
  switch (value) {
    case AgentComponentInvocationKind.Tool:
    case AgentComponentInvocationKind.Mcp:
    case AgentComponentInvocationKind.Orchestration:
    case AgentComponentInvocationKind.Command:
    case AgentComponentInvocationKind.Skill:
    case AgentComponentInvocationKind.Subagent:
    // FEA-4093: `hook` is a persisted invocation kind now that the desktop
    // captures Hook firings; accept it so a synced hook invocation reads back
    // instead of throwing on ingest.
    case AgentComponentInvocationKind.Hook:
      return value;
    default:
      throw new Error(`Invalid persisted invocation kind: ${value}`);
  }
}

export function toAttributionStatus(value: string): AttributionStatus {
  switch (value) {
    case AgentComponentInvocationAttributionStatus.Matched:
    case AgentComponentInvocationAttributionStatus.Unresolved:
    case AgentComponentInvocationAttributionStatus.Unmatched:
    case AgentComponentInvocationAttributionStatus.Ambiguous:
      return value;
    default:
      throw new Error(`Invalid persisted invocation status: ${value}`);
  }
}

export function toEvidenceClass(value: string): EvidenceClass {
  switch (value) {
    case AgentComponentInvocationEvidenceClass.TranscriptSnapshot:
    case AgentComponentInvocationEvidenceClass.CollectorSnapshot:
    case AgentComponentInvocationEvidenceClass.RepositoryCommit:
    case AgentComponentInvocationEvidenceClass.PackMembership:
    case AgentComponentInvocationEvidenceClass.None:
      return value;
    default:
      throw new Error(`Invalid persisted invocation evidence: ${value}`);
  }
}

export function toInvocationRelationship(
  value: string
): InvocationRelationship {
  switch (value) {
    case AgentComponentInvocationRelationship.Direct:
    case AgentComponentInvocationRelationship.ChildSession:
    case AgentComponentInvocationRelationship.Associated:
      return value;
    default:
      throw new Error(`Invalid persisted invocation relationship: ${value}`);
  }
}

export function persistedAnchor(
  value: Prisma.JsonValue
): AgentComponentInvocationAnchor {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid persisted invocation anchor");
  }
  const serialized = JSON.parse(JSON.stringify(value));
  return serialized as AgentComponentInvocationAnchor;
}

export function componentLookupKey(kind: string, componentKey: string): string {
  return `${kind}\u0000${componentKey}`;
}

export function optionalDate(value: string | undefined): Date | null {
  return value === undefined ? null : new Date(value);
}

export function serializedBytes(value: unknown): number {
  return TEXT_ENCODER.encode(JSON.stringify(value)).byteLength;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export type GenerationRecord = {
  id: string;
  agentSessionId: string;
  externalGenerationId: string;
  sourceUpdatedAt: Date;
  dataRevision: number;
  sourceSequence: number;
  expectedPartCount: number;
  activeAt: Date | null;
  completedAt: Date | null;
};

export type PartLedgerRecord = {
  partHash: string;
  itemCount: number;
  payloadBytes: number;
};

export type PartSequenceRecord = {
  partIndex: number;
  itemCount: number;
};

export type StagedInvocationRow = {
  id: string;
  externalInvocationId: string;
  sourceSessionId: string;
  childSessionId: string | null;
  parentExternalInvocationId: string | null;
  externalAgentId: string | null;
  componentKind: string;
  componentKey: string;
  rawName: string | null;
  normalizedName: string | null;
  relationship: string;
  invokedAt: Date | null;
  sequence: number;
  anchor: Prisma.JsonValue;
  providerInvocationId: string | null;
  attributionStatus: string;
  evidenceClass: string;
  definitionHash: string | null;
  normalizerContractVersion: number | null;
  definitionContent: string | null;
  definitionFormat: string | null;
  sourcePath: string | null;
  sourceModifiedAt: Date | null;
  capturedAt: Date | null;
  repositoryFullName: string | null;
  repositoryCommit: string | null;
  packId: string | null;
  branchName: string | null;
  model: string | null;
  inputTokens: bigint | null;
  outputTokens: bigint | null;
  cacheReadTokens: bigint | null;
  cacheWriteTokens: bigint | null;
  estimatedCost: Prisma.Decimal | null;
  footprintTokens: bigint | null;
};

export type ResolutionUpdate = {
  id: string;
  agentComponentId: string | null;
  attributionStatus: AttributionStatus;
  definitionHash: string | null;
  normalizerContractVersion: number | null;
  definitionVersionId: string | null;
  sourceOccurrenceId: string | null;
  // ISS-4923: the post-hash identity re-point for a skill-shadowed phantom
  // `command`. Present ONLY on a rewritten row — the UPDATE `COALESCE`s each
  // column, so an absent key leaves the stored value untouched. Deliberately
  // OPTIONAL rather than nullable: `null` would mean "clear this column", which
  // is never what a non-phantom row wants (see `skill-shadow-normalization.ts`).
  componentKind?: string;
  componentKey?: string;
  normalizedName?: string;
};

export type ResolutionInput = {
  organizationId: string;
  computeTargetId: string;
  rows: StagedInvocationRow[];
};

export type ResolutionResult =
  | { ok: true; updates: ResolutionUpdate[] }
  | { ok: false; error: SyncRejectReason };

export type ResolveInvocationInput = {
  organizationId: string;
  computeTargetId: string;
  row: StagedInvocationRow;
  componentMap: ReadonlyMap<string, ComponentResolution>;
  definitionMap: Map<string, DefinitionResolution>;
  ensuredDefinitionMap: Map<string, DefinitionResolution>;
  definitionObservedAtByHash: ReadonlyMap<string, Date>;
  occurrenceObservedAtByKey: ReadonlyMap<string, Date>;
  occurrenceIdCache: Map<string, string>;
};

export type ResolveInvocationResult =
  | { ok: true; update: ResolutionUpdate }
  | { ok: false; error: SyncRejectReason };

export type ComponentResolution =
  | { kind: "none" }
  | { kind: "single"; id: string }
  | { kind: "ambiguous" };

export type DefinitionResolution = {
  id: string;
  componentKind: string;
  definitionHash: string;
  normalizerContractVersion: number;
};

export type DefinitionResolutionResult =
  | { ok: true; value: DefinitionResolution | null }
  | { ok: false; error: SyncRejectReason };

export type GenuineSourceOccurrence = {
  occurrenceType: SourceOccurrenceType;
  accessState: SourceAccessState;
  computeTargetId: string | null;
  installPath: string | null;
  observedAt: Date;
  repoFullName?: string;
  repoPath?: string;
  repoCommit?: string;
  packId?: string;
};

export const TEXT_ENCODER = new TextEncoder();
export const INVOCATION_INGEST_TX_OPTIONS = { timeout: 30_000 } as const;
export const INCOMPLETE_GENERATION_TTL_MS = 24 * 60 * 60 * 1000;
export const GENERATION_SELECT = {
  id: true,
  agentSessionId: true,
  externalGenerationId: true,
  sourceUpdatedAt: true,
  dataRevision: true,
  sourceSequence: true,
  expectedPartCount: true,
  activeAt: true,
  completedAt: true,
} as const;
export const INVOCATION_HASH_SELECT = {
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
  definitionContent: true,
  definitionFormat: true,
  sourcePath: true,
  sourceModifiedAt: true,
  capturedAt: true,
  repositoryFullName: true,
  repositoryCommit: true,
  packId: true,
  branchName: true,
  // FEA-3981 (ISS-4976). These MUST stay selected: the post-ingest generation
  // hash is recomputed from these rows, so a telemetry column the producer sent
  // but this select omits would reconstruct a different item and reject the
  // whole generation as a `generation_conflict`.
  model: true,
  inputTokens: true,
  outputTokens: true,
  cacheReadTokens: true,
  cacheWriteTokens: true,
  estimatedCost: true,
  footprintTokens: true,
} as const;

export function deleteStaleIncompleteGenerations(
  tx: TransactionClient,
  agentSessionId: string,
  currentExternalGenerationId: string
) {
  const staleBefore = new Date(Date.now() - INCOMPLETE_GENERATION_TTL_MS);
  return tx.agentComponentInvocationGeneration.deleteMany({
    where: {
      agentSessionId,
      externalGenerationId: { not: currentExternalGenerationId },
      activeAt: null,
      completedAt: null,
      updatedAt: { lt: staleBefore },
    },
  });
}

export function deleteSupersededIncompleteGeneration(
  tx: TransactionClient,
  agentSessionId: string,
  part: AgentComponentInvocationSyncPart
) {
  const sourceUpdatedAt = new Date(part.sourceUpdatedAt);
  return tx.agentComponentInvocationGeneration.deleteMany({
    where: {
      agentSessionId,
      externalGenerationId: part.externalGenerationId,
      activeAt: null,
      completedAt: null,
      OR: [
        { sourceUpdatedAt: { lt: sourceUpdatedAt } },
        {
          sourceUpdatedAt,
          dataRevision: { lt: part.dataRevision },
        },
        {
          sourceUpdatedAt,
          dataRevision: part.dataRevision,
          sourceSequence: { lt: part.sourceSequence },
        },
      ],
    },
  });
}

export function deleteCompletedInactiveGenerations(
  tx: TransactionClient,
  agentSessionId: string,
  activeGenerationId: string | null
) {
  return tx.agentComponentInvocationGeneration.deleteMany({
    where: {
      agentSessionId,
      ...(activeGenerationId === null
        ? {}
        : { id: { not: activeGenerationId } }),
      activeAt: null,
      completedAt: { not: null },
    },
  });
}

export function loadActiveGeneration(
  tx: TransactionClient,
  agentSessionId: string
): Promise<GenerationRecord | null> {
  return tx.agentComponentInvocationGeneration.findFirst({
    where: {
      agentSessionId,
      activeAt: { not: null },
    },
    select: GENERATION_SELECT,
  });
}

export function comparePartFreshness(
  part: AgentComponentInvocationSyncPart,
  generation: GenerationRecord
): number {
  const byUpdatedAt =
    new Date(part.sourceUpdatedAt).getTime() -
    generation.sourceUpdatedAt.getTime();
  if (byUpdatedAt !== 0) {
    return byUpdatedAt;
  }
  const byRevision = part.dataRevision - generation.dataRevision;
  return byRevision === 0
    ? part.sourceSequence - generation.sourceSequence
    : byRevision;
}

export function latestDefinitionObservedAtByHash(
  rows: readonly StagedInvocationRow[]
): Map<string, Date> {
  const latestByHash = new Map<string, Date>();
  for (const row of rows) {
    if (
      row.definitionContent === null ||
      isNonVersionable(row.componentKind) ||
      row.attributionStatus ===
        AgentComponentInvocationAttributionStatus.Ambiguous
    ) {
      continue;
    }
    const fingerprint = computeDefinitionHash({
      frontmatter: "",
      body: row.definitionContent,
      kind: toDefinitionComponentKind(row.componentKind),
    });
    keepLatestDate(
      latestByHash,
      fingerprint.definitionHash,
      preferredObservedAt(row)
    );
  }
  return latestByHash;
}

export function latestOccurrenceObservedAtByKey(
  rows: readonly StagedInvocationRow[],
  computeTargetId: string
): Map<string, Date> {
  const latestByKey = new Map<string, Date>();
  for (const row of rows) {
    if (
      isNonVersionable(row.componentKind) ||
      row.attributionStatus ===
        AgentComponentInvocationAttributionStatus.Ambiguous
    ) {
      continue;
    }
    const definitionHash = definitionHashForRow(row);
    const occurrence = genuineSourceOccurrence(row, computeTargetId);
    if (!(definitionHash && occurrence)) {
      continue;
    }
    const { observedAt, ...occurrenceIdentity } = occurrence;
    keepLatestDate(
      latestByKey,
      sourceOccurrenceCacheKey(definitionHash, occurrenceIdentity),
      observedAt
    );
  }
  return latestByKey;
}

export function definitionHashForRow(row: StagedInvocationRow): string | null {
  if (row.definitionContent === null) {
    return row.definitionHash;
  }
  return computeDefinitionHash({
    frontmatter: "",
    body: row.definitionContent,
    kind: toDefinitionComponentKind(row.componentKind),
  }).definitionHash;
}

export function sourceOccurrenceCacheKey(
  definitionIdentity: string,
  occurrence: Omit<GenuineSourceOccurrence, "observedAt">
): string {
  return JSON.stringify({ definitionIdentity, ...occurrence });
}

export function keepLatestDate(
  dates: Map<string, Date>,
  key: string,
  candidate: Date
): void {
  const current = dates.get(key);
  if (!current || current < candidate) {
    dates.set(key, candidate);
  }
}
