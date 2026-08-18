import { computeDefinitionHash } from "@repo/api/src/definition-fingerprint";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_MAX_GENERATION_ITEMS,
  AGENT_COMPONENT_INVOCATION_SYNC_MAX_INFLIGHT_GENERATIONS,
  AGENT_COMPONENT_INVOCATION_SYNC_MAX_STAGED_BYTES,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationSyncAckState,
  type AgentComponentInvocationSyncItem,
  type AgentComponentInvocationSyncPart,
  AgentComponentInvocationSyncRejectReason,
  agentComponentInvocationGenerationHashPreimage,
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
  INVOCATION_HASH_SELECT,
  INVOCATION_INGEST_TX_OPTIONS,
  isNonVersionable,
  latestDefinitionObservedAtByHash,
  latestOccurrenceObservedAtByKey,
  loadActiveGeneration,
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
  sha256Hex,
  sourceOccurrenceCacheKey,
  toAttributionStatus,
  toDefinitionComponentKind,
} from "./component-invocation-helpers";
import {
  mapInvocationCreate,
  toSyncItem,
} from "./component-invocation-wire-row";
import { normalizeSkillShadowedInvocations } from "./skill-shadow-normalization";

export type IngestAgentComponentInvocationPartInput = {
  organizationId: string;
  computeTargetId: string;
  part: AgentComponentInvocationSyncPart;
};

export type IngestAgentComponentInvocationPartOutcome = {
  state: SyncAckState;
};

