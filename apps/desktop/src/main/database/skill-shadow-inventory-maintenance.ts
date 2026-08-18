/**
 * @file skill-shadow-inventory-maintenance.ts
 * @description ISS-5260 — the INVENTORY half of the slash-invoked-skill repair,
 * and the pass that keeps it converging on an already-populated store.
 *
 * ## Why the revision bump is not sufficient on its own
 *
 * `component-invocation-skill-repoint.ts` stops a slash invocation of a resolved
 * skill from MINTING a phantom `(command, /X)` inventory row, and revision 68
 * re-derives sealed sessions so their invocations and usage rollups move onto
 * the skill. Neither touches an inventory row that ALREADY exists, and two
 * distinct populations need exactly that:
 *
 *  1. **Upgraded stores.** Migration 0045 deleted the phantom rows once, and
 *     every import since re-minted them through `ensureInvocationComponents`.
 *     The rev-68 rebuild moves the invocations off the command, but
 *     `INVENTORY_SELECT` (`dashboard/shared-agent-components-api.ts`) lists every
 *     non-uninstalled `agent_components` row with NO invocation-count filter, so
 *     the Commands tab would keep rendering `/code-review:deep` — now reading
 *     zero invocations and no definition. That is a WORSE lie than the one it
 *     replaced: it asserts a command exists and was never used, when the record
 *     should not exist at all.
 *
 *  2. **Resolve-after-import ordering.** The re-point gates on a RESOLVED skill
 *     read at materialization time. A session imported before the definition
 *     collector promotes `(skill, X)` to resolved keeps its `(command, /X)`
 *     attribution and is sealed at the CURRENT revision — after which a one-shot
 *     bump can never select it again. A freshly installed skill invoked by slash
 *     in a live-watched session is the concrete shape: the invocation lands as a
 *     command, the collector resolves the skill minutes later, and the entity is
 *     split across two records again.
 *
 * ## The mechanism, and its guarantee
 *
 * One pass, run on EVERY boot before the data-revision rebuild, that re-reads
 * the live inventory and repairs whatever the current evidence says is wrong:
 * mark the affected sessions stale, then delete the phantom row. Because it is
 * evidence-driven rather than one-shot, a skill that resolves later is picked up
 * on the next pass — which is what a migration could not give us, and why this
 * is a maintenance pass rather than migration 0051.
 *
 * The guarantee is CONVERGENCE, not instantaneity: a session materialized after
 * this boot's pass, against a skill that resolves later in the same boot, is
 * repaired on the next boot rather than immediately. That is the same bound
 * migration 0045 gave, now repeating instead of firing once.
 *
 * ## Why deleting the row is safe
 *
 * `agent_component_invocations.local_component_id` is `onDelete: SetNull`, so
 * removing the phantom cannot orphan or cascade-delete an invocation. The
 * sessions holding those invocations are marked stale FIRST, so the rebuild
 * immediately following re-derives them through the shared re-point and lands
 * them on the skill.
 */

import { ComponentResolvedState } from "@repo/api/src/types/agent-component";
import { AgentComponentInvocationKind } from "@repo/api/src/types/agent-component-invocation";
import { z } from "zod";
import { DATA_REVISION_MAINTENANCE_STALE } from "../collectors/engine/data-revision.js";
import { EVENT_INSERT_PARAM_CAP } from "./db-constants.js";
import type { DesktopPrisma } from "./prisma-client.js";

/**
 * What one pass repaired, for the caller's log and cache-invalidation decision.
 *
 * The result crosses the db-host IPC boundary (structured clone), so the main
 * side parses it rather than trusting the shape — see
 * {@link skillShadowInventoryRepairSchema}.
 */
export type SkillShadowInventoryRepair = {
  /** Phantom `(command, /X)` inventory rows deleted. */
  deletedComponents: number;
  /** Sessions parked at {@link DATA_REVISION_MAINTENANCE_STALE} to re-derive. */
  markedSessions: number;
};

/**
 * The boundary schema for {@link SkillShadowInventoryRepair}. Non-negative
 * integers: a repair count is a row tally, and a negative or fractional value
 * means the payload is not what this pass produces.
 */
export const skillShadowInventoryRepairSchema = z.object({
  deletedComponents: z.int().nonnegative(),
  markedSessions: z.int().nonnegative(),
});

/**
 * Compile-time proof the boundary schema covers every field of the type it
 * guards, so a field added to {@link SkillShadowInventoryRepair} fails `tsc`
 * rather than being silently dropped at the IPC boundary.
 */
const _repairKeysCovered: Record<keyof SkillShadowInventoryRepair, z.ZodType> =
  skillShadowInventoryRepairSchema.shape;

type PhantomRow = { id: string; component_key: string };

const NO_REPAIR: SkillShadowInventoryRepair = {
  deletedComponents: 0,
  markedSessions: 0,
};

/**
 * Repair the component inventory against the CURRENT skill resolution state.
 *
 * Best-effort by design: a failure here degrades to "the phantom row survives
 * one more boot", which is strictly better than blocking the maintenance chain
 * that follows it, so the error is reported and swallowed exactly as the sibling
 * PR-link maintenance passes do.
 */
