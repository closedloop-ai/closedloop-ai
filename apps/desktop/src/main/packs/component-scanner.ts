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
 * T-13.4 plugin usage rollup: child `agent_components` rows of every kind the
 * rollups join (`PLUGIN_CHILD_KINDS` — skill, command, subagent, mcp) get their
 * `pack_id` field back-filled so the local IPC data source can compute a
 * plugin-level usage rollup by summing child usage rows. ISS-6094 widened that
 * list from a hardcoded skill/command pair, made the link reconcile when a pack
 * is uninstalled, and wired the whole projection into the production post-scan
 * path (`pack-scan-post-steps.ts`), which had never called it.
 */

import { createHash } from "node:crypto";
import {
  AgentComponentKind,
  Harness,
} from "@repo/api/src/types/agent-component";
import { PLUGIN_CHILD_KINDS_SQL_LIST } from "../database/db-helpers.js";
import type { DesktopPrisma } from "../database/prisma-client.js";
import { gatewayLog } from "../logging/gateway-logger.js";
import {
  type ClaudePluginRegistryEntry,
  RESERVED_PLUGIN_PACK_IDS,
  readClaudeInstalledPluginRegistry,
} from "./claude-plugin-registry.js";
import {
  applyComponentTombstone,
  reserveComponentOrderingKey,
} from "./component-tombstone.js";
import {
  buildChildCandidatePageSql,
  buildPackLinkClaimSql,
  type ChildOwnershipRow,
  comparePackClaimSpecificity,
  groupChildrenByNewOwner,
  PACK_LINK_READ_PAGE,
  PACK_LINK_WRITE_CHUNK,
  type PackLinkClaim,
  packLinkClaimParams,
  selectTombstonedPackIdsToClear,
} from "./pack-link-ownership.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PackScannerDb = DesktopPrisma;

export type ComponentScannerSummary = {
  upserted: number;
  tombstoned: number;
  packIdBackfills: number;
  /**
   * ISS-6094: child rows whose `pack_id` pointed at a now-uninstalled pack and
   * was cleared this pass. Counted separately from `packIdBackfills` — an
   * unlink removes a plugin's usage, a backfill adds it, and folding them into
   * one number would make a scan that only tore links down look like a scan
   * that built them.
   */
  packIdUnlinks: number;
};

/**
 * FEA-4094: discovery summary for the harness-native installed-plugin scan.
 * `discovered` counts installed-plugin `agent_components` rows upserted this
 * pass; `tombstoned` counts previously-discovered rows whose plugin is no
 * longer present in the harness registry.
 */
export type InstalledPluginDiscoverySummary = {
  discovered: number;
  tombstoned: number;
};

/**
 * One installed plugin resolved from a harness's on-disk registry. `harness`
 * is the vendor axis (currently only `Harness.Claude`); `marketplace` is the
 * source marketplace the plugin was installed from (or `null` for a plugin
 * installed directly into the harness with no marketplace).
 */
