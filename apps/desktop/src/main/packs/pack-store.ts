/**
 * @file pack-store.ts
 * @description SQLite persistence for agent-pack inventory: installed packs
 * (`agent_packs`), discovered skills (`skills`), and per-project markers
 * (`project_pack_associations`). All three are pure inventory written by the
 * filesystem scanner; invocation history is sourced from the existing `events`
 * table and never duplicated here (FEA-1224 architectural constraint).
 *
 * Runs on the single DesktopPrisma client. Mirrors the structure of the original
 * CJS pack-store.js with composite-key upserts in place of monotonic versioning.
 *
 * Schema is owned by Prisma + the migration runner — no ensurePackSchema() here.
 *
 * Part of CLOSEDLOOP pack-observability (FEA-1224 / PLN-651, parent PRD-364).
 */

import type {
  InstalledPack,
  InstalledPackDetail,
  SkillInvocation,
  SkillWithInvocations,
} from "../../shared/agent-db-contract.js";
import { MS_PER_DAY } from "../database/db-helpers.js";
import type { DbHostPrisma, DesktopPrisma } from "../database/prisma-client.js";
import { DEFAULT_SESSION_RETENTION_DAYS } from "../database/session-maintenance.js";
import {
  allOrNothingCanonicalSortSql,
  allOrNothingLatestByInstant,
  canonicalRankingKeySql,
  ISO_DATE_PREFIX_GLOB_SQL,
} from "../database/session-timestamp-form.js";

// Writes (upserts) use the typed delegates
// (`agentPack`/`skill`/`projectPackAssociation` `.upsert`) through
// `prisma.write` (the shared write queue, so they can't interleave with any
// other write on the single-connection SQLite handle). Reads use typed
// delegates wherever the query maps cleanly (`getPack`/`listSkillsForPack`/
// `collectPackPaths` via `findMany`). The `$queryRawUnsafe` escape hatch is
// reserved for the genuinely un-typeable aggregation reads
// (`listPacks`/`listSkills`/`listSkillInvocations`/`listPackUsage`/
// `listPackSessions`): string_agg, COUNT(DISTINCT …), the version CASE, jsonb
// prompt extraction, GROUP BY, and dynamic path-LIKE attribution.
//
// ISS-6753: the four page-facing reads — `listPacks`/`listSkills`/
// `listSkillInvocations`/`listPackSessions` — run on the READER POOL
// ({@link PackReaderPrisma}), not the writer-bound `prisma.client`. Everything
// else here stays on the single writer connection.

/**
 * ISS-6753 — the reader-pool facade the page-facing reads take.
 *
 * Three of them (`listSkills`/`listSkillInvocations`/`listPackSessions`) join
 * the whole `events` table, and the Packs/Skills pages are reachable DURING a
 * first-boot DATA_REVISION rebuild. On `prisma.client` (the PRIMARY writer
 * connection) they would queue on the same per-statement mutex as the rebuild's
 * bulk `$transaction`s and stall both. `prisma.read` dispatches to a
 * `query_only` reader connection that reads a committed WAL snapshot
 * CONCURRENTLY with the writer — the same trade ISS-4710/ISS-4716 already made
 * for the transcript-sync lane (see `transcript-sync-store.ts`), and exactly
 * right here: these are read-only page projections with no read-your-writes
 * requirement.
 *
 * `listPacks` is the inventory aggregate the same surface issues alongside them.
 * It never touches `events`, so it is the cheap one — but it contends for that
 * same writer mutex, and routing it with its siblings puts every one of these
 * aggregation reads on one connection story. `getPack` deliberately stays on
 * `prisma.client`: it is a pair of indexed `findMany`s on the small inventory
 * tables, not an aggregation, and is out of this issue's scope.
 *
 * `DbHostPrisma` deliberately cannot expose `read` (a callback can't cross the
 * db-host proxy), so these are reached from main as {@link PackStoreReadOp}
 * `store:` ops — see `database/db-host/db-host-store-op-registry.ts`.
 */
type PackReaderPrisma = Pick<DesktopPrisma, "read">;

function nowIso(): string {
  return new Date().toISOString();
}

// ────────────────────────────────────────────────────────────────────────────
// Upserts
// ────────────────────────────────────────────────────────────────────────────

/**
 * Upsert one `agent_packs` row keyed on (pack_id, harness, install_path).
 * Updates `last_seen_at` plus the mutable fields (`version`, `source_url`,
 * `install_kind`) but preserves the original `detected_at`.
 */
