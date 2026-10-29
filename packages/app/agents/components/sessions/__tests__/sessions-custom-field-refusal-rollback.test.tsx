/**
 * ISS-9352 — the HOST half of the production wiring, which the cell's own suite
 * cannot reach.
 *
 * `custom-field-shared-select-cell.test.tsx` renders `CustomFieldTableCell`
 * directly, so it proves the cell rolls back a refused write given a promise.
 * It says nothing about whether the Sessions surface actually HANDS the cell
 * that promise — and until this ticket the host deliberately swallowed it, so
 * deleting the pass-through would leave that suite green while every real
 * Session column silently kept showing a value the server refused.
 *
 * This drives `renderSessionsCustomFieldCell` with a rejecting controller and
 * asserts what the grid shows afterwards.
 */

import type {
  CustomFieldValueDetail,
  CustomFieldWithOptions,
} from "@repo/api/src/types/custom-field";
import {
  CustomFieldEntityType,
  CustomFieldType,
  NumberFormat,
} from "@repo/api/src/types/custom-field";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionTableRowFixture } from "../session-list-fixtures";
import { renderSessionsCustomFieldCell } from "../sessions-list-custom-fields";

afterEach(cleanup);

describe("PRD-722 AC-5 DT-021 DT-023 Session refused-write rollback", () => {
  it("puts the previous option back when the controller's mutation rejects", async () => {
    const onValueChange = vi
      .fn()
      .mockRejectedValue(new Error("the server refused it"));
    const row = createSessionTableRowFixture({ id: "session-1" });

    render(
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({
          enabledFlags: [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY],
        })}
      >
        {renderSessionsCustomFieldCell({
          controller: {
            fields: [SEVERITY_FIELD],
            onValueChange,
            valuesBySessionId: new Map([["session-1", [SEVERITY_VALUE]]]),
          },
          field: SEVERITY_FIELD,
          row,
        })}
      </FeatureFlagAdapterProvider>
    );

    const trigger = screen.getByRole("button", {
      name: `Edit Severity for ${row.name}, currently High`,
    });
    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Low" }));

    expect(onValueChange).toHaveBeenCalledWith(
      row,
      SEVERITY_FIELD,
      "option-low"
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: `Edit Severity for ${row.name}, currently High`,
        })
      ).toBeInTheDocument()
    );
  });
});

const HIGH_OPTION = {
  color: "#ff0000",
  createdAt: new Date("2026-08-25T12:00:00.000Z"),
  customFieldId: "severity",
  enabled: true,
  id: "option-high",
  name: "High",
  sortOrder: 0,
  updatedAt: new Date("2026-08-25T12:00:00.000Z"),
};

const LOW_OPTION = {
  ...HIGH_OPTION,
  id: "option-low",
  name: "Low",
  sortOrder: 1,
};

const SEVERITY_FIELD: CustomFieldWithOptions = {
  createdAt: new Date("2026-08-25T12:00:00.000Z"),
  createdById: "user-1",
  currencyCode: null,
  customLabel: null,
  customLabelPosition: null,
  description: null,
  entityTypes: [CustomFieldEntityType.Session],
  enumOptions: [HIGH_OPTION, LOW_OPTION],
  fieldType: CustomFieldType.Enum,
  id: "severity",
  isGlobalToOrg: false,
  isSearchable: false,
  isSortable: true,
  name: "Severity",
  numberFormat: NumberFormat.None,
  organizationId: "org-1",
  precision: null,
  referenceTargetSources: [],
  showInTable: true,
  updatedAt: new Date("2026-08-25T12:00:00.000Z"),
};

const SEVERITY_VALUE: CustomFieldValueDetail = {
  customFieldId: SEVERITY_FIELD.id,
  dateValue: null,
  displayValue: HIGH_OPTION.name,
  entityId: "session-1",
  enumValue: HIGH_OPTION,
  fieldType: CustomFieldType.Enum,
  id: "value-1",
  multiEnumValues: [],
  name: SEVERITY_FIELD.name,
  numberValue: null,
  peopleValues: [],
  referenceValues: [],
  showInTable: true,
  textValue: null,
};
