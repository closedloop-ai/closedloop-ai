/**
 * @file component-scanner.ts
 * @description Projects `agent_packs` rows to `componentKind='plugin'` rows in
 * the `agent_components` inventory table (FEA-2923 T-13.3).
 *
 * Rationale: the "pack" vocabulary is deprecated in favour of "plugin"
 * (reconciled-decisions.md §Vocabulary + kind set, batch 4). All existing
 * `agent_packs` rows represent installed Plugins and must be visible in the
 * Agents workspace under the `plugin` kind. This scanner reads the current
 * pack inventory and upserts an `agent_components` row for each pack, using
 * a deterministic sha256-based id so re-runs are idempotent.
 *
 * The scanner also tombstones `agent_components` rows of kind `plugin` whose
 * underlying `agent_packs` row has been uninstalled (i.e. `uninstalled_at IS
 * NOT NULL`), keeping the two tables in sync.
 *
 * T-13.4 plugin usage rollup: child skill/command `agent_components` rows
 * get their `pack_id` field back-filled so the local IPC data source can
 * compute a plugin-level usage rollup by summing child usage rows.
 */

import { createHash } from "node:crypto";
import type { DesktopPrisma } from "../database/prisma-client.js";
import { gatewayLog } from "../gateway-logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PackScannerDb = DesktopPrisma;

