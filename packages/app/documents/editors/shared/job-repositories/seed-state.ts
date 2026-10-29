import type {
  RepoSource,
  ResolvedRepo,
} from "@repo/app/documents/editors/shared/job-repositories/use-resolved-job-repos";

export type ComputeSeedStateArgs = {
  seedPrimary: ResolvedRepo | null;
  seedAdditional: ResolvedRepo[];
};

export type SeedState = {
  ids: Set<string>;
  primaryId: string | null;
  sources: Record<string, RepoSource>;
};

// Builds the seed state for the section's local state.
export function computeSeedState({
  seedPrimary,
  seedAdditional,
}: ComputeSeedStateArgs): SeedState {
  const ids = new Set<string>();
  const sources: Record<string, RepoSource> = {};
  if (seedPrimary) {
    ids.add(seedPrimary.id);
    sources[seedPrimary.id] = seedPrimary.source;
  }
  for (const repo of seedAdditional) {
    ids.add(repo.id);
    sources[repo.id] = repo.source;
  }
  return {
    ids,
    primaryId: seedPrimary ? seedPrimary.id : null,
    sources,
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
