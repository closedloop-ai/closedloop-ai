/**
 * Row <-> wire mapping for the dedicated component-invocation sync protocol.
 *
 * The two directions are a matched pair and must stay symmetric: after every
 * part of a generation is staged, ingest re-derives `externalGenerationId` from
 * the staged rows via `toSyncItem` and compares it to the id the producer sent.
 * A field that `mapInvocationCreate` writes but `toSyncItem` (and
 * `INVOCATION_HASH_SELECT`) do not read back — or that either side represents
 * differently from the producer — makes every generation carrying it fail
 * reconciliation as a `generation_conflict`, permanently.
 *
 * ISS-8736 is the first deliberate asymmetry. `externalInvocationId`,
 * `componentKey` and `branchName` each land on a btree index key, so
 * `mapInvocationCreate` runs them through `projectIndexKey` (ISS-8069): a value
 * inside the byte budget is stored verbatim and round-trips exactly; one past it
 * is stored as its deterministic projection, which `toSyncItem` cannot invert.
 * The generation-hash check therefore skips a generation holding a projected
 * key — see `generationHashIsVerifiable` — instead of rejecting it forever.
 *
 * ISS-4965 is the second: `definitionContent` is secret-redacted at the write,
 * with its fingerprint recomputed, so a row from a Desktop that sent raw text
 * cannot reproduce that text — see `generationHashVerdict`.
 */

import { storedAgentComponentFindingsWireProjection } from "@repo/api/src/types/agent-component-findings-funnel";
import {
  type AgentComponentInvocationSyncItem,
  agentComponentInvocationGenerationHashPreimage,
  canonicalAgentComponentInvocationCost,
} from "@repo/api/src/types/agent-component-invocation";
import { invocationDurationFields } from "@repo/api/src/types/agent-component-invocation-duration";
import {
  carriesRedactionMarker,
  redactInvocationDefinitionContent,
} from "@repo/lib/security/redact-definition-content";
import {
  countProjected,
  hasProjectedIndexKeyShape,
  indexKeyCandidates,
  projectIndexKey,
  projectNullableIndexKey,
} from "@/lib/index-key-projection";
import {
  optionalDate,
  persistedAnchor,
  type StagedInvocationRow,
  sha256Hex,
  toAttributionSource,
  toAttributionStatus,
  toEvidenceClass,
  toInvocationKind,
  toInvocationRelationship,
  toUsageMeasurement,
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
    ...buildInvocationColumns(item, projectInvocationIndexKeys(item)),
  };
}

/**
 * ISS-12781: the row a wire item persists as, held in memory under `id` until
 * its generation completes. Same columns {@link mapInvocationCreate} writes, so
 * the generation hash and resolution read exactly what a staged table row held.
 */
export function stagedInvocationRow(
  id: string,
  item: AgentComponentInvocationSyncItem
): StagedInvocationRow {
  return {
    id,
    ...buildInvocationColumns(item, projectInvocationIndexKeys(item)),
  };
}

/** How many index keys of these items the byte budget bound, reported once per part. */
export function countProjectedIndexKeys(
  items: readonly AgentComponentInvocationSyncItem[]
): number {
  return items.reduce(
    (total, item) => total + projectInvocationIndexKeys(item).projectedCount,
    0
  );
}

/**
 * Whether the generation hash can be recomputed from these rows. A projected
 * key is a digest of the bytes the producer hashed, not those bytes, so a
 * generation holding one cannot re-derive the id it was sent under from
 * storage. A one-part generation still can, from the raw wire part in hand —
 * see `generationHashVerdict`; only a multi-part one skips the check, and
 * each of its parts was still verified against `partHash` on the raw wire.
 */
export function generationHashIsVerifiable(
  rows: readonly StagedInvocationRow[]
): boolean {
  return rows.every(
    (row) =>
      !(
        hasProjectedIndexKeyShape(row.externalInvocationId) ||
        hasProjectedIndexKeyShape(row.componentKey) ||
        (row.branchName !== null && hasProjectedIndexKeyShape(row.branchName))
      )
  );
}

/**
 * Every key a staged row could hold for a wire `externalInvocationId`: its
 * projection, plus the raw form a row written before ISS-8736 stored verbatim
 * when it was long enough to project yet short enough for the index to hold.
 */
export function storedExternalInvocationIds(
  externalInvocationId: string
): string[] {
  return indexKeyCandidates(externalInvocationId);
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
    ...invocationDurationFields(row.durationMs),
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
            Number(row.estimatedCost)
          ),
        }),
    ...persistedTokenCount("footprintTokens", row.footprintTokens),
    ...persistedUsageMeasurement(row.usageMeasurement),
    ...persistedInvocationLines(row),
    ...persistedSucceeded(row.succeeded),
    ...persistedFindingsDisposition(row),
    ...persistedAttributionSource(row.attributionSource),
  };
}

