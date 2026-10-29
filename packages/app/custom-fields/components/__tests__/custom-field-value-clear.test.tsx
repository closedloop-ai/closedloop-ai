/**
 * ISS-8713: the per-record clear on the SINGLE-SELECT custom-field grid cells.
 *
 * The value a cell emits is the contract under test, and `null` is the whole
 * point of it: `useUpdateCustomFieldValueForEntityType` PUTs `{ value: null }`
 * to `/agent-sessions/:id/custom-field-values/:fieldId`, whose handler routes a
 * null to `customFieldValuesService.clearValue` — a `deleteMany` that removes
 * the row. So asserting `onValueChange(null)` here is asserting the delete,
 * not a re-render: the two hops between are covered by
 * `use-custom-fields.test.ts` ("sub-resource routing") and by
 * `apps/api/app/custom-fields/__tests__/custom-field-values-handlers.test.ts`.
 *
 * An empty array would NOT be the same assertion. `[]` upserts a row holding
 * empty arrays, leaving the record with a value that is present-but-empty
 * rather than absent — which is what a multi-select writes when its last entry
 * is toggled off. These tests pin the single-select cells to `null` so a future
 * edit cannot quietly swap in the other representation.
 */

import { ArtifactType } from "@repo/api/src/types/artifact";
import type {
  CustomFieldReferenceTarget,
  CustomFieldValueDetail,
  CustomFieldWithOptions,
} from "@repo/api/src/types/custom-field";
import {
  CustomFieldEntityType,
  CustomFieldType,
  NumberFormat,
  ReferenceTargetSource,
} from "@repo/api/src/types/custom-field";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { CUSTOM_FIELD_VALUE_CLEAR_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { CustomFieldTableCell } from "../custom-field-table-cell";

function renderWithFlag(node: ReactElement, enabled: boolean) {
  return render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: enabled
          ? [CUSTOM_FIELD_VALUE_CLEAR_FEATURE_FLAG_KEY]
          : [],
      })}
    >
      {node}
    </FeatureFlagAdapterProvider>
  );
}

describe("single-select ENUM cell clear (ISS-8713)", () => {
  it("clears the record's value by writing null, leaving other records alone", async () => {
    const onValueChange = vi.fn();
    renderWithFlag(
      <CustomFieldTableCell
        field={ENUM_FIELD}
        itemLabel="Session one"
        onValueChange={onValueChange}
        ownerEntityId={OWNER_ENTITY_ID}
        value={ENUM_VALUE}
      />,
      true
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Edit Severity for Session one" })
    );
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Clear Severity" })
    );

    // null — not "", not [], not the option id again. This is the delete.
    expect(onValueChange).toHaveBeenCalledWith(null);
    expect(onValueChange).toHaveBeenCalledTimes(1);
  });

  it("offers no clear while the flag is off, so the grid behaves as it does today", async () => {
    renderWithFlag(
      <CustomFieldTableCell
        field={ENUM_FIELD}
        itemLabel="Session one"
        onValueChange={vi.fn()}
        ownerEntityId={OWNER_ENTITY_ID}
        value={ENUM_VALUE}
      />,
      false
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Edit Severity for Session one" })
    );

    expect(screen.getByRole("menuitemradio", { name: "High" })).toBeVisible();
    expect(
      screen.queryByRole("menuitem", { name: "Clear Severity" })
    ).toBeNull();
  });

  it("offers no clear on a record that has no value, so 'cleared' cannot be confused with 'never set'", async () => {
    renderWithFlag(
      <CustomFieldTableCell
        field={ENUM_FIELD}
        itemLabel="Session one"
        onValueChange={vi.fn()}
        ownerEntityId={OWNER_ENTITY_ID}
      />,
      true
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Edit Severity for Session one" })
    );

    expect(
      screen.queryByRole("menuitem", { name: "Clear Severity" })
    ).toBeNull();
  });

  it("leaves MULTI_ENUM untouched — its entries already remove one at a time", async () => {
    const onValueChange = vi.fn();
    renderWithFlag(
      <CustomFieldTableCell
        field={MULTI_ENUM_FIELD}
        itemLabel="Session one"
        onValueChange={onValueChange}
        ownerEntityId={OWNER_ENTITY_ID}
        value={MULTI_ENUM_VALUE}
      />,
      true
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Edit Labels for Session one" })
    );

    expect(screen.queryByRole("menuitem", { name: "Clear Labels" })).toBeNull();

    // The non-lossy per-entry removal that already shipped still works, and
    // still writes an ARRAY rather than the null this change introduces.
    await userEvent.click(
      screen.getByRole("menuitemcheckbox", { name: "High" })
    );
    expect(onValueChange).toHaveBeenCalledWith([]);
  });
});

