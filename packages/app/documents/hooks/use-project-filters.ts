"use client";

import { DocumentType } from "@repo/api/src/types/document";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { toRowItem } from "@repo/app/documents/components/table/document-tree";
import type { FilterCategory } from "@repo/app/documents/components/table/filter-category";
import { useTableFilters } from "@repo/app/documents/hooks/use-table-filters";
import type { DocumentRowData } from "@repo/app/documents/lib/artifact-row-adapter";
import { useMemo } from "react";

// ---- Category helpers ----

function isDocumentVisibleInCategory(
  type: DocumentType,
  category: FilterCategory
): boolean {
  switch (category) {
    case "branches":
      return false;
    case "documents":
      return type === DocumentType.Prd;
    case "plans":
      return type === DocumentType.ImplementationPlan;
    case "features":
      return type === DocumentType.Feature;
    default:
      return true;
  }
}

// ---- Hook ----

type UseProjectFiltersOptions = {
  documents: DocumentRowData[];
  filterCategory: FilterCategory;
  currentUserId?: string;
  persistenceKey?: string;
  favoriteArtifactIds?: string[];
};

export function useProjectFilters({
  documents,
  filterCategory,
  currentUserId,
  persistenceKey,
  favoriteArtifactIds,
}: UseProjectFiltersOptions) {
  const rootItems = useMemo((): DocumentRowItem[] => {
    return documents
      .filter((d) => isDocumentVisibleInCategory(d.type, filterCategory))
      .map(toRowItem);
  }, [documents, filterCategory]);

  const tableFilters = useTableFilters({
    items: rootItems,
    currentUserId,
    persistenceKey,
    favoriteArtifactIds,
  });

  return {
    ...tableFilters,
    rootItems,
  };
}
