// @ts-check

export const legacyMigrationSortKeys = new Map([
  ["0011_session_activity_segments", "0011_session_activity_segments"],
  [
    "20260619220000_add_genai_prices_pricing_source",
    "0004_add_genai_prices_pricing_source",
  ],
  // FEA-2267 (#2157) merged with a stale base and re-used the 0011 prefix
  // already taken by 0011_clear_default_branch_pr_poison (which landed first),
  // producing two committed `0011_` migrations on main. Both are immutable, so
  // neither can be renamed. clear_default_branch_pr_poison keeps slot 0011 (it
  // landed first); session_activity_segments is logically the 12th migration,
  // so map it to a 0012 sort key. This exempts it from the canonical-name check
  // and orders it after 0011_clear — matching the existing application order
  // ("clear" < "session"), so runtime migration order is unchanged.
  ["0011_session_activity_segments", "0012_session_activity_segments"],
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
