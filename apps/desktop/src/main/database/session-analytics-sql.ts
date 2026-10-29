/**
 * @file session-analytics-sql.ts
 * @description SQL fragment builders shared by the session-analytics rollup and
 * its maintenance/heal passes.
 *
 * Extracted from `write-core.ts` (ISS-4592) so that file shrinks rather than
 * grows. Both builders are pure string construction over
 * code constants and were already imported by
 * `session-analytics-maintenance.ts`, so they belong beside their consumers
 * rather than inside the importer.
 */
import {
  HEADLESS_ENTRYPOINT_PREFIXES,
  HEADLESS_ENTRYPOINT_TOKENS,
  HEADLESS_PERMISSION_MODES,
} from "@repo/lib/session-trace/headless";

/**
 * FEA-2870 / FEA-3616: SQL predicate that matches a headless/autonomous session
 * by the calling params persisted in its `metadata` JSON blob. Uses
 * `json_extract` to read the TOP-LEVEL `entrypoint`/`permissionMode` fields — the
 * match is scoped to those extracted scalars, never a LIKE over the whole blob,
 * so a nested occurrence (e.g. a `"permissionMode":"bypassPermissions"` string
 * buried in `usageExtras`, `compactions`, or `messages`) can never misclassify a
 * human session as headless.
 *
 * `permissionMode` is an exact-match automation flag. `entrypoint` is matched by
 * the SDK/exec family — a `sdk-…` PREFIX (Claude's `sdk-ts` / `sdk-cli`) or an
 * `exec` TOKEN (Codex's `codex_exec` / `claude-codex-exec`) — via a
 * case-insensitive LIKE on the extracted field, mirroring `isHeadlessEntrypoint`.
 * This covers the whole autonomous family, not just the single legacy `"sdk-ts"`
 * spelling the old exact allow-list matched (FEA-3616), while deliberately NOT
 * sweeping in the interactive `codex_sdk_ts` VS Code IDE transport (it carries
 * `sdk` but is not `sdk-`-prefixed, and its prompts are genuine human turns per
 * the golden oracle). Built from the shared SSOT constants
 * (`HEADLESS_ENTRYPOINT_PREFIXES`/`HEADLESS_ENTRYPOINT_TOKENS`/
 * `HEADLESS_PERMISSION_MODES` — code constants, never user input) so this SQL,
 * `isHeadlessSession`, and the per-turn bucket derivation never drift. `col` is
 * the metadata column expression (e.g. `s.metadata`).
 */
export function headlessMetadataSql(col: string): string {
  // Escape single-quoted string literals for SQLite: replace ' with ''.
  const sqlLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const inList = (values: readonly string[]) =>
    values.map(sqlLiteral).join(", ");
  // Case-insensitive LIKE on the EXTRACTED entrypoint scalar only (SQLite LIKE is
  // case-insensitive for ASCII; a nested blob occurrence can never match because
  // the match is scoped to the json_extract'd field). Prefixes anchor with a
  // trailing `%`; tokens wrap with `%…%`. Values are code constants.
  const entrypointPrefixLike = HEADLESS_ENTRYPOINT_PREFIXES.map(
    (prefix) =>
      `lower(json_extract(${col}, '$.entrypoint')) LIKE ${sqlLiteral(`${prefix.toLowerCase()}%`)}`
  );
  const entrypointTokenLike = HEADLESS_ENTRYPOINT_TOKENS.map(
    (token) =>
      `lower(json_extract(${col}, '$.entrypoint')) LIKE ${sqlLiteral(`%${token.toLowerCase()}%`)}`
  );
  const conditions = [
    ...entrypointPrefixLike,
    ...entrypointTokenLike,
    `json_extract(${col}, '$.permissionMode') IN (${inList(HEADLESS_PERMISSION_MODES)})`,
  ];
  return `(${conditions.join(" OR ")})`;
}

/**
 * FEA-3226: SQL expression for the transcript-first assistant-turn count — the
 * importer's top-level `$.assistantMessages` metadata field (the parser's
 * billable round-trip count), or NULL when the blob lacks a numeric field
 * (hook-only live sessions, which never get an import metadata blob). Nested
 * CASE so json_type never runs on invalid JSON (same guard as the
 * transcript_human_turns expression). Shared between the rollup SQL and the
 * one-time boot heal pass (`recomputeImportedAgentTurnAnalytics`) so the two
 * can never drift. `col` is the metadata column expression (e.g. `s.metadata`).
 */
export function transcriptAssistantTurnsSql(col: string): string {
  return `CASE WHEN json_valid(${col})
              THEN CASE WHEN ${validCountPredicateSql(col, "$.assistantMessages")}
                        THEN json_extract(${col}, '$.assistantMessages')
                        ELSE NULL END
              ELSE NULL END`;
}

