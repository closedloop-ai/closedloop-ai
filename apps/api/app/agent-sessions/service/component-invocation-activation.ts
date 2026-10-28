/**
 * ISS-12781: make a complete generation the session's visible invocation set
 * while writing only the rows that changed.
 *
 * A generation is a session's whole invocation set and is re-sent on any
 * change, so replacing it wholesale rewrites every row the session holds on
 * every sync (prod, 2026-10-20: 6.67M rows inserted and 7.70M resolution-updated
 * in a day against ~5M live rows).
 *
 * So the active generation keeps its rows. The incoming generation's resolved
 * rows are compared with them by `externalInvocationId`: an identical row is
 * left untouched, a changed or new one is written, and one no longer in the set
 * is deleted. The active generation then takes the incoming identity and part
 * ledger, and the incoming staging generation is deleted. Readers see the same
 * column values a wholesale replacement produces, except bookkeeping: an
 * unchanged row keeps its `id`, `generation_id`, `created_at`, `updated_at` and
 * the `part_id` it was first inserted under, even when the new generation
 * carries its item in a different part. So `part_id` does not say which part
 * last carried a row; it only keeps the row → part cascade valid
 * (`adoptPartLedger`).
 */

import { stableStringify } from "@closedloop-ai/loops-api/stable-stringify";
import { AGENT_COMPONENT_INVOCATION_SYNC_MAX_PART_ITEMS } from "@repo/api/src/types/agent-component-invocation";
import { Prisma, type TransactionClient } from "@repo/database";
import { log } from "@repo/observability/log";
import {
  deleteCompletedInactiveGenerations,
  type GenerationRecord,
  INVOCATION_HASH_SELECT,
  type ResolutionUpdate,
  type StagedInvocationRow,
} from "./component-invocation-helpers";
import type { StagedPartRecord } from "./component-invocation-staging";
import { SessionSyncMetric } from "./session-sync-metrics";

/** Every persisted column of one invocation row, resolution applied. */
export type PersistedInvocation = Omit<StagedInvocationRow, "id"> & {
  agentComponentId: string | null;
  definitionVersionId: string | null;
  sourceOccurrenceId: string | null;
};

/** A row ready to write, with the part index it arrived in. */
export type ActivationRow = {
  partIndex: number;
  columns: PersistedInvocation;
};

/** An active row as the delta reads it. */
export type ActiveInvocationRow = PersistedInvocation & {
  id: string;
  partId: string;
};

/**
 * What one activation did: the rows the active generation held, and how the
 * incoming rows split into unchanged, rewritten (same id, changed) and inserted
 * (new id), plus the active rows deleted because the new set dropped them.
 */
export type ActivationDelta = {
  activeRows: number;
  unchanged: number;
  rewritten: number;
  inserted: number;
  deleted: number;
};

export const ACTIVE_INVOCATION_SELECT = {
  ...INVOCATION_HASH_SELECT,
  agentComponentId: true,
  definitionVersionId: true,
  sourceOccurrenceId: true,
  partId: true,
} as const satisfies Record<keyof ActiveInvocationRow, true>;

/**
 * Rows per write statement: the most one staged part ever inserted in a single
 * `createMany` before ISS-12781, so no statement here is larger than one the
 * ingest already issued.
 */
const INVOCATION_WRITE_BATCH_ROWS =
  AGENT_COMPONENT_INVOCATION_SYNC_MAX_PART_ITEMS;

/** A staged row with its resolution applied, exactly as the row is persisted. */
export function persistedInvocation(
  row: StagedInvocationRow,
  update: ResolutionUpdate
): PersistedInvocation {
  const { id: _id, ...columns } = row;
  return {
    ...columns,
    // ISS-4923: the identity re-point is present only on a skill-shadowed
    // phantom; every other row keeps the value the generation hash saw.
    componentKind: update.componentKind ?? row.componentKind,
    componentKey: update.componentKey ?? row.componentKey,
    normalizedName: update.normalizedName ?? row.normalizedName,
    agentComponentId: update.agentComponentId,
    attributionStatus: update.attributionStatus,
    definitionHash: update.definitionHash,
    normalizerContractVersion: update.normalizerContractVersion,
    definitionVersionId: update.definitionVersionId,
    sourceOccurrenceId: update.sourceOccurrenceId,
  };
}

/**
 * Which active rows to delete and which incoming rows to insert. A changed row
 * is deleted and re-inserted rather than updated: it touches every index either
 * way, and one write path keeps the comparison the only decision.
 *
 * Throws on two incoming rows with one id. The unique index refused that same
 * generation before ISS-12781; keying it into a map here would silently keep one.
 */
