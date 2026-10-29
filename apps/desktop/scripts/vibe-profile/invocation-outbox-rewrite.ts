import { createHash } from "node:crypto";
import {
  agentComponentInvocationGenerationHashPreimage,
  agentComponentInvocationSyncPartHashPreimage,
} from "@repo/api/src/types/agent-component-invocation";
import { agentComponentInvocationSyncPartSchema } from "@repo/api/src/types/agent-component-invocation-schema";
import { rewriteVibeCorpusText } from "@repo/api/src/vibe-seed-corpus";
import type { SqliteAgentDatabase } from "../../src/main/database/sqlite.js";

/**
 * ISS-12135: the invocation outbox holds the parts the vibe Desktop posts on
 * launch, as JSON the column rewrite in `corpus-rewrite.ts` does not reach. Its
 * component names are rewritten like the store's inventory, and because a
 * part's generation id hashes its items and its part hash covers them too,
 * both are re-signed (and the session's sync cursor follows the new
 * generation) so the server accepts what the Desktop sends. Item order, which
 * the generation hash depends on, sorts by `externalInvocationId`; that id is
 * left alone, so the order is unchanged.
 */

const ITEM_NAME_FIELDS = ["componentKey", "rawName", "normalizedName"] as const;

type OutboxRow = {
  readonly rowid: number;
  readonly sourceKey: string;
  readonly externalSessionId: string;
  readonly externalGenerationId: string;
  readonly partIndex: number;
  /** Text from a raw read of the store; Prisma hands a JSONB column back parsed. */
  readonly payload: unknown;
};

export async function rewriteInvocationOutbox(
  db: SqliteAgentDatabase
): Promise<number> {
  const rows = await db.prisma.client.$queryRawUnsafe<OutboxRow[]>(
    `SELECT rowid AS "rowid", source_key AS "sourceKey",
            external_session_id AS "externalSessionId",
            external_generation_id AS "externalGenerationId",
            part_index AS "partIndex", payload AS "payload"
       FROM agent_component_invocation_sync_outbox
      ORDER BY source_key, external_session_id, external_generation_id, part_index`
  );
  let rewritten = 0;
  await db.prisma.write(async (client) => {
    for (const generation of groupByGeneration(rows)) {
      const signed = resignGeneration(generation);
      if (signed === null) {
        continue;
      }
      for (const { row, part } of signed.parts) {
        await client.$executeRawUnsafe(
          `UPDATE agent_component_invocation_sync_outbox
              SET external_generation_id = ?, part_hash = ?, payload = ?
            WHERE rowid = ?`,
          part.externalGenerationId,
          part.partHash,
          JSON.stringify(part),
          row.rowid
        );
        rewritten += 1;
      }
      const [first] = generation;
      if (first !== undefined) {
        await client.$executeRawUnsafe(
          `UPDATE agent_component_invocation_sync_cursors
              SET external_generation_id = ?
            WHERE source_key = ? AND external_session_id = ?
              AND external_generation_id = ?`,
          signed.externalGenerationId,
          first.sourceKey,
          first.externalSessionId,
          first.externalGenerationId
        );
      }
    }
  });
  return rewritten;
}

/**
 * The generation's parts with their item names rewritten and re-signed, or
 * null when no name changed (the stored signatures still hold).
 */
function resignGeneration(generation: readonly OutboxRow[]) {
  let changed = false;
  const parsed = generation.map((row) => {
    const part = agentComponentInvocationSyncPartSchema.parse(
      typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload
    );
    const items = part.items.map((item) => {
      const renamed = { ...item };
      for (const field of ITEM_NAME_FIELDS) {
        const value = item[field];
        if (typeof value === "string") {
          const next = rewriteVibeCorpusText(value);
          changed ||= next !== value;
          renamed[field] = next;
        }
      }
      return renamed;
    });
    return { row, part: { ...part, items } };
  });
  const [first] = parsed;
  if (!changed || first === undefined) {
    return null;
  }
  const externalGenerationId = sha256Hex(
    agentComponentInvocationGenerationHashPreimage({
      externalSessionId: first.part.externalSessionId,
      items: parsed.flatMap(({ part }) => part.items),
    })
  );
  return {
    externalGenerationId,
    parts: parsed.map(({ row, part }) => {
      const { partHash: _staleHash, ...rest } = part;
      const withoutHash = { ...rest, externalGenerationId };
      return {
        row,
        part: {
          ...withoutHash,
          partHash: sha256Hex(
            agentComponentInvocationSyncPartHashPreimage(withoutHash)
          ),
        },
      };
    }),
  };
}

function groupByGeneration(rows: readonly OutboxRow[]): OutboxRow[][] {
  const groups = new Map<string, OutboxRow[]>();
  for (const row of rows) {
    const key = `${row.sourceKey}\u0000${row.externalSessionId}\u0000${row.externalGenerationId}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()];
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