describe("single-select REFERENCE cell clear (ISS-8713)", () => {
  it("clears the record's reference by writing null", async () => {
    const onValueChange = vi.fn();
    renderWithFlag(
      <CustomFieldTableCell
        field={REFERENCE_FIELD}
        itemLabel="Session one"
        onValueChange={onValueChange}
        ownerEntityId={OWNER_ENTITY_ID}
        referenceOptions={[SELECTED_TARGET]}
        value={REFERENCE_VALUE}
      />,
      true
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Edit Parent work for Session one" })
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Clear Parent work" })
    );

    expect(onValueChange).toHaveBeenCalledWith(null);
    expect(onValueChange).toHaveBeenCalledTimes(1);
  });

  it("offers no clear while the flag is off", async () => {
    renderWithFlag(
      <CustomFieldTableCell
        field={REFERENCE_FIELD}
        itemLabel="Session one"
        onValueChange={vi.fn()}
        ownerEntityId={OWNER_ENTITY_ID}
        referenceOptions={[SELECTED_TARGET]}
        value={REFERENCE_VALUE}
      />,
      false
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Edit Parent work for Session one" })
    );

    expect(
      screen.queryByRole("button", { name: "Clear Parent work" })
    ).toBeNull();
  });

  it("leaves REFERENCE_MULTI untouched — its targets already toggle off", async () => {
    renderWithFlag(
      <CustomFieldTableCell
        field={REFERENCE_MULTI_FIELD}
        itemLabel="Session one"
        onValueChange={vi.fn()}
        ownerEntityId={OWNER_ENTITY_ID}
        referenceOptions={[SELECTED_TARGET]}
        value={REFERENCE_MULTI_VALUE}
      />,
      true
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Edit Related work for Session one" })
    );

    expect(
      screen.queryByRole("button", { name: "Clear Related work" })
    ).toBeNull();
  });
});

/** The session these fixtures hang off; never one of its own reference targets. */
const OWNER_ENTITY_ID = "session-1";

const BASE_FIELD: CustomFieldWithOptions = {
  createdAt: new Date("2026-08-25T12:00:00.000Z"),
  createdById: "user-1",
  currencyCode: null,
  customLabel: null,
  customLabelPosition: null,
  description: null,
  entityTypes: [CustomFieldEntityType.Session],
  enumOptions: [],
  fieldType: CustomFieldType.Number,
  id: "base-field",
  isGlobalToOrg: false,
  isSearchable: false,
  isSortable: true,
  name: "Base",
  numberFormat: NumberFormat.None,
  organizationId: "org-1",
  precision: 0,
  referenceTargetSources: [],
  showInTable: true,
  updatedAt: new Date("2026-08-25T12:00:00.000Z"),
};

const HIGH_OPTION = {
  color: "#ff0000",
  createdAt: new Date("2026-08-25T12:00:00.000Z"),
  customFieldId: "severity",
  enabled: true,
  id: "option-high",
  name: "High",
  sortOrder: 0,
};

const ENUM_FIELD: CustomFieldWithOptions = {
  ...BASE_FIELD,
  enumOptions: [HIGH_OPTION],
  fieldType: CustomFieldType.Enum,
  id: "severity",
  name: "Severity",
  numberFormat: null,
  precision: null,
};

const BASE_VALUE: CustomFieldValueDetail = {
  customFieldId: ENUM_FIELD.id,
  dateValue: null,
  displayValue: null,
  entityId: OWNER_ENTITY_ID,
  enumValue: null,
  fieldType: CustomFieldType.Enum,
  id: "value-1",
  multiEnumValues: [],
  name: ENUM_FIELD.name,
  numberValue: null,
  peopleValues: [],
  referenceValues: [],
  showInTable: true,
  textValue: null,
};

const ENUM_VALUE: CustomFieldValueDetail = {
  ...BASE_VALUE,
  displayValue: HIGH_OPTION.name,
  enumValue: HIGH_OPTION,
};

const MULTI_ENUM_FIELD: CustomFieldWithOptions = {
  ...ENUM_FIELD,
  enumOptions: [{ ...HIGH_OPTION, customFieldId: "labels" }],
  fieldType: CustomFieldType.MultiEnum,
  id: "labels",
  name: "Labels",
};

const MULTI_ENUM_VALUE: CustomFieldValueDetail = {
  ...BASE_VALUE,
  customFieldId: MULTI_ENUM_FIELD.id,
  displayValue: HIGH_OPTION.name,
  fieldType: CustomFieldType.MultiEnum,
  multiEnumValues: [{ ...HIGH_OPTION, customFieldId: "labels" }],
  name: MULTI_ENUM_FIELD.name,
};

const SELECTED_TARGET: CustomFieldReferenceTarget = {
  artifactType: ArtifactType.Session,
  id: "selected-session",
  name: "Selected session",
  slug: "SES-1",
  status: "active",
  subtype: null,
};

const REFERENCE_FIELD: CustomFieldWithOptions = {
  ...BASE_FIELD,
  fieldType: CustomFieldType.Reference,
  id: "parent-work",
  name: "Parent work",
  numberFormat: null,
  precision: null,
  referenceTargetSources: [ReferenceTargetSource.Artifact],
};

const REFERENCE_VALUE: CustomFieldValueDetail = {
  ...BASE_VALUE,
  customFieldId: REFERENCE_FIELD.id,
  displayValue: SELECTED_TARGET.slug,
  fieldType: CustomFieldType.Reference,
  name: REFERENCE_FIELD.name,
  referenceValues: [SELECTED_TARGET],
};

const REFERENCE_MULTI_FIELD: CustomFieldWithOptions = {
  ...REFERENCE_FIELD,
  fieldType: CustomFieldType.ReferenceMulti,
  id: "related-work",
  name: "Related work",
};

const REFERENCE_MULTI_VALUE: CustomFieldValueDetail = {
  ...REFERENCE_VALUE,
  customFieldId: REFERENCE_MULTI_FIELD.id,
  fieldType: CustomFieldType.ReferenceMulti,
  name: REFERENCE_MULTI_FIELD.name,
};
