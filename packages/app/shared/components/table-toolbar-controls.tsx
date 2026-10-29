"use client";

/**
 * The table toolbar's five menus, as one shared adapter layer over the
 * `@repo/design-system` `Table*Menu` primitives.
 *
 * ISS-10476 promoted these out of `apps/prototypes/app/p/generic-artifact`: the
 * portable Projects surface needs the same sort / group / options / view / saved
 * views menus the generic-artifact prototype already drives, and a second copy
 * in `packages/app` would be two answers to one question. Domain identity stays
 * with the caller.
 */

import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import type { TableCustomFieldDefinition as CustomFieldDefinition } from "@repo/design-system/components/ui/table-add-field-dialog";
import { TableCompactViewMenu } from "@repo/design-system/components/ui/table-compact-view-menu-v2";
import { TableGroupMenu } from "@repo/design-system/components/ui/table-group-menu-v2";
import { TableOptionsMenu } from "@repo/design-system/components/ui/table-options-menu-v2";
import { TableSavedViewsMenu } from "@repo/design-system/components/ui/table-saved-views-menu-v2";
import { TableSortMenu } from "@repo/design-system/components/ui/table-sort-menu-v2";
import type {
  TableFieldOption,
  TableGroupingState,
  TableToggleOption,
} from "@repo/design-system/components/ui/table-toolbar-model";
import {
  type ColumnDefinition,
  resolveColumnCapabilities,
} from "@repo/design-system/lib/column-registry";
import type * as React from "react";
import type { ListSurfaceSortGrouping } from "./list-surface-toolbar-parts";

export type TableToolbarSavedView = {
  id: string;
  name: string;
  scope: "personal" | "project" | "team";
};

/** A summary metric the Options/View menus can show or hide. */
export type TableToolbarMetricOption = {
  key: string;
  label: string;
};

export type TableToolbarGroupOrder = "custom" | "asc" | "desc";

/**
 * Which custom fields a host allows sorting and grouping by. The vocabulary of
 * a custom field's `type` belongs to the host's own field model, so the menus
 * ask rather than decide; a host with no custom fields passes nothing.
 */
export type TableToolbarCustomFieldCapabilities = {
  readonly sortable: (field: CustomFieldDefinition) => boolean;
  readonly groupable: (field: CustomFieldDefinition) => boolean;
};

const ALL_CUSTOM_FIELDS_CAPABLE: TableToolbarCustomFieldCapabilities = {
  groupable: () => true,
  sortable: () => true,
};

export function TableToolbarSavedViewsMenu(props: {
  /** `null` when no saved view is applied — the trigger then reads "Views". */
  activeViewId: string | null;
  onApply: (viewId: string) => void;
  onSave: (name: string) => void;
  views: readonly TableToolbarSavedView[];
}) {
  return <TableSavedViewsMenu {...props} />;
}

export function TableToolbarSortMenu({
  active,
  columns,
  customFieldCapabilities,
  customFields,
  leadingLabel,
  onClear,
  onSort,
  sortBy,
}: {
  active: boolean;
  columns: readonly ColumnDefinition[];
  customFieldCapabilities?: TableToolbarCustomFieldCapabilities;
  customFields: readonly CustomFieldDefinition[];
  /** Visible name of the host's leading column. Defaults to "Artifact". */
  leadingLabel?: string;
  onClear: () => void;
  onSort: (column: string, direction: SortDirection) => void;
  sortBy: string;
}) {
  return (
    <TableSortMenu
      onClear={onClear}
      onSort={onSort}
      options={buildSortOptions(columns, customFields, {
        customFieldCapabilities,
        leadingLabel,
      })}
      sortBy={active ? sortBy : null}
    />
  );
}

