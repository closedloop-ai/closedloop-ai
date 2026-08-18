"use client";

import type { TableFiltersReturn } from "@repo/app/documents/hooks/use-table-filters";
import type { FilterCurrentUser } from "@repo/app/shared/hooks/use-filter-current-user";
import { ActiveFiltersBar as DesignSystemActiveFiltersBar } from "@repo/design-system/components/ui/active-filters-bar";
import type { User } from "@repo/design-system/components/ui/user-select-popover";
import type { ReactNode } from "react";
import { useDocumentTableFilterUi } from "./use-document-table-filter-ui";

type ActiveFiltersBarProps = {
  currentUser?: FilterCurrentUser | null;
  filtersReturn: TableFiltersReturn;
  teamMembers: User[];
  teamMembersLoading: boolean;
  teamMembersError: string | null;
  hideAssignee?: boolean;
  /**
   * Surface-owned chips rendered alongside the managed facet chips — for a
   * narrowing that is a server request parameter rather than a client-side
   * facet, and so has no place in `TableFiltersReturn`, but must still be
   * visible and removable like any other filter (My Tasks' recency window).
   */
  extraChips?: ReactNode;
  /**
   * Whether the add/clear controls render. Defaults to on; pass
   * `filtersReturn.isAnyFilterActive` when the bar can be on screen for
   * {@link ActiveFiltersBarProps.extraChips} alone.
   */
  showFilterControls?: boolean;
};

export function ActiveFiltersBar({
  extraChips,
  showFilterControls,
  ...props
}: ActiveFiltersBarProps) {
  const { controller, viewModel } = useDocumentTableFilterUi(props);

  return (
    <DesignSystemActiveFiltersBar
      controller={controller}
      extraChips={extraChips}
      showFilterControls={showFilterControls}
      viewModel={viewModel}
    />
  );
}