/**
 * ISS-10730: the persisted line attribution, re-emitted as an OMITTED key when
 * absent so a round trip through the cloud is byte-identical to what the
 * Desktop sent and the generation hash still reconciles.
 *
 * All-or-nothing: a row holding one half — only reachable if something wrote
 * outside this ingest boundary — emits neither, because half a delta is not a
 * smaller measurement.
 */
function persistedInvocationLines(row: {
  linesAdded: number | null;
  linesRemoved: number | null;
}): Partial<AgentComponentInvocationSyncItem> {
  if (row.linesAdded === null || row.linesRemoved === null) {
    return {};
  }
  return { linesAdded: row.linesAdded, linesRemoved: row.linesRemoved };
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

/**
 * ISS-10718: NULL is "not a fact this kind records", so it reads back as an
 * omitted key — never as `false`, which would be a verdict nobody reached.
 */
function persistedSucceeded(
  value: boolean | null
): Partial<AgentComponentInvocationSyncItem> {
  return value === null ? {} : { succeeded: value };
}

/**
 * ISS-11325: the stored funnel together with the statement about it.
 *
 * The keep/drop call is {@link storedAgentComponentFindingsWireProjection}'s and
 * NOT this module's. Ingest rebuilds a generation id from persisted rows through
 * this projection and reconciles it against the hash the Desktop sent, so the
 * two producers disagreeing by one dropped field is a permanent
 * `generation_conflict` for the whole generation — the same reason
 * {@link storedAgentComponentFindingsFunnel} was already shared.
 */
function persistedFindingsDisposition(row: {
  findingsEmitted: bigint | null;
  findingsInvalidated: bigint | null;
  findingsDisposition: string | null;
}): Partial<AgentComponentInvocationSyncItem> {
  return storedAgentComponentFindingsWireProjection(
    row.findingsEmitted,
    row.findingsInvalidated,
    row.findingsDisposition
  );
}

/**
 * ISS-10720: the stored attribution source, or an OMITTED key for NULL.
 *
 * NULL is "the transcript attributed it" — every row written before the column
 * existed and every row the OTel join did not reach — and the omitted key is
 * the shape that fact has always had on the wire. Narrowing, like its
 * `usageMeasurement` sibling, so a value this build cannot read fails loudly at
 * ingest-reconstruction rather than re-serializing into a generation hash as
 * something the producer never sent.
 */
function persistedAttributionSource(
  value: string | null
): Partial<AgentComponentInvocationSyncItem> {
  return value === null
    ? {}
    : { attributionSource: toAttributionSource(value) };
}

function persistedUsageMeasurement(
  value: string | null
): Partial<AgentComponentInvocationSyncItem> {
  return value === null ? {} : { usageMeasurement: toUsageMeasurement(value) };
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

function projectInvocationIndexKeys(item: AgentComponentInvocationSyncItem) {
  const externalInvocationId = projectIndexKey(item.externalInvocationId);
  const componentKey = projectIndexKey(item.componentKey);
  const branchName = projectNullableIndexKey(item.branchName);
  return {
    externalInvocationId: externalInvocationId.value,
    componentKey: componentKey.value,
    branchName: branchName.value,
    projectedCount: countProjected(
      externalInvocationId,
      componentKey,
      branchName
    ),
  };
}

function buildInvocationColumns(
  item: AgentComponentInvocationSyncItem,
  keys: ReturnType<typeof projectInvocationIndexKeys>
) {
  // ISS-4965: a Desktop build older than the producer-side redaction still
  // sends definition text raw, so no secret reaches this row either way.
  const definition = redactInvocationDefinitionContent(item);
  return {
    externalInvocationId: keys.externalInvocationId,
    sourceSessionId: item.sourceSessionId,
    childSessionId: item.childSessionId ?? null,
    parentExternalInvocationId: item.parentExternalInvocationId ?? null,
    externalAgentId: item.externalAgentId ?? null,
    componentKind: item.kind,
    componentKey: keys.componentKey,
    rawName: item.rawName ?? null,
    normalizedName: item.normalizedName ?? null,
    relationship: item.relationship,
    invokedAt: item.invokedAt === null ? null : new Date(item.invokedAt),
    sequence: item.sequence,
    anchor: JSON.parse(JSON.stringify(item.anchor)),
    providerInvocationId: item.providerInvocationId ?? null,
    attributionStatus: item.status,
    evidenceClass: item.evidenceClass,
    definitionHash: definition.definitionHash ?? null,
    normalizerContractVersion: definition.normalizerContractVersion ?? null,
    definitionContent: definition.definitionContent ?? null,
    definitionFormat: item.definitionFormat ?? null,
    sourcePath: item.sourcePath ?? null,
    sourceModifiedAt: optionalDate(item.sourceModifiedAt),
    capturedAt: optionalDate(item.capturedAt),
    repositoryFullName: item.repositoryFullName ?? null,
    repositoryCommit: item.repositoryCommit ?? null,
    packId: item.packId ?? null,
    branchName: keys.branchName,
    ...invocationMeasurementColumns(item),
  };
}

/**
 * The measurement columns of one persisted invocation row.
 *
 * Extracted from {@link buildInvocationColumns} so that builder stays under the
 * cognitive-complexity ceiling: ISS-10730's lines pair, ISS-10718's `succeeded`
 * and ISS-10725's findings pair all landed on it, and every one of them is
 * another `??` branch. Behaviour is unchanged — an absent optional persists as
 * NULL, which `toSyncItem` maps back to an OMITTED key rather than an explicit
 * null, so a version-skewed producer's row round-trips byte-identically.
 */
function invocationMeasurementColumns(item: AgentComponentInvocationSyncItem) {
  return {
    // FEA-3981 (ISS-4976) per-invocation telemetry. An absent optional wire
    // field persists as NULL ("not computed"), which `toSyncItem` maps back to
    // an omitted key rather than an explicit null.
    durationMs: item.durationMs === undefined ? null : BigInt(item.durationMs),
    model: item.model ?? null,
    inputTokens: optionalTokenCount(item.inputTokens),
    outputTokens: optionalTokenCount(item.outputTokens),
    cacheReadTokens: optionalTokenCount(item.cacheReadTokens),
    cacheWriteTokens: optionalTokenCount(item.cacheWriteTokens),
    estimatedCost: item.estimatedCost ?? null,
    footprintTokens: optionalTokenCount(item.footprintTokens),
    usageMeasurement: item.usageMeasurement ?? null,
    // ISS-10730: an absent optional persists as NULL ("not computed"), which
    // `toSyncItem` maps back to an omitted key rather than an explicit null.
    linesAdded: item.linesAdded ?? null,
    linesRemoved: item.linesRemoved ?? null,
    succeeded: item.succeeded ?? null,
    // ISS-10725: an absent pair persists as NULL ("not measured"), which
    // `toSyncItem` maps back to two omitted keys rather than explicit nulls. The
    // `.strict()` boundary has already refused a half-set or inverted pair, so
    // nothing partially-valid reaches these columns.
    findingsEmitted: optionalTokenCount(item.findingsEmitted),
    findingsInvalidated: optionalTokenCount(item.findingsInvalidated),
    // ISS-10720: an absent optional wire field persists as NULL ("the
    // transcript attributed it"), which `toSyncItem` maps back to an omitted
    // key rather than an explicit null.
    attributionSource: item.attributionSource ?? null,
    // ISS-11325: an absent optional wire field persists as NULL ("no disposition
    // recorded"), which `toSyncItem` maps back to an omitted key rather than an
    // explicit null. An older Desktop sends none and its rows stay NULL.
    findingsDisposition: item.findingsDisposition ?? null,
  };
}

/** What re-deriving a complete generation's id from its staged rows found. */
export const GenerationHashVerdict = {
  Verified: "verified",
  Conflict: "conflict",
  Unverifiable: "unverifiable",
} as const;
export type GenerationHashVerdict =
  (typeof GenerationHashVerdict)[keyof typeof GenerationHashVerdict];

/**
 * Re-derive a complete generation's id and compare it to the one the producer
 * sent. Storage is tried first whenever no key was projected (ISS-8736): a
 * current Desktop redacts definition text itself, so its rows round-trip
 * exactly even when they carry a redaction marker. Only a mismatch on rows that
 * DO carry a marker is explained by this file's own write redacting an older
 * Desktop's raw text (ISS-4965); that case, like a projected key, falls back to
 * the raw wire part of a one-part generation and is otherwise unverifiable.
 */
export function generationHashVerdict(input: {
  externalSessionId: string;
  externalGenerationId: string;
  expectedPartCount: number;
  wireItems: AgentComponentInvocationSyncItem[];
  rows: readonly StagedInvocationRow[];
}): GenerationHashVerdict {
  const matches = (items: AgentComponentInvocationSyncItem[]): boolean =>
    sha256Hex(
      agentComponentInvocationGenerationHashPreimage({
        externalSessionId: input.externalSessionId,
        items,
      })
    ) === input.externalGenerationId;
  if (generationHashIsVerifiable(input.rows)) {
    if (matches(input.rows.map(toSyncItem))) {
      return GenerationHashVerdict.Verified;
    }
    if (!input.rows.some(carriesRedactedDefinition)) {
      return GenerationHashVerdict.Conflict;
    }
  }
  if (input.expectedPartCount === 1) {
    return matches(input.wireItems)
      ? GenerationHashVerdict.Verified
      : GenerationHashVerdict.Conflict;
  }
  return GenerationHashVerdict.Unverifiable;
}

function carriesRedactedDefinition(row: StagedInvocationRow): boolean {
  return (
    row.definitionContent !== null &&
    carriesRedactionMarker(row.definitionContent)
  );
}
