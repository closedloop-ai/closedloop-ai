/**
 * @file catalog-store.ts
 * @description Persistence for the Agent Pack Catalog (FEA-1314 / PLN-657).
 * Three tables: `pack_catalog` (curated packs + live GitHub stats),
 * `pack_catalog_history` (append-only star/fork samples for the sparkline),
 * `pack_install_runs` (audit log for install/uninstall subprocess executions).
 *
 * FEA-1791 Phase 3: the whole module runs on the single `DesktopPrisma` client.
 * Writes (`upsertCatalogSeed`/`applyFetchResult`/`applyContentsFetch`/
 * `recordInstallRunStart`/`recordInstallRunEnd`) use typed delegates inside
 * `prisma.write(...)` so they serialize on libSQL's single connection; the
 * simple reads (`listHistory`/`inFlightInstallRun`/`listInstallRuns`) use typed
 * delegates on `prisma.client`. Only `listCatalog`/`getCatalog` stay on
 * `prisma.client.$queryRawUnsafe`: their installed-status decoration uses a
 * `group_concat` over a DISTINCT subquery plus COUNT/MAX scalar subqueries that
 * have no clean typed-delegate form.
 *
 * Catalog entries join against the FEA-1224 `agent_packs` table on `pack_id`
 * to derive installed status — keep pack_id strings aligned with what the
 * scanner writes (gstack, bmad-method, etc.).
 *
 * Part of CLOSEDLOOP pack-observability (FEA-1314 / PLN-657, builds on
 * FEA-1224).
 */

import type {
  CatalogContentItem,
  CatalogContentsConfig,
  CatalogEntry,
  InstallRunRecord,
} from "../../shared/agent-db-contract.js";
import { Prisma } from "../database/generated/client.js";
import type { DesktopPrisma } from "../database/prisma-client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

interface CatalogRow extends Record<string, unknown> {
  pack_id: string;
  display_name: string;
  category: string | null;
  github_url: string;
  marketplace_url: string | null;
  description: string | null;
  description_live: string | null;
  harnesses: string[] | null;
  install_commands: Record<string, unknown> | null;
  uninstall_commands: Record<string, unknown> | null;
  install_notes: string | null;
  placeholder_reason: string | null;
  verified: boolean;
  readme_excerpt: string | null;
  readme_fetched_at: string | null;
  stars: number | null;
  forks: number | null;
  last_release: string | null;
  last_fetched_at: string | null;
  seed_version: number;
  pin_order: number | null;
  contents: Record<string, unknown> | null;
  contents_cache: unknown[] | null;
  contents_fetched_at: string | null;
  detection_patterns: string[] | null;
  harness_agnostic: boolean;
  project_scoped: boolean;
  single_install: boolean;
  post_install: Record<string, unknown> | null;
  // Derived via subquery joins:
  installed_harnesses: string | null;
  installed_skill_count: number | null;
  uninstalled_at: string | null;
}

type PackUsage = {
  tool_calls: number;
  sessions: number;
  first_used_at: string;
  last_used_at: string;
};

type SeedPack = {
  pack_id: string;
  display_name: string;
  github_url: string;
  category?: string | null;
  marketplace_url?: string | null;
  description?: string | null;
  harnesses?: string[] | null;
  install_commands?: Record<string, unknown> | null;
  uninstall_commands?: Record<string, unknown> | null;
  install_notes?: string | null;
  placeholder_reason?: string | null;
  verified?: boolean;
  pin_order?: number | null;
  contents?: Record<string, unknown> | null;
  detection_patterns?: string[] | null;
  harness_agnostic?: boolean;
  project_scoped?: boolean;
  single_install?: boolean;
  post_install?: Record<string, unknown> | null;
};

type SeedDoc = {
  seed_version?: number;
  packs: SeedPack[];
};

// ---------------------------------------------------------------------------
// Usage attribution (best-effort)
// ---------------------------------------------------------------------------

/**
 * Compute pack usage attribution from the existing `events` table — works
 * retroactively on already-imported sessions.
 *
 * Returns Map<pack_id, { tool_calls, sessions, first_used_at, last_used_at }>.
 *
 * TODO: Wire up to the first-party pack-store's listPackUsage once ported.
 */
