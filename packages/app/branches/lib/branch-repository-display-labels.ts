import { type BranchRow, shortRepoName } from "./branch-row";

/** Full identity is always the key; compact labels are used only if unique. */
export function repositoryDisplayLabels(
  rows: readonly BranchRow[]
): ReadonlyMap<string, string> {
  const fullNamesByShortName = new Map<string, Set<string>>();
  for (const row of rows) {
    const shortName = shortRepoName(row.repo);
    const identities = fullNamesByShortName.get(shortName) ?? new Set<string>();
    identities.add(row.repo);
    fullNamesByShortName.set(shortName, identities);
  }
  return new Map(
    rows.map((row) => {
      const shortName = shortRepoName(row.repo);
      const collides = (fullNamesByShortName.get(shortName)?.size ?? 0) > 1;
      return [row.repo, collides ? row.repo : shortName] as const;
    })
  );
}
