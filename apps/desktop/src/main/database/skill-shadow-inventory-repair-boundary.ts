/**
 * @file skill-shadow-inventory-repair-boundary.ts
 * @description ISS-5260 — the main-process side of the `skillShadowInventory.repair`
 * store op.
 *
 * The repair itself runs in the db host (it issues `prisma.write` callbacks,
 * which cannot be structured-cloned across the method proxy), so its result
 * reaches main as an `unknown` over IPC. That is a real trust boundary: a
 * version-skewed or failing host can return a shape this side never produced, so
 * the payload is PARSED rather than cast, and an unparseable result degrades to
 * "nothing was repaired" — which is exactly what a caller should assume when it
 * cannot tell.
 *
 * Kept in its own module rather than inlined in the maintenance chain so the
 * schema lives next to the type it guards and the chain keeps only the call,
 * mirroring the artifact-link and activity-segment runtime boundaries.
 */

import {
  type SkillShadowInventoryRepair,
  skillShadowInventoryRepairSchema,
} from "./skill-shadow-inventory-maintenance.js";

/** The store-op key registered in `db-host-worker.ts`'s `storeOps`. */
export const SKILL_SHADOW_INVENTORY_REPAIR_OP = "skillShadowInventory.repair";

const NO_REPAIR: SkillShadowInventoryRepair = {
  deletedComponents: 0,
  markedSessions: 0,
};

export type SkillShadowInventoryRepairBoundaryOptions = {
  invokeStoreOp: (name: string, args?: unknown[]) => Promise<unknown>;
  log: (message: string) => void;
};

/**
 * Run the inventory repair in the db host and return its parsed result.
 *
 * Never throws: the repair is best-effort maintenance, and a failure here must
 * not block the data-revision rebuild queued behind it. A rejected invoke or an
 * unrecognized payload is reported and reduced to {@link NO_REPAIR}, so the only
 * cost is that the phantom row survives until the next boot.
 */
export async function runSkillShadowInventoryRepairBoundary(
  options: SkillShadowInventoryRepairBoundaryOptions
): Promise<SkillShadowInventoryRepair> {
  const raw = await options
    .invokeStoreOp(SKILL_SHADOW_INVENTORY_REPAIR_OP)
    .catch((e: unknown) => {
      options.log(
        `ISS-5260 inventory repair op failed: ${e instanceof Error ? e.message : String(e)}`
      );
      return null;
    });
  if (raw === null || raw === undefined) {
    return NO_REPAIR;
  }
  const parsed = skillShadowInventoryRepairSchema.safeParse(raw);
  if (!parsed.success) {
    // A shape main never produced means the host is skewed or wedged — say so
    // rather than silently treating an unreadable payload as a clean pass.
    options.log(
      `ISS-5260 inventory repair returned an unrecognized result shape: ${parsed.error.message}`
    );
    return NO_REPAIR;
  }
  return parsed.data;
}
