/**
 * ISS-9484 (#7902 review: tamsinb) — the DETAIL PANEL picks its editor through
 * `CUSTOM_FIELD_EDITOR`, the same registry the grid cell reads.
 *
 * The registry only reached the grid: this panel still chose with a chain of
 * `fieldType === CustomFieldType.X &&` blocks, so a field type added against an
 * editor this file already renders compiled here and left the panel showing a
 * field name with nothing under it. The cases below are the two that chain
 * could not state — that the registry is what production reads, and that a type
 * this build has no row for degrades to no editor rather than one that cannot
 * store what it collects.
 */

import type {
  CustomFieldSettingWithOptions,
  CustomFieldValueDetail,
} from "@repo/api/src/types/custom-field";
import {
  CustomFieldEntityType,
  CustomFieldType,
} from "@repo/api/src/types/custom-field";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CustomFieldValueEditor } from "../custom-field-value-editor";

const FIELD_NAME = "Stage";
const FIELD_ID = "field-1";
const ENTITY_ID = "proj-1";

/** A field type shipped by a peer this build predates. */
const UNKNOWN_FIELD_TYPE = "GEO_POINT" as CustomFieldType;

vi.mock("@repo/app/custom-fields/hooks/use-custom-fields", () => ({
  useUpdateCustomFieldValue: () => ({ mutate: vi.fn(), isPending: false }),
}));

afterEach(cleanup);

describe("CustomFieldValueEditor editor dispatch", () => {
  /**
   * TWO field types resolving to DIFFERENT editors, asserted by the control
   * each one renders. A test that stopped at "something rendered" would stay
   * green when the registry swaps two live editor kinds.
   */
  it.each([
    ["a scalar field", CustomFieldType.Text, "textbox"],
    ["a choice field", CustomFieldType.Enum, "combobox"],
  ] as const)("renders the registered editor for %s", (_l, fieldType, role) => {
    renderEditor(fieldType);

    expect(screen.getAllByRole(role).length).toBeGreaterThan(0);
  });

  it("renders a field type this build does not know without an editor", () => {
    renderEditor(UNKNOWN_FIELD_TYPE);

    expect(screen.getByText(FIELD_NAME)).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

function renderEditor(fieldType: CustomFieldType) {
  render(
    <CustomFieldValueEditor
      entityId={ENTITY_ID}
      entityType={CustomFieldEntityType.Project}
      setting={setting(fieldType)}
      value={storedValue(fieldType)}
    />
  );
}

function setting(fieldType: CustomFieldType): CustomFieldSettingWithOptions {
  return {
    id: "setting-1",
    customFieldId: FIELD_ID,
    entityType: CustomFieldEntityType.Project,
    entityId: ENTITY_ID,
    isImportant: false,
    isRequired: false,
    sortOrder: 0,
    createdAt: new Date("2026-08-25T12:00:00.000Z"),
    customField: {
      id: FIELD_ID,
      organizationId: "org-1",
      name: FIELD_NAME,
      description: null,
      fieldType,
      createdById: null,
      createdAt: new Date("2026-08-25T12:00:00.000Z"),
      updatedAt: new Date("2026-08-25T12:00:00.000Z"),
      precision: null,
      numberFormat: null,
      currencyCode: null,
      customLabel: null,
      customLabelPosition: null,
      isGlobalToOrg: false,
      entityTypes: [CustomFieldEntityType.Project],
      referenceTargetSources: [],
      showInTable: false,
      isSearchable: false,
      isSortable: false,
      enumOptions: [
        {
          id: "opt-1",
          customFieldId: FIELD_ID,
          name: "Low",
          color: "none",
          enabled: true,
          sortOrder: 0,
        },
      ],
    },
  };
}

function storedValue(fieldType: CustomFieldType): CustomFieldValueDetail {
  return {
    id: "value-1",
    customFieldId: FIELD_ID,
    entityId: ENTITY_ID,
    name: FIELD_NAME,
    fieldType,
    displayValue: null,
    showInTable: false,
    textValue: null,
    numberValue: null,
    dateValue: null,
    enumValue: null,
    multiEnumValues: [],
    peopleValues: [],
    referenceValues: [],
  };
}
