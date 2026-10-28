"use client";

import type { ProjectTreeResponse } from "@repo/api/src/types/project-tree";
import { useDocumentsHierarchyExpansion } from "@repo/app/documents/hooks/use-documents-hierarchy-expansion";
import {
  completeProjectTreeArtifactIds,
  hierarchyExpansionParentIds,
  mergeProjectTreeExpansionPages,
} from "@repo/app/documents/lib/project-hierarchy-child-pages";
import { resolveTreeData } from "@repo/app/documents/lib/table-view-pipeline";
import {
  useProjectTree,
  useProjectTreeExpansionBatch,
} from "@repo/app/projects/hooks/use-project-tree";
import { useEffect, useMemo } from "react";

type UseDocumentsProjectTreeInput = {
  expansionStorageKey: string | null;
  isProvidedTreeLoading?: boolean;
  projectId?: string;
  providedTree?: ProjectTreeResponse | null;
};

/** Own the project-tree read, bounded child continuation merge, and safe expansion pruning. */
export function useDocumentsProjectTree({
  expansionStorageKey,
  isProvidedTreeLoading,
  projectId,
  providedTree,
}: UseDocumentsProjectTreeInput) {
  const fetchedTree = useProjectTree(projectId ?? "", {
    enabled: Boolean(projectId && providedTree === undefined),
  });
  const { treeData: baseTreeData, isLoadingTree } = resolveTreeData(
    providedTree,
    isProvidedTreeLoading,
    fetchedTree.data,
    fetchedTree.isLoading
  );
  const hierarchyCapabilityEnabled = baseTreeData?.hierarchy !== undefined;
  const {
    isExpanded,
    pruneGroups: pruneExpandedGroups,
    toggleGroup,
  } = useDocumentsHierarchyExpansion(
    expansionStorageKey,
    hierarchyCapabilityEnabled
  );
  const expansionParentIds = useMemo(
    () =>
      hierarchyCapabilityEnabled
        ? hierarchyExpansionParentIds(baseTreeData, isExpanded)
        : [],
    [baseTreeData, hierarchyCapabilityEnabled, isExpanded]
  );
  const expansionQueries = useProjectTreeExpansionBatch(
    projectId ?? "",
    expansionParentIds
  );
  const treeData = useMemo(() => {
    if (!baseTreeData) {
      return baseTreeData;
    }
    const pageGroups = expansionQueries.flatMap((query) =>
      query.data ? [query.data] : []
    );
    return pageGroups.length > 0
      ? mergeProjectTreeExpansionPages(baseTreeData, pageGroups)
      : baseTreeData;
  }, [baseTreeData, expansionQueries]);
  const completeTreeArtifactIds = useMemo(
    () => completeProjectTreeArtifactIds(treeData),
    [treeData]
  );

  useEffect(() => {
    if (completeTreeArtifactIds) {
      pruneExpandedGroups(completeTreeArtifactIds);
    }
  }, [completeTreeArtifactIds, pruneExpandedGroups]);

  return { isExpanded, isLoadingTree, toggleGroup, treeData };
}
