"use client";

import type {
  CustomFieldValueDetail,
  CustomFieldWithOptions,
} from "@repo/api/src/types/custom-field";
import type { BasicUser } from "@repo/api/src/types/user";
import { getUserDisplayName } from "@repo/app/shared/lib/user-utils";
import {
  InlineMultiSelectCell,
  type InlineSelectOption,
} from "@repo/design-system/components/ui/inline-select-cell";
import { TablePeopleCell } from "@repo/design-system/components/ui/table-cell-primitives";
import type { CustomFieldTableValue } from "./custom-field-table-cell";

/**
 * PRD-722 (ISS-9349): the PEOPLE custom-field grid cell, rendered by the
 * multi-select champion instead of this package's own `DropdownMenu`.
 *
 * Reached only through `CustomFieldTableCell`'s `gridview-adoption` gate.
 * Each toggle commits the whole next set through the champion's ledger, and
 * `onValueChange` returns the host's mutation promise, so a refused write puts
 * the confirmed people back on screen; the hand-rolled editor fired the write
 * and forgot it.
 *
 * It keeps what the legacy editor offered: the search box over the
 * organization's people with the same words, and the committed set drawn by
 * `TablePeopleCell`. A stored person the people list no longer carries is
 * still offered and named, so the set never shows fewer people than it holds.
 */
export function SharedPeopleCustomFieldCell({
  field,
  itemLabel,
  onValueChange,
  options,
  value,
}: {
  field: CustomFieldWithOptions;
  itemLabel: string;
  onValueChange: (value: CustomFieldTableValue) => unknown;
  options: readonly BasicUser[];
  value?: CustomFieldValueDetail;
}) {
  const stored = value?.peopleValues ?? [];
  const offered = new Set(options.map((person) => person.id));
  const selectOptions: InlineSelectOption[] = [
    ...options,
    ...stored.filter((person) => !offered.has(person.id)),
  ].map((person) => ({
    value: person.id,
    label: getUserDisplayName(person),
  }));

  return (
    <InlineMultiSelectCell
      label={`${field.name} for ${itemLabel}`}
      onCommit={(next) => Promise.resolve(onValueChange([...next]))}
      options={selectOptions}
      primaryEditor
      search={{
        label: `Search ${field.name} people`,
        placeholder: "Search people…",
        emptyMessage: "No matching people",
      }}
      valueContent={
        <TablePeopleCell
          people={stored.map((person) => ({
            avatarUrl: person.avatarUrl ?? undefined,
            name: getUserDisplayName(person),
          }))}
        />
      }
      valueLabel={stored.map(getUserDisplayName).join(", ")}
      values={stored.map((person) => person.id)}
    />
  );
}
