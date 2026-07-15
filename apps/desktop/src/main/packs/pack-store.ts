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
import type { DbHostPrisma, DesktopPrisma } from "../database/prisma-client.js";

// Every pack-store function — reads AND writes — runs on the single
// DesktopPrisma client. Writes (upserts) use the typed delegates
// (`agentPack`/`skill`/`projectPackAssociation` `.upsert`) through
// `prisma.write` (the shared write queue, so they can't interleave with any
// other write on the single-connection SQLite handle). Reads use typed
// delegates wherever the query maps cleanly (`getPack`/`listSkillsForPack`/
// `collectPackPaths` via `findMany`). The `prisma.client.$queryRawUnsafe`
// escape hatch is reserved for the genuinely un-typeable aggregation reads
// (`listPacks`/`listSkills`/`listSkillInvocations`/`listPackUsage`/
// `listPackSessions`): string_agg, COUNT(DISTINCT …), the version CASE, jsonb
// prompt extraction, GROUP BY, and dynamic path-LIKE attribution.

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
  first_detected_at: string;
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
  const sortedLastSeenTimes = installs
    .map((install) => install.lastSeenAt)
    .filter((value): value is string => typeof value === "string")
    .sort();
  const lastSeenAt =
    sortedLastSeenTimes.length > 0 ? sortedLastSeenTimes.at(-1)! : null;

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
 */
export async function listPacks(
  prisma: DbHostPrisma
): Promise<InstalledPack[]> {
  const rows = await prisma.client.$queryRawUnsafe<PackListRow[]>(
    `SELECT
       p.pack_id,
       CASE
         WHEN COUNT(DISTINCT COALESCE(p.version, '')) > 1 THEN NULL
         ELSE MAX(p.version)
       END                                                AS version,
       group_concat(DISTINCT p.harness)                   AS harnesses,
       COUNT(DISTINCT p.harness || '|' || p.install_path) AS install_count,
       MIN(p.detected_at)                                 AS first_detected_at,
       MAX(p.last_seen_at)                                AS last_seen_at,
       (SELECT COUNT(*)
        FROM skills s
        WHERE s.pack_id = p.pack_id
          AND s.uninstalled_at IS NULL)                   AS skill_count
     FROM agent_packs p
     WHERE p.uninstalled_at IS NULL
     GROUP BY p.pack_id
     ORDER BY p.pack_id ASC`
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
  prisma: DbHostPrisma
): Promise<SkillWithInvocations[]> {
  const rows = await prisma.client.$queryRawUnsafe<SkillWithInvocationsRow[]>(
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
       SELECT
         ${skillNameFromPromptSql("e")} AS skill_name,
         COALESCE(NULLIF(sess.harness, ''), 'claude')  AS harness,
         COUNT(*)                                  AS invocation_count,
         MAX(e.created_at)                              AS last_invoked_at
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
       GROUP BY skill_name, harness
     ) inv ON inv.skill_name = s.name AND inv.harness = s.harness
     WHERE s.uninstalled_at IS NULL
     ORDER BY (s.pack_id IS NULL) ASC, s.pack_id ASC, s.name ASC, s.harness ASC`
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
  prisma: DbHostPrisma,
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

  const rows = await prisma.client.$queryRawUnsafe<SkillInvocationRow[]>(
    `SELECT
       e.id                AS event_id,
       e.session_id,
       e.created_at,
       e.summary,
       e.data,
       sess.name           AS session_name,
       sess.cwd            AS session_cwd,
       COALESCE(NULLIF(sess.harness, ''), 'claude') AS session_harness,
       sess.model          AS session_model
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
     ORDER BY e.created_at DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    ...params
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
         COUNT(*)                   AS tool_calls,
         COUNT(DISTINCT e.session_id) AS sessions,
         MIN(e.created_at)               AS first_used_at,
         MAX(e.created_at)               AS last_used_at
       FROM events e
       WHERE ${likeClauses}`,
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

interface PackSessionRow extends Record<string, unknown> {
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
 * Per-session usage rollup for one pack. Powers the "Used in N sessions"
 * table on the Pack detail page. Each row is one session whose events touched
 * one or more of the pack's detection paths (see `collectPackPaths()`).
 *
 * Sorted by last activity in that session, descending.
 */
export async function listPackSessions(
  prisma: DbHostPrisma,
  packId: string,
  { limit = 25, offset = 0 } = {}
): Promise<PackSessionRow[]> {
  const byPack = await collectPackPaths(prisma);
  const packPaths = byPack.get(packId);
  if (!packPaths || packPaths.length === 0) {
    return [];
  }

  const likeClauses = packPaths
    .map((_, i) => `e.data LIKE $${i + 1}`)
    .join(" OR ");
  const likeParams: unknown[] = packPaths.map((p) => `%${p}%`);

  const limitIdx = likeParams.length + 1;
  const offsetIdx = likeParams.length + 2;
  likeParams.push(limit, offset);

  const rows = await prisma.client.$queryRawUnsafe<PackSessionRow[]>(
    `SELECT
       e.session_id,
       sess.name                                    AS session_name,
       sess.cwd                                     AS session_cwd,
       COALESCE(NULLIF(sess.harness, ''), 'claude') AS session_harness,
       sess.model                                   AS session_model,
       sess.started_at                              AS session_started_at,
       COUNT(*)                                AS tool_calls,
       MIN(e.created_at)                            AS first_used_at,
       MAX(e.created_at)                            AS last_used_at
     FROM events e
     JOIN sessions sess ON sess.id = e.session_id
     WHERE ${likeClauses}
     GROUP BY e.session_id, sess.name, sess.cwd, sess.harness, sess.model, sess.started_at
     ORDER BY last_used_at DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    ...likeParams
  );
  //  tool_calls can surface as bigint via the adapter — coerce for IPC.
  return rows.map((row) => ({ ...row, tool_calls: Number(row.tool_calls) }));
}