export async function upsertPack(
  prisma: DesktopPrisma,
  row: {
    pack_id: string;
    harness: string;
    install_path: string;
    install_kind: string;
    source_url?: string | null;
    version?: string | null;
  }
): Promise<void> {
  const ts = nowIso();
  const sourceUrl = row.source_url || null;
  const version = row.version || null;
  await prisma.write((client) =>
    client.agentPack.upsert({
      where: {
        packId_harness_installPath: {
          packId: row.pack_id,
          harness: row.harness,
          installPath: row.install_path,
        },
      },
      create: {
        packId: row.pack_id,
        harness: row.harness,
        installPath: row.install_path,
        installKind: row.install_kind,
        sourceUrl,
        version,
        detectedAt: ts,
        lastSeenAt: ts,
        uninstalledAt: null,
      },
      // Mirror the prior ON CONFLICT: refresh install_kind/last_seen_at, clear
      // the tombstone, preserve detected_at, and set source_url/version only
      // when a non-null value was supplied (the COALESCE(excluded, existing)).
      update: {
        installKind: row.install_kind,
        lastSeenAt: ts,
        uninstalledAt: null,
        ...(sourceUrl === null ? {} : { sourceUrl }),
        ...(version === null ? {} : { version }),
      },
      select: { packId: true, harness: true, installPath: true },
    })
  );
}

/**
 * Upsert one `skills` row keyed on `skill_id`. Callers compute `skill_id`
 * deterministically (e.g. sha256 of harness|install_path|name) so re-scans
 * dedupe to the same row.
 */
export async function upsertSkill(
  prisma: DesktopPrisma,
  row: {
    skill_id: string;
    pack_id?: string | null;
    harness: string;
    install_path: string;
    name: string;
    version?: string | null;
    description?: string | null;
    source_url?: string | null;
  }
): Promise<void> {
  const ts = nowIso();
  const packId = row.pack_id || null;
  const version = row.version || null;
  const description = row.description || null;
  const sourceUrl = row.source_url || null;
  await prisma.write((client) =>
    client.skill.upsert({
      where: { skillId: row.skill_id },
      create: {
        skillId: row.skill_id,
        packId,
        harness: row.harness,
        installPath: row.install_path,
        name: row.name,
        version,
        description,
        sourceUrl,
        detectedAt: ts,
        lastSeenAt: ts,
        uninstalledAt: null,
      },
      // Mirror the prior ON CONFLICT: pack_id is always re-pointed (excluded),
      // last_seen_at refreshed, tombstone cleared; version/description/source_url
      // are COALESCE(excluded, existing) — set only when non-null. harness,
      // install_path, name and detected_at are preserved.
      update: {
        packId,
        lastSeenAt: ts,
        uninstalledAt: null,
        ...(version === null ? {} : { version }),
        ...(description === null ? {} : { description }),
        ...(sourceUrl === null ? {} : { sourceUrl }),
      },
      select: { skillId: true },
    })
  );
}

/**
 * Upsert one `project_pack_associations` row keyed on (project_path, pack_id).
 */
