import type { CustomFieldValueDetail } from "@repo/api/src/types/custom-field";
import { useState } from "react";

/**
 * Hook that manages column visibility state for custom field columns in tables.
 *
 * Tracks which custom field columns are hidden and provides helpers for toggling,
 * computing a visibility record, and filtering to visible columns only.
 *
 * @param customFieldColumns - The full list of custom field column definitions.
 * @returns Object with toggle handler, visibility record, and visible columns array.
 */
export function useCustomFieldColumnVisibility(
  customFieldColumns: CustomFieldValueDetail[]
) {
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(new Set());

  const handleToggleColumn = (fieldId: string) => {
    setHiddenColumns((prev) => {
      const next = new Set(prev);
      if (next.has(fieldId)) {
        next.delete(fieldId);
      } else {
        next.add(fieldId);
      }
      return next;
    });
  };

  const visibleColumnsRecord: Record<string, boolean> = Object.fromEntries(
    customFieldColumns.map((f) => [
      f.customFieldId,
      !hiddenColumns.has(f.customFieldId),
    ])
  );

  const visibleCustomFieldColumns = customFieldColumns.filter(
    (f) => !hiddenColumns.has(f.customFieldId)
  );

  return {
    handleToggleColumn,
    visibleColumnsRecord,
    visibleCustomFieldColumns,
  };
}