export async function repairSkillShadowedCommandInventory(
  prisma: DesktopPrisma,
  log: (msg: string) => void
): Promise<SkillShadowInventoryRepair> {
  try {
    const phantoms = await selectPhantomCommandRows(prisma);
    if (phantoms.length === 0) {
      return NO_REPAIR;
    }
    const slashKeys = [...new Set(phantoms.map((row) => row.component_key))];
    const markedSessions = await markSessionsStale(prisma, slashKeys);
    const deletedComponents = await deletePhantomRows(
      prisma,
      phantoms.map((row) => row.id)
    );
    if (deletedComponents > 0 || markedSessions > 0) {
      log(
        `ISS-5260 inventory repair: deleted ${deletedComponents} phantom command component(s) shadowed by a resolved skill (${slashKeys.join(", ")}); parked ${markedSessions} session(s) for re-derivation`
      );
    }
    return { deletedComponents, markedSessions };
  } catch (e) {
    log(
      `ISS-5260 inventory repair failed: ${e instanceof Error ? e.message : String(e)}`
    );
    return NO_REPAIR;
  }
}

/**
 * The `(command, /X)` inventory rows a RESOLVED `(skill, X)` shadows and no
 * command-side evidence vouches for.
 *
 * This is `isSkillInvokedSlashKey` expressed in SQL over the inventory itself
 * rather than over a candidate: a resolved skill answers to the bare name, and
 * the command row vouches for neither of the two ways a genuine command can —
 * it has not resolved against a real `.claude/commands/<name>.md` and carries no
 * definition text of its own. The bare-name derivation is `substr(key, 2)`,
 * which is exactly {@link slashKeyBareName}'s parse, so a leading-slash-run key
 * (`//deploy` → `/deploy`) does not match a `deploy` skill here either — the same
 * population ISS-4795 documented and the per-occurrence correlation protects.
 *
 * `uninstalled_at IS NULL` on BOTH sides: a tombstoned command row is already
 * hidden from `INVENTORY_SELECT` (nothing to repair), and a tombstoned skill is
 * no longer evidence that the name resolves to a skill at all.
 */
function selectPhantomCommandRows(
  prisma: DesktopPrisma
): Promise<PhantomRow[]> {
  return prisma.client.$queryRawUnsafe<PhantomRow[]>(
    `SELECT c.id AS id, c.component_key AS component_key
       FROM agent_components c
      WHERE c.component_kind = $1
        AND c.component_key LIKE '/%'
        AND c.uninstalled_at IS NULL
        AND c.resolved_state != $3
        AND (c.content IS NULL OR trim(c.content) = '')
        AND EXISTS (
              SELECT 1
                FROM agent_components s
               WHERE s.component_kind = $2
                 AND s.resolved_state = $3
                 AND s.uninstalled_at IS NULL
                 AND s.component_key = substr(c.component_key, 2)
            )`,
    AgentComponentInvocationKind.Command,
    AgentComponentInvocationKind.Skill,
    ComponentResolvedState.Resolved
  );
}

/**
 * Park every session holding an invocation on one of `slashKeys` so the rebuild
 * that follows re-derives it through the shared re-point.
 *
 * Deliberately scoped to sessions that actually carry such an invocation: a
 * store-wide reset would re-derive the entire corpus to fix a handful of rows.
 * The `data_revision != $stale` guard keeps the pass idempotent across boots that
 * repair nothing new — a session already parked is not re-counted, so the
 * reported total describes work this pass actually did.
 */
async function markSessionsStale(
  prisma: DesktopPrisma,
  slashKeys: string[]
): Promise<number> {
  let marked = 0;
  for (const chunk of chunkKeys(slashKeys)) {
    const placeholders = chunk.map((_, index) => `$${index + 3}`).join(", ");
    marked += await prisma.write((client) =>
      client.$executeRawUnsafe(
        `UPDATE sessions
            SET data_revision = $1
          WHERE data_revision != $1
            AND id IN (
                  SELECT DISTINCT session_id
                    FROM agent_component_invocations
                   WHERE component_kind = $2
                     AND component_key IN (${placeholders})
                )`,
        DATA_REVISION_MAINTENANCE_STALE,
        AgentComponentInvocationKind.Command,
        ...chunk
      )
    );
  }
  return marked;
}

/**
 * Delete the phantom inventory rows. Safe after the stale marking above because
 * the invocation FK is `onDelete: SetNull` — the invocations survive with a null
 * `local_component_id` until the rebuild re-points them onto the skill.
 */
async function deletePhantomRows(
  prisma: DesktopPrisma,
  ids: string[]
): Promise<number> {
  let deleted = 0;
  for (const chunk of chunkKeys(ids)) {
    const placeholders = chunk.map((_, index) => `$${index + 1}`).join(", ");
    deleted += await prisma.write((client) =>
      client.$executeRawUnsafe(
        `DELETE FROM agent_components WHERE id IN (${placeholders})`,
        ...chunk
      )
    );
  }
  return deleted;
}

/**
 * Split an id/key list so no statement crosses the SQLite variable floor
 * `EVENT_INSERT_PARAM_CAP` guards. The widest statement here binds two fixed
 * parameters ahead of the list, so the reserve covers both call sites.
 */
function chunkKeys(values: string[]): string[][] {
  const perChunk = EVENT_INSERT_PARAM_CAP - 2;
  const chunks: string[][] = [];
  for (let offset = 0; offset < values.length; offset += perChunk) {
    chunks.push(values.slice(offset, offset + perChunk));
  }
  return chunks;
}
