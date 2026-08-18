/**
 * @file store-integrity-sql.ts
 * @description SSOT for the two store-integrity reads. Shared by
 * `runStoreIntegrityCheck` (store-integrity-reads.ts) and its test reader
 * adapter so the SQL cannot drift between production and the test. Pure strings,
 * no imports, so it stays electron-free and safe to load from either side.
 *
 * Both statements are ENGINE-level and name no table of ours — `quick_check` is
 * a PRAGMA and `sqlite_master` is SQLite's own catalog. That is the boundary this
 * directory keeps: the token_usage↔token_events parity source filter that used to
 * live here is schema-coupled and moved to `../token-parity.ts`.
 */

/** `PRAGMA quick_check(maxErrors)` — bounded integrity scan. */
export function storeIntegrityQuickCheckSql(maxErrors: number): string {
  return `PRAGMA quick_check(${maxErrors})`;
}

/** Lists every index currently present in the schema. */
export const STORE_INTEGRITY_INDEX_SQL =
  "SELECT name FROM sqlite_master WHERE type = 'index'";
