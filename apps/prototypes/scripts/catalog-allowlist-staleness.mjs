// ISS-12426 item 4: the gardener treats every module this allowlist names as
// in use, so an entry no prototype imports any more (its page was deleted)
// would keep that module alive forever. The catalog gate fails on such an
// entry instead.

/**
 * Allowlist entries that no prototype source file imports. Throws when either
 * input is empty, because an empty allowlist or an import scan that found
 * nothing would make every entry look current.
 *
 * @param {Iterable<string>} allowlist
 * @param {Iterable<string>} importedSpecifiers
 * @returns {string[]}
 */
export function staleAllowlistEntries(allowlist, importedSpecifiers) {
  const entries = [...new Set(allowlist)];
  const imported = new Set(importedSpecifiers);
  if (entries.length === 0) {
    throw new Error("portable surface allowlist is empty");
  }
  if (imported.size === 0) {
    throw new Error("the prototype import scan found no @repo imports");
  }
  return entries.filter((entry) => !imported.has(entry)).sort();
}
