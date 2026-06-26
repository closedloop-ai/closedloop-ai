"use client";

import type { TableFiltersReturn } from "@repo/app/documents/hooks/use-table-filters";
import type { FilterCurrentUser } from "@repo/app/shared/hooks/use-filter-current-user";
import {
  AssigneeFilterContent as DesignSystemAssigneeFilterContent,
  DateFilterContent as DesignSystemDateFilterContent,
  FilterMenuContent as DesignSystemFilterMenuContent,
  FilterPopover as DesignSystemFilterPopover,
  PriorityFilterContent as DesignSystemPriorityFilterContent,
  StatusFilterContent as DesignSystemStatusFilterContent,
  TagsFilterContent as DesignSystemTagsFilterContent,
  type TableTextFilter,
} from "@repo/design-system/components/ui/filter-popover";
import type { User } from "@repo/design-system/components/ui/user-select-popover";
import { useDocumentTableFilterUi } from "./use-document-table-filter-ui";

type FilterPopoverProps = {
  filtersReturn: TableFiltersReturn;
  currentUser?: FilterCurrentUser | null;
  teamMembers: User[];
  teamMembersLoading: boolean;
  teamMembersError: string | null;
  hideAssignee?: boolean;
  /** Optional free-text search rendered at the top of the filter menu. */
  textFilter?: TableTextFilter;
};

export function FilterPopover(props: FilterPopoverProps) {
  const { controller, viewModel } = useDocumentTableFilterUi(props);

  return (
    <DesignSystemFilterPopover
      controller={controller}
      textFilter={props.textFilter}
      viewModel={viewModel}
    />
  );
}

export function FilterMenuContent(props: FilterPopoverProps) {
  const { controller, viewModel } = useDocumentTableFilterUi(props);

  return (
    <DesignSystemFilterMenuContent
      controller={controller}
      viewModel={viewModel}
    />
  );
}

export function AssigneeFilterContent(props: FilterPopoverProps) {
  const { controller, viewModel } = useDocumentTableFilterUi(props);

  return (
    <DesignSystemAssigneeFilterContent
      controller={controller}
      viewModel={viewModel}
    />
  );
}

export function StatusFilterContent(props: FilterPopoverProps) {
  const { controller, viewModel } = useDocumentTableFilterUi(props);

  return (
    <DesignSystemStatusFilterContent
      controller={controller}
      viewModel={viewModel}
    />
  );
}

export function PriorityFilterContent(props: FilterPopoverProps) {
  const { controller, viewModel } = useDocumentTableFilterUi(props);

  return (
    <DesignSystemPriorityFilterContent
      controller={controller}
      viewModel={viewModel}
    />
  );
}

export function DateFilterContent(props: FilterPopoverProps) {
  const { controller } = useDocumentTableFilterUi(props);

  return <DesignSystemDateFilterContent controller={controller} />;
}

export function TagsFilterContent(props: FilterPopoverProps) {
  const { controller, viewModel } = useDocumentTableFilterUi(props);

  return (
    <DesignSystemTagsFilterContent
      controller={controller}
      viewModel={viewModel}
    />
  );
}
