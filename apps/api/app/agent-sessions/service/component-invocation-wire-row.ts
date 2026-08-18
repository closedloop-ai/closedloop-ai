/**
 * Row <-> wire mapping for the dedicated component-invocation sync protocol.
 *
 * The two directions are a matched pair and must stay symmetric: after every
 * part of a generation is staged, ingest re-derives `externalGenerationId` from
 * the PERSISTED rows via `toSyncItem` and compares it to the id the producer
 * sent. A field that `mapInvocationCreate` writes but `toSyncItem` (and
 * `INVOCATION_HASH_SELECT`) do not read back — or that either side represents
 * differently from the producer — makes every generation carrying it fail
 * reconciliation as a `generation_conflict`, permanently.
 */

import {
  type AgentComponentInvocationSyncItem,
  canonicalAgentComponentInvocationCost,
} from "@repo/api/src/types/agent-component-invocation";
import {
  optionalDate,
  persistedAnchor,
  type StagedInvocationRow,
  toAttributionStatus,
  toEvidenceClass,
  toInvocationKind,
  toInvocationRelationship,
} from "./component-invocation-helpers";

/** Project one validated wire item onto its immutable staged row. */
export function mapInvocationCreate(
  generationId: string,
  partId: string,
  item: AgentComponentInvocationSyncItem
) {
  return {
    generationId,
    partId,
    externalInvocationId: item.externalInvocationId,
    sourceSessionId: item.sourceSessionId,
    childSessionId: item.childSessionId ?? null,
    parentExternalInvocationId: item.parentExternalInvocationId ?? null,
    externalAgentId: item.externalAgentId ?? null,
    componentKind: item.kind,
    componentKey: item.componentKey,
    rawName: item.rawName ?? null,
    normalizedName: item.normalizedName ?? null,
    relationship: item.relationship,
    invokedAt: item.invokedAt === null ? null : new Date(item.invokedAt),
    sequence: item.sequence,
    anchor: JSON.parse(JSON.stringify(item.anchor)),
    providerInvocationId: item.providerInvocationId ?? null,
    attributionStatus: item.status,
    evidenceClass: item.evidenceClass,
    definitionHash: item.definitionHash ?? null,
    normalizerContractVersion: item.normalizerContractVersion ?? null,
    definitionContent: item.definitionContent ?? null,
    definitionFormat: item.definitionFormat ?? null,
    sourcePath: item.sourcePath ?? null,
    sourceModifiedAt: optionalDate(item.sourceModifiedAt),
    capturedAt: optionalDate(item.capturedAt),
    repositoryFullName: item.repositoryFullName ?? null,
    repositoryCommit: item.repositoryCommit ?? null,
    packId: item.packId ?? null,
    branchName: item.branchName ?? null,
    // FEA-3981 (ISS-4976) per-invocation telemetry. An absent optional wire
    // field persists as NULL ("not computed"), which `toSyncItem` maps back to
    // an omitted key rather than an explicit null.
    model: item.model ?? null,
    inputTokens: optionalTokenCount(item.inputTokens),
    outputTokens: optionalTokenCount(item.outputTokens),
    cacheReadTokens: optionalTokenCount(item.cacheReadTokens),
    cacheWriteTokens: optionalTokenCount(item.cacheWriteTokens),
    estimatedCost: item.estimatedCost ?? null,
    footprintTokens: optionalTokenCount(item.footprintTokens),
  };
}

/**
 * Reconstruct the exact wire item a staged row came from. Absent values are
 * omitted rather than emitted as `null`, matching the producer's omission
 * contract so the canonical JSON — and therefore the generation hash — is
 * byte-identical on both sides.
 */
export function toSyncItem(
  row: StagedInvocationRow
): AgentComponentInvocationSyncItem {
  return {
    externalInvocationId: row.externalInvocationId,
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
    kind: toInvocationKind(row.componentKind),
    componentKey: row.componentKey,
    ...(row.rawName === null ? {} : { rawName: row.rawName }),
    ...(row.normalizedName === null
      ? {}
      : { normalizedName: row.normalizedName }),
    relationship: toInvocationRelationship(row.relationship),
    invokedAt: row.invokedAt?.toISOString() ?? null,
    sequence: row.sequence,
    anchor: persistedAnchor(row.anchor),
    ...(row.providerInvocationId === null
      ? {}
      : { providerInvocationId: row.providerInvocationId }),
    status: toAttributionStatus(row.attributionStatus),
    evidenceClass: toEvidenceClass(row.evidenceClass),
    ...(row.definitionHash === null
      ? {}
      : { definitionHash: row.definitionHash }),
    ...(row.normalizerContractVersion === null
      ? {}
      : { normalizerContractVersion: row.normalizerContractVersion }),
    ...(row.definitionContent === null
      ? {}
      : { definitionContent: row.definitionContent }),
    ...(row.definitionFormat === null
      ? {}
      : { definitionFormat: row.definitionFormat }),
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
    ...(row.model === null ? {} : { model: row.model }),
    ...persistedTokenCount("inputTokens", row.inputTokens),
    ...persistedTokenCount("outputTokens", row.outputTokens),
    ...persistedTokenCount("cacheReadTokens", row.cacheReadTokens),
    ...persistedTokenCount("cacheWriteTokens", row.cacheWriteTokens),
    ...(row.estimatedCost === null
      ? {}
      : {
          estimatedCost: canonicalAgentComponentInvocationCost(
            row.estimatedCost.toNumber()
          ),
        }),
    ...persistedTokenCount("footprintTokens", row.footprintTokens),
  };
}

/**
 * Token counts persist as `BigInt`. Every row in this table is written by the
 * ingest path above, whose `.strict()` boundary already bounded each count to a
 * safe integer, so the `Number()` read back below is exact. Were a row ever
 * seeded outside that boundary with a larger value, the widened read would fail
 * the generation-hash reconciliation and be rejected as a `generation_conflict`
 * rather than silently persisting a wrong number.
 */
function optionalTokenCount(value: number | undefined): bigint | null {
  return value === undefined ? null : BigInt(value);
}

function persistedTokenCount(
  key:
    | "inputTokens"
    | "outputTokens"
    | "cacheReadTokens"
    | "cacheWriteTokens"
    | "footprintTokens",
  value: bigint | null
): Partial<AgentComponentInvocationSyncItem> {
  return value === null ? {} : { [key]: Number(value) };
}
