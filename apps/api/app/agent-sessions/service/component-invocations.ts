import { computeDefinitionHash } from "@repo/api/src/definition-fingerprint";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_MAX_GENERATION_ITEMS,
  AGENT_COMPONENT_INVOCATION_SYNC_MAX_INFLIGHT_GENERATIONS,
  AGENT_COMPONENT_INVOCATION_SYNC_MAX_STAGED_BYTES,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationSyncAckState,
  type AgentComponentInvocationSyncPart,
  AgentComponentInvocationSyncRejectReason,
  type AgentComponentInvocationSyncAckState as SyncAckState,
  type AgentComponentInvocationSyncRejectReason as SyncRejectReason,
} from "@repo/api/src/types/agent-component-invocation";
import { Result } from "@repo/api/src/types/result";
import { Prisma, type TransactionClient, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import {
  ensureDefinitionVersion,
  recordDefinitionSourceOccurrence,
} from "@/app/definition-registry/service";
import {
  hasProjectedIndexKeyShape,
  projectedIndexKeyHead,
  projectIndexKey,
} from "@/lib/index-key-projection";
import {
  type RecordWriteInTransaction,
  writeInShape,
} from "@/lib/record-write-in-transaction";
import {
  type ActivationDelta,
  activateGeneration,
  persistedInvocation,
  reportGenerationActivation,
} from "./component-invocation-activation";
import {
  ackStateForGeneration,
  buildResolutionUpdate,
  type ComponentResolution,
  compareFreshness,
  comparePartFreshness,
  componentLookupKey,
  type DefinitionResolution,
  type DefinitionResolutionResult,
  deleteCompletedInactiveGenerations,
  deleteStaleIncompleteGenerations,
  deleteSupersededIncompleteGeneration,
  GENERATION_SELECT,
  type GenerationRecord,
  generationMatchesPart,
  genuineSourceOccurrence,
  hasEveryPart,
  hasUniqueInvocationIds,
  hasValidPartHash,
  INVOCATION_INGEST_TX_OPTIONS,
  isNonVersionable,
  latestDefinitionObservedAtByHash,
  latestOccurrenceObservedAtByKey,
  loadActiveGeneration,
  PART_LEDGER_SELECT,
  partLedgerMatches,
  preferredObservedAt,
  type ResolutionInput,
  type ResolutionResult,
  type ResolutionUpdate,
  type ResolveInvocationInput,
  type ResolveInvocationResult,
  resolveComponent,
  resolvedAttributionStatus,
  type StagedInvocationRow,
  serializedBytes,
  sourceOccurrenceCacheKey,
  toAttributionStatus,
  toDefinitionComponentKind,
} from "./component-invocation-helpers";
import { resolveInvocationSession } from "./component-invocation-session-resolution";
import {
  hasLegacyStagedPart,
  hasStagedInvocationIdConflict,
  loadStagedGenerationRows,
  STAGED_PART_SELECT,
  stagedInvocationIds,
  stagedItemsValue,
} from "./component-invocation-staging";
import {
  countProjectedIndexKeys,
  GenerationHashVerdict,
  generationHashVerdict,
} from "./component-invocation-wire-row";
import { reportInvocationIndexKeyProjections } from "./invocation-index-key-telemetry";
import { SessionSyncMetric } from "./session-sync-metrics";
import { normalizeSkillShadowedInvocations } from "./skill-shadow-normalization";

export type IngestAgentComponentInvocationPartInput = {
  organizationId: string;
  computeTargetId: string;
  part: AgentComponentInvocationSyncPart;
};

export type IngestAgentComponentInvocationPartOutcome = {
  state: SyncAckState;
};

/** What one committed ingest transaction answered, accepted or refused. */
export type IngestAgentComponentInvocationPartResult = Result<
  IngestAgentComponentInvocationPartOutcome,
  SyncRejectReason
>;

/** What one ingest reports once its transaction commits. */
type IngestTelemetry = {
  projectedIndexKeys: number;
  activation: ActivationDelta | null;
};

export const agentComponentInvocationsService = {
  async ingestPart(
    input: IngestAgentComponentInvocationPartInput,
    recordWrite?: RecordWriteInTransaction<IngestAgentComponentInvocationPartResult>
  ): Promise<IngestAgentComponentInvocationPartResult> {
    if (!(hasValidPartHash(input.part) && hasUniqueInvocationIds(input.part))) {
      return Result.err(
        AgentComponentInvocationSyncRejectReason.ValidationFailed
      );
    }

    const staged: IngestTelemetry = { projectedIndexKeys: 0, activation: null };
    try {
      const result = await writeInShape(recordWrite, {
        unrecorded: () =>
          withDb.tx(
            (tx) => ingestPartInTx(tx, input, staged),
            INVOCATION_INGEST_TX_OPTIONS
          ),
        recorded: (record) =>
          withDb.tx(async (tx) => {
            const ingested = await ingestPartInTx(tx, input, staged);
            await record(tx, ingested);
            return ingested;
          }, INVOCATION_INGEST_TX_OPTIONS),
      });
      const context = {
        organizationId: input.organizationId,
        computeTargetId: input.computeTargetId,
        externalSessionId: input.part.externalSessionId,
        externalGenerationId: input.part.externalGenerationId,
      };
      reportInvocationIndexKeyProjections(
        { ...context, partIndex: input.part.partIndex },
        staged.projectedIndexKeys
      );
      if (staged.activation) {
        reportGenerationActivation(context, staged.activation);
      }
      return result;
    } catch (error) {
      log.error("Agent component invocation ingest failed", {
        organizationId: input.organizationId,
        computeTargetId: input.computeTargetId,
        externalSessionId: input.part.externalSessionId,
        externalGenerationId: input.part.externalGenerationId,
        partIndex: input.part.partIndex,
        error,
      });
      return Result.err(
        AgentComponentInvocationSyncRejectReason.IngestionFailed
      );
    }
  },

  /**
   * Repair active invocation rows after component inventory arrives later.
   * The SQL links only a unique exact `(kind, componentKey)` match inside the
   * authenticated org + compute target; ambiguous inventory is never guessed.
   *
   * ISS-12872: the `component_key_normalized` predicate never changes which
   * rows match. The fold trigger (migration 20260820140000) keeps that column
   * equal to `lower(component_key)`, so the exact key equality already implies
   * it. It is there so each inventory row's probe seeks
   * `idx_aci_kind_key_normalized_unattributed` on kind AND key. On kind alone
   * the probe read every unattributed row of that kind, once per component.
   */
  relinkActiveForComputeTarget(input: {
    organizationId: string;
    computeTargetId: string;
  }): Promise<number> {
    return withDb.tx(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
        WITH exact_components AS (
          SELECT
            component_kind,
            component_key,
            MIN(id::text)::uuid AS agent_component_id
          FROM agent_components
          WHERE organization_id = ${input.organizationId}::uuid
            AND compute_target_id = ${input.computeTargetId}::uuid
            AND component_key IS NOT NULL
          GROUP BY component_kind, component_key
          HAVING COUNT(*) = 1
        ), relinked AS (
          UPDATE agent_component_invocations AS invocation
          SET
            agent_component_id = component.agent_component_id,
            attribution_status = CASE
              WHEN invocation.attribution_status = ${AgentComponentInvocationAttributionStatus.Unmatched}
                AND invocation.definition_version_id IS NOT NULL
                THEN ${AgentComponentInvocationAttributionStatus.Matched}
              ELSE invocation.attribution_status
            END,
            updated_at = CURRENT_TIMESTAMP
          FROM exact_components AS component,
            agent_component_invocation_generations AS generation,
            session_detail AS session,
            artifacts AS artifact
          WHERE invocation.agent_component_id IS NULL
            AND invocation.attribution_status <> ${AgentComponentInvocationAttributionStatus.Ambiguous}
            AND invocation.component_kind = component.component_kind
            AND invocation.component_key = component.component_key
            AND invocation.component_key_normalized = lower(component.component_key)
            AND generation.id = invocation.generation_id
            AND generation.active_at IS NOT NULL
            AND generation.completed_at IS NOT NULL
            AND session.artifact_id = generation.agent_session_id
            AND session.compute_target_id = ${input.computeTargetId}::uuid
            AND artifact.id = session.artifact_id
            AND artifact.organization_id = ${input.organizationId}::uuid
          RETURNING invocation.id
        )
        SELECT COUNT(*)::bigint AS count FROM relinked
      `);
      return Number(rows[0]?.count ?? 0n);
    });
  },
};

async function ingestPartInTx(
  tx: TransactionClient,
  input: IngestAgentComponentInvocationPartInput,
  staged: IngestTelemetry
): Promise<
  Result<IngestAgentComponentInvocationPartOutcome, SyncRejectReason>
> {
  const { part } = input;
  const session = await resolveInvocationSession(tx, input);
  if (!session) {
    return Result.err(AgentComponentInvocationSyncRejectReason.SessionMissing);
  }
  // Replay from a migrated machine belongs to the original session's inventory
  // and source locations, not the sending machine's component catalog.
  const sessionInput = { ...input, computeTargetId: session.computeTargetId };

  await lockSessionDetail(tx, session.artifactId);
  const activeGeneration = await loadActiveGeneration(tx, session.artifactId);
  const activeFreshnessComparison = activeGeneration
    ? comparePartFreshness(part, activeGeneration)
    : null;
  if (
    activeGeneration &&
    activeFreshnessComparison !== null &&
    (activeFreshnessComparison < 0 ||
      (activeFreshnessComparison === 0 &&
        activeGeneration.externalGenerationId !== part.externalGenerationId))
  ) {
    await tx.agentComponentInvocationGeneration.deleteMany({
      where: {
        agentSessionId: session.artifactId,
        externalGenerationId: part.externalGenerationId,
        sourceUpdatedAt: new Date(part.sourceUpdatedAt),
        dataRevision: part.dataRevision,
        sourceSequence: part.sourceSequence,
        expectedPartCount: part.partCount,
        activeAt: null,
      },
    });
    return Result.ok({ state: AgentComponentInvocationSyncAckState.Stale });
  }
  await deleteSupersededIncompleteGeneration(tx, session.artifactId, part);
  await deleteStaleIncompleteGenerations(
    tx,
    session.artifactId,
    part.externalGenerationId
  );
  if (await shouldDeferNewGeneration(tx, session.artifactId, part)) {
    return Result.err(AgentComponentInvocationSyncRejectReason.RateLimited);
  }
  const generation = await upsertGeneration(tx, session.artifactId, part);
  if (!generationMatchesPart(generation, part)) {
    return Result.err(
      AgentComponentInvocationSyncRejectReason.GenerationConflict
    );
  }

  const existingPart = await tx.agentComponentInvocationPart.findUnique({
    where: {
      generationId_partIndex: {
        generationId: generation.id,
        partIndex: part.partIndex,
      },
    },
    select: PART_LEDGER_SELECT,
  });
  const payloadBytes = serializedBytes(part);
  if (existingPart) {
    if (!partLedgerMatches(existingPart, part, payloadBytes)) {
      return Result.err(AgentComponentInvocationSyncRejectReason.PartConflict);
    }
    if (generation.activeAt !== null || generation.completedAt !== null) {
      return Result.ok({ state: ackStateForGeneration(generation) });
    }
    return completeGenerationIfReady(tx, sessionInput, generation, staged);
  }

  if (await hasStagedInvocationIdConflict(tx, generation.id, part.items)) {
    return Result.err(
      AgentComponentInvocationSyncRejectReason.GenerationConflict
    );
  }
  // Every part, whether its items wait on the ledger row or (staged by an
  // older build) as invocation rows, records its item count here.
  const stagedTotals = await tx.agentComponentInvocationPart.aggregate({
    where: { generationId: generation.id },
    _sum: { payloadBytes: true, itemCount: true },
  });
  if (
    (stagedTotals._sum.itemCount ?? 0) + part.items.length >
    AGENT_COMPONENT_INVOCATION_SYNC_MAX_GENERATION_ITEMS
  ) {
    return Result.err(
      AgentComponentInvocationSyncRejectReason.ValidationFailed
    );
  }
  if (
    (stagedTotals._sum.payloadBytes ?? 0) + payloadBytes >
    AGENT_COMPONENT_INVOCATION_SYNC_MAX_STAGED_BYTES
  ) {
    return Result.err(
      AgentComponentInvocationSyncRejectReason.ValidationFailed
    );
  }

  await tx.agentComponentInvocationPart.create({
    data: {
      generationId: generation.id,
      partIndex: part.partIndex,
      partHash: part.partHash,
      itemCount: part.items.length,
      payloadBytes,
      stagedItems: stagedItemsValue(part.items),
      stagedInvocationIds: stagedInvocationIds(part.items),
    },
    select: { id: true },
  });
  staged.projectedIndexKeys = countProjectedIndexKeys(part.items);

  return completeGenerationIfReady(tx, sessionInput, generation, staged);
}

async function completeGenerationIfReady(
  tx: TransactionClient,
  input: IngestAgentComponentInvocationPartInput,
  generation: GenerationRecord,
  staged: IngestTelemetry
): Promise<
  Result<IngestAgentComponentInvocationPartOutcome, SyncRejectReason>
> {
  const ledger = await tx.agentComponentInvocationPart.findMany({
    where: { generationId: generation.id },
    orderBy: { partIndex: "asc" },
    select: { partIndex: true, itemCount: true },
  });
  if (!hasEveryPart(ledger, generation.expectedPartCount)) {
    return Result.ok({ state: AgentComponentInvocationSyncAckState.Staged });
  }
  // Staged items are the payload, so they are read once, when every part is in.
  const parts = await tx.agentComponentInvocationPart.findMany({
    where: { generationId: generation.id },
    orderBy: { partIndex: "asc" },
    select: STAGED_PART_SELECT,
  });

  const stagedRows = await loadStagedGenerationRows(tx, generation.id, parts);
  const invocationRows = stagedRows.map(({ row }) => row);
  const expectedItemCount = parts.reduce(
    (total, row) => total + row.itemCount,
    0
  );
  if (invocationRows.length !== expectedItemCount) {
    return Result.err(
      AgentComponentInvocationSyncRejectReason.GenerationConflict
    );
  }

  const hashVerdict = generationHashVerdict({
    externalSessionId: input.part.externalSessionId,
    externalGenerationId: generation.externalGenerationId,
    expectedPartCount: generation.expectedPartCount,
    wireItems: input.part.items,
    rows: invocationRows,
  });
  if (hashVerdict === GenerationHashVerdict.Conflict) {
    return Result.err(
      AgentComponentInvocationSyncRejectReason.GenerationConflict
    );
  }
  if (hashVerdict === GenerationHashVerdict.Unverifiable) {
    log.warn("Skipped generation hash check for rewritten invocation rows", {
      metric: SessionSyncMetric.InvocationGenerationHashUnverified,
      organizationId: input.organizationId,
      computeTargetId: input.computeTargetId,
      externalSessionId: input.part.externalSessionId,
      externalGenerationId: generation.externalGenerationId,
    });
  }

  const activeGeneration = await loadActiveGeneration(
    tx,
    generation.agentSessionId
  );
  const now = new Date();
  if (activeGeneration && compareFreshness(generation, activeGeneration) <= 0) {
    await tx.agentComponentInvocationGeneration.update({
      where: { id: generation.id },
      data: { completedAt: now },
      select: { id: true },
    });
    await deleteCompletedInactiveGenerations(
      tx,
      generation.agentSessionId,
      null
    );
    return Result.ok({ state: AgentComponentInvocationSyncAckState.Stale });
  }

  const resolution = await resolveGenerationInvocations(tx, {
    organizationId: input.organizationId,
    computeTargetId: input.computeTargetId,
    rows: invocationRows,
  });
  if (!resolution.ok) {
    return Result.err(resolution.error);
  }
  const updateById = new Map(
    resolution.updates.map((update) => [update.id, update])
  );
  staged.activation = await activateGeneration(tx, {
    generation,
    activeGeneration,
    parts,
    rows: stagedRows.map(({ partIndex, row }) => ({
      partIndex,
      columns: persistedInvocation(row, resolvedUpdate(updateById, row.id)),
    })),
    hasLegacyRows: hasLegacyStagedPart(parts),
    now,
  });
  return Result.ok({ state: AgentComponentInvocationSyncAckState.Activated });
}

async function resolveGenerationInvocations(
  tx: TransactionClient,
  input: ResolutionInput
): Promise<ResolutionResult> {
  // ISS-4923: re-point skill-shadowed phantom `command` rows at the skill they
  // shadowed BEFORE resolution (so component lookup lands on the skill inventory
  // row) but AFTER the caller's generation-hash check — this function only ever
  // runs from `completeGenerationIfReady`, past that check. See the module
  // header for why the drop-at-ingest shape the other two lanes use is unsafe
  // here.
  const normalization = await normalizeSkillShadowedInvocations(
    tx,
    input.computeTargetId,
    input.rows
  );
  const rows = normalization.rows;
  const componentMap = await loadComponentMap(
    tx,
    input.organizationId,
    input.computeTargetId,
    rows
  );
  const definitionMap = await loadDefinitionMap(tx, input.organizationId, rows);
  const ensuredDefinitionMap = new Map<string, DefinitionResolution>();
  const definitionObservedAtByHash = latestDefinitionObservedAtByHash(rows);
  const occurrenceObservedAtByKey = latestOccurrenceObservedAtByKey(
    rows,
    input.computeTargetId
  );
  const occurrenceIdCache = new Map<string, string>();
  const updates: ResolutionUpdate[] = [];
  for (const row of rows) {
    const resolved = await resolveInvocation(tx, {
      organizationId: input.organizationId,
      computeTargetId: input.computeTargetId,
      row,
      componentMap,
      definitionMap,
      ensuredDefinitionMap,
      definitionObservedAtByHash,
      occurrenceObservedAtByKey,
      occurrenceIdCache,
    });
    if (!resolved.ok) {
      return resolved;
    }
    const rewrite = normalization.rewritesByInvocationId.get(row.id);
    updates.push(
      rewrite ? { ...resolved.update, ...rewrite } : resolved.update
    );
  }
  return { ok: true, updates };
}

async function resolveInvocation(
  tx: TransactionClient,
  input: ResolveInvocationInput
): Promise<ResolveInvocationResult> {
  const row = input.row;
  const component = resolveComponent(input.componentMap, row);
  if (isNonVersionable(row.componentKind)) {
    return {
      ok: true,
      update: buildResolutionUpdate(row, {
        agentComponentId: component.kind === "single" ? component.id : null,
        attributionStatus: AgentComponentInvocationAttributionStatus.Unresolved,
        definitionHash: null,
        normalizerContractVersion: null,
        definitionVersionId: null,
        sourceOccurrenceId: null,
      }),
    };
  }
  if (
    row.attributionStatus ===
    AgentComponentInvocationAttributionStatus.Ambiguous
  ) {
    return {
      ok: true,
      update: buildResolutionUpdate(row, {
        agentComponentId: null,
        attributionStatus: AgentComponentInvocationAttributionStatus.Ambiguous,
        definitionHash: row.definitionHash,
        normalizerContractVersion: row.normalizerContractVersion,
        definitionVersionId: null,
        sourceOccurrenceId: null,
      }),
    };
  }

  const version = await resolveDefinitionVersion(tx, input);
  if (!version.ok) {
    return version;
  }
  const sourceOccurrenceId = version.value
    ? await resolveSourceOccurrence(tx, input, version.value)
    : null;
  return {
    ok: true,
    update: buildResolutionUpdate(row, {
      agentComponentId: component.kind === "single" ? component.id : null,
      attributionStatus: resolvedAttributionStatus(
        toAttributionStatus(row.attributionStatus),
        component,
        version.value !== null
      ),
      definitionHash: version.value?.definitionHash ?? row.definitionHash,
      normalizerContractVersion:
        version.value?.normalizerContractVersion ??
        row.normalizerContractVersion,
      definitionVersionId: version.value?.id ?? null,
      sourceOccurrenceId,
    }),
  };
}

async function resolveDefinitionVersion(
  tx: TransactionClient,
  input: ResolveInvocationInput
): Promise<DefinitionResolutionResult> {
  const row = input.row;
  if (row.definitionContent === null) {
    if (row.definitionHash === null) {
      return { ok: true, value: null };
    }
    const existing = input.definitionMap.get(row.definitionHash);
    if (
      !existing ||
      existing.componentKind !== row.componentKind ||
      existing.normalizerContractVersion !== row.normalizerContractVersion
    ) {
      return { ok: true, value: null };
    }
    return { ok: true, value: existing };
  }

  const definitionKind = toDefinitionComponentKind(row.componentKind);
  const fingerprint = computeDefinitionHash({
    frontmatter: "",
    body: row.definitionContent,
    kind: definitionKind,
  });
  if (
    (row.definitionHash !== null &&
      row.definitionHash !== fingerprint.definitionHash) ||
    (row.normalizerContractVersion !== null &&
      row.normalizerContractVersion !== fingerprint.normalizerContractVersion)
  ) {
    return {
      ok: false,
      error: AgentComponentInvocationSyncRejectReason.GenerationConflict,
    };
  }

  const ensured = input.ensuredDefinitionMap.get(fingerprint.definitionHash);
  if (ensured) {
    return { ok: true, value: ensured };
  }

  const id = await ensureDefinitionVersion(tx, {
    organizationId: input.organizationId,
    componentKind: definitionKind,
    content: row.definitionContent,
    format: row.definitionFormat,
    observedAt:
      input.definitionObservedAtByHash.get(fingerprint.definitionHash) ??
      preferredObservedAt(row),
  });
  const value: DefinitionResolution = {
    id,
    componentKind: row.componentKind,
    ...fingerprint,
  };
  input.definitionMap.set(fingerprint.definitionHash, value);
  input.ensuredDefinitionMap.set(fingerprint.definitionHash, value);
  return { ok: true, value };
}

async function resolveSourceOccurrence(
  tx: TransactionClient,
  input: ResolveInvocationInput,
  definition: DefinitionResolution
): Promise<string | null> {
  const occurrence = genuineSourceOccurrence(input.row, input.computeTargetId);
  if (!occurrence) {
    return null;
  }
  const { observedAt: _observedAt, ...occurrenceIdentity } = occurrence;
  const cacheKey = sourceOccurrenceCacheKey(definition.id, occurrenceIdentity);
  const cached = input.occurrenceIdCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const observedAt =
    input.occurrenceObservedAtByKey.get(
      sourceOccurrenceCacheKey(definition.definitionHash, occurrenceIdentity)
    ) ?? occurrence.observedAt;
  const id = await recordDefinitionSourceOccurrence(tx, {
    organizationId: input.organizationId,
    definitionVersionId: definition.id,
    ...occurrenceIdentity,
    observedAt,
  });
  input.occurrenceIdCache.set(cacheKey, id);
  return id;
}

async function loadComponentMap(
  tx: TransactionClient,
  organizationId: string,
  computeTargetId: string,
  rows: readonly StagedInvocationRow[]
): Promise<Map<string, ComponentResolution>> {
  const componentKeys = Array.from(
    new Set(rows.map((row) => row.componentKey))
  );
  const componentKinds = Array.from(
    new Set(rows.map((row) => row.componentKind))
  );
  if (componentKeys.length === 0) {
    return new Map();
  }
  const components = await tx.agentComponent.findMany({
    where: {
      organizationId,
      computeTargetId,
      componentKey: { in: componentKeys },
      componentKind: { in: componentKinds },
    },
    select: { id: true, componentKind: true, componentKey: true },
  });
  const idsByKey = new Map<string, string[]>();
  const addComponent = (
    componentKind: string,
    lookupValue: string,
    id: string
  ): void => {
    const key = componentLookupKey(componentKind, lookupValue);
    const ids = idsByKey.get(key);
    if (!ids) {
      idsByKey.set(key, [id]);
      return;
    }
    if (!ids.includes(id)) {
      ids.push(id);
    }
  };
  for (const component of components) {
    if (component.componentKey === null) {
      continue;
    }
    addComponent(component.componentKind, component.componentKey, component.id);
  }
  await attachLegacyRawComponents(tx, {
    organizationId,
    computeTargetId,
    componentKinds,
    rows,
    idsByKey,
    addComponent,
  });
  const result = new Map<string, ComponentResolution>();
  for (const [key, ids] of idsByKey) {
    result.set(
      key,
      ids.length === 1 ? { kind: "single", id: ids[0] } : { kind: "ambiguous" }
    );
  }
  return result;
}

/**
 * ISS-8736 (review: whitlockk): recover the components a projected key can no longer
 * match by equality.
 *
 * `componentKey` on a staged row is now PROJECTED, but an `agent_components` row
 * written before ISS-8069 bounded that column can still hold the RAW
 * 513–2704-byte value — long enough to project, short enough for the btree to
 * have accepted it. The `IN` list above is built from projected keys, so it
 * misses that row and the invocation resolves to `none` FOREVER: nothing
 * re-derives it, and the desktop has no signal that attribution silently stopped.
 *
 * A projection cannot be inverted, so the probe is by retained HEAD — which the
 * raw value shares byte-for-byte — and every candidate is then re-projected and
 * compared IN FULL. The head alone is not a match: it is a prefix two distinct
 * keys can share, which is the whole reason the digest tail exists.
 *
 * Runs only for projected keys the exact lookup already failed to resolve, so a
 * fleet that has never seen an over-budget key never issues this query.
 */
async function attachLegacyRawComponents(
  tx: TransactionClient,
  args: {
    organizationId: string;
    computeTargetId: string;
    componentKinds: readonly string[];
    rows: readonly StagedInvocationRow[];
    idsByKey: ReadonlyMap<string, string[]>;
    addComponent: (
      componentKind: string,
      lookupValue: string,
      id: string
    ) => void;
  }
): Promise<void> {
  const unresolvedHeads = new Set<string>();
  for (const row of args.rows) {
    if (!hasProjectedIndexKeyShape(row.componentKey)) {
      continue;
    }
    if (
      args.idsByKey.has(componentLookupKey(row.componentKind, row.componentKey))
    ) {
      continue;
    }
    unresolvedHeads.add(projectedIndexKeyHead(row.componentKey));
  }
  if (unresolvedHeads.size === 0) {
    return;
  }
  const legacy = await tx.agentComponent.findMany({
    where: {
      organizationId: args.organizationId,
      computeTargetId: args.computeTargetId,
      componentKind: { in: [...args.componentKinds] },
      OR: [...unresolvedHeads].map((head) => ({
        componentKey: { startsWith: head },
      })),
    },
    select: { id: true, componentKind: true, componentKey: true },
  });
  for (const component of legacy) {
    if (component.componentKey === null) {
      continue;
    }
    // Re-project and compare in full: the head is a prefix, never an identity.
    const projection = projectIndexKey(component.componentKey);
    if (!projection.projected) {
      continue;
    }
    args.addComponent(component.componentKind, projection.value, component.id);
  }
}

async function loadDefinitionMap(
  tx: TransactionClient,
  organizationId: string,
  rows: readonly StagedInvocationRow[]
): Promise<Map<string, DefinitionResolution>> {
  const hashes = Array.from(
    new Set(
      rows.flatMap((row) =>
        row.definitionHash === null ? [] : [row.definitionHash]
      )
    )
  );
  if (hashes.length === 0) {
    return new Map();
  }
  const versions = await tx.definitionVersion.findMany({
    where: { organizationId, definitionHash: { in: hashes } },
    select: {
      id: true,
      componentKind: true,
      definitionHash: true,
      normalizerContractVersion: true,
    },
  });
  return new Map(versions.map((version) => [version.definitionHash, version]));
}

/**
 * ISS-8267: deliberately NOT a Prisma `upsert`. With the partial unique
 * `idx_acig_one_active_per_session` declared in schema.prisma, Prisma 7.8's
 * native upsert arbitrates `ON CONFLICT ("agent_session_id")` — the partial
 * index — instead of the five-column identity named in `where`, and Postgres
 * rejects that with 42P10 on every call. Read-then-write is race-free here:
 * `lockSessionDetail` holds the session row FOR UPDATE before any generation
 * write in this transaction, and the identity leads with `agentSessionId`, so
 * writers for other sessions cannot collide on it.
 */
async function upsertGeneration(
  tx: TransactionClient,
  agentSessionId: string,
  part: AgentComponentInvocationSyncPart
): Promise<GenerationRecord> {
  const existing = await tx.agentComponentInvocationGeneration.findUnique({
    where: generationIdentityWhere(agentSessionId, part),
    select: { id: true },
  });
  if (existing) {
    return await tx.agentComponentInvocationGeneration.update({
      where: { id: existing.id },
      data: { updatedAt: new Date() },
      select: GENERATION_SELECT,
    });
  }
  return await tx.agentComponentInvocationGeneration.create({
    data: {
      agentSessionId,
      externalGenerationId: part.externalGenerationId,
      sourceUpdatedAt: new Date(part.sourceUpdatedAt),
      dataRevision: part.dataRevision,
      sourceSequence: part.sourceSequence,
      expectedPartCount: part.partCount,
    },
    select: GENERATION_SELECT,
  });
}

async function lockSessionDetail(
  tx: TransactionClient,
  agentSessionId: string
): Promise<void> {
  await tx.$queryRaw(Prisma.sql`
    SELECT artifact_id
    FROM session_detail
    WHERE artifact_id = ${agentSessionId}::uuid
    FOR UPDATE
  `);
}

/** The generation a part belongs to, by its full wire identity. */
function generationIdentityWhere(
  agentSessionId: string,
  part: AgentComponentInvocationSyncPart
) {
  return {
    agentSessionId_externalGenerationId_sourceUpdatedAt_dataRevision_sourceSequence:
      {
        agentSessionId,
        externalGenerationId: part.externalGenerationId,
        sourceUpdatedAt: new Date(part.sourceUpdatedAt),
        dataRevision: part.dataRevision,
        sourceSequence: part.sourceSequence,
      },
  };
}

/**
 * ISS-6883. The in-flight cap bounds how many generations one session may have
 * OPEN at once, so it is charged when a generation is created and never when a
 * later part of an already-admitted one arrives. Charging it on every part made
 * the incoming generation count against itself: at the cap, part 0 was admitted
 * and part 1 of that same generation was then rejected, stranding a generation
 * that can never complete. Desktop treats `validation_failed` as a permanent
 * rejection, so that part dead-letters and its data never reaches the cloud.
 *
 * The load therefore has to precede the count: only an identity with no row yet
 * is a new generation.
 *
 * The caller answers a true cap with `rate_limited`, not `validation_failed`.
 * Which generations are open is a property of the SESSION, never of the part
 * being charged, so `main/sync/AGENTS.md` invariant 4 forbids spending that
 * row's permanent budget on it — and `validation_failed` is exactly that spend.
 * `rate_limited` is the lane-wide reason Desktop already classifies as
 * transient, so the part defers and retries until capacity frees instead of
 * dead-lettering into a lane that has no dead-letter recovery.
 */
async function shouldDeferNewGeneration(
  tx: TransactionClient,
  agentSessionId: string,
  part: AgentComponentInvocationSyncPart
): Promise<boolean> {
  const admitted = await tx.agentComponentInvocationGeneration.findUnique({
    where: generationIdentityWhere(agentSessionId, part),
    select: { id: true },
  });
  if (admitted) {
    return false;
  }
  const inflightCount = await tx.agentComponentInvocationGeneration.count({
    where: { agentSessionId, activeAt: null, completedAt: null },
  });
  return (
    inflightCount >= AGENT_COMPONENT_INVOCATION_SYNC_MAX_INFLIGHT_GENERATIONS
  );
}

/** The resolution `resolveGenerationInvocations` produced for one staged row. */
function resolvedUpdate(
  updateById: ReadonlyMap<string, ResolutionUpdate>,
  rowId: string
): ResolutionUpdate {
  const update = updateById.get(rowId);
  if (!update) {
    throw new Error("Staged invocation row has no resolution");
  }
  return update;
}
