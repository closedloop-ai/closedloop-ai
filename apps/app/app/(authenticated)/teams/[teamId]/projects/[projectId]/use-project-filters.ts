"use client";

import {
  DocumentType,
  type DocumentWithWorkstream,
} from "@repo/api/src/types/document";
import { useMemo } from "react";
import type { DocumentRowItem } from "@/components/document-table/document-row";
import { useTableFilters } from "@/hooks/use-table-filters";
import type { FilterCategory } from "./page";

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

function toRowItem(doc: DocumentWithWorkstream): DocumentRowItem {
  return doc.type === DocumentType.Feature
    ? { kind: "feature", data: doc }
    : { kind: "artifact", data: doc };
}

// ---- Hook ----

type UseProjectFiltersOptions = {
  documents: DocumentWithWorkstream[];
  filterCategory: FilterCategory;
  currentUserId?: string;
};

export function useProjectFilters({
  documents,
  filterCategory,
  currentUserId,
}: UseProjectFiltersOptions) {
  const rootItems = useMemo((): DocumentRowItem[] => {
    return documents
      .filter((d) => isDocumentVisibleInCategory(d.type, filterCategory))
      .map(toRowItem);
  }, [documents, filterCategory]);

  const tableFilters = useTableFilters({
    items: rootItems,
    currentUserId,
  });

  return {
    ...tableFilters,
    rootItems,
  };
}
