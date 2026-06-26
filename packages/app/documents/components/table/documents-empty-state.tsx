"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { FileTextIcon, FilterXIcon } from "lucide-react";

/**
 * Empty state for the documents table (FEA-1763 / PLN-874 Phase 3; extracted
 * from the page-private `documents-view.tsx`). Distinguishes a truly empty
 * project, an active-filter mismatch, and a text-search mismatch.
 */
export function DocumentsEmptyState({
  hasAnyItems,
  isFilterActive,
  onClearFilters,
}: {
  hasAnyItems: boolean;
  isFilterActive?: boolean;
  onClearFilters?: () => void;
}) {
  if (!hasAnyItems) {
    return (
      <EmptyState
        description="Create a PRD, feature, or plan to get started."
        icon={FileTextIcon}
        title="No artifacts yet"
      />
    );
  }
  if (isFilterActive) {
    return (
      <EmptyState
        action={
          onClearFilters ? (
            <Button onClick={onClearFilters} size="sm" variant="outline">
              Clear filters
            </Button>
          ) : undefined
        }
        description="Try adjusting your filters or search term."
        icon={FilterXIcon}
        title="No items match your filters"
      />
    );
  }
  return (
    <EmptyState
      description="Try adjusting your filter or search term."
      icon={FileTextIcon}
      title="No matching artifacts"
    />
  );
}