export function TableToolbarGroupMenu({
  columns,
  customFieldCapabilities,
  customFields,
  groupBy,
  groupOrder,
  secondaryGroupBy,
  secondaryGroupOrder,
  setGroupBy,
  setGroupOrder,
  setSecondaryGroupBy,
  setSecondaryGroupOrder,
  setShowEmptyGroups,
  setShowEmptySubgroups,
  showEmptyGroups,
  showEmptySubgroups,
}: {
  columns: readonly ColumnDefinition[];
  customFieldCapabilities?: TableToolbarCustomFieldCapabilities;
  customFields: readonly CustomFieldDefinition[];
  groupBy: string;
  groupOrder: TableToolbarGroupOrder;
  secondaryGroupBy: string;
  secondaryGroupOrder: TableToolbarGroupOrder;
  setGroupBy: (groupBy: string) => void;
  setGroupOrder: (order: TableToolbarGroupOrder) => void;
  setSecondaryGroupBy: (groupBy: string) => void;
  setSecondaryGroupOrder: (order: TableToolbarGroupOrder) => void;
  setShowEmptyGroups: (show: boolean) => void;
  setShowEmptySubgroups: (show: boolean) => void;
  showEmptyGroups: boolean;
  showEmptySubgroups: boolean;
}) {
  return (
    <TableGroupMenu
      grouping={buildGrouping({
        groupBy,
        groupOrder,
        secondaryGroupBy,
        secondaryGroupOrder,
        showEmptyGroups,
        showEmptySubgroups,
      })}
      onGroupingChange={(next) =>
        applyGrouping(next, {
          setGroupBy,
          setGroupOrder,
          setSecondaryGroupBy,
          setSecondaryGroupOrder,
          setShowEmptyGroups,
          setShowEmptySubgroups,
        })
      }
      options={buildGroupOptions(
        columns,
        customFields,
        customFieldCapabilities
      )}
    />
  );
}

export function TableToolbarOptionsMenu({
  columnIds,
  columns,
  customFields,
  metricDefinitions,
  metricKeys,
  setColumnIds,
  setMetricKeys,
}: {
  columnIds: Set<string>;
  columns: readonly ColumnDefinition[];
  customFields: readonly CustomFieldDefinition[];
  metricDefinitions: readonly TableToolbarMetricOption[];
  metricKeys: Set<string>;
  setColumnIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  setMetricKeys: React.Dispatch<React.SetStateAction<Set<string>>>;
}) {
  return (
    <TableOptionsMenu
      columns={buildColumnOptions(columns, customFields)}
      metrics={buildMetricOptions(metricDefinitions)}
      onToggleColumn={(key) => toggleSetValue(setColumnIds, key)}
      onToggleMetric={(key) => toggleSetValue(setMetricKeys, key)}
      visibleColumnIds={columnIds}
      visibleMetricKeys={metricKeys}
    />
  );
}

export function TableToolbarViewMenu({
  columnIds,
  columns,
  customFieldCapabilities,
  customFields,
  groupBy,
  leadingLabel,
  metricDefinitions,
  metricKeys,
  onAddField,
  onClearSort,
  onSort,
  secondaryGroupBy,
  setColumnIds,
  setGroupBy,
  setMetricKeys,
  setSecondaryGroupBy,
  showAddFieldButton,
  sortBy,
}: {
  columnIds: Set<string>;
  columns: readonly ColumnDefinition[];
  customFieldCapabilities?: TableToolbarCustomFieldCapabilities;
  customFields: readonly CustomFieldDefinition[];
  groupBy: string;
  /** Visible name of the host's leading column. Defaults to "Artifact". */
  leadingLabel?: string;
  metricDefinitions: readonly TableToolbarMetricOption[];
  metricKeys: Set<string>;
  onAddField: () => void;
  onClearSort: () => void;
  onSort: (column: string) => void;
  secondaryGroupBy: string;
  setColumnIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  setGroupBy: (groupBy: string) => void;
  setMetricKeys: React.Dispatch<React.SetStateAction<Set<string>>>;
  setSecondaryGroupBy: (groupBy: string) => void;
  showAddFieldButton: boolean;
  sortBy: string;
}) {
  return (
    <TableCompactViewMenu
      columns={buildColumnOptions(columns, customFields)}
      grouping={buildGrouping({
        groupBy,
        groupOrder: "custom",
        secondaryGroupBy,
        secondaryGroupOrder: "asc",
        showEmptyGroups: false,
        showEmptySubgroups: false,
      })}
      groupOptions={buildGroupOptions(
        columns,
        customFields,
        customFieldCapabilities
      )}
      metrics={buildMetricOptions(metricDefinitions)}
      onAddField={showAddFieldButton ? onAddField : undefined}
      onClearSort={onClearSort}
      onGroupingChange={(next) => {
        setGroupBy(next.primary.fieldId ?? "none");
        setSecondaryGroupBy(next.secondary.fieldId ?? "none");
      }}
      onSort={onSort}
      onToggleColumn={(key) => toggleSetValue(setColumnIds, key)}
      onToggleMetric={(key) => toggleSetValue(setMetricKeys, key)}
      sortBy={sortBy === "none" ? null : sortBy}
      sortOptions={buildSortOptions(columns, customFields, {
        customFieldCapabilities,
        leadingLabel,
      })}
      visibleColumnIds={columnIds}
      visibleMetricKeys={metricKeys}
    />
  );
}