export function planActiveRowDelta(
  active: readonly ActiveInvocationRow[],
  incoming: readonly ActivationRow[]
): { deleteIds: string[]; inserts: ActivationRow[]; delta: ActivationDelta } {
  const activeById = new Map(
    active.map((row) => [row.externalInvocationId, row])
  );
  const seen = new Set<string>();
  const deleteIds: string[] = [];
  const inserts: ActivationRow[] = [];
  let rewritten = 0;
  for (const next of incoming) {
    const key = next.columns.externalInvocationId;
    if (seen.has(key)) {
      throw new Error("Duplicate invocation id in a complete generation");
    }
    seen.add(key);
    const current = activeById.get(key);
    if (current && storedRowKey(current) === storedRowKey(next.columns)) {
      continue;
    }
    if (current) {
      deleteIds.push(current.id);
      rewritten += 1;
    }
    inserts.push(next);
  }
  for (const row of active) {
    if (!seen.has(row.externalInvocationId)) {
      deleteIds.push(row.id);
    }
  }
  return {
    deleteIds,
    inserts,
    delta: {
      activeRows: active.length,
      unchanged: incoming.length - inserts.length,
      rewritten,
      inserted: inserts.length - rewritten,
      deleted: deleteIds.length - rewritten,
    },
  };
}

/**
 * The activation log (ISS-12781, marisolashgrove review on #9039): one per
 * activated generation, after its transaction commits, so a comparator that
 * starts calling every row changed shows up as `rewritten` instead of as table
 * churn. Never throws: the generation is already committed when this runs.
 */
export function reportGenerationActivation(
  context: {
    organizationId: string;
    computeTargetId: string;
    externalSessionId: string;
    externalGenerationId: string;
  },
  delta: ActivationDelta
): void {
  try {
    log.info("Activated agent component invocation generation", {
      metric: SessionSyncMetric.InvocationGenerationActivated,
      ...context,
      ...delta,
    });
  } catch {
    // A failure to report must not turn a committed activation into an error.
  }
}

/**
 * Make `generation` (complete, verified, fresher than any active one) the
 * session's visible set. With no active generation its rows are inserted
 * under it; otherwise the active generation absorbs it (see module header).
 */
export async function activateGeneration(
  tx: TransactionClient,
  input: {
    generation: GenerationRecord;
    activeGeneration: GenerationRecord | null;
    parts: readonly StagedPartRecord[];
    rows: readonly ActivationRow[];
    hasLegacyRows: boolean;
    now: Date;
  }
): Promise<ActivationDelta> {
  const target = input.activeGeneration ?? input.generation;
  let delta: ActivationDelta;
  if (input.activeGeneration) {
    delta = await absorbIntoActiveGeneration(tx, input.activeGeneration, input);
  } else {
    await activateStagingGeneration(tx, input);
    delta = {
      activeRows: 0,
      unchanged: 0,
      rewritten: 0,
      inserted: input.rows.length,
      deleted: 0,
    };
  }
  // ISS-5801: fold the activated row count onto the parent so the
  // substantive/idle SQL twin (SESSION_SUBSTANTIVE_WHERE) classifies
  // invocation-only sessions without a join.
  await tx.sessionDetail.update({
    where: { artifactId: target.agentSessionId },
    data: { componentInvocationCount: input.rows.length },
    select: { artifactId: true },
  });
  await deleteCompletedInactiveGenerations(
    tx,
    target.agentSessionId,
    target.id
  );
  return delta;
}

async function activateStagingGeneration(
  tx: TransactionClient,
  input: {
    generation: GenerationRecord;
    parts: readonly StagedPartRecord[];
    rows: readonly ActivationRow[];
    hasLegacyRows: boolean;
    now: Date;
  }
): Promise<void> {
  const { generation } = input;
  if (input.hasLegacyRows) {
    // Rows an older build staged were read into `rows`; they are re-written
    // below with their resolution, like every other row of this generation.
    await tx.agentComponentInvocation.deleteMany({
      where: { generationId: generation.id },
    });
  }
  const partIdByIndex = new Map(
    input.parts.map((part) => [part.partIndex, part.id])
  );
  await insertRows(tx, generation.id, partIdByIndex, input.rows);
  await tx.$executeRaw(Prisma.sql`
    UPDATE agent_component_invocation_parts
    SET staged_items = NULL, staged_invocation_ids = NULL
    WHERE generation_id = ${generation.id}::uuid
  `);
  await tx.agentComponentInvocationGeneration.updateMany({
    where: {
      agentSessionId: generation.agentSessionId,
      activeAt: { not: null },
    },
    data: { activeAt: null },
  });
  await tx.agentComponentInvocationGeneration.update({
    where: { id: generation.id },
    data: { activeAt: input.now, completedAt: input.now },
    select: { id: true },
  });
}

