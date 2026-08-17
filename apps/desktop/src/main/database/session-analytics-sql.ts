/**
 * @file session-analytics-sql.ts
 * @description SQL fragment builders shared by the session-analytics rollup and
 * its maintenance/heal passes.
 *
 * Extracted from `write-core.ts` (ISS-4592), which is on the `biome.jsonc`
 * shrink-only grandfather list. Both builders are pure string construction over
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
              THEN CASE WHEN json_type(${col}, '$.assistantMessages') IN ('integer', 'real')
                        THEN json_extract(${col}, '$.assistantMessages')
                        ELSE NULL END
              ELSE NULL END`;
}
