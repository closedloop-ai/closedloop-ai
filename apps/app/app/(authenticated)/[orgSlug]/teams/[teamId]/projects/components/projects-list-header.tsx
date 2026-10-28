"use client";

import { TableViewMenu } from "@repo/app/documents/components/table/table-view-menu";
import type {
  ColumnVisibility,
  DocumentColumn,
} from "@repo/app/shared/hooks/use-column-visibility";
import { PROJECT_DEFAULT_COLUMNS } from "@repo/app/shared/hooks/use-column-visibility";
import type { ReactNode } from "react";

/**
 * The Projects list title bar, owned once (ISS-9346).
 *
 * Extracted so the filter trigger can sit BESIDE the column menu rather than in
 * a second bordered row below it: Branches and the project detail page both
 * keep their filter and view controls in one cluster, and splitting them makes
 * the eye hunt for the same cluster twice. `filterSlot` is what the gated
 * surface fills; the ungated page passes nothing and renders exactly the bar it
 * has today.
 */

type ProjectsListHeaderProps = {
  visibility: ColumnVisibility;
  onToggleColumn: (column: DocumentColumn) => void;
  /** The filter entry, when the surface has one. */
  filterSlot?: ReactNode;
};

export function ProjectsListHeader({
  visibility,
  onToggleColumn,
  filterSlot,
}: ProjectsListHeaderProps) {
  return (
    <div className="flex min-w-fit items-center justify-between gap-2 border-b px-4 pt-4 pb-2">
      <h1 className="font-semibold text-xl">Projects</h1>
      <div className="flex items-center gap-2">
        {filterSlot}
        <TableViewMenu
          columns={PROJECT_DEFAULT_COLUMNS}
          onToggle={onToggleColumn}
          visibility={visibility}
        />
      </div>
    </div>
  );
}
