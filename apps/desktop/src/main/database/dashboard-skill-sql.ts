import {
  allOrNothingCanonicalSortSql,
  canonicalRankingKeySql,
} from "./session-timestamp-form.js";

/**
 * ISS-4854 / ISS-5629: the SQLite read behind `getSkills`, extracted from
 * `dashboard-queries.ts` so the skills
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
  /**
   * The query's single `MAX` aggregate. No summary field maps from it, but it
   * MUST stay in the SELECT list: dropping it leaves the query with no min/max
   * aggregate at all, so the bare-column rule below stops applying and
   * `last_used_at` silently rebinds to the inner column of the same name.
   */
  last_used_sort: string | null;
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
 * `last_used_at`/`description`/`install_path` are BARE columns beside the single
 * `MAX` aggregate, which SQLite documents as taking their values from the row
 * that produced the max.
 *
 * ISS-6414: what that max ranks is `last_used_sort`, not the raw
 * `created_at` bytes. `events.created_at` holds raw harness text and is
 * deliberately outside the FEA-3743 heal's `HEALED_COLUMNS`
 * (timestamp-format-maintenance.ts), so the column carries mixed forms
 * indefinitely — and byte order is only time order at a FIXED width. A
 * whole-second stamp beats a sub-second one at the same instant (`Z` 0x5A sorts
 * after `.` 0x2E), so the ISS-5629 byte-wise max returned the EARLIER event,
 * regressing the `maxIso`/`Date.parse` fold it replaced. It handed the
 * descriptive columns to that same earlier row, which the pre-ISS-5629 fold also
 * got wrong (it took them from the first row of a byte-wise
 * `ORDER BY created_at DESC`), so those are corrected here for the first time.
 *
 * TWO MODES, never mixed — ISS-5497's rule, and it is load-bearing rather than
 * conservative. Both ways of half-applying it move a value BACKWARD past where
 * `main` puts it, on shapes ISS-5497 measured in the real store:
 *
 *  - MIXING a canonical operand with a raw one. Canonicalizing LOWERS a value's
 *    text whenever it applies a positive offset, so a canonicalized true winner
 *    can sort below an un-canonicalizable sibling — `2026-06-22T23:00:00+05:00`
 *    (18:00Z) and `2026-06-22T21:00:00.000+0530` (15:30Z, which SQLite cannot
 *    parse) fold to 18:00Z today and to 15:30Z when only the first is rewritten.
 *  - DROPPING the un-canonicalizable operand, which is the same defect from the
 *    other side: the row it drops is exactly the one that could have won.
 *    `2026-06-25T10:00:00.000+0530` beside `2026-06-22T10:00:00.000Z` folds to
 *    the June 25 row today, and to June 22 — three days back, with a stale
 *    description — once the June 25 row is skipped for being unreadable.
 *
 * So `last_used_sort` is canonical for every row in the group or raw for every
 * row in it: `canonicalRankingKeySql` (session-timestamp-form.ts, the SSOT for
 * what a stored timestamp's text form means) yields NULL for a shape it
 * declines, the window `COUNT` compares that against the non-NULL `created_at`
 * count, and a single dissenter drops the whole group back to the pre-ISS-6414
 * expression verbatim — which cannot regress anything, because it is what
 * shipped. The guarantee is: a group whose every event canonicalizes gets an
 * exact instant comparison; any other group behaves EXACTLY as it did before.
 *
 * Consuming that SSOT rather than a bare `unixepoch` keeps the ACCEPTED SET in
 * step with the `Date.parse` this read's own consumer re-sorts on
 * (`compareLastUsedThenName`): SQLite alone would accept an hour of `24` that
 * `Date.parse` reads as NaN, and would hand the renderer a `lastUsedAt` it
 * cannot render. ISS-6815 (review) closed the same hole from the other side: the
 * canonical GLOB is a SHAPE test, so `canonicalRankingKeySql` adds the VALUE
 * check that keeps an impossible instant like month 13 from passing through as
 * canonical and winning the fold on its bytes. Only the accepted set — the two readers still disagree on the
 * INSTANT of a zone-less `T`-form, which the SSOT reads as UTC (ISS-5496) and
 * `Date.parse` reads as host-local. That round trip is `main`'s too.
 *
 * The trailing ORDER BY is NOT redundant with the caller's
 * `compareLastUsedThenName` sort: that comparator returns 0 for two rows
 * sharing a `lastUsedAt` AND a `name` (the same skill under two harnesses), and
 * `Array.prototype.sort` is stable, so input order decides the tie. Without
 * this clause the tie would fall to SQLite's unordered GROUP BY output and the
 * dashboard could reorder between reads of an unchanged corpus.
 *
 * Canonicalizing WIDENS that tie class rather than narrowing it: two spellings
 * of one instant used to sort apart on their raw bytes and now collapse to the
 * same key, so a same-instant/same-name pair is a full tie here and the row
 * order — like the bare columns inside a same-instant group — falls to the query
 * plan. Which of two events recorded at the same instant supplies the
 * description is arbitrary in the domain, so this is accepted, not resolved.
 */
export const SKILL_SUMMARY_SQL = `
  SELECT
    name,
    harness,
    description,
    install_path,
    COUNT(*) AS invocation_count,
    created_at AS last_used_at,
    MAX(last_used_sort) AS last_used_sort
  FROM (
    SELECT
      name,
      harness,
      description,
      install_path,
      created_at,
      ${allOrNothingCanonicalSortSql("canonical_created_at", "created_at", "PARTITION BY harness, name")} AS last_used_sort
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
        e.created_at AS created_at,
        ${canonicalRankingKeySql("e.created_at")} AS canonical_created_at
      FROM events e
      LEFT JOIN sessions s ON s.id = e.session_id
      WHERE e.tool_name = 'Skill'
    )
    WHERE name IS NOT NULL
  )
  GROUP BY harness, name
  ORDER BY last_used_sort DESC, name ASC
`;