export const agentComponentInvocationsService = {
  async ingestPart(
    input: IngestAgentComponentInvocationPartInput
  ): Promise<
    Result<IngestAgentComponentInvocationPartOutcome, SyncRejectReason>
  > {
    if (!(hasValidPartHash(input.part) && hasUniqueInvocationIds(input.part))) {
      return Result.err(
        AgentComponentInvocationSyncRejectReason.ValidationFailed
      );
    }

    try {
      return await withDb.tx(
        (tx) => ingestPartInTx(tx, input),
        INVOCATION_INGEST_TX_OPTIONS
      );
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
  input: IngestAgentComponentInvocationPartInput
): Promise<
  Result<IngestAgentComponentInvocationPartOutcome, SyncRejectReason>
> {
  const { part } = input;
  const session = await tx.sessionDetail.findFirst({
    where: {
      computeTargetId: input.computeTargetId,
      externalSessionId: part.externalSessionId,
      artifact: { organizationId: input.organizationId },
    },
    select: { artifactId: true },
  });
  if (!session) {
    return Result.err(AgentComponentInvocationSyncRejectReason.SessionMissing);
  }

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
  const inflightCount = await tx.agentComponentInvocationGeneration.count({
    where: {
      agentSessionId: session.artifactId,
      activeAt: null,
      completedAt: null,
    },
  });
  if (
    inflightCount >= AGENT_COMPONENT_INVOCATION_SYNC_MAX_INFLIGHT_GENERATIONS
  ) {
    return Result.err(
      AgentComponentInvocationSyncRejectReason.ValidationFailed
    );
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
  });
  const payloadBytes = serializedBytes(part);
  if (existingPart) {
    if (!partLedgerMatches(existingPart, part, payloadBytes)) {
      return Result.err(AgentComponentInvocationSyncRejectReason.PartConflict);
    }
    if (generation.activeAt !== null || generation.completedAt !== null) {
      return Result.ok({ state: ackStateForGeneration(generation) });
    }
    return completeGenerationIfReady(tx, input, generation);
  }

  if (await hasInvocationIdConflict(tx, generation.id, part.items)) {
    return Result.err(
      AgentComponentInvocationSyncRejectReason.GenerationConflict
    );
  }
  const [stagedItemCount, stagedBytes] = await Promise.all([
    tx.agentComponentInvocation.count({
      where: { generationId: generation.id },
    }),
    tx.agentComponentInvocationPart.aggregate({
      where: { generationId: generation.id },
      _sum: { payloadBytes: true },
    }),
  ]);
  if (
    stagedItemCount + part.items.length >
    AGENT_COMPONENT_INVOCATION_SYNC_MAX_GENERATION_ITEMS
  ) {
    return Result.err(
      AgentComponentInvocationSyncRejectReason.ValidationFailed
    );
  }
  if (
    (stagedBytes._sum.payloadBytes ?? 0) + payloadBytes >
    AGENT_COMPONENT_INVOCATION_SYNC_MAX_STAGED_BYTES
  ) {
    return Result.err(
      AgentComponentInvocationSyncRejectReason.ValidationFailed
    );
  }

  const persistedPart = await tx.agentComponentInvocationPart.create({
    data: {
      generationId: generation.id,
      partIndex: part.partIndex,
      partHash: part.partHash,
      itemCount: part.items.length,
      payloadBytes,
    },
    select: { id: true },
  });
  if (part.items.length > 0) {
    await tx.agentComponentInvocation.createMany({
      data: part.items.map((item) =>
        mapInvocationCreate(generation.id, persistedPart.id, item)
      ),
    });
  }

  return completeGenerationIfReady(tx, input, generation);
}

async function completeGenerationIfReady(
  tx: TransactionClient,
  input: IngestAgentComponentInvocationPartInput,
  generation: GenerationRecord
): Promise<
  Result<IngestAgentComponentInvocationPartOutcome, SyncRejectReason>
> {
  const partRows = await tx.agentComponentInvocationPart.findMany({
    where: { generationId: generation.id },
    orderBy: { partIndex: "asc" },
    select: { partIndex: true, itemCount: true },
  });
  if (!hasEveryPart(partRows, generation.expectedPartCount)) {
    return Result.ok({ state: AgentComponentInvocationSyncAckState.Staged });
  }

  const invocationRows = await loadGenerationInvocations(tx, generation.id);
  const expectedItemCount = partRows.reduce(
    (total, row) => total + row.itemCount,
    0
  );
  if (invocationRows.length !== expectedItemCount) {
    return Result.err(
      AgentComponentInvocationSyncRejectReason.GenerationConflict
    );
  }

  const computedGenerationId = sha256Hex(
    agentComponentInvocationGenerationHashPreimage({
      externalSessionId: input.part.externalSessionId,
      items: invocationRows.map(toSyncItem),
    })
  );
  if (computedGenerationId !== generation.externalGenerationId) {
    return Result.err(
      AgentComponentInvocationSyncRejectReason.GenerationConflict
    );
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
  await applyResolutionUpdates(tx, generation.id, resolution.updates);
  await tx.agentComponentInvocationGeneration.updateMany({
    where: {
      agentSessionId: generation.agentSessionId,
      activeAt: { not: null },
    },
    data: { activeAt: null },
  });
  await tx.agentComponentInvocationGeneration.update({
    where: { id: generation.id },
    data: { activeAt: now, completedAt: now },
  });
  await deleteCompletedInactiveGenerations(
    tx,
    generation.agentSessionId,
    generation.id
  );
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
  for (const component of components) {
    if (component.componentKey === null) {
      continue;
    }
    const key = componentLookupKey(
      component.componentKind,
      component.componentKey
    );
    const ids = idsByKey.get(key);
    if (ids) {
      ids.push(component.id);
    } else {
      idsByKey.set(key, [component.id]);
    }
  }
  const result = new Map<string, ComponentResolution>();
  for (const [key, ids] of idsByKey) {
    result.set(
      key,
      ids.length === 1 ? { kind: "single", id: ids[0] } : { kind: "ambiguous" }
    );
  }
  return result;
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

async function applyResolutionUpdates(
  tx: TransactionClient,
  generationId: string,
  updates: readonly ResolutionUpdate[]
): Promise<void> {
  if (updates.length === 0) {
    return;
  }
  await tx.$executeRaw(Prisma.sql`
    UPDATE agent_component_invocations AS invocation
    SET
      agent_component_id = NULLIF(resolved."agentComponentId", '')::uuid,
      attribution_status = resolved."attributionStatus",
      definition_hash = resolved."definitionHash",
      normalizer_contract_version = resolved."normalizerContractVersion",
      definition_version_id = NULLIF(resolved."definitionVersionId", '')::uuid,
      source_occurrence_id = NULLIF(resolved."sourceOccurrenceId", '')::uuid,
      -- ISS-4923: the identity columns are re-pointed ONLY for a skill-shadowed
      -- phantom, which is the only row that carries them. Every other row omits
      -- the key entirely, so jsonb_to_recordset yields NULL and the COALESCE
      -- leaves the stored value exactly as the generation hash saw it.
      component_kind = COALESCE(resolved."componentKind", invocation.component_kind),
      component_key = COALESCE(resolved."componentKey", invocation.component_key),
      normalized_name = COALESCE(resolved."normalizedName", invocation.normalized_name),
      updated_at = CURRENT_TIMESTAMP
    FROM jsonb_to_recordset(${JSON.stringify(updates)}::jsonb) AS resolved(
      id text,
      "agentComponentId" text,
      "attributionStatus" text,
      "definitionHash" text,
      "normalizerContractVersion" integer,
      "definitionVersionId" text,
      "sourceOccurrenceId" text,
      "componentKind" text,
      "componentKey" text,
      "normalizedName" text
    )
    WHERE invocation.id = resolved.id::uuid
      AND invocation.generation_id = ${generationId}::uuid
  `);
}

function loadGenerationInvocations(
  tx: TransactionClient,
  generationId: string
): Promise<StagedInvocationRow[]> {
  return tx.agentComponentInvocation.findMany({
    where: { generationId },
    orderBy: [{ sequence: "asc" }, { externalInvocationId: "asc" }],
    select: INVOCATION_HASH_SELECT,
  });
}

function upsertGeneration(
  tx: TransactionClient,
  agentSessionId: string,
  part: AgentComponentInvocationSyncPart
): Promise<GenerationRecord> {
  return tx.agentComponentInvocationGeneration.upsert({
    where: {
      agentSessionId_externalGenerationId_sourceUpdatedAt_dataRevision_sourceSequence:
        {
          agentSessionId,
          externalGenerationId: part.externalGenerationId,
          sourceUpdatedAt: new Date(part.sourceUpdatedAt),
          dataRevision: part.dataRevision,
          sourceSequence: part.sourceSequence,
        },
    },
    create: {
      agentSessionId,
      externalGenerationId: part.externalGenerationId,
      sourceUpdatedAt: new Date(part.sourceUpdatedAt),
      dataRevision: part.dataRevision,
      sourceSequence: part.sourceSequence,
      expectedPartCount: part.partCount,
    },
    update: { updatedAt: new Date() },
    select: GENERATION_SELECT,
  });
}

async function hasInvocationIdConflict(
  tx: TransactionClient,
  generationId: string,
  items: readonly AgentComponentInvocationSyncItem[]
): Promise<boolean> {
  if (items.length === 0) {
    return false;
  }
  const row = await tx.agentComponentInvocation.findFirst({
    where: {
      generationId,
      externalInvocationId: {
        in: items.map((item) => item.externalInvocationId),
      },
    },
    select: { id: true },
  });
  return row !== null;
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