/**
 * The shared toolbar's sort and group cluster for a page whose ordering and
 * grouping are held as the column-based state the prototype shell shares
 * (Documents, Issues, Projects). Both adapters call this, so the mapping lives
 * once.
 */
export function buildToolbarSortGrouping({
  columns,
  customFieldCapabilities,
  customFields,
  groupBy,
  groupOrder,
  leadingLabel,
  onClearSort,
  onSort,
  secondaryGroupBy,
  secondaryGroupOrder,
  setGroupBy,
  setGroupOrder,
  setSecondaryGroupBy,
  setSecondaryGroupOrder,
  setShowEmptyGroups,
  setShowEmptySubgroups,
  showEmptyGroups,
  showEmptySubgroups,
  sortActive,
  sortBy,
}: {
  columns: readonly ColumnDefinition[];
  customFieldCapabilities?: TableToolbarCustomFieldCapabilities;
  customFields: readonly CustomFieldDefinition[];
  groupBy: string;
  groupOrder: TableToolbarGroupOrder;
  leadingLabel?: string;
  onClearSort: () => void;
  onSort: (column: string, direction: SortDirection) => void;
  secondaryGroupBy: string;
  secondaryGroupOrder: TableToolbarGroupOrder;
  setGroupBy: (groupBy: string) => void;
  setGroupOrder: (order: TableToolbarGroupOrder) => void;
  setSecondaryGroupBy: (groupBy: string) => void;
  setSecondaryGroupOrder: (order: TableToolbarGroupOrder) => void;
  setShowEmptyGroups: (show: boolean) => void;
  setShowEmptySubgroups: (show: boolean) => void;
  showEmptyGroups: boolean;
  showEmptySubgroups: boolean;
  sortActive: boolean;
  sortBy: string;
}): ListSurfaceSortGrouping {
  return {
    grouping: buildGrouping({
      groupBy,
      groupOrder,
      secondaryGroupBy,
      secondaryGroupOrder,
      showEmptyGroups,
      showEmptySubgroups,
    }),
    groupOptions: buildGroupOptions(
      columns,
      customFields,
      customFieldCapabilities
    ),
    onClearSort,
    onGroupingChange: (next) =>
      applyGrouping(next, {
        setGroupBy,
        setGroupOrder,
        setSecondaryGroupBy,
        setSecondaryGroupOrder,
        setShowEmptyGroups,
        setShowEmptySubgroups,
      }),
    onSort: (column, direction = "asc") => onSort(column, direction),
    sortBy: sortActive ? sortBy : null,
    sortOptions: buildSortOptions(columns, customFields, {
      customFieldCapabilities,
      leadingLabel,
    }),
  };
}

export function toggleSetValue(
  setter: React.Dispatch<React.SetStateAction<Set<string>>>,
  key: string
) {
  setter((current) => {
    const next = new Set(current);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    return next;
  });
}

/**
 * The sort menu's offered fields: the host's leading column plus every sortable
 * registry column and custom field. Exported so a host can hold its own sort
 * model to what this actually offers, rather than a second copy of the rule.
 */
