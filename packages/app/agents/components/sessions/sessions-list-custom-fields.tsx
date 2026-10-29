"use client";

import type {
  CreateCustomFieldInput,
  CustomFieldReferenceSearchResponse,
  CustomFieldReferenceTarget,
  CustomFieldValueDetail,
  CustomFieldWithOptions,
} from "@repo/api/src/types/custom-field";
import {
  CustomFieldEntityType,
  CustomFieldType,
} from "@repo/api/src/types/custom-field";
import {
  GROUP_EMPTY_VALUE,
  GroupEmptyBand,
  resolveCustomFieldCapabilities,
} from "@repo/api/src/types/custom-field-capabilities";
import type { BasicUser } from "@repo/api/src/types/user";
import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import type { CustomFieldTableValue } from "@repo/app/custom-fields/components/custom-field-table-cell";
import {
  ListAddFieldDialog,
  ListCustomFieldCell,
} from "@repo/app/custom-fields/components/list-custom-field-controls";
import {
  buildListCustomFieldColumns,
  LIST_CUSTOM_FIELD_WIDTH_PX,
} from "@repo/app/custom-fields/lib/list-custom-field-columns";
import { getUserDisplayName } from "@repo/app/shared/lib/user-utils";
import {
  getTableCellPrimitiveStateValue,
  TABLE_CELL_UNAVAILABLE_LABEL,
  TableCellValueState,
} from "@repo/design-system/components/ui/table-cell-primitives";
import type { FilterMenuGroup } from "@repo/design-system/components/ui/table-filters";
import type { SessionsGroupContribution } from "./sessions-list-surface-rows";
import {
  SESSIONS_CUSTOM_FIELD_COLUMN_PREFIX,
  type SessionsCustomFieldColumnId,
} from "./sessions-list-view-state";

export const SESSION_CUSTOM_FIELD_WIDTH_PX = LIST_CUSTOM_FIELD_WIDTH_PX;

export type SessionsCustomFieldsController = {
  fields: readonly CustomFieldWithOptions[];
  valuesBySessionId: ReadonlyMap<string, readonly CustomFieldValueDetail[]>;
  /** Whether this row's producer supplied a writable custom-field operand. */
  isValueWritable?: (row: SessionTableRow) => boolean;
  onCreateField?: (
    input: CreateCustomFieldInput
  ) => Promise<CustomFieldWithOptions> | CustomFieldWithOptions;
  onAddExistingField?: (fieldId: string) => Promise<void> | void;
  onValueChange?: (
    row: SessionTableRow,
    field: CustomFieldWithOptions,
    value: CustomFieldTableValue
  ) => Promise<void> | void;
  peopleOptions?: readonly BasicUser[];
  searchReferenceTargets?: (
    field: CustomFieldWithOptions,
    row: SessionTableRow,
    query: string
  ) => Promise<CustomFieldReferenceSearchResponse>;
  /** Static options remain available for isolated stories and fixtures. */
  referenceOptions?: readonly CustomFieldReferenceTarget[];
  /** Org fields the host has decided this Session surface may attach. */
  availableFields?: readonly CustomFieldWithOptions[];
};

