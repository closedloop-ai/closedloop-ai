/**
 * ISS-4854 / ISS-5629: the SQLite read behind `getSkills`, extracted from
 * `dashboard-queries.ts` (a grandfathered over-ceiling file) so the skills
 * aggregate can grow without growing it. The consumer keeps only the JS map
 * from a row to a `DashboardSkillSummary`.
 */

/**
 * ISS-4854: guarded SQL extraction of one TEXT field from a Skill event's
 * `data` JSON blob. `json_valid` short-circuits before any `json_type`/
 * `json_extract` touches the blob (the same guard order
 * `buildListCursorFilterClause` relies on), and the `= 'text'` type gate makes
 * a non-string field extract NULL — mirroring how `parseJsonObjectText` +
 * `nonEmptyString` classified an object/array/number field as "no value".
 * `field` is a compile-time literal below, never caller input.
 */
function skillDataTextExpr(field: string): string {
  return (
    "CASE WHEN e.data IS NOT NULL AND json_valid(e.data)" +
    ` AND json_type(e.data) = 'object'` +
    ` AND json_type(e.data, '$.${field}') = 'text'` +
    ` THEN json_extract(e.data, '$.${field}') END`
  );
}

/**
 * ISS-5629: every code point `String.prototype.trim` strips — the ECMAScript
 * `WhiteSpace` production (tab/VT/FF/space/NBSP/BOM plus the Unicode Zs set:
 * OGHAM SPACE MARK, EN QUAD…HAIR SPACE, NARROW NO-BREAK SPACE, MEDIUM
 * MATHEMATICAL SPACE, IDEOGRAPHIC SPACE) and `LineTerminator` (LF/CR/LS/PS).
 * Spelled as code points because a literal control character in the SQL string
 * would be invisible in review. Must stay in lockstep with JS `trim()`: the
 * golden layer-3 twin (`test/golden/golden-layer3-derive.ts`) re-derives skill
 * ids with the JS spelling, so a code point missing here would split one group
 * in two and blame production.
 */
const TRIM_WHITESPACE_CHARS =
  "char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196," +
  " 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279)";

/**
 * ISS-5629: the SQL twin of `nonEmptyString` (`db-helpers.ts`) — trim, then
 * fold an empty result to NULL so a whitespace-only value falls THROUGH a
 * COALESCE chain instead of winning it, and so a grouped value carries the same
 * trimmed text the JS fold stored. SQLite's bare `TRIM` strips spaces only,
 * hence the explicit charset.
 */
function sqlNonEmptyText(expr: string): string {
  return `NULLIF(TRIM(${expr}, ${TRIM_WHITESPACE_CHARS}), '')`;
}

/**
 * ISS-4854 / ISS-5629: one SQL-aggregated skill — the resolved identity plus
 * the rollup `getSkills` maps straight onto a `DashboardSkillSummary`.
 */
export type SqliteSkillRow = {
  name: string;
  harness: string;
  description: string | null;
  install_path: string | null;
  invocation_count: number | bigint;
  last_used_at: string | null;
};

/**
 * ISS-4854 / ISS-5629: the skill fields are extracted AND the per-skill fold is
 * aggregated in SQL, so the read ships ONE row per (harness, skill name)
 * instead of the whole Skill-event corpus — `COUNT(*)` / `MAX(created_at)` /
 * `GROUP BY`, the shape `getTools` and `getSubAgents` already use, per the
 * FEA-2038 analytics invariant (never hydrate the corpus into the heap-capped
 * db-host).
 *
 * The inner select classifies each event exactly as the former JS fold did:
 * `skillDataTextExpr`'s `json_valid`/`json_type = 'text'` guards degrade a
 * malformed blob or non-string field to NULL, and `sqlNonEmptyText` trims and
 * folds a whitespace-only value to NULL so it falls THROUGH the COALESCE
 * instead of winning it. The Event model has no Prisma relation to Session
 * (events can predate their session row), so the harness is a LEFT JOIN whose
 * NULL becomes 'unknown'.
 *
 * Grouping on (harness, name) is equivalent to the old JS Map keyed by
 * `${harness}:${packId ?? "standalone"}:${name}`: `packIdFromSkillName` is a
 * pure function of `name` (its prefix before the first `/` or `:`), so that key
 * is injective in the pair and is still derived in JS by the caller.
 * `description`/`install_path` are BARE columns beside the single
 * `MAX(created_at)`, which SQLite documents as taking their values from the row
 * that produced the max — the newest event, i.e. the first row the former
 * `ORDER BY created_at DESC` fold saw and kept.
 *
 * The trailing ORDER BY is NOT redundant with the caller's
 * `compareLastUsedThenName` sort: that comparator returns 0 for two rows
 * sharing a `lastUsedAt` AND a `name` (the same skill under two harnesses), and
 * `Array.prototype.sort` is stable, so input order decides the tie. Without
 * this clause the tie would fall to SQLite's unordered GROUP BY output and the
 * dashboard could reorder between reads of an unchanged corpus.
 */
export const SKILL_SUMMARY_SQL = `
  SELECT
    name,
    harness,
    description,
    install_path,
    COUNT(*) AS invocation_count,
    MAX(created_at) AS last_used_at
  FROM (
    SELECT
      COALESCE(
        ${sqlNonEmptyText(skillDataTextExpr("skillName"))},
        ${sqlNonEmptyText(skillDataTextExpr("skill"))},
        ${sqlNonEmptyText(skillDataTextExpr("name"))},
        ${sqlNonEmptyText("e.summary")}
      ) AS name,
      COALESCE(${sqlNonEmptyText("s.harness")}, 'unknown') AS harness,
      ${sqlNonEmptyText(skillDataTextExpr("description"))} AS description,
      COALESCE(
        ${sqlNonEmptyText(skillDataTextExpr("installPath"))},
        ${sqlNonEmptyText(skillDataTextExpr("path"))}
      ) AS install_path,
      e.created_at AS created_at
    FROM events e
    LEFT JOIN sessions s ON s.id = e.session_id
    WHERE e.tool_name = 'Skill'
  )
  WHERE name IS NOT NULL
  GROUP BY harness, name
  ORDER BY last_used_at DESC, name ASC
`;
