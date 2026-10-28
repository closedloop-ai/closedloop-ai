/**
 * ISS-9484: the grid cell picks its editor through `CUSTOM_FIELD_EDITOR`, not
 * through a chain of `if`s over a `string`.
 *
 * The cases that matter here are the two the old dispatch could not state: that
 * the registry is what production reads (flip a row and the picker disappears),
 * and that a field type this build has no row for degrades to a read-only cell
 * instead of an editor that cannot store what it collects. The refusal copy
 * itself is pinned by the sibling suites that already assert it.
 */

import type {
  CustomFieldValueDetail,
  CustomFieldWithOptions,
} from "@repo/api/src/types/custom-field";
import {
  CustomFieldEntityType,
  CustomFieldType,
} from "@repo/api/src/types/custom-field";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CustomFieldTableCell } from "../custom-field-table-cell";

const ITEM_LABEL = "Row one";
const OWNER_ID = "entity-1";

/** A field type shipped by a peer this build predates. */
const UNKNOWN_FIELD_TYPE = "GEO_POINT";

const BASE_FIELD: CustomFieldWithOptions = {
  createdAt: new Date("2026-08-25T12:00:00.000Z"),
  createdById: "user-1",
  currencyCode: null,
  customLabel: null,
  customLabelPosition: null,
  description: null,
  entityTypes: [CustomFieldEntityType.Session],
  enumOptions: [],
  fieldType: CustomFieldType.Text,
  id: "field-1",
  isGlobalToOrg: false,
  isSearchable: false,
  isSortable: false,
  name: "Stage",
  numberFormat: null,
  organizationId: "org-1",
  precision: null,
  referenceTargetSources: [],
  showInTable: true,
  updatedAt: new Date("2026-08-25T12:00:00.000Z"),
};

const BASE_VALUE: CustomFieldValueDetail = {
  customFieldId: BASE_FIELD.id,
  dateValue: null,
  displayValue: null,
  entityId: OWNER_ID,
  enumValue: null,
  fieldType: CustomFieldType.Text,
  id: "value-1",
  multiEnumValues: [],
  name: BASE_FIELD.name,
  numberValue: null,
  peopleValues: [],
  referenceValues: [],
  showInTable: true,
  textValue: null,
};

describe("CustomFieldTableCell editor dispatch", () => {
  /**
   * TWO field types resolving to DIFFERENT editors, asserted by the control
   * each one opens rather than by "some trigger rendered". Both kinds render a
   * trigger button, so a test that stopped at the button would stay green when
   * the registry swaps two live editor kinds (#7901 review: test-strategist).
   * Rewriting either row in `CUSTOM_FIELD_EDITOR` reddens this case.
   */
  it.each([
    ["a choice field", CustomFieldType.Enum, "menuitemradio"],
    ["a scalar field", CustomFieldType.Text, "textbox"],
  ] as const)(
    "opens the registered editor for %s",
    async (_label, fieldType, openedRole) => {
      render(
        cell(
          {
            ...BASE_FIELD,
            fieldType,
            enumOptions: [
              {
                id: "opt-low",
                customFieldId: BASE_FIELD.id,
                name: "Low",
                color: "none",
                enabled: true,
                sortOrder: 0,
              },
            ],
          },
          { ...BASE_VALUE, fieldType }
        )
      );

      const trigger = screen.getByRole("button", {
        name: `Edit ${BASE_FIELD.name} for ${ITEM_LABEL}`,
      });
      await userEvent.click(trigger);

      expect(screen.getAllByRole(openedRole).length).toBeGreaterThan(0);
    }
  );

  it("renders a field type this build does not know without an editor", () => {
    const onValueChange = vi.fn();
    render(
      cell(
        { ...BASE_FIELD, fieldType: UNKNOWN_FIELD_TYPE as CustomFieldType },
        { ...BASE_VALUE, fieldType: UNKNOWN_FIELD_TYPE as CustomFieldType },
        onValueChange
      )
    );

    expect(
      screen.queryByRole("button", {
        name: `Edit ${BASE_FIELD.name} for ${ITEM_LABEL}`,
      })
    ).toBeNull();
    expect(onValueChange).not.toHaveBeenCalled();
  });
});

function cell(
  fieldDef: CustomFieldWithOptions,
  value: CustomFieldValueDetail,
  onValueChange: (next: string | number | string[] | null) => void = vi.fn()
) {
  return (
    <CustomFieldTableCell
      field={fieldDef}
      itemLabel={ITEM_LABEL}
      onValueChange={onValueChange}
      ownerEntityId={OWNER_ID}
      value={value}
    />
  );
}