async function loadUsageMap(): Promise<Map<string, PackUsage>> {
  // pack-store with listPackUsage is not yet ported to the first-party app.
  // Return an empty map until the dependency is available.
  return new Map();
}

/**
 * Parse a JSON column read over the raw SQL path. PGlite returned jsonb columns
 * already deserialized; libSQL/SQLite stores JSON as TEXT, so a raw read yields
 * the JSON string. Normalize both shapes to a parsed value (null on absent or
 * unparseable input) so the downstream mappers see the same thing they did
 * under PGlite. Prisma-typed reads parse Json fields themselves and don't use
 * this path.
 */
function parseJsonColumn<T>(value: unknown): T | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }
  return value as T;
}

function stringRecordOrNull(
  value: Record<string, unknown> | null
): Record<string, string> | null {
  if (!value) {
    return null;
  }
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string"
  );
  return Object.fromEntries(entries);
}

function catalogContentsOrNull(
  value: Record<string, unknown> | null
): CatalogContentsConfig | null {
  if (!value || typeof value.type !== "string") {
    return null;
  }
  return { ...value, type: value.type };
}

function isCatalogContentItem(value: unknown): value is CatalogContentItem {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const item = value as { name?: unknown; type?: unknown };
  return typeof item.name === "string" && typeof item.type === "string";
}

function catalogContentItemsOrNull(
  value: unknown[] | null
): CatalogContentItem[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value.filter(isCatalogContentItem);
}

function splitInstalledHarnesses(value: string | null): string[] {
  if (!value) {
    return [];
  }
  return value.split(",").filter(Boolean);
}

function toCatalogEntry(
  row: CatalogRow,
  {
    history = [],
    usage = null,
  }: {
    history?: CatalogEntry["history"];
    usage?: PackUsage | null;
  } = {}
): CatalogEntry {
  return {
    packId: row.pack_id,
    displayName: row.display_name,
    category: row.category,
    githubUrl: row.github_url,
    marketplaceUrl: row.marketplace_url,
    description: row.description,
    descriptionLive: row.description_live,
    harnesses: parseJsonColumn<string[]>(row.harnesses) ?? [],
    installCommands: stringRecordOrNull(
      parseJsonColumn<Record<string, unknown>>(row.install_commands)
    ),
    uninstallCommands: stringRecordOrNull(
      parseJsonColumn<Record<string, unknown>>(row.uninstall_commands)
    ),
    installNotes: row.install_notes,
    placeholderReason: row.placeholder_reason,
    verified: !!row.verified,
    readmeExcerpt: row.readme_excerpt,
    stars: row.stars,
    forks: row.forks,
    lastRelease: row.last_release,
    seedVersion: row.seed_version,
    pinOrder: row.pin_order,
    contents: catalogContentsOrNull(
      parseJsonColumn<Record<string, unknown>>(row.contents)
    ),
    contentsCache: catalogContentItemsOrNull(
      parseJsonColumn<unknown[]>(row.contents_cache)
    ),
    detectionPatterns: parseJsonColumn<string[]>(row.detection_patterns),
    harnessAgnostic: !!row.harness_agnostic,
    projectScoped: !!row.project_scoped,
    singleInstall: !!row.single_install,
    postInstall: parseJsonColumn<Record<string, unknown>>(row.post_install),
    installedHarnesses: splitInstalledHarnesses(row.installed_harnesses),
    // COUNT(*) from the listCatalog/getCatalog $queryRawUnsafe path can surface
    // as bigint through the adapter; Number() keeps it IPC/JSON-serializable.
    skillCount:
      row.installed_skill_count == null ? 0 : Number(row.installed_skill_count),
    usageCount: usage?.tool_calls ?? 0,
    history,
  };
}

// ---------------------------------------------------------------------------
// Seed upsert
// ---------------------------------------------------------------------------

/**
 * Map a nullable seed JSON field to a Prisma JSON input (SQL NULL when absent).
 * The seed's JSON fields are arrays or plain objects; round-tripping through
 * JSON validates the value is serializable and yields a plain JSON value at the
 * type boundary (no `as` on unvalidated data) — a non-serializable value would
 * throw here rather than at the driver-adapter layer.
 */
