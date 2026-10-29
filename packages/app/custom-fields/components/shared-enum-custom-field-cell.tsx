"use client";

import type {
  CustomFieldValueDetail,
  CustomFieldWithOptions,
} from "@repo/api/src/types/custom-field";
import { CustomFieldType } from "@repo/api/src/types/custom-field";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { CUSTOM_FIELD_VALUE_CLEAR_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import {
  InlineMultiSelectCell,
  InlineSelectCell,
  type InlineSelectOption,
} from "@repo/design-system/components/ui/inline-select-cell";
import {
  type CustomFieldTableValue,
  renderCustomFieldTableValue,
} from "./custom-field-table-cell";

/**
 * ISS-9352 — the ENUM and MULTI_ENUM custom-field grid cells, rendered by the
 * mastered closed-list cell instead of this package's own `DropdownMenu`.
 *
 * Reached only through `CustomFieldTableCell`'s `gridview-adoption` gate,
 * which picks between this module and the legacy editor as two whole shapes.
 * The boolean never crosses that boundary: this module reads the gate it needs
 * (the ISS-8713 clear) for itself, which is also why it is its own module — a
 * second read of that key inside `custom-field-table-cell.tsx` would be a
 * module holding two answers to one question.
 *
 * **What this adapter owes the champion.** Typed options and a commit that can
 * REFUSE. `onValueChange` returns the host's mutation promise, so a rejected
 * PUT reaches the cell's commit ledger and the previously committed option goes
 * back on screen — the capability the hand-rolled editor never had.
 *
 * **What it must not lose.** `primaryEditor` keeps the trigger marked as this
 * cell's grid-keyboard entry target, and the clear stays a real choice that
 * writes `null` (a `deleteMany`), never `[]` (a present-but-empty row).
 */
export function SharedEnumCustomFieldCell({
  field,
  itemLabel,
  onValueChange,
  value,
}: {
  field: CustomFieldWithOptions;
  itemLabel: string;
  onValueChange: (value: CustomFieldTableValue) => unknown;
  value?: CustomFieldValueDetail;
}) {
  const clearEnabled = useFeatureFlagEnabledOptional(
    CUSTOM_FIELD_VALUE_CLEAR_FEATURE_FLAG_KEY
  );
  const multiple = field.fieldType === CustomFieldType.MultiEnum;
  const options: InlineSelectOption[] = field.enumOptions.map((option) => ({
    value: option.id,
    label: option.name,
  }));
  // The champion names the control "Edit {label}, currently {value}", so the
  // label is the field AND the row it belongs to — a grid full of "Edit
  // Severity" says nothing about which session is being edited.
  const label = `${field.name} for ${itemLabel}`;

  if (multiple) {
    const selectedIds = value?.multiEnumValues.map((option) => option.id) ?? [];
    return (
      <InlineMultiSelectCell
        label={label}
        onCommit={(next) => Promise.resolve(onValueChange([...next]))}
        options={options}
        primaryEditor
        values={selectedIds}
      />
    );
  }

  const selectedId = value?.enumValue?.id ?? "";
  // Single-select only: a radio group cannot be un-picked by re-picking it, so
  // without an explicit clear the first choice is permanent. MULTI_ENUM needs
  // no equivalent — every entry already toggles off through its own checkbox.
  const canClear = clearEnabled && selectedId !== "" && Boolean(value);

  return (
    <InlineSelectCell
      clearLabel={canClear ? `Clear ${field.name}` : undefined}
      label={label}
      onCommit={(next) =>
        // `Promise.resolve` adopts whatever the host returns — a mutation
        // promise, or nothing — so a rejection still reaches the cell's ledger.
        // The cell commits `""` for a clear, and `null` is what deletes the row
        // (an empty array would leave it present-but-empty).
        Promise.resolve(onValueChange(next === "" ? null : next))
      }
      options={options}
      primaryEditor
      value={selectedId}
      valueContent={renderCustomFieldTableValue(field, value)}
      valueLabel={value?.enumValue?.name ?? ""}
    />
  );
}
