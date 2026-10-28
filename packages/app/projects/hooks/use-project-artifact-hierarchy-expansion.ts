"use client";

import type { ProjectTreeDetailsResponse } from "@repo/api/src/types/project-tree";
import { completeProjectTreeArtifactIds } from "@repo/app/documents/lib/project-hierarchy-child-pages";
import { useArtifactHierarchyExpansion } from "@repo/app/shared/hooks/use-artifact-hierarchy-expansion";
import { useEffect, useMemo } from "react";

/** Project adapter for the shared bounded, versioned, link-restorable owner. */
export function useProjectArtifactHierarchyExpansion(
  storageKey: string | null,
  tree: ProjectTreeDetailsResponse | undefined
) {
  const { expandedSet, pruneGroups, setExpandedIds } =
    useArtifactHierarchyExpansion(storageKey, tree?.hierarchy !== undefined);
  const completeIds = useMemo(
    () => completeProjectTreeArtifactIds(tree),
    [tree]
  );
  useEffect(() => {
    if (completeIds) {
      pruneGroups(completeIds);
    }
  }, [completeIds, pruneGroups]);
  const controlledExpansion = useMemo(
    () => ({ expandedIds: expandedSet, onChange: setExpandedIds }),
    [expandedSet, setExpandedIds]
  );
  return { controlledExpansion, expandedArtifactIds: expandedSet };
}
