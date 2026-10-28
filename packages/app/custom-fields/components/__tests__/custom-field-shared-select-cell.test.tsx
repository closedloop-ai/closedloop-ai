/**
 * ISS-9352: the production adoption of the mastered closed-list cell by the
 * Session custom-field grid — the one inline editor that mounts on BOTH the web
 * app and the Electron renderer.
 *
 * Two gates sit on this surface and they are not the same gate. The OUTER one
 * (`gridview-adoption`) picks between two whole editors; the INNER one
 * (`custom-field-value-clear`, ISS-8713) decides whether the single-select
 * editor offers a clear. Turning both off exercises neither new branch, so the
 * cases below pin outer-off, outer-on with inner OFF, and outer-on with inner
 * ON separately — otherwise the inner gate's off-branch under the new editor is
 * reached by no test at all.
 *
 * Every fixture carries TWO options with different names, so "it committed the
 * option the user picked" is observable rather than satisfied by a cell that
 * always emits the first one.
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
import {
  CUSTOM_FIELD_VALUE_CLEAR_FEATURE_FLAG_KEY,
  GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { CustomFieldTableCell } from "../custom-field-table-cell";

/** The shape the clear must never take: the ACTION rendered as the VALUE. */
const CLEAR_AS_VALUE_PATTERN = /currently Clear Severity/;

function renderWithFlags(
  node: ReactElement,
  { sharedCells, clear }: { sharedCells: boolean; clear: boolean }
) {
  const enabledFlags: string[] = [];
  if (sharedCells) {
    enabledFlags.push(GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY);
  }
  if (clear) {
    enabledFlags.push(CUSTOM_FIELD_VALUE_CLEAR_FEATURE_FLAG_KEY);
  }
  return render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({ enabledFlags })}
    >
      {node}
    </FeatureFlagAdapterProvider>
  );
}

