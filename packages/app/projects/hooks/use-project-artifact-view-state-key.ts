"use client";

import { useOptionalAuthSnapshot } from "../../shared/auth/use-auth-snapshot";
import { orgScopedViewStateKey } from "../../shared/lib/org-scoped-view-state-key";

/** The shared list's existing saved-view store, scoped to its full owner. */
export function useProjectArtifactViewStateKey(
  teamId: string,
  projectId: string
): string | null {
  const { userId, orgId } = useOptionalAuthSnapshot();
  if (!(teamId && projectId)) {
    return null;
  }
  return orgScopedViewStateKey(
    `table:view:project-artifacts-portable:${teamId}:${projectId}`,
    userId,
    orgId
  );
}
