// biome-ignore-all lint/a11y/useSemanticElements: the ARIA grid's trailing header cannot be a native th outside table markup.
"use client";

import type {
  CreateCustomFieldInput,
  CustomFieldEntityType,
  CustomFieldWithOptions,
} from "@repo/api/src/types/custom-field";
import {
  CustomFieldTableCell,
  type CustomFieldTableValue,
} from "@repo/app/custom-fields/components/custom-field-table-cell";
import type { EntityListCustomFieldsController } from "@repo/app/custom-fields/hooks/use-entity-list-custom-fields-controller";
import { customFieldOptionColorFromDialogClass } from "@repo/app/custom-fields/lib/option-colors";
import {
  buildTableCustomFieldInput,
  existingCustomFieldOptions,
  TABLE_CUSTOM_FIELD_REFERENCE_SOURCES,
} from "@repo/app/custom-fields/lib/table-custom-field-creation";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { CUSTOM_FIELD_EDITOR_CONTRACTS_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { TableAddFieldDialog } from "@repo/design-system/components/ui/table-add-field-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import {
  type GridChromeCellProps,
  NAVIGABLE_CHROME_CELL_CLASS,
} from "@repo/design-system/lib/grid-table-v2-chrome-rows";
import { cn } from "@repo/design-system/lib/utils";
import { PlusIcon } from "lucide-react";

/**
 * ISS-12663 — the list-surface custom-field controls the Sessions list built
 * first, shared so the Branches list offers the same Add field dialog, the same
 * trailing Add field header and the same editable cell rather than its own.
 */

/** What Add field needs from a list's controller. */
export type ListAddFieldController = Pick<
  EntityListCustomFieldsController,
  "availableFields" | "onAddExistingField" | "onCreateField"
>;

export function ListAddFieldDialog({
  controller,
  entityType,
  onOpenChange,
  open,
}: {
  controller?: ListAddFieldController;
  entityType: CustomFieldEntityType;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const canonicalColors = useFeatureFlagEnabledOptional(
    CUSTOM_FIELD_EDITOR_CONTRACTS_FEATURE_FLAG_KEY
  );
  const onCreateField = controller?.onCreateField;
  if (!onCreateField) {
    return null;
  }
  return (
    <TableAddFieldDialog
      existingFields={existingCustomFieldOptions(
        controller?.availableFields ?? []
      )}
      onCreate={async (draft) => {
        const input = buildTableCustomFieldInput(draft, entityType);
        await onCreateField(
          canonicalColors ? withCanonicalOptionColors(input) : input
        );
      }}
      onOpenChange={onOpenChange}
      onSelectExisting={
        controller?.onAddExistingField
          ? async (fieldId) => {
              await controller.onAddExistingField?.(fieldId);
            }
          : undefined
      }
      open={open}
      referenceSources={TABLE_CUSTOM_FIELD_REFERENCE_SOURCES}
    />
  );
}

/**
 * The trailing Add field column header. Takes the grid's roving wiring so the
 * button joins the header's arrow walk rather than holding a tab stop the grid
 * cannot see (whitlockk review).
 */
export function AddFieldHeaderButton({
  columnIndex,
  navigationProps,
  onClick,
}: {
  columnIndex: number | undefined;
  /**
   * Roving wiring from `GridTableV2`'s trailing-header seam (ISS-8930). It
   * carries the cell's `data-grid-cell` and its roving `tabIndex`, which is what
   * puts this slot in the header's arrow walk AND gives `suppressCellTabStops`
   * the `[data-grid-cell]` ancestor it needs to reach the button inside.
   *
   * OPTIONAL because `GridTableV2` types the seam that way for callers that pass
   * `navigableHeaderCells={false}`, and the static `tabIndex` below is what the
   * absent case would fall back to.
   */
  navigationProps?: GridChromeCellProps;
  onClick: () => void;
}) {
  // The spread supplies the roving `tabIndex` and must therefore win over the
  // static one below.
  return (
    <div
      aria-colindex={columnIndex}
      // The SAME ring every other navigable chrome cell wears. A cell that can
      // take focus and does not show it is WCAG 2.4.7, and a second ring
      // invented here is the drift the shared constant exists to stop.
      className={cn(navigationProps && NAVIGABLE_CHROME_CELL_CLASS)}
      role="columnheader"
      tabIndex={-1}
      {...navigationProps}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            aria-label="Add field"
            className="flex size-full items-center justify-center border-l text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
            onClick={onClick}
            type="button"
          >
            <PlusIcon aria-hidden className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent>Add field</TooltipContent>
      </Tooltip>
    </div>
  );
}

/** One row's editable value for one custom-field column. */
export function ListCustomFieldCell({
  controller,
  entityId,
  field,
  itemLabel,
}: {
  controller: Pick<
    EntityListCustomFieldsController,
    | "onValueChange"
    | "peopleOptions"
    | "searchReferenceTargets"
    | "valuesByEntityId"
  > & {
    referenceOptions?: Parameters<
      typeof CustomFieldTableCell
    >[0]["referenceOptions"];
  };
  entityId: string;
  field: CustomFieldWithOptions;
  itemLabel: string;
}) {
  const { onValueChange, searchReferenceTargets } = controller;
  const value = controller.valuesByEntityId
    .get(entityId)
    ?.find((candidate) => candidate.customFieldId === field.id);
  return (
    <CustomFieldTableCell
      field={field}
      itemLabel={itemLabel}
      loadReferenceOptions={
        searchReferenceTargets
          ? (query) => searchReferenceTargets(field, entityId, query)
          : undefined
      }
      onValueChange={
        onValueChange
          ? (nextValue: CustomFieldTableValue) =>
              // ISS-9352: the controller is allowed to be async (`mutateAsync`)
              // and the promise is HANDED TO THE CELL rather than swallowed
              // here — that is the only way a refused write can reach the
              // shared cell's commit ledger and put the previous option back.
              onValueChange(entityId, field, nextValue)
          : undefined
      }
      ownerEntityId={entityId}
      peopleOptions={controller.peopleOptions}
      referenceOptions={controller.referenceOptions}
      value={value}
    />
  );
}

/**
 * The same create input with every dialog swatch class replaced by the canonical
 * colour id (ISS-8215).
 *
 * The add-field dialog is project-agnostic and hands back its own Tailwind
 * classes; persisting one stores a value no other custom-field host can read, so
 * the class is translated here — at the gate's read site — and only the id is
 * ever written. An unrecognised swatch drops `color` entirely rather than
 * guessing, so the optional stays OMITTED and the server picks its own default.
 */
function withCanonicalOptionColors(
  input: CreateCustomFieldInput
): CreateCustomFieldInput {
  if (!input.enumOptions) {
    return input;
  }
  return {
    ...input,
    enumOptions: input.enumOptions.map(({ color, ...option }) => {
      const canonical = customFieldOptionColorFromDialogClass(color);
      return canonical === undefined ? option : { ...option, color: canonical };
    }),
  };
}
