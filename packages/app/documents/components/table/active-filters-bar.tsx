"use client";

import type { TableFiltersReturn } from "@repo/app/documents/hooks/use-table-filters";
import type { FilterCurrentUser } from "@repo/app/shared/hooks/use-filter-current-user";
import { ActiveFiltersBar as DesignSystemActiveFiltersBar } from "@repo/design-system/components/ui/active-filters-bar";
import type { User } from "@repo/design-system/components/ui/user-select-popover";
import { useDocumentTableFilterUi } from "./use-document-table-filter-ui";

type ActiveFiltersBarProps = {
  currentUser?: FilterCurrentUser | null;
  filtersReturn: TableFiltersReturn;
  teamMembers: User[];
  teamMembersLoading: boolean;
  teamMembersError: string | null;
  hideAssignee?: boolean;
};

export function ActiveFiltersBar(props: ActiveFiltersBarProps) {
  const { controller, viewModel } = useDocumentTableFilterUi(props);

  return (
    <DesignSystemActiveFiltersBar
      controller={controller}
      viewModel={viewModel}
    />
  );
}
