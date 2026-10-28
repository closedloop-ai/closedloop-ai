/**
 * @file pack-prune.ts — tombstone the pack-scanner rows a scan did not
 * re-stamp. Moved out of pack-scanner.ts (ISS-11914) so that grandfathered file
 * does not grow.
 */

import { isTccProtectedPath } from "../../shared/sandbox-policy.js";
import type { DesktopPrisma } from "../database/prisma-client.js";
import { gatewayLog } from "../logging/gateway-logger.js";

/**
 * Tombstone rows the current scan didn't observe. Packs/skills that USED to
 * be installed are kept around with `uninstalled_at` set so the catalog can
 * surface "previously installed, used N times" badges.
 * project_pack_associations is still pruned (associations are observational).
 *
 * ISS-11914 (Perrin Upcott's ruling, 2026-10-07): a row inside a TCC-protected
 * folder keeps its last-scanned state, because the scan no longer reads there.
 * Each write reads its stale rows and leaves out the protected ones inside the
 * same queued write, so the check and the update see the same rows.
 */
export async function pruneStaleRows(
  db: DesktopPrisma,
  scanStartedAt: string
): Promise<void> {
  const stale = { lastSeenAt: { lt: scanStartedAt }, uninstalledAt: null };
  try {
    await db.write(async (client) => {
      const held = (
        await client.agentPack.findMany({
          where: stale,
          select: { packId: true, harness: true, installPath: true },
        })
      ).filter((row) => isTccProtectedPath(row.installPath));
      return client.agentPack.updateMany({
        where: held.length > 0 ? { ...stale, NOT: held } : stale,
        data: { uninstalledAt: scanStartedAt },
      });
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    gatewayLog.warn("pack-scanner", `tombstone agent_packs failed: ${msg}`);
  }
  try {
    await db.write(async (client) => {
      const heldIds = (
        await client.skill.findMany({
          where: stale,
          select: { skillId: true, installPath: true },
        })
      )
        .filter((row) => isTccProtectedPath(row.installPath))
        .map((row) => row.skillId);
      return client.skill.updateMany({
        where:
          heldIds.length > 0
            ? { ...stale, skillId: { notIn: heldIds } }
            : stale,
        data: { uninstalledAt: scanStartedAt },
      });
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    gatewayLog.warn("pack-scanner", `tombstone skills failed: ${msg}`);
  }
  try {
    await db.write(async (client) => {
      const staleAssociation = { lastSeenAt: { lt: scanStartedAt } };
      const held = (
        await client.projectPackAssociation.findMany({
          where: staleAssociation,
          select: { projectPath: true, packId: true },
        })
      ).filter(
        (row) =>
          !STAT_ONLY_ASSOCIATION_PACKS.has(row.packId) &&
          isTccProtectedPath(row.projectPath)
      );
      return client.projectPackAssociation.deleteMany({
        where:
          held.length > 0
            ? { ...staleAssociation, NOT: held }
            : staleAssociation,
      });
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    gatewayLog.warn(
      "pack-scanner",
      `prune project_pack_associations failed: ${msg}`
    );
  }
}

/**
 * Packs whose project association comes from a bare `stat` of a marker file
 * (`scanProjectGStackAssociations`). That still runs inside protected folders,
 * so a missing marker there is a real removal.
 */
const STAT_ONLY_ASSOCIATION_PACKS: ReadonlySet<string> = new Set(["gstack"]);
