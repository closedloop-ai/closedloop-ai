"use client";

import { DocumentType } from "@repo/api/src/types/document";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { toRowItem } from "@repo/app/documents/components/table/document-tree";
import type { FilterCategory } from "@repo/app/documents/components/table/filter-category";
import { useTableFilters } from "@repo/app/documents/hooks/use-table-filters";
import type { DocumentRowData } from "@repo/app/documents/lib/artifact-row-adapter";
import { useMemo } from "react";

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

type UseProjectFiltersOptions = {
  documents: DocumentRowData[];
  filterCategory: FilterCategory;
  currentUserId?: string;
  /**
   * ISS-9726: `null` (the active organization has not resolved) takes the same
   * memory-only branch an omitted key does.
   */
  persistenceKey?: string | null;
  favoriteArtifactIds?: string[];
  /** See `useTableFilters` — false on a surface that filters server-side. */
  supportsUnknownStatusFacet?: boolean;
};

export function useProjectFilters({
  documents,
  filterCategory,
  currentUserId,
  persistenceKey,
  favoriteArtifactIds,
  supportsUnknownStatusFacet,
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
    supportsUnknownStatusFacet,
  });

  return {
    ...tableFilters,
    rootItems,
  };
}