/**
 * ISS-8659: SQL expression for the transcript-first HUMAN-turn count. Prefers
 * the importer's top-level `$.userMessages` scalar — the parser's own count —
 * and only falls back to counting `role:"human"` rows in `$.messages` when the
 * blob predates that field.
 *
 * The order matters, and it is the same lesson `transcriptAssistantTurnsSql`
 * above already learned: `$.messages` is the RENDERED conversation, not a
 * tally, so anything the parser deliberately keeps in the transcript but
 * excludes from its counts makes the two disagree. A Claude `/fork` child is
 * exactly that shape — the parent's replayed messages stay in `$.messages`
 * because the inherited conversation is a real capability, while `userMessages`
 * counts only the fork's own. Counting the array attributed the parent's
 * prompts to the child a second time and, above the threshold, could flip its
 * `is_human` classification.
 *
 * Nested CASE so json_type never runs on invalid JSON. `col` is the metadata
 * column expression (e.g. `s.metadata`).
 */
export function transcriptHumanTurnsSql(col: string): string {
  return `CASE WHEN json_valid(${col})
              THEN CASE WHEN ${validCountPredicateSql(col, "$.userMessages")}
                        THEN json_extract(${col}, '$.userMessages')
                        WHEN json_type(${col}, '$.messages') = 'array'
                        THEN (SELECT COUNT(*)
                              FROM json_each(${col}, '$.messages') AS m
                              WHERE CASE WHEN m.type = 'object'
                                         THEN json_extract(m.value, '$.role') = 'human'
                                              AND json_type(m.value, '$.isForkReplayed') IS NOT 'true'
                                         ELSE 0 END)
                        ELSE NULL END
              ELSE NULL END`;
}

/**
 * The largest count these expressions will accept as measured rather than
 * corrupt. Deliberately the safe-integer ceiling and not a product limit: past
 * it an integer is no longer exactly representable, so the stored number cannot
 * be trusted to be the one that was written. Anything below it is somebody
 * else's judgment call, and inventing one here would silently reject a real
 * outlier.
 */
const MAX_MEASURED_COUNT = Number.MAX_SAFE_INTEGER;

/**
 * ISS-8659: a persisted count is valid or absent, never partially believed.
 *
 * These fields are the AUTHORITATIVE source for their metric — a value that
 * passes here wins over the `$.messages` fallback and lands in `human_turns` /
 * `assistant_turns` as a measured figure. So the predicate has to cover the
 * whole impossible set, not the half that is easy to picture. `json_type(...)
 * IN ('integer','real')` covered neither: `real` admits a fractional `1.5`
 * turns, and NEITHER type check has a sign, so `-3` turns was equally welcome.
 * Both render downstream as a confident measurement, which is worse than the
 * NULL that says "not known" and lets the caller fall back.
 *
 * `BETWEEN` is inclusive, and `json_extract` on an integer-typed path yields an
 * INTEGER, so no cast is needed to compare it.
 */
function validCountPredicateSql(col: string, path: string): string {
  return `json_type(${col}, '${path}') = 'integer'
                   AND json_extract(${col}, '${path}') BETWEEN 0 AND ${MAX_MEASURED_COUNT}`;
}

export // FEA-2038: the error/fail predicate over an event's `event_type`, mirroring
// `ERROR_EVENT_PATTERN = /error|fail/i` in shared-agent-sessions-api.ts. SQLite
// has no case-insensitive regex, so lower() + LIKE substring matches the
// `/i` substring test exactly (the pattern has no anchors/metacharacters).
const ANALYTICS_EVENT_ERROR_PREDICATE =
  "(lower({col}) LIKE '%error%' OR lower({col}) LIKE '%fail%')";

/**
 * FEA-2038: integer-ms-since-epoch for a canonical `toISOString()` value
 * (`YYYY-MM-DDTHH:MM:SS.mmmZ`), else 0 — matching `new Date(iso).getTime()` and
 * `parseSessionDate`'s NaN→epoch(0) fallback. NOT julianday (it drifts and
 * fails the golden parity test). `col` is substituted with the column ref.
 *
 * Moved here from `sync-source.ts` (ISS-9802) for the reason this module was
 * split out of `write-core.ts` in the first place: it is pure SQL fragment
 * construction for session analytics, and its importer is shrink-only.
 */
export function analyticsIsoMsExpr(col: string): string {
  return (
    `(CASE WHEN ${col} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' ` +
    `THEN CAST(strftime('%s', ${col}) AS INTEGER) * 1000 + CAST(substr(${col}, 21, 3) AS INTEGER) ` +
    "ELSE 0 END)"
  );
}
