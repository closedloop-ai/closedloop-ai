import "server-only";

import type { ProjectArtifactLanePolicy } from "@repo/api/src/types/project-artifact-lane-policy";

/**
 * Authoritative Project adapter seam for optional lane policy.
 *
 * No approved Project policy exists today, so the production result is no cap
 * and unrestricted transitions. A future adapter supplies policy here once;
 * both board reads and mutations consume this same server-owned result.
 */
export function resolveProjectArtifactLanePolicy(
  _projectId: string,
  _organizationId: string
): Promise<ProjectArtifactLanePolicy | null> {
  return Promise.resolve(null);
}
