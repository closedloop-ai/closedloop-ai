/**
 * @file store-integrity-sql.ts
 * @description SSOT for the two store-integrity reads. Shared by the in-child
 * `runStoreIntegrityCheck` (sqlite.ts) and its test reader adapter so the SQL
 * cannot drift between production and the test. Pure strings, no imports, so it
 * stays electron-free and safe to load from either side.
 */

/** `PRAGMA quick_check(maxErrors)` — bounded integrity scan. */
export function storeIntegrityQuickCheckSql(maxErrors: number): string {
  return `PRAGMA quick_check(${maxErrors})`;
}

/** Lists every index currently present in the schema. */
export const STORE_INTEGRITY_INDEX_SQL =
  "SELECT name FROM sqlite_master WHERE type = 'index'";