describe("shared inline select cell adoption", () => {
  it("keeps the legacy editor while the gate is closed", () => {
    renderWithFlags(
      <CustomFieldTableCell
        field={ENUM_FIELD}
        itemLabel="Session one"
        onValueChange={vi.fn()}
        ownerEntityId={OWNER_ENTITY_ID}
        value={ENUM_VALUE}
      />,
      { sharedCells: false, clear: true }
    );

    // The legacy trigger never names the value it holds; the shared one does,
    // which is how the two are told apart without asserting on internals.
    expect(
      screen.getByRole("button", { name: "Edit Severity for Session one" })
    ).toBeInTheDocument();
  });

  it("renders the shared cell, naming the field and its current value", () => {
    renderWithFlags(
      <CustomFieldTableCell
        field={ENUM_FIELD}
        itemLabel="Session one"
        onValueChange={vi.fn()}
        ownerEntityId={OWNER_ENTITY_ID}
        value={ENUM_VALUE}
      />,
      { sharedCells: true, clear: false }
    );

    const trigger = screen.getByRole("button", {
      name: "Edit Severity for Session one, currently High",
    });
    expect(trigger).toBeInTheDocument();
    // Grid keyboard entry lands on the cell's declared primary editor; losing
    // the marker would silently take Enter-to-edit away from this column.
    expect(trigger).toHaveAttribute("data-grid-primary-editor");
  });

  it("commits the option the user picked", async () => {
    const onValueChange = vi.fn();
    renderWithFlags(
      <CustomFieldTableCell
        field={ENUM_FIELD}
        itemLabel="Session one"
        onValueChange={onValueChange}
        ownerEntityId={OWNER_ENTITY_ID}
        value={ENUM_VALUE}
      />,
      { sharedCells: true, clear: false }
    );

    await userEvent.click(
      screen.getByRole("button", {
        name: "Edit Severity for Session one, currently High",
      })
    );
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Low" }));

    expect(onValueChange).toHaveBeenCalledWith(LOW_OPTION.id);
  });

  it("puts the previous option back when the write is refused", async () => {
    const onValueChange = vi
      .fn()
      .mockRejectedValue(new Error("the server refused it"));
    renderWithFlags(
      <CustomFieldTableCell
        field={ENUM_FIELD}
        itemLabel="Session one"
        onValueChange={onValueChange}
        ownerEntityId={OWNER_ENTITY_ID}
        value={ENUM_VALUE}
      />,
      { sharedCells: true, clear: false }
    );

    await userEvent.click(
      screen.getByRole("button", {
        name: "Edit Severity for Session one, currently High",
      })
    );
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Low" }));

    // The capability the legacy editor never had: a cell still showing "Low"
    // after the PUT failed tells the reader a value was saved that was not.
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: "Edit Severity for Session one, currently High",
        })
      ).toBeInTheDocument()
    );
  });

  it("offers no clear under the shared cell while the clear gate is closed", async () => {
    renderWithFlags(
      <CustomFieldTableCell
        field={ENUM_FIELD}
        itemLabel="Session one"
        onValueChange={vi.fn()}
        ownerEntityId={OWNER_ENTITY_ID}
        value={ENUM_VALUE}
      />,
      { sharedCells: true, clear: false }
    );

    await userEvent.click(
      screen.getByRole("button", {
        name: "Edit Severity for Session one, currently High",
      })
    );

    expect(
      screen.queryByRole("menuitem", { name: CLEAR_SEVERITY_LABEL })
    ).not.toBeInTheDocument();
  });

  it("keeps the clear, writing null, when both gates are open", async () => {
    const onValueChange = vi.fn();
    renderWithFlags(
      <CustomFieldTableCell
        field={ENUM_FIELD}
        itemLabel="Session one"
        onValueChange={onValueChange}
        ownerEntityId={OWNER_ENTITY_ID}
        value={ENUM_VALUE}
      />,
      { sharedCells: true, clear: true }
    );

    await userEvent.click(
      screen.getByRole("button", {
        name: "Edit Severity for Session one, currently High",
      })
    );
    await userEvent.click(
      screen.getByRole("menuitem", { name: CLEAR_SEVERITY_LABEL })
    );

    // `null` deletes the row; `[]` would leave a present-but-empty value.
    expect(onValueChange).toHaveBeenCalledWith(null);
    // And the cell must never show the ACTION where the value belongs. A clear
    // routed through the option list renders "Clear Severity" as the field's
    // value — and announces it — for as long as the PUT and the refetch take.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Set Severity for Session one" })
      ).toBeInTheDocument()
    );
    expect(
      screen.queryByRole("button", {
        name: CLEAR_AS_VALUE_PATTERN,
      })
    ).not.toBeInTheDocument();
  });

  it("offers the clear as an action, never as a fourth value", async () => {
    renderWithFlags(
      <CustomFieldTableCell
        field={ENUM_FIELD}
        itemLabel="Session one"
        onValueChange={vi.fn()}
        ownerEntityId={OWNER_ENTITY_ID}
        value={ENUM_VALUE}
      />,
      { sharedCells: true, clear: true }
    );

    await userEvent.click(
      screen.getByRole("button", {
        name: "Edit Severity for Session one, currently High",
      })
    );

    // A radio announces as one of the field's values and paints a selected
    // indicator while the write is in flight; the legacy editor used a plain
    // separated item and that semantic is preserved.
    expect(
      screen.getByRole("menuitem", { name: CLEAR_SEVERITY_LABEL })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("menuitemradio", { name: CLEAR_SEVERITY_LABEL })
    ).not.toBeInTheDocument();
  });

  it("renders the record's own value, not an option lookup", () => {
    // An option the record still holds but the field definition no longer
    // offers: resolving display from `options` would blank a cell that has data
    // in it, and drop the multi-select's chips and measured overflow with it.
    renderWithFlags(
      <CustomFieldTableCell
        field={{ ...ENUM_FIELD, enumOptions: [LOW_OPTION] }}
        itemLabel="Session one"
        onValueChange={vi.fn()}
        ownerEntityId={OWNER_ENTITY_ID}
        value={ENUM_VALUE}
      />,
      { sharedCells: true, clear: false }
    );

    expect(
      screen.getByRole("button", {
        name: "Edit Severity for Session one, currently High",
      })
    ).toBeInTheDocument();
    expect(screen.getByText("High")).toBeInTheDocument();
  });

  it("offers no clear on a field that holds nothing", async () => {
    // `canClear` is three conjuncts and only the gate was exercised. A clear on
    // an empty cell writes `null` over nothing and offers a destructive action
    // for a value that is not there.
    renderWithFlags(
      <CustomFieldTableCell
        field={ENUM_FIELD}
        itemLabel="Session one"
        onValueChange={vi.fn()}
        ownerEntityId={OWNER_ENTITY_ID}
      />,
      { sharedCells: true, clear: true }
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Set Severity for Session one" })
    );

    expect(
      screen.queryByRole("menuitem", { name: CLEAR_SEVERITY_LABEL })
    ).not.toBeInTheDocument();
  });

  it("commits the whole next set for a multi-select field", async () => {
    const onValueChange = vi.fn();
    renderWithFlags(
      <CustomFieldTableCell
        field={MULTI_ENUM_FIELD}
        itemLabel="Session one"
        onValueChange={onValueChange}
        ownerEntityId={OWNER_ENTITY_ID}
        value={MULTI_ENUM_VALUE}
      />,
      { sharedCells: true, clear: false }
    );

    await userEvent.click(
      screen.getByRole("button", {
        name: "Edit Labels for Session one, currently High",
      })
    );
    await userEvent.click(
      screen.getByRole("menuitemcheckbox", { name: "Low" })
    );

    expect(onValueChange).toHaveBeenCalledWith([HIGH_OPTION.id, LOW_OPTION.id]);
  });
});

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
  updatedAt: new Date("2026-08-25T12:00:00.000Z"),
};

const LOW_OPTION = {
  ...HIGH_OPTION,
  id: "option-low",
  name: "Low",
  sortOrder: 1,
};

const ENUM_FIELD: CustomFieldWithOptions = {
  ...BASE_FIELD,
  enumOptions: [HIGH_OPTION, LOW_OPTION],
  fieldType: CustomFieldType.Enum,
  id: "severity",
  name: "Severity",
  numberFormat: null,
  precision: null,
};

/**
 * Built from the fixture the way the component builds it (`Clear ${field.name}`)
 * rather than re-typed: an absence assertion holding its own copy of the words
 * matches nothing once the copy is reworded, so the regression it exists to
 * catch — the clear coming back while its gate is closed — would pass.
 */
const CLEAR_SEVERITY_LABEL = `Clear ${ENUM_FIELD.name}`;

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
  enumOptions: [
    { ...HIGH_OPTION, customFieldId: "labels" },
    { ...LOW_OPTION, customFieldId: "labels" },
  ],
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
