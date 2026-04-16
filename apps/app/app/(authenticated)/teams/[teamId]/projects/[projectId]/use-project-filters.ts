"use client";

import {
  ArtifactType,
  type ArtifactWithWorkstream,
} from "@repo/api/src/types/artifact";
import type { FeatureWithWorkstream } from "@repo/api/src/types/feature";
import { useMemo } from "react";
import type { ArtifactRowItem } from "@/components/artifact-table/artifact-row";
import { useTableFilters } from "@/hooks/use-table-filters";
import type { FilterCategory } from "./page";

// ---- Category helpers ----

function isArtifactVisibleInCategory(
  type: ArtifactType,
  category: FilterCategory
): boolean {
  if (category === "features" || category === "branches") {
    return false;
  }
  if (category === "documents") {
    return type === ArtifactType.Prd;
  }
  if (category === "plans") {
    return type === ArtifactType.ImplementationPlan;
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
  artifacts: ArtifactWithWorkstream[];
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
  const rootItems = useMemo((): ArtifactRowItem[] => {
    const items: ArtifactRowItem[] = artifacts
      .filter((a) => isArtifactVisibleInCategory(a.type, filterCategory))
      .map((a): ArtifactRowItem => ({ kind: "artifact", data: a }));
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
