import type {
  RepoSource,
  ResolvedRepo,
} from "@repo/app/loops/hooks/use-resolved-job-repos";

export type ComputeSeedStateArgs = {
  seedPrimary: ResolvedRepo | null;
  seedAdditional: ResolvedRepo[];
};

export type SeedState = {
  ids: Set<string>;
  primaryId: string | null;
  sources: Record<string, RepoSource>;
  branches: Record<string, string>;
};

// Builds the seed state for the section's local state. Non-pool seeds are
// dropped (they would lock submit).
export function computeSeedState({
  seedPrimary,
  seedAdditional,
}: ComputeSeedStateArgs): SeedState {
  const ids = new Set<string>();
  const sources: Record<string, RepoSource> = {};
  const branches: Record<string, string> = {};
  const primaryEligible = seedPrimary?.inPool ?? false;
  if (primaryEligible && seedPrimary) {
    ids.add(seedPrimary.id);
    sources[seedPrimary.id] = seedPrimary.source;
    if (seedPrimary.branch) {
      branches[seedPrimary.id] = seedPrimary.branch;
    }
  }
  for (const repo of seedAdditional) {
    if (!repo.inPool) {
      continue;
    }
    ids.add(repo.id);
    sources[repo.id] = repo.source;
    if (repo.branch) {
      branches[repo.id] = repo.branch;
    }
  }
  return {
    ids,
    primaryId: primaryEligible && seedPrimary ? seedPrimary.id : null,
    sources,
    branches,
  };
}

// Fingerprint encoding the inputs that drive `computeSeedState`. Used as the
// inner component's `key` so a new seed identity remounts with a fresh
// initial state.
export function computeSeedKey(
  seedPrimary: ResolvedRepo | null,
  seedAdditional: ResolvedRepo[]
): string {
  const primaryPart = seedPrimary?.id ?? "_none";
  const additionalPart = seedAdditional
    .map((r) => r.id)
    .sort((a, b) => a.localeCompare(b))
    .join(",");
  return `${primaryPart}|${additionalPart}`;
}