async function absorbIntoActiveGeneration(
  tx: TransactionClient,
  active: GenerationRecord,
  input: {
    generation: GenerationRecord;
    parts: readonly StagedPartRecord[];
    rows: readonly ActivationRow[];
    now: Date;
  }
): Promise<ActivationDelta> {
  // First, so the active generation can take this identity under
  // `idx_acig_session_external_generation_freshness`.
  await tx.agentComponentInvocationGeneration.deleteMany({
    where: { id: input.generation.id },
  });
  const activeRows = await tx.agentComponentInvocation.findMany({
    where: { generationId: active.id },
    select: ACTIVE_INVOCATION_SELECT,
  });
  const plan = planActiveRowDelta(activeRows, input.rows);
  for (const ids of chunk(plan.deleteIds)) {
    await tx.agentComponentInvocation.deleteMany({
      where: { id: { in: ids } },
    });
  }
  const partIdByIndex = await adoptPartLedger(tx, active.id, input.parts);
  await insertRows(tx, active.id, partIdByIndex, plan.inserts);
  await tx.agentComponentInvocationGeneration.update({
    where: { id: active.id },
    data: {
      externalGenerationId: input.generation.externalGenerationId,
      sourceUpdatedAt: input.generation.sourceUpdatedAt,
      dataRevision: input.generation.dataRevision,
      sourceSequence: input.generation.sourceSequence,
      expectedPartCount: input.generation.expectedPartCount,
      activeAt: input.now,
      completedAt: input.now,
    },
    select: { id: true },
  });
  return plan.delta;
}

/**
 * Give the active generation the incoming part ledger, so a re-sent part of the
 * generation it now carries is acknowledged against the right hash. A part
 * index the new generation no longer has is deleted after its surviving rows
 * move to part 0 — the row → part foreign key cascades, and those rows stay.
 */
async function adoptPartLedger(
  tx: TransactionClient,
  generationId: string,
  ledger: readonly StagedPartRecord[]
): Promise<Map<number, string>> {
  const current = await tx.agentComponentInvocationPart.findMany({
    where: { generationId },
    select: {
      id: true,
      partIndex: true,
      partHash: true,
      itemCount: true,
      payloadBytes: true,
    },
  });
  const currentByIndex = new Map(current.map((part) => [part.partIndex, part]));
  const partIdByIndex = new Map<number, string>();
  for (const part of ledger) {
    const existing = currentByIndex.get(part.partIndex);
    const values = {
      partHash: part.partHash,
      itemCount: part.itemCount,
      payloadBytes: part.payloadBytes,
    };
    if (!existing) {
      const created = await tx.agentComponentInvocationPart.create({
        data: { generationId, partIndex: part.partIndex, ...values },
        select: { id: true },
      });
      partIdByIndex.set(part.partIndex, created.id);
      continue;
    }
    partIdByIndex.set(part.partIndex, existing.id);
    if (
      existing.partHash !== values.partHash ||
      existing.itemCount !== values.itemCount ||
      existing.payloadBytes !== values.payloadBytes
    ) {
      await tx.agentComponentInvocationPart.update({
        where: { id: existing.id },
        data: values,
        select: { id: true },
      });
    }
  }
  const droppedIds = current
    .filter((part) => !partIdByIndex.has(part.partIndex))
    .map((part) => part.id);
  if (droppedIds.length > 0) {
    await tx.agentComponentInvocation.updateMany({
      where: { partId: { in: droppedIds } },
      data: { partId: firstPartId(partIdByIndex) },
    });
    await tx.agentComponentInvocationPart.deleteMany({
      where: { id: { in: droppedIds } },
    });
  }
  return partIdByIndex;
}

async function insertRows(
  tx: TransactionClient,
  generationId: string,
  partIdByIndex: ReadonlyMap<number, string>,
  rows: readonly ActivationRow[]
): Promise<void> {
  for (const batch of chunk(rows)) {
    await tx.agentComponentInvocation.createMany({
      data: batch.map(({ partIndex, columns }) => ({
        ...columns,
        anchor: JSON.parse(JSON.stringify(columns.anchor)),
        generationId,
        partId: partIdForIndex(partIdByIndex, partIndex),
      })),
    });
  }
}

function partIdForIndex(
  partIdByIndex: ReadonlyMap<number, string>,
  partIndex: number
): string {
  const partId = partIdByIndex.get(partIndex);
  if (partId === undefined) {
    throw new Error("Invocation row names a part its generation lacks");
  }
  return partId;
}

function firstPartId(partIdByIndex: ReadonlyMap<number, string>): string {
  return partIdForIndex(partIdByIndex, 0);
}

/**
 * One row's persisted columns, normalized to what each column stores: a
 * timestamp to its milliseconds, a bigint to its digits, `estimated_cost` to its
 * six stored decimals, jsonb to sorted keys, an absent value to NULL. Equal keys
 * mean equal stored rows. A false "changed" only costs one rewrite of that row,
 * so nothing here may normalize two values the column distinguishes to one.
 */
function storedRowKey(row: PersistedInvocation | ActiveInvocationRow): string {
  const normalized: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(row)) {
    if (column === "id" || column === "partId") {
      continue;
    }
    normalized[column] = storedValue(column, value);
  }
  return stableStringify(normalized);
}

function storedValue(column: string, value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (column === "estimatedCost") {
    return Number(value).toFixed(6);
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  return value;
}

function chunk<T>(values: readonly T[]): T[][] {
  const batches: T[][] = [];
  for (
    let start = 0;
    start < values.length;
    start += INVOCATION_WRITE_BATCH_ROWS
  ) {
    batches.push(values.slice(start, start + INVOCATION_WRITE_BATCH_ROWS));
  }
  return batches;
}
