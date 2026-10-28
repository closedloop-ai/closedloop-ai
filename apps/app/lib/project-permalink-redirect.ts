"use client";
// biome-ignore lint/performance/noBarrelFile: Compatibility path retained while the shared owner serves both shells.
export {
  appendLocationHash,
  type ProjectPermalinkLocation,
  projectTeamIdsOf,
  resolveProjectPermalinkRedirect,
  useProjectPermalinkCanonicalization,
} from "@repo/app/projects/hooks/use-project-permalink-canonicalization";
