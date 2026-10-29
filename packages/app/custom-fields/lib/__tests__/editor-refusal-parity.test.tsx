import type {
  CustomFieldValueDetail,
  CustomFieldWithOptions,
} from "@repo/api/src/types/custom-field";
import {
  CustomFieldEntityType,
  CustomFieldType,
  NumberFormat,
} from "@repo/api/src/types/custom-field";
import { InlineCustomFieldCell } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-custom-field-cell";
import { INLINE_SCALAR_NUMBER_INVALID_MESSAGE } from "@repo/app/shared/lib/inline-scalar-invalid-message";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { CustomFieldTableCell } from "../../components/custom-field-table-cell";

/**
 * ISS-9590 — two editors, one sentence.
 *
 * The champion (`InlineScalarCell`, through its preview adapter) and the
 * hand-rolled grid cell refuse an unparseable number by completely different
 * routes: the champion reads the browser's `validity.badInput` on a numeric
 * input, the grid cell runs the custom-field codec over a text input. Before
 * this ticket they also answered differently — the grid cell said
 * "Enter a valid number" and the champion said NOTHING, because
 * `invalidMessage` was optional and no adapter passed one.
 *
 * Asserting they agree with EACH OTHER is what catches a future editor that
 * stops reading the map; asserting they agree with the map is what catches both
 * drifting together. Neither assertion holds its own copy of the words.
 */
afterEach(cleanup);

type ValidationRefusal = {
  describedText: string;
  draft: string;
  hasAlert: boolean;
  invalid: boolean;
  retainsFocus: boolean;
};

/** The champion's route: a numeric input the browser could not parse. */
function refuseThroughChampion(): ValidationRefusal {
  render(
    <InlineCustomFieldCell
      ariaLabel="Edit Estimate"
      initialValue="7"
      type="number"
    />
  );
  const field = screen.getByRole<HTMLInputElement>("spinbutton", {
    name: "Edit Estimate",
  });
  field.focus();
  // jsdom computes no validity, so the state a browser reports for "12e" is
  // stated directly. The cell reads it on every native input.
  Object.defineProperty(field, "validity", {
    configurable: true,
    value: { badInput: true },
  });
  fireEvent.input(field);
  return readValidationRefusal(field);
}

/** The grid cell's route: the custom-field codec refusing a text draft. */
async function refuseThroughGridCell(): Promise<ValidationRefusal> {
  render(
    <CustomFieldTableCell
      field={NUMBER_FIELD}
      itemLabel="Session one"
      onValueChange={() => undefined}
      ownerEntityId="session-1"
      value={NUMBER_VALUE}
    />
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Edit Estimate for Session one" })
  );
  const input = screen.getByRole<HTMLInputElement>("textbox", {
    name: "Edit Estimate for Session one",
  });
  await userEvent.clear(input);
  await userEvent.type(input, "12e");
  fireEvent.keyDown(input, { key: "Enter" });
  return readValidationRefusal(input);
}

describe("an unparseable number, refused by two different editors", () => {
  it("PRD-722 DT-015 DT-033 keeps both validation drafts active with an adjacent live alert", async () => {
    const fromGridCell = await refuseThroughGridCell();
    cleanup();
    const fromChampion = refuseThroughChampion();

    expect(fromChampion.describedText).toBe(fromGridCell.describedText);
    expect(fromGridCell).toEqual({
      describedText: INLINE_SCALAR_NUMBER_INVALID_MESSAGE,
      draft: "12e",
      hasAlert: true,
      invalid: true,
      retainsFocus: true,
    });
    expect(fromChampion).toEqual({
      describedText: INLINE_SCALAR_NUMBER_INVALID_MESSAGE,
      draft: "7",
      hasAlert: true,
      invalid: true,
      retainsFocus: true,
    });
  });

  it("is refused in the words the canonical map holds", async () => {
    const fromGridCell = await refuseThroughGridCell();

    expect(fromGridCell.describedText).toBe(
      INLINE_SCALAR_NUMBER_INVALID_MESSAGE
    );
  });

  // The words themselves, written out rather than read back from the map, for
  // the same reason `value-rejection-message.test.ts` writes them out: a
  // fixture built from the map agrees with a reworded map.
  it("says what the grid cell already shipped", () => {
    expect(INLINE_SCALAR_NUMBER_INVALID_MESSAGE).toBe("Enter a valid number");
  });
});

function readValidationRefusal(input: HTMLInputElement): ValidationRefusal {
  const describedBy = input.getAttribute("aria-describedby");
  return {
    describedText:
      (describedBy && document.getElementById(describedBy)?.textContent) || "",
    draft: input.value,
    hasAlert: screen.queryByRole("alert") !== null,
    invalid: input.getAttribute("aria-invalid") === "true",
    retainsFocus: document.activeElement === input,
  };
}

const NUMBER_FIELD: CustomFieldWithOptions = {
  createdAt: new Date("2026-08-25T12:00:00.000Z"),
  createdById: "user-1",
  currencyCode: null,
  customLabel: null,
  customLabelPosition: null,
  description: null,
  entityTypes: [CustomFieldEntityType.Session],
  enumOptions: [],
  fieldType: CustomFieldType.Number,
  id: "estimate",
  isGlobalToOrg: false,
  isSearchable: false,
  isSortable: true,
  name: "Estimate",
  numberFormat: NumberFormat.None,
  organizationId: "org-1",
  precision: 0,
  referenceTargetSources: [],
  showInTable: true,
  updatedAt: new Date("2026-08-25T12:00:00.000Z"),
};

const NUMBER_VALUE: CustomFieldValueDetail = {
  customFieldId: NUMBER_FIELD.id,
  dateValue: null,
  displayValue: "12",
  entityId: "session-1",
  enumValue: null,
  fieldType: CustomFieldType.Number,
  id: "value-1",
  multiEnumValues: [],
  name: NUMBER_FIELD.name,
  numberValue: 12,
  peopleValues: [],
  referenceValues: [],
  showInTable: true,
  textValue: null,
};