function jsonOrDbNull(
  value: string[] | Record<string, unknown> | null | undefined
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (value === null || value === undefined) {
    return Prisma.DbNull;
  }
  return JSON.parse(JSON.stringify(value));
}

/**
 * Apply the seed JSON to `pack_catalog`. Each row's `seed_version` is
 * compared against the seed's top-level `seed_version`; rows whose stored
 * seed_version is lower (or absent) are upserted. Higher stored seed_versions
 * are left alone (assume a newer seed was previously applied — don't roll
 * back).
 *
 * Live fields (stars, forks, description_live, last_fetched_at) are NEVER
 * touched by this function — they're owned by the fetcher; the `update` block
 * below lists only the seed-owned columns, exactly mirroring the prior raw
 * `ON CONFLICT DO UPDATE SET`.
 *
 * FEA-1791 Phase 3: this is the first store converted to the typed Prisma
 * client. Writes go through `prisma.write(...)` so they serialize with the raw
 * store path on PGlite's single connection; JSON columns are passed as objects
 * (Prisma stores them as jsonb — no manual JSON.stringify).
 */
export async function upsertCatalogSeed(
  prisma: DesktopPrisma,
  seedDoc: SeedDoc | null | undefined
): Promise<{ inserted: number; updated: number; skipped: number }> {
  if (!(seedDoc && Array.isArray(seedDoc.packs))) {
    return { inserted: 0, updated: 0, skipped: 0 };
  }
  const seedVersion = Number.isInteger(seedDoc.seed_version)
    ? seedDoc.seed_version!
    : 1;
  const stats = { inserted: 0, updated: 0, skipped: 0 };

  for (const pack of seedDoc.packs) {
    if (!(pack?.pack_id && pack.display_name && pack.github_url)) {
      continue;
    }

    const existing = await prisma.client.packCatalog.findUnique({
      where: { packId: pack.pack_id },
      select: { seedVersion: true },
    });

    if (existing && existing.seedVersion >= seedVersion) {
      stats.skipped += 1;
      continue;
    }

    // Seed-owned columns only — must match the live-field exclusions documented
    // above. Shared between create and update so the two paths can't drift.
    const seedFields = {
      displayName: pack.display_name,
      category: pack.category ?? null,
      githubUrl: pack.github_url,
      marketplaceUrl: pack.marketplace_url ?? null,
      description: pack.description ?? null,
      harnesses: jsonOrDbNull(pack.harnesses),
      installCommands: jsonOrDbNull(pack.install_commands),
      uninstallCommands: jsonOrDbNull(pack.uninstall_commands),
      installNotes: pack.install_notes ?? null,
      placeholderReason: pack.placeholder_reason ?? null,
      verified: !!pack.verified,
      pinOrder: typeof pack.pin_order === "number" ? pack.pin_order : null,
      contents: jsonOrDbNull(pack.contents),
      detectionPatterns: jsonOrDbNull(pack.detection_patterns),
      harnessAgnostic: !!pack.harness_agnostic,
      projectScoped: !!pack.project_scoped,
      singleInstall: !!pack.single_install,
      postInstall: jsonOrDbNull(pack.post_install),
      seedVersion,
    };

    await prisma.write((client) =>
      client.packCatalog.upsert({
        where: { packId: pack.pack_id },
        create: { packId: pack.pack_id, ...seedFields },
        update: seedFields,
      })
    );

    if (existing) {
      stats.updated += 1;
    } else {
      stats.inserted += 1;
    }
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Catalog listing
// ---------------------------------------------------------------------------

/**
 * List all catalog entries. Sort order:
 *   1. Pinned entries (pin_order ASC) — Closedloop always lands first.
 *   2. Everything else by star count DESC.
 *   3. Tiebreak: display name ASC.
 *
 * Installed status is decorated via subquery joins against `agent_packs` and
 * `skills`.
 */
export async function listCatalog(
  prisma: DesktopPrisma
): Promise<CatalogEntry[]> {
  const rows = await prisma.client.$queryRawUnsafe<CatalogRow[]>(
    `SELECT
       c.*,
       (SELECT group_concat(h, ',')
        FROM (SELECT DISTINCT ap.harness AS h
              FROM agent_packs ap
              WHERE ap.pack_id = c.pack_id
                AND ap.uninstalled_at IS NULL))     AS installed_harnesses,
       (SELECT COUNT(*) FROM skills s
        WHERE s.pack_id = c.pack_id
          AND s.uninstalled_at IS NULL)             AS installed_skill_count,
       (SELECT MAX(ap.uninstalled_at)
        FROM agent_packs ap
        WHERE ap.pack_id = c.pack_id
          AND ap.uninstalled_at IS NOT NULL)        AS uninstalled_at
     FROM pack_catalog c
     ORDER BY
       CASE WHEN c.pin_order IS NULL THEN 1 ELSE 0 END ASC,
       c.pin_order ASC,
       COALESCE(c.stars, 0) DESC,
       c.display_name ASC`
  );

  const usage = await loadUsageMap();

  return rows.map((row) =>
    toCatalogEntry(row, { usage: usage.get(row.pack_id) ?? null })
  );
}

// ---------------------------------------------------------------------------
// Single-entry detail
// ---------------------------------------------------------------------------

/** Get one catalog entry by pack_id, with installed status + recent history. */
export async function getCatalog(
  prisma: DesktopPrisma,
  packId: string,
  { historyDays = 30 }: { historyDays?: number } = {}
): Promise<CatalogEntry | null> {
  const rows = await prisma.client.$queryRawUnsafe<CatalogRow[]>(
    `SELECT
       c.*,
       (SELECT group_concat(h, ',')
        FROM (SELECT DISTINCT ap.harness AS h
              FROM agent_packs ap
              WHERE ap.pack_id = c.pack_id
                AND ap.uninstalled_at IS NULL))     AS installed_harnesses,
       (SELECT COUNT(*) FROM skills s
        WHERE s.pack_id = c.pack_id
          AND s.uninstalled_at IS NULL)             AS installed_skill_count,
       (SELECT MAX(ap.uninstalled_at)
        FROM agent_packs ap
        WHERE ap.pack_id = c.pack_id
          AND ap.uninstalled_at IS NOT NULL)        AS uninstalled_at
     FROM pack_catalog c
     WHERE c.pack_id = $1`,
    packId
  );
  const row = rows[0] ?? null;
  if (!row) {
    return null;
  }

  const usage = await loadUsageMap();

  return toCatalogEntry(row, {
    usage: usage.get(packId) ?? null,
    history: await listHistory(prisma, packId, historyDays),
  });
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export async function listHistory(
  prisma: DesktopPrisma,
  packId: string,
  days = 30
): Promise<CatalogEntry["history"]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const rows = await prisma.client.packCatalogHistory.findMany({
    where: { packId, fetchedAt: { gte: since } },
    select: { fetchedAt: true, stars: true, forks: true },
    orderBy: { fetchedAt: "asc" },
  });
  return rows.map((row) => ({
    fetchedAt: row.fetchedAt,
    stars: row.stars ?? 0,
    forks: row.forks ?? 0,
  }));
}

// ---------------------------------------------------------------------------
// Fetch results (GitHub stats)
// ---------------------------------------------------------------------------

/**
 * Update the live fields after a successful GitHub fetch + append a history
 * sample. Called by the fetcher.
 */
export async function applyFetchResult(
  prisma: DesktopPrisma,
  {
    pack_id,
    stars,
    forks,
    description,
    last_release,
  }: {
    pack_id: string;
    stars?: number | null;
    forks?: number | null;
    description?: string | null;
    last_release?: string | null;
  }
): Promise<void> {
  const ts = nowIso();
  await prisma.write(async (client) => {
    // `updateMany` (not `update`) preserves the prior raw UPDATE's no-op when
    // the pack_id is absent. stars/forks are always written (value or NULL);
    // description_live/last_release are COALESCE(excluded, existing) — set only
    // when a non-empty value was fetched (matching the prior `COALESCE($n, …)`).
    await client.packCatalog.updateMany({
      where: { packId: pack_id },
      data: {
        stars: stars ?? null,
        forks: forks ?? null,
        ...(description ? { descriptionLive: description } : {}),
        ...(last_release ? { lastRelease: last_release } : {}),
        lastFetchedAt: ts,
      },
    });
    if (stars != null || forks != null) {
      await client.packCatalogHistory.upsert({
        where: { packId_fetchedAt: { packId: pack_id, fetchedAt: ts } },
        create: {
          packId: pack_id,
          fetchedAt: ts,
          stars: stars ?? null,
          forks: forks ?? null,
        },
        update: { stars: stars ?? null, forks: forks ?? null },
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Contents fetch
// ---------------------------------------------------------------------------

/**
 * Cache the per-pack contents listing fetched by catalog-contents.
 * `items` is an array of `{ name, kind, description?, path? }`.
 */
export async function applyContentsFetch(
  prisma: DesktopPrisma,
  { pack_id, items }: { pack_id: string; items: unknown[] | null | undefined }
): Promise<void> {
  const ts = nowIso();
  await prisma.write((client) =>
    // contents_cache is a Json column: pass the array as a JSON value (Prisma
    // serializes it) rather than a pre-stringified blob. `updateMany` keeps the
    // prior raw UPDATE's no-op-when-absent semantics.
    client.packCatalog.updateMany({
      where: { packId: pack_id },
      data: {
        contentsCache:
          items == null
            ? Prisma.DbNull
            : (JSON.parse(JSON.stringify(items)) as Prisma.InputJsonValue),
        contentsFetchedAt: ts,
      },
    })
  );
}

// ---------------------------------------------------------------------------
// Install runs (audit log)
// ---------------------------------------------------------------------------

export async function recordInstallRunStart(
  prisma: DesktopPrisma,
  {
    pack_id,
    harness,
    action,
    command,
  }: { pack_id: string; harness: string; action: string; command: string }
): Promise<number> {
  const ts = nowIso();
  const run = await prisma.write((client) =>
    client.packInstallRun.create({
      data: { packId: pack_id, harness, action, command, startedAt: ts },
      select: { id: true },
    })
  );
  return run.id;
}

export async function recordInstallRunEnd(
  prisma: DesktopPrisma,
  id: number,
  {
    exit_code,
    stdout_tail,
    stderr_tail,
  }: {
    exit_code?: number | null;
    stdout_tail?: string | null;
    stderr_tail?: string | null;
  }
): Promise<void> {
  await prisma.write((client) =>
    client.packInstallRun.updateMany({
      where: { id },
      data: {
        exitCode: exit_code ?? null,
        endedAt: nowIso(),
        stdoutTail: stdout_tail || null,
        stderrTail: stderr_tail || null,
      },
    })
  );
}

interface InFlightRow extends Record<string, unknown> {
  id: number;
  harness: string | null;
  command: string | null;
  started_at: string;
}

export async function inFlightInstallRun(
  prisma: DesktopPrisma,
  packId: string
): Promise<InFlightRow | null> {
  const run = await prisma.client.packInstallRun.findFirst({
    where: { packId, endedAt: null },
    select: { id: true, harness: true, command: true, startedAt: true },
    orderBy: { startedAt: "desc" },
  });
  return run
    ? {
        id: run.id,
        harness: run.harness,
        command: run.command,
        started_at: run.startedAt,
      }
    : null;
}

export async function listInstallRuns(
  prisma: DesktopPrisma,
  {
    pack_id = null,
    limit = 50,
    offset = 0,
  }: { pack_id?: string | null; limit?: number; offset?: number } = {}
): Promise<InstallRunRecord[]> {
  const rows = await prisma.client.packInstallRun.findMany({
    where: pack_id ? { packId: pack_id } : undefined,
    orderBy: { startedAt: "desc" },
    take: limit,
    skip: offset,
  });
  return rows.map((row) => ({
    id: row.id,
    packId: row.packId,
    harness: row.harness,
    action: row.action,
    command: row.command,
    exitCode: row.exitCode,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    stdoutTail: row.stdoutTail,
    stderrTail: row.stderrTail,
  }));
}
