"use client";

import {
  DocumentType,
  type DocumentWithWorkstream,
} from "@repo/api/src/types/document";
import type { FeatureWithWorkstream } from "@repo/api/src/types/feature";
import { useMemo } from "react";
import type { DocumentRowItem } from "@/components/document-table/document-row";
import { useTableFilters } from "@/hooks/use-table-filters";
import type { FilterCategory } from "./page";

// ---- Category helpers ----

function isDocumentVisibleInCategory(
  type: DocumentType,
  category: FilterCategory
): boolean {
  if (category === "features" || category === "branches") {
    return false;
  }
  if (category === "documents") {
    return type === DocumentType.Prd;
  }
  if (category === "plans") {
    return type === DocumentType.ImplementationPlan;
  }
  return true;
}

function includesFeatures(category: FilterCategory): boolean {
  return (
    category !== "documents" && category !== "plans" && category !== "branches"
  );
}

// ---- Hook ----

type UseProjectFiltersOptions = {
  artifacts: DocumentWithWorkstream[];
  features: FeatureWithWorkstream[];
  filterCategory: FilterCategory;
  currentUserId?: string;
};

export function useProjectFilters({
  artifacts,
  features,
  filterCategory,
  currentUserId,
}: UseProjectFiltersOptions) {
  const rootItems = useMemo((): DocumentRowItem[] => {
    const items: DocumentRowItem[] = artifacts
      .filter((a) => isDocumentVisibleInCategory(a.type, filterCategory))
      .map((a): DocumentRowItem => ({ kind: "artifact", data: a }));
    if (includesFeatures(filterCategory)) {
      for (const f of features) {
        items.push({ kind: "feature", data: f });
      }
    }
    return items;
  }, [artifacts, features, filterCategory]);

  const tableFilters = useTableFilters({
    items: rootItems,
    currentUserId,
  });

  return {
    ...tableFilters,
    rootItems,
  };
}