export async function upsertProjectAssociation(
  prisma: DesktopPrisma,
  row: { project_path: string; pack_id: string }
): Promise<void> {
  const ts = nowIso();
  await prisma.write((client) =>
    client.projectPackAssociation.upsert({
      where: {
        projectPath_packId: {
          projectPath: row.project_path,
          packId: row.pack_id,
        },
      },
      create: {
        projectPath: row.project_path,
        packId: row.pack_id,
        detectedAt: ts,
        lastSeenAt: ts,
      },
      // Only last_seen_at is refreshed on conflict; detected_at is preserved.
      update: { lastSeenAt: ts },
      select: { projectPath: true, packId: true },
    })
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Reads
// ────────────────────────────────────────────────────────────────────────────

interface PackListRow extends Record<string, unknown> {
  pack_id: string;
  version: string | null;
  harnesses: string | null;
  install_count: number;
  last_seen_at: string;
  skill_count: number;
}

function splitHarnesses(value: string | null): string[] {
  if (!value) {
    return [];
  }
  return value.split(",").filter(Boolean);
}

function toInstalledPack(row: PackListRow): InstalledPack {
  return {
    packId: row.pack_id,
    harnesses: splitHarnesses(row.harnesses),
    installs: [],
    // COUNT subquery has no  cast → int8 surfaces as bigint through the
    // $queryRawUnsafe adapter path; Number() keeps it IPC/JSON-serializable.
    skillCount: Number(row.skill_count),
    lastSeenAt: row.last_seen_at,
  };
}

// `installs`, `skills`, and `associations` arrive already DTO-shaped from the
// typed Prisma `select`s in getPack/listSkillsForPack, so this only derives the
// roll-ups (distinct harnesses, newest last_seen_at, skill count).
function toInstalledPackDetail(
  packId: string,
  installs: InstalledPack["installs"],
  skills: InstalledPackDetail["skills"],
  associations: InstalledPackDetail["associations"]
): InstalledPackDetail {
  // ISS-11317 (review): ranked by INSTANT, not by bytes. This is the detail half of
  // the roll-up `listPacks` does in SQL, over the same TEXT column, so it goes through
  // the JS mirror of that statement's fold — otherwise one pack reports a different
  // "last seen" in the detail IPC than in the list.
  const lastSeenAt = allOrNothingLatestByInstant(
    installs.map((install) => install.lastSeenAt)
  );

  return {
    packId,
    harnesses: [...new Set(installs.map((install) => install.harness))],
    installs,
    skillCount: skills.length,
    lastSeenAt,
    skills,
    associations,
  };
}

function toSkillWithInvocations(
  row: SkillWithInvocationsRow
): SkillWithInvocations {
  return {
    skillId: row.skill_id,
    packId: row.pack_id,
    name: row.name,
    harness: row.harness,
    description: row.description,
    invocationCount: Number(row.invocation_count),
    lastUsedAt: row.last_invoked_at,
  };
}

function toSkillInvocation(row: SkillInvocationRow): SkillInvocation {
  return {
    eventId: row.event_id,
    sessionId: row.session_id,
    sessionName: row.session_name,
    harness: row.session_harness,
    model: row.session_model,
    createdAt: row.created_at,
  };
}

/**
 * List all packs, collapsed to one row per `pack_id` (the user-facing handle).
 * Includes harness fan-out and skill count.
 *
 * Installed-inventory reads filter uninstalled_at IS NULL so tombstoned
 * rows (kept for retroactive usage attribution) do NOT surface as
 * currently-installed. Re-installing a tombstoned pack clears
 * uninstalled_at in the upsert path.
 *
 * version is NULL when the pack has multiple distinct install versions
 * (e.g. a marketplace pack with several plugins at different versions) --
 * avoids picking one arbitrary value and presenting it as authoritative.
 *
 * ISS-11317: `MAX(last_seen_at)` now ranks the canonical key, because
 * `agent_packs.last_seen_at` is TEXT outside the FEA-3743 heal's `HEALED_COLUMNS`
 * and byte order is time order only at a fixed width — a whole-second `...:00Z`
 * beat a `...:00.500Z` sibling while being the earlier instant, so the pack's
 * "last seen" could name the wrong install. The statement also carried a
 * `MIN(detected_at) AS first_detected_at` that `toInstalledPack` never read (and
 * `InstalledPack` has no field for), so that one was deleted rather than ranked.
 */
export async function listPacks(
  prisma: PackReaderPrisma
): Promise<InstalledPack[]> {
  const rows = await prisma.read((reader) =>
    reader.$queryRawUnsafe<PackListRow[]>(
      `SELECT
       p.pack_id,
       CASE
         WHEN COUNT(DISTINCT COALESCE(p.version, '')) > 1 THEN NULL
         ELSE MAX(p.version)
       END                                                AS version,
       group_concat(DISTINCT p.harness)                   AS harnesses,
       COUNT(DISTINCT p.harness || '|' || p.install_path) AS install_count,
       MAX(p.last_seen_sort)                              AS last_seen_at,
       (SELECT COUNT(*)
        FROM skills s
        WHERE s.pack_id = p.pack_id
          AND s.uninstalled_at IS NULL)                   AS skill_count
     FROM (
       SELECT pack_id, harness, install_path, version,
         ${allOrNothingCanonicalSortSql("canonical_last_seen_at", "last_seen_at", "PARTITION BY pack_id")} AS last_seen_sort
       FROM (
         SELECT pack_id, harness, install_path, version, last_seen_at,
           ${canonicalRankingKeySql("last_seen_at")} AS canonical_last_seen_at
         FROM agent_packs
         WHERE uninstalled_at IS NULL
       )
     ) p
     GROUP BY p.pack_id
     ORDER BY p.pack_id ASC`
    )
  );
  return rows.map(toInstalledPack);
}

// SkillRow is the raw row shape for the aggregation read `listSkills` (extended
// by SkillWithInvocationsRow). getPack/listSkillsForPack now return typed Prisma
// rows, so the install/association raw-row shapes were removed.
interface SkillRow extends Record<string, unknown> {
  skill_id: string;
  pack_id: string | null;
  harness: string;
  install_path: string;
  name: string;
  version: string | null;
  description: string | null;
  source_url: string | null;
  detected_at: string;
  last_seen_at: string;
}

/**
 * Get one pack by `pack_id`, returning installs (one row per harness/install
 * path), skills, and project associations. Tombstoned installs are excluded.
 */
export async function getPack(
  prisma: DbHostPrisma,
  packId: string
): Promise<InstalledPackDetail | null> {
  const installs = await prisma.client.agentPack.findMany({
    where: { packId, uninstalledAt: null },
    select: {
      harness: true,
      installPath: true,
      installKind: true,
      sourceUrl: true,
      version: true,
      detectedAt: true,
      lastSeenAt: true,
    },
    orderBy: [{ harness: "asc" }, { installPath: "asc" }],
  });
  if (installs.length === 0) {
    return null;
  }

  const skills = await listSkillsForPack(prisma, packId);

  const associations = await prisma.client.projectPackAssociation.findMany({
    where: { packId },
    select: { projectPath: true, detectedAt: true, lastSeenAt: true },
    orderBy: { lastSeenAt: "desc" },
  });

  return toInstalledPackDetail(packId, installs, skills, associations);
}

// getPack always passes a concrete packId, so the prior null-safe
// `pack_id IS NOT DISTINCT FROM $1` is a plain equality here.
export function listSkillsForPack(prisma: DbHostPrisma, packId: string) {
  return prisma.client.skill.findMany({
    where: { packId, uninstalledAt: null },
    select: {
      skillId: true,
      name: true,
      version: true,
      description: true,
      harness: true,
    },
    orderBy: [{ name: "asc" }, { harness: "asc" }],
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Skill invocation queries
// ────────────────────────────────────────────────────────────────────────────

// Shared SQL fragment: extract the leading `/<name>` token from a
// UserPromptSubmit event's `data` field (stored as TEXT, cast to jsonb).
//
// NOTE (FEA-3048): this is a legacy prompt-based matcher on the standalone
// Skills page — NOT the Agents-workspace component-usage rollup. The earlier
// comment here wrongly claimed Claude fires "no tool_name='Skill' event" for a
// skill; in fact Claude DOES fire a first-class `Skill` tool call
// (`{"type":"tool_use","name":"Skill","input":{"skill":"<name>"}}`), which the
// Agents-workspace rollup now keys off (see insertSkillUsage in write-core.ts).
// This page still keys off the `/<name>` prompt token because it maps calls
// back to the `skills` inventory table by name; the `Skill`-tool-based path is
// the SoT for the Agents workspace usage counts.
//
// We pull the first whitespace-delimited token after the leading slash.
// Path-like prompts (e.g. "/Users/foo/...") are filtered out by requiring the
// extracted token to contain no slash characters.
//
// PG equivalent of the SQLite `instr / substr / json_extract` pattern:
//   - json_extract(data,'$.prompt') → (data::jsonb->>'prompt')
//   - instr(x, y)                   → position(y in x)
//   - substr(x, a, b)               → substring(x from a for b)
function skillNameFromPromptSql(tableAlias: string): string {
  const prompt = `json_extract(${tableAlias}.data, '$.prompt')`;
  const tail = `substr(${prompt}, 2)`; // strip leading '/'
  return `
  CASE
    WHEN instr(${tail}, ' ') > 0
      THEN substr(${tail}, 1, instr(${tail}, ' ') - 1)
    ELSE ${tail}
  END`;
}

interface SkillWithInvocationsRow extends SkillRow {
  invocation_count: number;
  last_invoked_at: string | null;
}

/**
 * Cross-pack skills aggregate joined against the existing `events` table for
 * invocation counts. Slash-command invocations are recorded by Claude Code's
 * hook pipeline as `events` rows with `event_type='UserPromptSubmit'` and
 * `data.prompt` of the form `/<skill-name> [args...]` -- NOT as
 * `PreToolUse`/`Skill` (those only fire for the tools the skill USES).
 *
 * Aggregation is partitioned by harness (joined from `sessions.harness`) so a
 * pack installed for multiple harnesses (e.g. gstack for Claude AND Codex)
 * reports each install row with its own count rather than attributing every
 * call to every install. `sessions.harness` is the SoT for which harness
 * fired a given hook event -- it has been on the schema since the FEA-1132
 * Codex patch (default 'claude' for legacy rows).
 */
export async function listSkills(
  prisma: PackReaderPrisma
): Promise<SkillWithInvocations[]> {
  const rows = await prisma.read((reader) =>
    reader.$queryRawUnsafe<SkillWithInvocationsRow[]>(
      `SELECT
       s.skill_id,
       s.pack_id,
       s.harness,
       s.install_path,
       s.name,
       s.version,
       s.description,
       s.source_url,
       s.detected_at,
       s.last_seen_at,
       COALESCE(inv.invocation_count, 0) AS invocation_count,
       inv.last_invoked_at                     AS last_invoked_at
     FROM skills s
     LEFT JOIN (
       SELECT skill_name, harness,
         COUNT(*)                                  AS invocation_count,
         MAX(invoked_sort)                         AS last_invoked_at
       FROM (
       SELECT skill_name, harness,
         ${allOrNothingCanonicalSortSql("canonical_created_at", "created_at", "PARTITION BY skill_name, harness")} AS invoked_sort
       FROM (
       SELECT
         ${skillNameFromPromptSql("e")} AS skill_name,
         COALESCE(NULLIF(sess.harness, ''), 'claude')  AS harness,
         e.created_at                                  AS created_at,
         ${canonicalRankingKeySql("e.created_at")}      AS canonical_created_at
       FROM events e
       JOIN sessions sess ON sess.id = e.session_id
       WHERE e.event_type = 'UserPromptSubmit'
         -- FEA-3048 (root cause 4): match "leading slash followed by 1+ chars"
         -- WITHOUT relying on the bare underscore LIKE wildcard (which, with no
         -- ESCAPE clause, silently matches any character). Anchor on the literal
         -- slash and require length > 1 so a bare slash is excluded but the
         -- intent is explicit and escape-safe.
         AND json_extract(e.data, '$.prompt') LIKE '/%'
         AND length(json_extract(e.data, '$.prompt')) > 1
         -- ISS-6752: narrow to the INSTALLED skill-name set BEFORE grouping.
         -- Without this the aggregate built one group per distinct slash
         -- prompt ever typed and the outer LEFT JOIN then discarded every
         -- group matching no install, so the GROUP BY's temp b-tree scaled
         -- with total prompt history instead of with the (small) skills
         -- inventory. Note the planner materializes this IN list ONCE (a
         -- single SCAN of skills plus a bloom filter) rather than probing
         -- idx_skills_name per event row -- the win is the rows kept out of
         -- the grouping, not the lookup. The predicate is a strict subset of
         -- what the outer LEFT JOIN already kept -- including the
         -- uninstalled_at IS NULL tombstone filter the outer WHERE applies --
         -- so the reported counts are unchanged.
         AND ${skillNameFromPromptSql("e")} IN (
           SELECT sk.name
           FROM skills sk
           WHERE sk.name IS NOT NULL
             AND sk.uninstalled_at IS NULL
         )
       )
       )
       GROUP BY skill_name, harness
     ) inv ON inv.skill_name = s.name AND inv.harness = s.harness
     WHERE s.uninstalled_at IS NULL
     ORDER BY (s.pack_id IS NULL) ASC, s.pack_id ASC, s.name ASC, s.harness ASC`
    )
  );
  return rows.map(toSkillWithInvocations);
}

interface SkillInvocationRow extends Record<string, unknown> {
  event_id: string;
  session_id: string;
  created_at: string;
  summary: string | null;
  data: string | null;
  session_name: string | null;
  session_cwd: string | null;
  session_harness: string;
  session_model: string | null;
}

/**
 * Recent invocations for one skill name, joined to `sessions` for session
 * labels, cwd, harness, and model. Pulls from the `events` table only -- no
 * parallel invocation storage exists. Same UserPromptSubmit pattern as
 * listSkills. The optional `harness` filter restricts results to a single
 * install row's calls -- needed so the Skills page detail panel shows only
 * the calls that match the install row the user clicked on.
 */
export async function listSkillInvocations(
  prisma: PackReaderPrisma,
  name: string,
  { limit = 50, offset = 0, harness = null as string | null } = {}
): Promise<SkillInvocation[]> {
  const harnessClause = harness
    ? "AND COALESCE(NULLIF(sess.harness, ''), 'claude') = $2"
    : "";

  const params: unknown[] = [name];
  if (harness) {
    params.push(harness);
  }
  // limit and offset positions depend on whether harness is present
  const limitIdx = params.length + 1;
  const offsetIdx = params.length + 2;
  params.push(limit, offset);

  const prompt = `json_extract(e.data, '$.prompt')`;
  const tail = `substr(${prompt}, 2)`;

  const rows = await prisma.read((reader) =>
    reader.$queryRawUnsafe<SkillInvocationRow[]>(
      `SELECT
       event_id,
       session_id,
       created_at,
       summary,
       data,
       session_name,
       session_cwd,
       session_harness,
       session_model
     FROM (
     SELECT event_id, session_id, created_at, summary, data, session_name,
       session_cwd, session_harness, session_model,
       ${allOrNothingCanonicalSortSql("canonical_created_at", "created_at", "")} AS invoked_sort
     FROM (
     SELECT
       e.id                AS event_id,
       e.session_id        AS session_id,
       e.created_at        AS created_at,
       e.summary           AS summary,
       e.data              AS data,
       sess.name           AS session_name,
       sess.cwd            AS session_cwd,
       COALESCE(NULLIF(sess.harness, ''), 'claude') AS session_harness,
       sess.model          AS session_model,
       ${canonicalRankingKeySql("e.created_at")}    AS canonical_created_at
     FROM events e
     JOIN sessions sess ON sess.id = e.session_id
     WHERE e.event_type = 'UserPromptSubmit'
       -- FEA-3048 (root cause 4): escape-safe "leading slash + 1+ chars" (see
       -- listSkills) instead of the bare underscore LIKE wildcard.
       AND ${prompt} LIKE '/%'
       AND length(${prompt}) > 1
       AND (
         CASE
           WHEN instr(${tail}, ' ') > 0
             THEN substr(${tail}, 1, instr(${tail}, ' ') - 1)
           ELSE ${tail}
         END
       ) = $1
       ${harnessClause}
     )
     )
     ORDER BY invoked_sort DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      ...params
    )
  );
  return rows.map(toSkillInvocation);
}

// ────────────────────────────────────────────────────────────────────────────
// Pack path collection & usage attribution
// ────────────────────────────────────────────────────────────────────────────

/**
 * Collect per-pack detection-path patterns from three sources:
 *   1. `agent_packs.install_path` -- current AND tombstoned installs.
 *   2. `project_pack_associations.project_path` -- per-project installs like
 *      BMad's `_bmad/` directory.
 *   3. `pack_catalog.detection_patterns` (optional) -- seeded fuzzy patterns
 *      for packs invoked via plugins-cache or other path shapes that don't
 *      have a formal install row. Catches packs that were used but never
 *      formally installed in `agent_packs`.
 *
 * Returns Map<pack_id, string[]>.
 */
export async function collectPackPaths(
  prisma: DbHostPrisma
): Promise<Map<string, string[]>> {
  const out = new Map<string, Set<string>>();

  function add(pack_id: string | null, p: unknown): void {
    if (!pack_id || typeof p !== "string" || !p) {
      return;
    }
    if (!out.has(pack_id)) {
      out.set(pack_id, new Set());
    }
    out.get(pack_id)!.add(p);
  }

  // install_path / project_path are non-null PK columns, so the prior
  // `WHERE ... IS NOT NULL` filters are no-ops — the empty-string guard lives
  // in add().
  const installRows = await prisma.client.agentPack.findMany({
    select: { packId: true, installPath: true },
  });
  for (const row of installRows) {
    add(row.packId, row.installPath);
  }

  const assocRows = await prisma.client.projectPackAssociation.findMany({
    select: { packId: true, projectPath: true },
  });
  for (const row of assocRows) {
    add(row.packId, row.projectPath);
  }

  // detection_patterns is on the catalog table -- may not exist in legacy/test
  // environments. try/catch keeps this best-effort. Null patterns fall through
  // the type guards below to `continue`, so no IS NOT NULL filter is needed.
  try {
    const catalogRows = await prisma.client.packCatalog.findMany({
      select: { packId: true, detectionPatterns: true },
    });
    for (const row of catalogRows) {
      // detection_patterns is JSONB in SQLite, so it comes back as a parsed
      // value (array) rather than a string that needs JSON.parse.
      let patterns: unknown[];
      if (Array.isArray(row.detectionPatterns)) {
        patterns = row.detectionPatterns;
      } else if (typeof row.detectionPatterns === "string") {
        try {
          patterns = JSON.parse(row.detectionPatterns);
        } catch {
          continue;
        }
        if (!Array.isArray(patterns)) {
          continue;
        }
      } else {
        continue;
      }
      for (const p of patterns) {
        add(row.packId, p);
      }
    }
  } catch {
    /* pack_catalog table missing -- non-fatal */
  }

  // Convert Set values to arrays so callers can map over them.
  const result = new Map<string, string[]>();
  for (const [k, v] of out) {
    result.set(k, Array.from(v));
  }
  return result;
}

interface PackUsageRow extends Record<string, unknown> {
  pack_id: string;
  tool_calls: number;
  sessions: number;
  first_used_at: string;
  last_used_at: string;
}

/**
 * Retroactive pack-usage attribution from the existing `events` table.
 * See `collectPackPaths()` for which path sources are joined.
 *
 * Returns one row per pack_id with: tool-call count, distinct sessions,
 * first/last used timestamps. Includes tombstoned (uninstalled) packs so they
 * still surface as "previously installed, used N times" on the catalog grid.
 */
export async function listPackUsage(
  prisma: DesktopPrisma
): Promise<PackUsageRow[]> {
  const byPack = await collectPackPaths(prisma);
  if (byPack.size === 0) {
    return [];
  }

  const out: PackUsageRow[] = [];
  for (const [packId, packPaths] of byPack) {
    const likeClauses = packPaths
      .map((_, i) => `e.data LIKE $${i + 1}`)
      .join(" OR ");
    const likeParams = packPaths.map((p) => `%${p}%`);
    const rows = await prisma.client.$queryRawUnsafe<
      {
        tool_calls: number;
        sessions: number;
        first_used_at: string;
        last_used_at: string;
      }[]
    >(
      `SELECT
         COUNT(*)                     AS tool_calls,
         COUNT(DISTINCT session_id)   AS sessions,
         MIN(used_sort)               AS first_used_at,
         MAX(used_sort)               AS last_used_at
       FROM (
         SELECT session_id,
           ${allOrNothingCanonicalSortSql("canonical_created_at", "created_at", "")} AS used_sort
         FROM (
           SELECT e.session_id AS session_id,
             e.created_at AS created_at,
             ${canonicalRankingKeySql("e.created_at")} AS canonical_created_at
           FROM events e
           WHERE ${likeClauses}
         )
       )`,
      ...likeParams
    );
    const row = rows[0] ?? null;
    if (!row) {
      continue;
    }
    //  counts can surface as bigint via the adapter — coerce once so the
    // row is IPC/JSON-serializable and the > 0 guard compares numbers.
    const toolCalls = Number(row.tool_calls);
    if (toolCalls > 0) {
      out.push({
        pack_id: packId,
        tool_calls: toolCalls,
        sessions: Number(row.sessions),
        first_used_at: row.first_used_at,
        last_used_at: row.last_used_at,
      });
    }
  }
  return out;
}

/** One row of {@link listPackSessions}; exported so the main-process IPC handler
 * can type the `store:` op's clone-safe result (ISS-6753). */
export interface PackSessionRow extends Record<string, unknown> {
  session_id: string;
  session_name: string | null;
  session_cwd: string | null;
  session_harness: string;
  session_model: string | null;
  session_started_at: string | null;
  tool_calls: number;
  first_used_at: string;
  last_used_at: string;
}

/**
 * ISS-6751: the inclusive `events.created_at` floor for a `lookbackDays` window.
 *
 * Total over every input, because an Invalid Date's `toISOString()` THROWS and
 * this runs on a live IPC read: a sub-day window clamps up to a day, and one
 * wide enough to push the cutoff past the epoch clamps down to the epoch — a
 * window wider than all of recorded time is still just an unfiltered window.
 *
 * Only `NaN` falls back to the default, deliberately. Rejecting every
 * non-finite value instead would make `Infinity` — the widest way to spell the
 * window — return the 90-day slice, i.e. STRICTLY LESS than the finite and
 * strictly smaller `Number.MAX_SAFE_INTEGER`. The epoch clamp already makes an
 * over-wide window total, so `Infinity` needs no special case; `NaN` is the
 * only input with no width to honour at all.
 */
function eventLookbackCutoff(lookbackDays: number): string {
  const days = Number.isNaN(lookbackDays)
    ? DEFAULT_SESSION_RETENTION_DAYS
    : Math.max(1, Math.round(lookbackDays));
  return new Date(Math.max(0, Date.now() - days * MS_PER_DAY)).toISOString();
}

/**
 * Per-session usage rollup for one pack. Powers the "Used in N sessions"
 * table on the Pack detail page. Each row is one session whose events touched
 * one or more of the pack's detection paths (see `collectPackPaths()`).
 *
 * Sorted by last activity in that session, descending.
 *
 * ISS-6751: bounded to a rolling `lookbackDays` window on `created_at`. The
 * path attribution is a leading-wildcard `data LIKE '%…%'`, which no index can
 * serve, so without a narrowing predicate SQLite read every row's multi-KB
 * `data` blob on every call — inside the heap-capped db-host worker — and the
 * `LIMIT` did not help because it applies AFTER the `GROUP BY`, bounding rows
 * RETURNED, not rows SCANNED. Cost therefore grew with total event volume
 * rather than with the pack's usage. The siblings in this file
 * (`listSkills`/`listSkillInvocations`) are already narrowed by
 * `event_type = 'UserPromptSubmit'`; this read had no narrowing predicate at
 * all.
 *
 * What the window actually buys is that `created_at` is compared BEFORE the
 * blob is touched, so an out-of-window row costs a record header instead of a
 * multi-KB read. Cost then tracks in-window rows rather than the corpus.
 * Measured on a 20k-event fixture with 3KB `data` blobs (median of 9,
 * interleaved, warm): a store that is 95% out-of-window goes 105ms → 6ms, one
 * that is half out-of-window 103ms → 52ms, and one whose events are ALL inside
 * the window 101ms → 104ms. That last case — no rows to skip, so nothing to
 * win and one extra comparison to pay — is the honest worst case, and it is
 * where an install younger than the retention horizon sits.
 *
 * The window defaults to {@link DEFAULT_SESSION_RETENTION_DAYS} because that is
 * the local store's DEFAULT purge horizon, so in the ordinary case scanning
 * further back mostly pays for rows `sweepExpiredSessions` is already entitled
 * to delete.
 *
 * That is a rationale, NOT an equivalence, and the gap it leaves is the real
 * trade this read makes. It is wider than "rows the purge would have taken
 * anyway", in five ways. The purge is anchored on `sessions.last_activity_at`
 * and this window on `events.created_at`, so a long-lived session that is
 * wholly retained still has its OLD events cut. It only ever purges TERMINAL
 * sessions, so a `waiting` or never-finished session is retained indefinitely
 * and simply drops out of this read. `sweepExpiredSessions` takes a
 * caller-supplied `retentionDays` (`SqliteStoreOptions.retentionDays`), which
 * nothing overrides today but which would silently widen the store past this
 * constant. ISS-6031 defers purging a past-window session that still owes the
 * cloud a delivery. And an event whose `created_at` is NULL or not date-shaped
 * fails the guard and the range at EVERY window width, since there is no
 * defensible way to order it.
 *
 * So the row shape is a WINDOWED rollup and not an all-time one — for any
 * session older than the window, `tool_calls` counts only its in-window calls
 * and `first_used_at` is its first IN-WINDOW use, not its true first use. Given
 * the anchor mismatch above that is the ordinary case for a long-lived session,
 * not a boundary curiosity. Nothing renders these yet (the IPC channel has no
 * renderer caller), so no surface currently labels them as totals — but one
 * that does must say which. Removing the trade rather than disclosing it is
 * the per-(pack, session) ingest rollup ISS-6751 names as the alternative,
 * mirroring `agent_component_session_usage`; it needs DDL and is deliberately
 * not in this change. Anchoring the window on `sessions.last_activity_at`
 * instead would preserve whole-session counts, but measured on the 20k-event
 * fixture it is worth nothing (100ms vs 100ms baseline at every mix): the
 * filter sits on the JOINED table, so every event blob is read regardless.
 *
 * `lookbackDays` is the escape hatch for a caller that genuinely needs deeper
 * history, so widening stays explicit rather than being the default.
 *
 * Deliberately NOT pinned with `INDEXED BY idx_events_created_at`. The pin does
 * force a range seek, but measured against the statement this actually emits it
 * is worth nothing (6ms vs 6ms, 92ms vs 93ms) — the saving is the skipped blob
 * read, which the predicate already gets — while making the read raise outright
 * if that index is ever dropped.
 */
export async function listPackSessions(
  prisma: PackReaderPrisma,
  packId: string,
  { limit = 25, offset = 0, lookbackDays = DEFAULT_SESSION_RETENTION_DAYS } = {}
): Promise<PackSessionRow[]> {
  const rows = await prisma.read(async (reader) => {
    // ISS-6753: the path collection runs on the SAME pooled reader as the scan
    // below rather than on `prisma.client`, so no part of this read touches the
    // writer connection. Deliberately NOT a read `$transaction`: the two halves
    // need no shared snapshot (a pack installed between them is simply
    // unattributed until the next load, exactly as the pre-ISS-6753 pair of
    // writer statements already allowed), and pinning one of the two reader
    // connections inside BEGIN..COMMIT for the whole unindexed `events` scan
    // would cost real capacity — plus put this scan under the client's
    // interactive-transaction deadline — to buy nothing.
    const byPack = await collectPackPaths({ client: reader });
    const packPaths = byPack.get(packId);
    if (!packPaths || packPaths.length === 0) {
      return [];
    }

    const likeClauses = packPaths
      .map((_, i) => `e.data LIKE $${i + 1}`)
      .join(" OR ");
    const likeParams: unknown[] = packPaths.map((p) => `%${p}%`);

    const cutoffIdx = likeParams.length + 1;
    likeParams.push(eventLookbackCutoff(lookbackDays));
    const limitIdx = likeParams.length + 1;
    const offsetIdx = likeParams.length + 2;
    likeParams.push(limit, offset);

    return await reader.$queryRawUnsafe<PackSessionRow[]>(
      `SELECT
       session_id,
       session_name,
       session_cwd,
       session_harness,
       session_model,
       session_started_at,
       COUNT(*)                                     AS tool_calls,
       MIN(used_sort)                               AS first_used_at,
       MAX(used_sort)                               AS last_used_at
     FROM (
     SELECT session_id, session_name, session_cwd, session_harness,
       session_model, session_started_at,
       ${allOrNothingCanonicalSortSql("canonical_created_at", "created_at", "")} AS used_sort
     FROM (
     SELECT
       e.session_id                                 AS session_id,
       sess.name                                    AS session_name,
       sess.cwd                                     AS session_cwd,
       COALESCE(NULLIF(sess.harness, ''), 'claude') AS session_harness,
       sess.model                                   AS session_model,
       sess.started_at                              AS session_started_at,
       e.created_at                                 AS created_at,
       ${canonicalRankingKeySql("e.created_at")}     AS canonical_created_at
     FROM events e
     JOIN sessions sess ON sess.id = e.session_id
     -- The guard is not decoration: created_at is TEXT compared byte-wise and is
     -- NOT one of the columns the timestamp-format heal normalizes, and a value
     -- that is not date-shaped outranges every ISO string — so the bare range
     -- below would ADMIT precisely the rows it cannot order.
     -- The OR-chain MUST stay parenthesized: AND binds tighter than OR, so
     -- without the parens the window would attach to the FIRST LIKE only and
     -- every other detection path would go straight back to a full scan.
     WHERE e.created_at GLOB ${ISO_DATE_PREFIX_GLOB_SQL}
       AND e.created_at >= $${cutoffIdx}
       AND (${likeClauses})
     )
     )
     GROUP BY session_id, session_name, session_cwd, session_harness, session_model, session_started_at
     ORDER BY MAX(used_sort) DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      ...likeParams
    );
  });
  //  tool_calls can surface as bigint via the adapter — coerce for IPC.
  return rows.map((row) => ({ ...row, tool_calls: Number(row.tool_calls) }));
}

/**
 * ISS-6753 — the `store:` op names the four {@link PackReaderPrisma} reads are
 * reached by from the main process.
 *
 * Declared here, next to the functions they name, so the string is written once
 * rather than at both ends of the IPC: the db-host registry keys its handlers
 * off these values and the `desktop:db:*` handlers invoke them by the same
 * reference, so a rename is a compile error instead of a runtime
 * `db-host store op not found`.
 */
export const PackStoreReadOp = {
  ListPacks: "packStore.listPacks",
  ListSkills: "packStore.listSkills",
  ListSkillInvocations: "packStore.listSkillInvocations",
  ListPackSessions: "packStore.listPackSessions",
} as const;
export type PackStoreReadOp =
  (typeof PackStoreReadOp)[keyof typeof PackStoreReadOp];

/**
 * What each {@link PackStoreReadOp} resolves to once it has crossed the db-host
 * boundary.
 *
 * The op name alone only guarantees that SOME handler answers; it says nothing
 * about the shape that comes back, and `InvokeStoreOp` is typed
 * `Promise<unknown>`. This map is the missing half, and it is enforced at BOTH
 * ends: the db-host registry declares its handler table `satisfies` a mapped
 * type built from this, so an op wired to the wrong store function fails to
 * compile, and the main-process handlers annotate their return type from it, so
 * a channel wired to the wrong op fails to compile too.
 */
export type PackStoreReadResult = {
  [PackStoreReadOp.ListPacks]: InstalledPack[];
  [PackStoreReadOp.ListSkills]: SkillWithInvocations[];
  [PackStoreReadOp.ListSkillInvocations]: SkillInvocation[];
  [PackStoreReadOp.ListPackSessions]: PackSessionRow[];
};
