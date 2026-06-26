// @ts-check

export const legacyMigrationSortKeys = new Map([
  [
    "20260619220000_add_genai_prices_pricing_source",
    "0004_add_genai_prices_pricing_source",
  ],
]);

/**
 * @param {string} left
 * @param {string} right
 */
export function compareMigrationDirNames(left, right) {
  const leftKey = migrationSortKey(left);
  const rightKey = migrationSortKey(right);
  return leftKey.localeCompare(rightKey) || left.localeCompare(right);
}

/**
 * @param {string} name
 */
export function migrationSortKey(name) {
  return legacyMigrationSortKeys.get(name) ?? name;
}