export function buildSortOptions(
  columns: readonly ColumnDefinition[],
  customFields: readonly CustomFieldDefinition[],
  options: {
    customFieldCapabilities?: TableToolbarCustomFieldCapabilities;
    leadingLabel?: string;
  }
): TableFieldOption[] {
  const {
    customFieldCapabilities = ALL_CUSTOM_FIELDS_CAPABLE,
    leadingLabel = "Artifact",
  } = options;
  return [
    {
      id: "name",
      label: leadingLabel,
    },
    ...columns
      .filter((column) => column.sortable)
      .map((column) => ({
        id: column.id,
        label: column.label,
      })),
    ...customFields.filter(customFieldCapabilities.sortable).map((field) => ({
      id: field.id,
      label: field.label,
    })),
  ];
}

export function buildGroupOptions(
  columns: readonly ColumnDefinition[],
  customFields: readonly CustomFieldDefinition[],
  customFieldCapabilities: TableToolbarCustomFieldCapabilities = ALL_CUSTOM_FIELDS_CAPABLE
): TableFieldOption[] {
  return [
    ...columns.filter((column) => column.groupable),
    ...customFields.filter(customFieldCapabilities.groupable),
  ].map(({ id, label }) => ({ id, label }));
}

/**
 * whitlockk review: these are registry declarations now, so the menu has to read
 * their visibility capability rather than assume every column is the user's to
 * hide. A `hideable: false` column is kept rendered by `resolveColumnLayout`
 * whatever the view state asks, so a switch for it reports a state it cannot
 * reach — it showed as UNCHECKED while the column stayed on screen. Such a
 * column is left out of the list entirely; `TableToggleOption` carries no
 * disabled state, and adding one is a `packages/design-system` change this
 * recompose does not make.
 */
export function buildColumnOptions(
  columns: readonly ColumnDefinition[],
  customFields: readonly CustomFieldDefinition[]
): TableToggleOption[] {
  const hideable = columns.filter(
    (column) => resolveColumnCapabilities(column).hideable
  );
  return [
    ...hideable.filter((column) => column.id !== "tags"),
    ...customFields,
    ...hideable.filter((column) => column.id === "tags"),
  ].map(({ id, label }) => ({ key: id, label }));
}

export function buildMetricOptions(
  metrics: readonly TableToolbarMetricOption[]
): TableToggleOption[] {
  return metrics.map((metric) => ({ key: metric.key, label: metric.label }));
}

export function buildGrouping({
  groupBy,
  groupOrder,
  secondaryGroupBy,
  secondaryGroupOrder,
  showEmptyGroups,
  showEmptySubgroups,
}: {
  groupBy: string;
  groupOrder: TableToolbarGroupOrder;
  secondaryGroupBy: string;
  secondaryGroupOrder: TableToolbarGroupOrder;
  showEmptyGroups: boolean;
  showEmptySubgroups: boolean;
}): TableGroupingState {
  return {
    primary: {
      fieldId: groupBy === "none" ? null : groupBy,
      order: groupOrder,
      showEmptyGroups,
    },
    secondary: {
      fieldId: secondaryGroupBy === "none" ? null : secondaryGroupBy,
      order: secondaryGroupOrder,
      showEmptyGroups: showEmptySubgroups,
    },
  };
}

export function applyGrouping(
  grouping: TableGroupingState,
  setters: {
    setGroupBy: (groupBy: string) => void;
    setGroupOrder: (order: TableToolbarGroupOrder) => void;
    setSecondaryGroupBy: (groupBy: string) => void;
    setSecondaryGroupOrder: (order: TableToolbarGroupOrder) => void;
    setShowEmptyGroups: (show: boolean) => void;
    setShowEmptySubgroups: (show: boolean) => void;
  }
) {
  setters.setGroupBy(grouping.primary.fieldId ?? "none");
  setters.setGroupOrder(grouping.primary.order);
  setters.setShowEmptyGroups(grouping.primary.showEmptyGroups);
  setters.setSecondaryGroupBy(grouping.secondary.fieldId ?? "none");
  setters.setSecondaryGroupOrder(grouping.secondary.order);
  setters.setShowEmptySubgroups(grouping.secondary.showEmptyGroups);
}