type InstalledPlugin = {
  pluginName: string;
  marketplace: string | null;
  installPath: string;
  version: string | null;
  harness: Harness;
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
 * Sets `pack_id` to the pack's own id so children of every kind the rollups join
 * can be associated via the `packId` FK column in `agent_components`. Tombstones
 * `agent_components` plugin rows whose `agent_packs` row is now uninstalled, and
 * releases the child links that pack held.
 *
 * Called from the post-scan settle steps (`runPackScanPostSteps`, and again
 * after the definition pass applies) — see `pack-scan-post-steps.ts`.
 *
 * Best-effort: exceptions in one row are logged and skipped; the rest
 * continue.
 */
export async function projectPacksToComponents(
  db: PackScannerDb,
  packLinkChunkSize: number = PACK_LINK_WRITE_CHUNK
): Promise<ComponentScannerSummary> {
  const summary: ComponentScannerSummary = {
    upserted: 0,
    tombstoned: 0,
    packIdBackfills: 0,
    packIdUnlinks: 0,
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
      // Deterministic read order: the plugin-row upsert/tombstone loop below
      // walks this list, and an unordered read makes a failure reproduce
      // differently every run. It is NOT the child-claim rule — that is
      // `comparePackClaimSpecificity`, applied inside `backfillChildPackIds`.
      orderBy: [{ packId: "asc" }, { harness: "asc" }, { installPath: "asc" }],
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
      await tombstonePluginComponent(
        db,
        compId,
        pack.uninstalledAt,
        now,
        summary
      );
    }
  }

  // Reconcile the child `pack_id` links: release the ones a now-uninstalled pack
  // held, then back-fill every child kind the plugin usage rollup joins so it can
  // sum their invocation counts (T-13.4, widened by ISS-6094).
  await backfillChildPackIds(db, packs, now, packLinkChunkSize, summary);

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

/**
 * Mirror an `agent_packs` tombstone onto its projected plugin component row.
 *
 * ISS-6881: the write goes through {@link applyComponentTombstone} so it also
 * advances the sync ordering key — the component-sync cursor pages by
 * `(last_seen_at, id)`, so a tombstone that left the ordering key behind the
 * persisted cursor stayed invisible to the lane and the uninstall never reached the
 * cloud. The scan instant is only a floor for that key, never the key itself: the
 * pack's own `uninstalledAt` belongs to whichever earlier scan retired it, and `now`
 * ties with every sibling row this same scan writes. See that module's header.
 */
async function tombstonePluginComponent(
  db: PackScannerDb,
  compId: string,
  uninstalledAt: string,
  now: string,
  summary: ComponentScannerSummary
): Promise<void> {
  try {
    await applyComponentTombstone(db, {
      uninstalledAt,
      scanInstant: now,
      whereSql: "id = $3 AND uninstalled_at IS NULL",
      whereParams: [compId],
    });
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
 * Back-fill `pack_id` on child `agent_components` rows (children whose
 * install_path is a subdirectory of the pack's install_path) so the plugin
 * usage rollup in the local IPC data source can join them.
 *
 * T-13.4: the plugin usage rollup relies on `agent_components.pack_id` being set
 * on child rows. We use a path-prefix heuristic: a child with
 * `install_path LIKE '<packInstallPath>%'` is a child of that pack.
 *
 * ISS-6094: the kind list is `PLUGIN_CHILD_KINDS`, NOT a literal. It was a
 * hardcoded `('skill', 'command')` while all three rollup readers in
 * `dashboard/shared-agent-components-api.ts` — and the cloud's
 * `loadChildInventoryJoin` — joined `('skill','command','subagent','mcp')`, so a
 * subagent or MCP child could never be stamped with a pack_id and any plugin
 * whose children are subagents or MCP servers rolled up to a permanent zero,
 * silently, with no test failing. Every side now reads the same constant (the
 * desktop pair through `db-helpers.ts`'s SQL rendering of it); see
 * `test/plugin-child-kind-parity.test.ts` for the guard that keeps it that way.
 *
 * ISS-6094 (second-order effect, deliberate): `pack_id` is ALSO the first-
 * priority signal for a component's OWN displayed Source — `toSourceType` /
 * `honestSourceOf` (dashboard/agent-component-honest-source.ts) and the cloud's
 * kind-agnostic `resolveDetailSourceType` / `resolveHonestSource`
 * (apps/api/app/agent-components/identity.ts) classify any row with a `pack_id`
 * as `SourceType.Pack`. So widening the kinds does not only feed the usage
 * rollup: a subagent or MCP component that genuinely belongs to a plugin will
 * also start reporting Pack instead of Repo/Local. That is the correct answer —
 * those readers were always kind-agnostic and it was this backfill that
 * under-populated them — but it is a real, user-visible consequence, recorded
 * here rather than discovered later. It IS reachable: the same ticket wired
 * `projectPacksToComponents` into `runPackScanPostSteps`, which both db-host
 * pack-scan store ops run, so this is the first release in which the backfill
 * executes on a user's machine at all.
 *
 * ISS-6905: `pack_id` is ON THE COMPONENT SYNC WIRE (`component-sync-source.ts`
 * maps it to `SyncedComponent.packId`), so this UPDATE is a mutation that must
 * RE-ENTER the keyset lane — which pages by `(COALESCE(last_seen_at,''), id)`.
 * Writing `pack_id` alone left the row at its existing ordering key, so once the
 * cursor had paged past it the new link never reached the cloud and org inventory
 * kept attributing the child to its old pack (or to none) indefinitely. The key
 * comes from {@link reserveComponentOrderingKey} — the same owner the tombstone
 * writers use — rather than from `now`, because one scan stamps one `now` across
 * every row it writes and the lane runs concurrently: a row landing at `(now, idA)`
 * after the lane acknowledged a sibling at `(now, idB >= idA)` satisfies neither
 * keyset disjunct. Reserving inside the `write` task is what makes the ORDERING-KEY
 * read and the UPDATE one atomic read-modify-write; see that module's header. That
 * claim covers only those two statements. The candidate-row read below runs on a
 * reader connection OUTSIDE any write task, so the owner it resolves is a decision
 * about a committed snapshot — which is why the UPDATE re-asserts the whole of that
 * snapshot (`id`, `install_path`, `component_kind`, and the `pack_id` it is changing
 * FROM) rather than trusting it to still hold. `install_path` is the load-bearing
 * half: `upsertDefinition` moves a child's path under the same id, so an id-only
 * predicate would stamp a moved row with the pack that owned it where it used to
 * live. {@link buildPackLinkClaimSql} carries that argument in full.
 *
 * The read is KEYSET-PAGED on `id` ({@link PACK_LINK_READ_PAGE}), each page resolved
 * and written before the next is read, so peak row residency is one page rather than
 * the whole plugin-child inventory.
 *
 * The `pack_id IS NULL OR pack_id != $1` guard is what bounds the re-sync cost:
 * it matches only rows whose `pack_id` actually CHANGES, so a scan that finds
 * nothing new writes nothing and re-enters nothing. The added lane volume is
 * exactly one row per genuine link change, which is the floor for delivering it
 * at all — not one row per scan.
 *
 * Advancing the key also refreshes what `shared-agent-components-api.ts` presents as
 * "last observed", for a row selected by its STORED `install_path` rather than by a
 * fresh on-disk check. That is inherent to `last_seen_at` carrying both meanings —
 * ISS-6881 made it the sync ordering key, and a tombstone already advances it for a
 * component the scan just found GONE. It is recorded here because this widens the set
 * of mutations that touch it, and it is bounded: only a row whose owning pack actually
 * changed is written at all.
 *
 * `chunkSize` exists so the multi-chunk write path is reachable from a test without
 * seeding `PACK_LINK_WRITE_CHUNK` rows, the same knob `component-tombstone-repair.ts`
 * threads for the same reason.
 */
async function backfillChildPackIds(
  db: PackScannerDb,
  packs: Array<{
    packId: string;
    installPath: string;
    uninstalledAt: string | null;
  }>,
  now: string,
  chunkSize: number,
  summary: ComponentScannerSummary
): Promise<void> {
  // ISS-6094: reconcile FIRST, claim second. Skipping an uninstalled pack (the
  // loop below) only stops it acquiring NEW children — a link an earlier scan
  // already stamped would survive the uninstall untouched, so a removed plugin
  // kept rolling up its ex-children's invocations forever. Clearing before the
  // active claims run also means a child that a still-installed nested pack owns
  // is immediately re-stamped by that pack in the same pass, never left NULL.
  await clearTombstonedPackLinks(db, packs, now, summary);

  // ISS-6094: claim in SHALLOWEST-FIRST order so the deepest matching pack is
  // the last writer, and therefore the owner. Packs are not all keyed on their
  // own leaf directory — the Codex gstack row is deliberately keyed on the whole
  // `~/.codex/skills` root (see `scanGStack`) — so an ancestor pack prefix-
  // matches every child installed beneath it. Ordering by packId instead handed
  // that child to whichever id happened to sort later, which for `gstack` means
  // it steals every child of any pack whose id sorts before it. Most-specific
  // root is the only defensible owner.
  const claimOrder = packs
    .filter((pack) => pack.uninstalledAt === null)
    .sort(comparePackClaimSpecificity);

  const width = Math.max(1, Math.floor(chunkSize));
  let afterId: string | null = null;
  for (;;) {
    let page: ChildOwnershipRow[];
    try {
      page = await readChildCandidatePage(db, afterId);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      gatewayLog.warn(
        "component-scanner",
        `backfillChildPackIds: failed to read child rows: ${msg}`
      );
      return;
    }
    const lastRow = page.at(-1);
    if (lastRow === undefined) {
      return;
    }
    for (const [packId, claims] of groupChildrenByNewOwner(page, claimOrder)) {
      await claimChildrenForPack(db, packId, claims, now, width, summary);
    }
    if (page.length < PACK_LINK_READ_PAGE) {
      return;
    }
    afterId = lastRow.id;
  }
}

/**
 * ISS-6094: clear `pack_id` on children still pointing at a pack whose
 * `agent_packs` row is tombstoned.
 *
 * `backfillChildPackIds` only ever WROTE the column, so the link an active scan
 * stamped outlived the pack: once `uninstalled_at` was set the pack was skipped
 * and its stale `pack_id` stayed on every child. The plugin rollup groups by
 * that column, so an uninstalled plugin went on accumulating its ex-children's
 * invocations — and, because `pack_id` is also the first-priority Source signal,
 * those children kept reporting `Pack` for a pack that is gone.
 *
 * Scoped to `PLUGIN_CHILD_KINDS` so the pack's own `component_kind='plugin'`
 * row (which legitimately carries its `pack_id`) is never cleared.
 *
 * ISS-6905: the unlink advances the sync ordering key for the same reason the
 * backfill above does — `pack_id` is on the component sync wire, and a mutation
 * left behind the keyset cursor never reaches the cloud, so the child would go on
 * being attributed to a pack the user removed. `pack_id = $1` already scopes the
 * write to rows still pointing at THIS tombstoned pack, so a repeat scan matches
 * nothing and costs the lane nothing.
 *
 * Which ids get released is {@link selectTombstonedPackIdsToClear}'s decision, not
 * "every row with `uninstalled_at`": one logical pack id can hold several
 * `agent_packs` installs, and releasing an id that still has an active one starts a
 * per-scan release/re-claim loop that the ordering-key advance turns into permanent
 * sync volume. See that helper for the gstack case it is derived from.
 */
async function clearTombstonedPackLinks(
  db: PackScannerDb,
  packs: Array<{
    packId: string;
    installPath: string;
    uninstalledAt: string | null;
  }>,
  now: string,
  summary: ComponentScannerSummary
): Promise<void> {
  for (const packId of selectTombstonedPackIdsToClear(packs)) {
    try {
      const affected = await db.write(async (client) => {
        const orderingKey = await reserveComponentOrderingKey(client, now);
        return await client.$executeRawUnsafe(
          `UPDATE agent_components
           SET pack_id = NULL,
               last_seen_at = $2
           WHERE component_kind IN (${PLUGIN_CHILD_KINDS_SQL_LIST})
             AND pack_id = $1`,
          packId,
          orderingKey
        );
      });
      if (typeof affected === "number" && affected > 0) {
        summary.packIdUnlinks += affected;
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      gatewayLog.warn(
        "component-scanner",
        `clearTombstonedPackLinks(${packId}): ${msg}`
      );
    }
  }
}

/**
 * One keyset page of plugin-child candidate rows, ordered by `id` after `afterId`.
 *
 * Split from the caller so the two bind shapes (first page, continuation) stay a
 * detail of the read rather than a branch inside the claim loop. Throws; the caller
 * owns the warn-and-stop.
 */
async function readChildCandidatePage(
  db: PackScannerDb,
  afterId: string | null
): Promise<ChildOwnershipRow[]> {
  const sql = buildChildCandidatePageSql(afterId !== null, PACK_LINK_READ_PAGE);
  return await db.read((reader) =>
    afterId === null
      ? reader.$queryRawUnsafe<ChildOwnershipRow[]>(sql)
      : reader.$queryRawUnsafe<ChildOwnershipRow[]>(sql, afterId)
  );
}

/**
 * Stamp one pack's resolved claims, `width` rows per statement.
 *
 * A failed chunk is warned and skipped rather than aborting the pass: the next scan
 * re-resolves the same rows from their current paths, and one unwritable chunk must
 * not cost every other pack its link.
 */
async function claimChildrenForPack(
  db: PackScannerDb,
  packId: string,
  claims: readonly PackLinkClaim[],
  now: string,
  width: number,
  summary: ComponentScannerSummary
): Promise<void> {
  for (let start = 0; start < claims.length; start += width) {
    const chunk = claims.slice(start, start + width);
    try {
      const affected = await db.write(async (client) => {
        const orderingKey = await reserveComponentOrderingKey(client, now);
        return await client.$executeRawUnsafe(
          buildPackLinkClaimSql(chunk.length),
          packId,
          orderingKey,
          ...packLinkClaimParams(chunk)
        );
      });
      if (typeof affected === "number" && affected > 0) {
        summary.packIdBackfills += affected;
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      gatewayLog.warn(
        "component-scanner",
        `backfillChildPackIds(${packId}): ${msg}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// discoverInstalledPlugins (FEA-4094)
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic `agent_components.id` for a harness-native installed
 * plugin from its STABLE identity — the same `external_id` the ON CONFLICT dedup
 * key uses (harness, marketplace, plugin name). `installPath` is deliberately
 * NOT hashed: a reinstall to a new path must keep the same component id, so it
 * updates the existing row (and its install history) instead of minting a
 * second identity for the same plugin. Distinct from
 * `deterministicPluginComponentId` (the pack-derived id) so the two projections
 * never collide on the primary key.
 */
function deterministicInstalledPluginId(externalId: string): string {
  return createHash("sha256").update(externalId).digest("hex").slice(0, 32);
}

/**
 * Stable `external_id` for an installed-plugin component — the dedup key for
 * the `(component_kind, external_id)` conflict target. Mutable install location
 * is excluded so the same plugin has one identity across reinstalls/scopes.
 */
function installedPluginExternalId(plugin: InstalledPlugin): string {
  const market = plugin.marketplace ?? "";
  return `installed-plugin|${plugin.harness}|${market}|${plugin.pluginName}`;
}

/**
 * Resolve every installed plugin from Claude Code's on-disk registry
 * (`~/.claude/plugins/installed_plugins.json`) — one entry per (plugin, install
 * scope), independent of whether the plugin came from a Closedloop Pack, a
 * bundled marketplace, or a direct harness install.
 *
 * Carries the registry read's tri-state through: `entries` is authoritative
 * only when `registryAuthoritative` is true. A transient read/parse failure
 * (`registryAuthoritative === false`) yields `entries: []` but must NOT be
 * reconciled to zero by the caller — otherwise a corrupt or mid-rewrite
 * registry mass-tombstones every previously discovered plugin.
 *
 * This is the SAME registry `scanClaudeMarketplaces` reads (shared low-level
 * reader), but here every installed plugin is surfaced as its own plugin — the
 * marketplace-bundle collapse the pack path applies does NOT hide sub-plugins.
 * Entries owned by a dedicated first-party scanner (gstack, bmad-method) are
 * skipped so those plugins are not double-counted here.
 */
function resolveClaudeInstalledPlugins(): {
  entries: InstalledPlugin[];
  registryAuthoritative: boolean;
} {
  const read = readClaudeInstalledPluginRegistry();
  if (read.status !== "ok") {
    return { entries: [], registryAuthoritative: false };
  }

  const entries: InstalledPlugin[] = [];
  for (const entry of read.entries) {
    if (isReservedRegistryEntry(entry)) {
      continue;
    }
    entries.push({
      pluginName: entry.pluginName,
      marketplace: entry.marketplace,
      installPath: entry.installPath,
      version: entry.version,
      harness: Harness.Claude,
    });
  }
  return { entries, registryAuthoritative: true };
}

/**
 * Registry entries whose marketplace OR plugin name is owned by a dedicated
 * first-party scanner (gstack, bmad-method), mirroring the exclusion
 * `scanClaudeMarketplaces` applies so those plugins stay solely owned by their
 * dedicated scanner and are not double-counted as installed plugins.
 */
function isReservedRegistryEntry(entry: ClaudePluginRegistryEntry): boolean {
  return (
    (entry.marketplace !== null &&
      RESERVED_PLUGIN_PACK_IDS.has(entry.marketplace)) ||
    RESERVED_PLUGIN_PACK_IDS.has(entry.pluginName)
  );
}

/**
 * FEA-4094: discover harness-native installed plugins and materialize each as
 * its own `component_kind='plugin'` `agent_components` row — presence-based
 * discovery independent of usage or the pack/catalog install-state model.
 *
 * Fixes the bug where multiple installed plugins were invisible: the only
 * plugin-kind writer (`projectPacksToComponents`) collapses a bundled
 * marketplace to a single pack, and plugins installed outside the pack path
 * were never projected at all. This scan reads the harness registry directly,
 * upserts one plugin row per installed plugin (idempotent, deterministic id),
 * and tombstones plugin rows whose installed plugin is no longer present.
 *
 * A transient registry read/parse failure is a no-op: nothing is upserted and
 * nothing is tombstoned, so a corrupt or mid-rewrite registry never marks every
 * plugin uninstalled. Best-effort: a per-row write failure is logged and
 * skipped; the rest continue. Currently covers Claude Code; other harnesses
 * have no documented installed-plugin registry (Codex plugins ship no
 * equivalent manifest) and are added here when one exists.
 */
export async function discoverInstalledPlugins(
  db: PackScannerDb
): Promise<InstalledPluginDiscoverySummary> {
  const summary: InstalledPluginDiscoverySummary = {
    discovered: 0,
    tombstoned: 0,
  };

  const { entries, registryAuthoritative } = resolveClaudeInstalledPlugins();
  if (!registryAuthoritative) {
    // Read/parse failed — the registry contents are unknown. Do not reconcile
    // to zero; leave the existing inventory untouched until a clean read.
    return summary;
  }

  // A plugin can appear under multiple install scopes (user + project); those
  // entries share one `external_id` (the dedup key) so they collapse to a
  // single plugin row. Dedup up front — last scope wins, mirroring the
  // ON CONFLICT DO UPDATE — so `discovered` counts distinct plugins and we
  // issue one write per row instead of a redundant self-conflicting write.
  const byExternalId = new Map<string, InstalledPlugin>();
  for (const plugin of entries) {
    byExternalId.set(installedPluginExternalId(plugin), plugin);
  }

  const now = new Date().toISOString();
  for (const [externalId, plugin] of byExternalId) {
    await upsertInstalledPluginComponent(db, plugin, externalId, now, summary);
  }

  await tombstoneMissingInstalledPlugins(
    db,
    new Set(byExternalId.keys()),
    now,
    summary
  );
  return summary;
}

async function upsertInstalledPluginComponent(
  db: PackScannerDb,
  plugin: InstalledPlugin,
  externalId: string,
  now: string,
  summary: InstalledPluginDiscoverySummary
): Promise<void> {
  const compId = deterministicInstalledPluginId(externalId);
  try {
    await db.write((client) =>
      client.$executeRawUnsafe(
        `INSERT INTO agent_components
           (id, component_kind, external_id, component_key, name, version,
            harness, install_path, pack_id,
            first_seen_at, last_seen_at, uninstalled_at)
         VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $4, $8, $8, NULL)
         ON CONFLICT (component_kind, external_id) DO UPDATE SET
           name         = excluded.name,
           version      = COALESCE(excluded.version, agent_components.version),
           harness      = excluded.harness,
           install_path = excluded.install_path,
           last_seen_at = excluded.last_seen_at,
           uninstalled_at = NULL`,
        compId,
        AgentComponentKind.Plugin,
        externalId,
        plugin.pluginName,
        plugin.version ?? null,
        plugin.harness,
        plugin.installPath,
        now
      )
    );
    summary.discovered++;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    gatewayLog.warn(
      "component-scanner",
      `upsertInstalledPluginComponent(${plugin.pluginName}): ${msg}`
    );
  }
}

/**
 * Tombstone installed-plugin `agent_components` rows whose plugin no longer
 * appears in the harness registry. Scoped to rows this discovery owns
 * (external_id prefix `installed-plugin|`) so it never touches pack-projected
 * plugin rows or any other kind.
 *
 * Advances the sync ordering key alongside `uninstalled_at` so the tombstone is
 * re-selected by the component-sync cursor, which pages by `(last_seen_at, id)`
 * (see `listAgentComponentCursorRows` in sync-source.ts). A tombstone left behind
 * the cursor would never reach the cloud, so the uninstall would silently not sync.
 * ISS-6881 moved that write into {@link applyComponentTombstone} — it was derived
 * here and then copied into neither of the two sibling writers, which is precisely
 * how they lost it, and stamping `now` was in any case not enough to clear a cursor
 * the lane may already have advanced to a same-instant sibling row.
 */
async function tombstoneMissingInstalledPlugins(
  db: PackScannerDb,
  liveExternalIds: Set<string>,
  now: string,
  summary: InstalledPluginDiscoverySummary
): Promise<void> {
  let rows: Array<{ id: string; externalId: string }>;
  try {
    rows = await db.client.$queryRawUnsafe<
      Array<{ id: string; externalId: string }>
    >(
      `SELECT id, external_id AS "externalId"
       FROM agent_components
       WHERE component_kind = $1
         AND external_id LIKE 'installed-plugin|%'
         AND uninstalled_at IS NULL`,
      AgentComponentKind.Plugin
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    gatewayLog.warn(
      "component-scanner",
      `tombstoneMissingInstalledPlugins: failed to read rows: ${msg}`
    );
    return;
  }

  for (const row of rows) {
    if (liveExternalIds.has(row.externalId)) {
      continue;
    }
    try {
      await applyComponentTombstone(db, {
        uninstalledAt: now,
        scanInstant: now,
        whereSql: "id = $3 AND uninstalled_at IS NULL",
        whereParams: [row.id],
      });
      summary.tombstoned++;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      gatewayLog.warn(
        "component-scanner",
        `tombstoneMissingInstalledPlugins(${row.id}): ${msg}`
      );
    }
  }
}