export function SessionsAddFieldDialog({
  controller,
  onOpenChange,
  open,
}: {
  controller?: SessionsCustomFieldsController;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  return (
    <ListAddFieldDialog
      controller={controller}
      entityType={CustomFieldEntityType.Session}
      onOpenChange={onOpenChange}
      open={open}
    />
  );
}

export type SessionsCustomFieldColumn = {
  id: string;
  label: string;
  minWidthPx: number;
  width: string;
  tooltip: string;
  customField: CustomFieldWithOptions;
};

export function buildSessionsCustomFieldColumns(
  controller?: SessionsCustomFieldsController
): SessionsCustomFieldColumn[] {
  return buildListCustomFieldColumns(controller?.fields ?? []);
}

export function sessionsCustomFieldColumnId(
  fieldId: string
): SessionsCustomFieldColumnId {
  return `${SESSIONS_CUSTOM_FIELD_COLUMN_PREFIX}${fieldId}`;
}

export function customFieldForColumn(
  columnId: string,
  columns: readonly SessionsCustomFieldColumn[]
): CustomFieldWithOptions | undefined {
  return columns.find((column) => column.id === columnId)?.customField;
}

export function renderSessionsCustomFieldCell({
  controller,
  field,
  row,
}: {
  controller: SessionsCustomFieldsController;
  field: CustomFieldWithOptions;
  row: SessionTableRow;
}) {
  const { onValueChange, searchReferenceTargets } = controller;
  const isValueWritable = controller.isValueWritable?.(row) ?? true;
  const rowValues = controller.valuesBySessionId.get(row.id);
  if (!rowValues) {
    return getTableCellPrimitiveStateValue({
      state: TableCellValueState.Unavailable,
    });
  }
  return (
    <ListCustomFieldCell
      controller={{
        onValueChange:
          isValueWritable && onValueChange
            ? (_entityId, nextField, value) =>
                onValueChange(row, nextField, value)
            : undefined,
        peopleOptions: controller.peopleOptions,
        referenceOptions: controller.referenceOptions,
        searchReferenceTargets:
          isValueWritable && searchReferenceTargets
            ? (nextField, _entityId, query) =>
                searchReferenceTargets(nextField, row, query)
            : undefined,
        valuesByEntityId: controller.valuesBySessionId,
      }}
      entityId={row.id}
      field={field}
      itemLabel={row.name}
    />
  );
}

export function sortSessionsByCustomField(
  rows: readonly SessionTableRow[],
  controller: SessionsCustomFieldsController,
  columnId: SessionsCustomFieldColumnId,
  direction: "asc" | "desc",
  options?: { preservePriorSortsOnTie?: boolean }
): SessionTableRow[] {
  const field = customFieldForColumn(
    columnId,
    buildSessionsCustomFieldColumns(controller)
  );
  if (!field) {
    return [...rows];
  }
  return [...rows].sort((left, right) => {
    const leftValue = customFieldSortValue(controller, left.id, field.id);
    const rightValue = customFieldSortValue(controller, right.id, field.id);
    const comparison = compareCustomFieldSortValues(
      leftValue,
      rightValue,
      direction
    );
    if (comparison !== 0 || options?.preservePriorSortsOnTie) {
      return comparison;
    }
    return left.id.localeCompare(right.id);
  });
}

/** Seeds stable multi-rule sorting with the unique final tie-break. */
export function sortSessionsByStableId(
  rows: readonly SessionTableRow[]
): SessionTableRow[] {
  return [...rows].sort((left, right) => left.id.localeCompare(right.id));
}

export type SessionsCustomFieldOptionFilter = {
  kind: "options";
  selectedValues: readonly string[];
};

export type SessionsCustomFieldRangeFilter = {
  kind: "range";
  min?: number;
  max?: number;
};

export type SessionsCustomFieldFilter =
  | SessionsCustomFieldOptionFilter
  | SessionsCustomFieldRangeFilter;

export type SessionsCustomFieldFilters = ReadonlyMap<
  string,
  SessionsCustomFieldFilter
>;

export function filterSessionsByCustomFields(
  rows: readonly SessionTableRow[],
  controller: SessionsCustomFieldsController,
  filters: SessionsCustomFieldFilters
): SessionTableRow[] {
  const columns = buildSessionsCustomFieldColumns(controller);
  const representable = representableCustomFieldFilters(filters, columns);
  if (![...representable.values()].some(isActiveCustomFieldFilter)) {
    return [...rows];
  }
  return rows.filter((row) => {
    const rowValues = controller.valuesBySessionId.get(row.id) ?? [];
    for (const [columnId, filter] of representable) {
      if (!isActiveCustomFieldFilter(filter)) {
        continue;
      }
      const field = customFieldForColumn(columnId, columns);
      const value = rowValues.find(
        (candidate) => candidate.customFieldId === field?.id
      );
      const matches =
        filter.kind === "range"
          ? matchesCustomFieldRange(value, filter)
          : Boolean(
              value &&
                customFieldFilterOptions(value).some((option) =>
                  filter.selectedValues.includes(option.id)
                )
            );
      if (!matches) {
        return false;
      }
    }
    return true;
  });
}

export function buildSessionsCustomFieldFacetGroups(
  controller: SessionsCustomFieldsController,
  filters: SessionsCustomFieldFilters,
  onToggle: (columnId: string, value: string) => void,
  onRangeChange: (
    columnId: string,
    next: { min?: number; max?: number }
  ) => void
): FilterMenuGroup[] {
  return buildSessionsCustomFieldColumns(controller)
    .filter((column) => column.customField.isSearchable)
    .map((column): FilterMenuGroup => {
      if (column.customField.fieldType === CustomFieldType.Number) {
        const filter = filters.get(column.id);
        return {
          id: column.id,
          kind: "range",
          label: column.label,
          max: filter?.kind === "range" ? filter.max : undefined,
          min: filter?.kind === "range" ? filter.min : undefined,
          minPlaceholder: "Min",
          maxPlaceholder: "Max",
          onChange: (next) => onRangeChange(column.id, next),
        };
      }
      // Keyed by option id, so two people who share a display name stay two
      // options; the label is whatever the last row rendered for that id.
      const options = new Map<string, string>();
      for (const rowValues of controller.valuesBySessionId.values()) {
        const value = rowValues.find(
          (candidate) => candidate.customFieldId === column.customField.id
        );
        for (const option of value ? customFieldFilterOptions(value) : []) {
          options.set(option.id, option.label);
        }
      }
      const filter = filters.get(column.id);
      return {
        id: column.id,
        kind: "options",
        label: column.label,
        onToggle: (value: string) => onToggle(column.id, value),
        options: [...options]
          .map(([id, label]) => ({ id, label }))
          .sort((left, right) => left.label.localeCompare(right.label)),
        selectedValues:
          filter?.kind === "options" ? [...filter.selectedValues] : [],
      };
    });
}

export function hasActiveSessionsCustomFieldFilters(
  filters: SessionsCustomFieldFilters
): boolean {
  return [...filters.values()].some(isActiveCustomFieldFilter);
}

/**
 * What a custom-field column contributes to a band: the rendered LABEL, and the
 * canonical value a drop onto that band would write (ISS-8296).
 *
 * The label half is byte-unchanged — still `displayValue || "—"` — because
 * ISS-7902 fixed on purpose that a band is named by what its cells render.
 * The value half is new and is never the label: two REFERENCE targets sharing a
 * name is the same collision two people sharing a name is, and `"—"` as a
 * canonical value would mean "unset" to a host that had no way to know better.
 */
export function sessionsCustomFieldGroupContribution(
  controller: SessionsCustomFieldsController,
  columnId: string,
  sessionId: string
): SessionsGroupContribution {
  const field = customFieldForColumn(
    columnId,
    buildSessionsCustomFieldColumns(controller)
  );
  const rowValues = controller.valuesBySessionId.get(sessionId);
  if (!rowValues) {
    return { key: TABLE_CELL_UNAVAILABLE_LABEL, value: undefined };
  }
  const value = rowValues.find(
    (candidate) => candidate.customFieldId === field?.id
  );
  return {
    key: value?.displayValue || "—",
    value: customFieldCanonicalValue(field?.fieldType, value),
  };
}

/**
 * The canonical value for one custom-field cell, or `undefined` when the field
 * has none a host could write.
 *
 * `undefined` for every type outside the two the capability table declares
 * groupable — and that branch is REACHABLE, not defensive: this surface's own
 * {@link isSessionsCustomFieldGroupable} still offers DATE and PEOPLE for
 * grouping, so those bands exist. Returning nothing for them makes the band
 * refuse the drop, which is the safe direction while the two inventories
 * disagree.
 */
function customFieldCanonicalValue(
  fieldType: CustomFieldType | undefined,
  value: CustomFieldValueDetail | undefined
): string | undefined {
  if (!fieldType) {
    return;
  }
  const capabilities = resolveCustomFieldCapabilities(fieldType);
  if (capabilities.emptyBand === GroupEmptyBand.Settable && !value) {
    return GROUP_EMPTY_VALUE;
  }
  if (fieldType === CustomFieldType.Enum) {
    const optionId = value?.enumValue?.id;
    if (optionId) {
      return optionId;
    }
    // A record whose option did NOT resolve is undetermined, not empty
    // (marisolashgrove review). ENUM alone can hold a label that outlived the thing
    // it names: `displayValue` is `CachedOnWrite` while `enumValue` resolves
    // live, and the FK is `onDelete: SetNull` (schema.prisma:3879), so deleting
    // an option leaves a row reading "In progress" with `enumValueId` null.
    // Folding that to `GROUP_EMPTY_VALUE` made the band droppable and had the
    // drop CLEAR the field the band says it sets — the label-is-not-a-value
    // defect this whole ticket exists to stop, pointed the other way.
    //
    // The genuine clear is distinguishable and still admitted: `buildValuePayload`
    // recomputes `displayValue` on every write, so a cleared row carries no label
    // and is already the "—" band `sessionsCustomFieldGroupContribution` keys on.
    // REFERENCE and PEOPLE need no such branch — both are `ResolvedOnRead`, so
    // neither has a cached label that can outlive the thing it names. (PEOPLE
    // joined REFERENCE there in ISS-7215; its stored column survives only as a
    // sort key and is never what this row rendered.)
    if (value?.displayValue) {
      return;
    }
    return GROUP_EMPTY_VALUE;
  }
  if (fieldType === CustomFieldType.Reference) {
    // REFERENCE is Single by enforcement (`validateReferenceShape` rejects an
    // array), so more than one target is corrupt rather than a case to pick
    // from — refuse rather than guess which one the reader meant.
    const targets = value?.referenceValues ?? [];
    if (targets.length > 1) {
      return;
    }
    return targets[0]?.id ?? GROUP_EMPTY_VALUE;
  }
  return;
}

export function isSessionsCustomFieldGroupable(
  field: CustomFieldWithOptions
): boolean {
  return (
    field.fieldType === CustomFieldType.Enum ||
    field.fieldType === CustomFieldType.Date ||
    field.fieldType === CustomFieldType.People ||
    field.fieldType === CustomFieldType.Reference
  );
}

function isActiveCustomFieldFilter(filter: SessionsCustomFieldFilter): boolean {
  return filter.kind === "range"
    ? filter.min !== undefined || filter.max !== undefined
    : filter.selectedValues.length > 0;
}

function matchesCustomFieldRange(
  value: CustomFieldValueDetail | undefined,
  filter: SessionsCustomFieldRangeFilter
): boolean {
  const numericValue = value?.numberValue;
  if (numericValue === null || numericValue === undefined) {
    return false;
  }
  return (
    (filter.min === undefined || numericValue >= filter.min) &&
    (filter.max === undefined || numericValue <= filter.max)
  );
}

/**
 * The value a custom-field sort actually orders by.
 *
 * DATE and NUMBER fields are ordered by their TYPED value, never by
 * `displayValue`: the API formats a date as `Dec 1, 2026` and a duration as
 * text, so a lexical compare puts December before January and `10` before `9`
 * (whitlockk review). Duration is a NUMBER field whose canonical storage unit is
 * milliseconds, so `numberValue` orders it correctly too.
 *
 * Everything else has no typed value to order by and keeps the display text.
 */
function customFieldSortValue(
  controller: SessionsCustomFieldsController,
  sessionId: string,
  fieldId: string
): CustomFieldSortValue {
  const rowValues = controller.valuesBySessionId.get(sessionId);
  if (!rowValues) {
    return { state: TableCellValueState.Unavailable };
  }
  const value = rowValues.find(
    (candidate) => candidate.customFieldId === fieldId
  );
  if (!value) {
    return { state: TableCellValueState.Default, value: "" };
  }
  if (value.dateValue) {
    const timestamp = new Date(value.dateValue).getTime();
    // A malformed stored date must not order as `NaN`, which compares false
    // against everything and would make the sort order depend on input order.
    if (!Number.isNaN(timestamp)) {
      return { state: TableCellValueState.Default, value: timestamp };
    }
  }
  if (value.numberValue !== null && value.numberValue !== undefined) {
    return { state: TableCellValueState.Default, value: value.numberValue };
  }
  return {
    state: TableCellValueState.Default,
    value: value.displayValue ?? "",
  };
}

/** Unavailable sorts last in either direction; available values keep prior order. */
function compareCustomFieldSortValues(
  left: CustomFieldSortValue,
  right: CustomFieldSortValue,
  direction: "asc" | "desc"
): number {
  if (left.state === TableCellValueState.Unavailable) {
    return right.state === TableCellValueState.Unavailable ? 0 : 1;
  }
  if (right.state === TableCellValueState.Unavailable) {
    return -1;
  }
  const sign = direction === "asc" ? 1 : -1;
  if (typeof left.value === "number" && typeof right.value === "number") {
    return (left.value - right.value) * sign;
  }
  return (
    String(left.value).localeCompare(String(right.value), undefined, {
      numeric: true,
    }) * sign
  );
}

/**
 * The facet options one stored value contributes, as `{ id, label }`.
 *
 * People are keyed by USER ID rather than by their rendered name (tamsinb
 * review): two people who happen to share a name collapsed into one option that
 * then matched both, and a user with no name parts produced a blank option even
 * though the cell beside it shows their email. `getUserDisplayName` is the same
 * derivation `TablePeopleCell` renders, so the option reads as the cell does.
 *
 * Every other field type still keys by its own displayed string — those ARE the
 * value, and there is no separate identifier to prefer.
 */
function customFieldFilterOptions(
  value: CustomFieldValueDetail
): { id: string; label: string }[] {
  if (value.fieldType === CustomFieldType.People) {
    return value.peopleValues.map((person) => ({
      id: person.id,
      label: getUserDisplayName(person),
    }));
  }
  return customFieldFilterValues(value).map((candidate) => ({
    id: candidate,
    label: candidate,
  }));
}

/**
 * The entries of `filters` the reader can actually SEE — those whose column is
 * one {@link buildSessionsCustomFieldFacetGroups} renders a control for.
 *
 * ISS-8216 made this axis outlive the mount that set it: a saved view can now
 * restore a selection made against a custom field that has since been deleted,
 * un-shown in the table, or made non-searchable. Such an entry resolves to no
 * column, so {@link customFieldForColumn} returns `undefined`, no row's value
 * carries a matching `customFieldId`, and the row filter rejected EVERY row —
 * while the facet builder emitted no group and the chip bar no chip. An empty
 * list, no stated reason, and no control to undo it (codex review
 * PRRT_kwDOQ4gDpM6d4V-c / PRRT_kwDOQ4gDpM6d4czZ).
 *
 * IGNORED at read rather than DISCARDED at restore, and the difference is
 * load-bearing: `controller.fields` arrives from a query, so "no column for
 * this id" is also what a view restored before that query settles looks like.
 * Discarding there would destroy the reader's filter for good; ignoring it
 * narrows nothing until the definitions land and then applies it.
 *
 * One predicate, applied by both the row filter and the "is anything narrowing
 * this list" count, so the two cannot disagree about a filter that is not there.
 */
export function representableCustomFieldFilters(
  filters: SessionsCustomFieldFilters,
  columns: readonly SessionsCustomFieldColumn[]
): SessionsCustomFieldFilters {
  const representable = new Map<string, SessionsCustomFieldFilter>();
  for (const [columnId, filter] of filters) {
    const column = columns.find((candidate) => candidate.id === columnId);
    if (column?.customField.isSearchable) {
      representable.set(columnId, filter);
    }
  }
  return representable;
}

function customFieldFilterValues(value: CustomFieldValueDetail): string[] {
  if (value.fieldType === CustomFieldType.Enum) {
    return value.enumValue ? [value.enumValue.name] : [];
  }
  if (value.fieldType === CustomFieldType.MultiEnum) {
    return value.multiEnumValues.map((option) => option.name);
  }
  if (
    value.fieldType === CustomFieldType.Reference ||
    value.fieldType === CustomFieldType.ReferenceMulti
  ) {
    return value.referenceValues.map((target) => target.slug ?? target.name);
  }
  return value.displayValue ? [value.displayValue] : [];
}

type CustomFieldSortValue =
  | {
      state: typeof TableCellValueState.Default;
      value: number | string;
    }
  | { state: typeof TableCellValueState.Unavailable };

/** Whether a persisted custom-field sort still resolves to a visible field. */
export function hasSessionsCustomFieldSortColumn(
  controller: SessionsCustomFieldsController,
  columnId: string
): boolean {
  return Boolean(
    customFieldForColumn(columnId, buildSessionsCustomFieldColumns(controller))
  );
}