export type ComponentScannerSummary = {
  upserted: number;
  tombstoned: number;
  packIdBackfills: number;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic `agent_components.id` for a plugin row from the
 * pack's composite key (harness, installPath, packId). Mirrors the hash used
 * in write-core.ts `deterministicComponentId` — 32-char hex prefix of sha256.
 */
function deterministicPluginComponentId(
  packId: string,
  harness: string,
  installPath: string
): string {
  return createHash("sha256")
    .update(`plugin|${harness}|${installPath}|${packId}`)
    .digest("hex")
    .slice(0, 32);
}

// ---------------------------------------------------------------------------
// projectPacksToComponents
// ---------------------------------------------------------------------------

/**
 * Read existing `agent_packs` rows and upsert a `componentKind='plugin'` row
 * in `agent_components` for each active (non-tombstoned) pack.
 *
 * Sets `pack_id` to the pack's own id so child skills/commands can be
 * associated via the `packId` FK column in `agent_components`. Tombstones
 * `agent_components` plugin rows whose `agent_packs` row is now uninstalled.
 *
 * Best-effort: exceptions in one row are logged and skipped; the rest
 * continue.
 */
export async function projectPacksToComponents(
  db: PackScannerDb
): Promise<ComponentScannerSummary> {
  const summary: ComponentScannerSummary = {
    upserted: 0,
    tombstoned: 0,
    packIdBackfills: 0,
  };

  // Load all agent_packs rows (including tombstoned so we can mirror the
  // tombstone state in agent_components).
  let packs: Array<{
    packId: string;
    harness: string;
    installPath: string;
    installKind: string | null;
    sourceUrl: string | null;
    version: string | null;
    detectedAt: string | null;
    lastSeenAt: string | null;
    uninstalledAt: string | null;
  }>;
  try {
    packs = await db.client.agentPack.findMany({
      select: {
        packId: true,
        harness: true,
        installPath: true,
        installKind: true,
        sourceUrl: true,
        version: true,
        detectedAt: true,
        lastSeenAt: true,
        uninstalledAt: true,
      },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    gatewayLog.warn(
      "component-scanner",
      `projectPacksToComponents: failed to read agent_packs: ${msg}`
    );
    return summary;
  }

  const now = new Date().toISOString();

  for (const pack of packs) {
    const compId = deterministicPluginComponentId(
      pack.packId,
      pack.harness,
      pack.installPath
    );

    if (pack.uninstalledAt === null) {
      // Upsert the active plugin component row.
      await upsertPluginComponent(db, compId, pack, now, summary);
    } else {
      // Tombstone the corresponding plugin component row.
      await tombstonePluginComponent(db, compId, pack.uninstalledAt, summary);
    }
  }

  // Back-fill pack_id on child skill/command agent_components rows so the
  // plugin usage rollup can sum their invocation counts (T-13.4).
  await backfillChildPackIds(db, packs, summary);

  return summary;
}

// ---------------------------------------------------------------------------
// Private helpers (split for cognitive complexity <20)
// ---------------------------------------------------------------------------

async function upsertPluginComponent(
  db: PackScannerDb,
  compId: string,
  pack: {
    packId: string;
    harness: string;
    installPath: string;
    installKind: string | null;
    sourceUrl: string | null;
    version: string | null;
    detectedAt: string | null;
    lastSeenAt: string | null;
  },
  now: string,
  summary: ComponentScannerSummary
): Promise<void> {
  try {
    await db.write((client) =>
      client.$executeRawUnsafe(
        `INSERT INTO agent_components
           (id, component_kind, external_id, component_key, name, version,
            harness, source_url, install_path, pack_id,
            first_seen_at, last_seen_at, uninstalled_at)
         VALUES ($1, 'plugin', $2, $3, $3, $4, $5, $6, $7, $3, $8, $9, NULL)
         ON CONFLICT (component_kind, external_id) DO UPDATE SET
           name        = excluded.name,
           version     = COALESCE(excluded.version, agent_components.version),
           harness     = excluded.harness,
           source_url  = COALESCE(excluded.source_url, agent_components.source_url),
           install_path = excluded.install_path,
           pack_id     = excluded.pack_id,
           last_seen_at = excluded.last_seen_at,
           uninstalled_at = NULL`,
        compId,
        // external_id: stable composite key mirrors agent_packs PK
        `${pack.harness}|${pack.installPath}|${pack.packId}`,
        // component_key / name: use packId as the display key
        pack.packId,
        pack.version ?? null,
        pack.harness,
        pack.sourceUrl ?? null,
        pack.installPath,
        pack.detectedAt ?? now,
        pack.lastSeenAt ?? now
      )
    );
    summary.upserted++;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    gatewayLog.warn(
      "component-scanner",
      `upsertPluginComponent(${pack.packId}): ${msg}`
    );
  }
}

async function tombstonePluginComponent(
  db: PackScannerDb,
  compId: string,
  uninstalledAt: string,
  summary: ComponentScannerSummary
): Promise<void> {
  try {
    await db.write((client) =>
      client.$executeRawUnsafe(
        `UPDATE agent_components
         SET uninstalled_at = $1
         WHERE id = $2 AND uninstalled_at IS NULL`,
        uninstalledAt,
        compId
      )
    );
    summary.tombstoned++;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    gatewayLog.warn(
      "component-scanner",
      `tombstonePluginComponent(${compId}): ${msg}`
    );
  }
}

/**
 * Back-fill `pack_id` on child `agent_components` rows (skills/commands whose
 * install_path is a subdirectory of the pack's install_path) so the plugin
 * usage rollup in the local IPC data source can join them efficiently.
 *
 * T-13.4: plugin usage rollup relies on `agent_components.pack_id` being set
 * on child skill/command rows. We use a path-prefix heuristic: a skill with
 * `install_path LIKE '<packInstallPath>%'` is a child of that pack.
 */
async function backfillChildPackIds(
  db: PackScannerDb,
  packs: Array<{
    packId: string;
    installPath: string;
    uninstalledAt: string | null;
  }>,
  summary: ComponentScannerSummary
): Promise<void> {
  for (const pack of packs) {
    if (pack.uninstalledAt !== null) {
      continue; // Don't link children to uninstalled packs.
    }
    try {
      const affected = await db.write((client) =>
        client.$executeRawUnsafe(
          `UPDATE agent_components
           SET pack_id = $1
           WHERE component_kind IN ('skill', 'command')
             AND install_path LIKE $2
             AND (pack_id IS NULL OR pack_id != $1)`,
          pack.packId,
          `${pack.installPath}%`
        )
      );
      if (typeof affected === "number" && affected > 0) {
        summary.packIdBackfills += affected;
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      gatewayLog.warn(
        "component-scanner",
        `backfillChildPackIds(${pack.packId}): ${msg}`
      );
    }
  }
}
