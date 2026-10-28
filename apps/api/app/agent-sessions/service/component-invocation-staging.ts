/**
 * ISS-12781: where a generation's items wait until every part has arrived.
 *
 * Each part's items are held on its own ledger row (`staged_items`), redacted
 * exactly as the invocation row would be, instead of as one invocation row per
 * item. A generation is the session's COMPLETE set, re-sent whenever any item
 * changes, so staging it as rows inserted, then resolution-updated, then deleted
 * on the next generation, every row the session has ever produced on every
 * sync. Holding the items here lets activation write only the rows that differ
 * from the active set (`component-invocation-activation.ts`).
 *
 * A part staged by a build that predates the column has `staged_items` NULL and
 * its items as invocation rows in the generation; both are read back so a
 * generation that straddles a deploy still completes.
 */
import type { AgentComponentInvocationSyncItem } from "@repo/api/src/types/agent-component-invocation";
import { agentComponentInvocationSyncItemFieldsSchema } from "@repo/api/src/types/agent-component-invocation-schema";
import { Prisma, type TransactionClient } from "@repo/database";
import { redactInvocationDefinitionContent } from "@repo/lib/security/redact-definition-content";
import { z } from "zod";
import { projectIndexKey } from "@/lib/index-key-projection";
import {
  INVOCATION_HASH_SELECT,
  type StagedInvocationRow,
} from "./component-invocation-helpers";
import {
  stagedInvocationRow,
  storedExternalInvocationIds,
} from "./component-invocation-wire-row";

/** One part's ledger as completion reads it. */
export type StagedPartRecord = {
  id: string;
  partIndex: number;
  partHash: string;
  itemCount: number;
  payloadBytes: number;
  stagedItems: Prisma.JsonValue;
};

/** A staged row and the part index it arrived in. */
export type StagedGenerationRow = {
  partIndex: number;
  row: StagedInvocationRow;
};

export const STAGED_PART_SELECT = {
  id: true,
  partIndex: true,
  partHash: true,
  itemCount: true,
  payloadBytes: true,
  stagedItems: true,
} as const satisfies Record<keyof StagedPartRecord, true>;

// Field contract only: the whole-item byte ceilings were applied to the raw
// item at the route, and redaction can lengthen definition text past them.
const stagedItemsSchema = z.array(agentComponentInvocationSyncItemFieldsSchema);

/**
 * The value written to `staged_items`. Redacted here, not only at the row write
 * (ISS-4965), so no definition secret is stored while the part waits.
 */
export function stagedItemsValue(
  items: readonly AgentComponentInvocationSyncItem[]
): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify(items.map(redactInvocationDefinitionContent))
  );
}

/**
 * The value written to `staged_invocation_ids`: each item's id in the projected
 * form a row stores (ISS-8736), so the cross-part check below reads these short
 * keys instead of detoasting every earlier part's `staged_items`.
 */
export function stagedInvocationIds(
  items: readonly AgentComponentInvocationSyncItem[]
): string[] {
  return items.map((item) => projectIndexKey(item.externalInvocationId).value);
}

/**
 * Whether any item's id is already staged by ANOTHER part of this generation,
 * compared in the projected form a row stores (ISS-8736), so two raw ids that
 * project alike collide here as they would on the row's unique index.
 */
export async function hasStagedInvocationIdConflict(
  tx: TransactionClient,
  generationId: string,
  items: readonly AgentComponentInvocationSyncItem[]
): Promise<boolean> {
  if (items.length === 0) {
    return false;
  }
  const [staged] = await tx.$queryRaw<Array<{ conflict: boolean }>>(
    Prisma.sql`
      SELECT EXISTS (
        SELECT 1
          FROM agent_component_invocation_parts
         WHERE generation_id = ${generationId}::uuid
           AND staged_invocation_ids ?| ${stagedInvocationIds(items)}::text[]
      ) AS "conflict"
    `
  );
  if (staged?.conflict) {
    return true;
  }
  const legacyRow = await tx.agentComponentInvocation.findFirst({
    where: {
      generationId,
      externalInvocationId: {
        in: items.flatMap((item) =>
          storedExternalInvocationIds(item.externalInvocationId)
        ),
      },
    },
    select: { id: true },
  });
  return legacyRow !== null;
}

/**
 * Every row of a complete generation, in the `(sequence, externalInvocationId)`
 * order the generation hash is computed over. Throws on a `staged_items` value
 * that is not a list of valid items: this module wrote it, so a malformed one is
 * corruption, and the ingest's catch reports it and refuses the part.
 */
export async function loadStagedGenerationRows(
  tx: TransactionClient,
  generationId: string,
  parts: readonly StagedPartRecord[]
): Promise<StagedGenerationRow[]> {
  const rows: StagedGenerationRow[] = [];
  const legacyPartIndexById = new Map<string, number>();
  for (const part of parts) {
    if (part.stagedItems === null) {
      legacyPartIndexById.set(part.id, part.partIndex);
      continue;
    }
    const items = stagedItemsSchema.parse(part.stagedItems);
    for (const [index, item] of items.entries()) {
      rows.push({
        partIndex: part.partIndex,
        row: stagedInvocationRow(`${part.id}:${index}`, item),
      });
    }
  }
  if (legacyPartIndexById.size > 0) {
    const legacyRows = await tx.agentComponentInvocation.findMany({
      where: { generationId, partId: { in: [...legacyPartIndexById.keys()] } },
      select: { ...INVOCATION_HASH_SELECT, partId: true },
    });
    for (const { partId, ...row } of legacyRows) {
      rows.push({ partIndex: legacyPartIndexById.get(partId) ?? 0, row });
    }
  }
  return rows.sort(compareStagedRows);
}

/** True when a part of this generation was staged as rows by an older build. */
export function hasLegacyStagedPart(
  parts: readonly StagedPartRecord[]
): boolean {
  return parts.some((part) => part.stagedItems === null);
}

/**
 * Sequence first, as staged rows were read before ISS-12781. A generation's
 * sequences are its producer's positions, so the id tiebreak (code-unit order
 * here, the database collation before) only orders a producer that repeated one.
 */
function compareStagedRows(
  left: StagedGenerationRow,
  right: StagedGenerationRow
): number {
  if (left.row.sequence !== right.row.sequence) {
    return left.row.sequence - right.row.sequence;
  }
  if (left.row.externalInvocationId === right.row.externalInvocationId) {
    return 0;
  }
  return left.row.externalInvocationId < right.row.externalInvocationId
    ? -1
    : 1;
}
