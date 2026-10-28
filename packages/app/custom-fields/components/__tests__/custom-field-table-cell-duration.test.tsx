/**
 * ISS-8213 — a DURATION custom field is edited in the grid through the duration
 * parser, in the same unit as the detail-panel editor and the API.
 *
 * The cell used to send `Number(draft)` for every NUMBER field. A duration is a
 * NUMBER field whose canonical storage unit is milliseconds, so that refused
 * "1h 12m" outright and read a bare `90` as 90 MILLISECONDS — while
 * `DurationFieldEditor` and `coerceCustomFieldDurationMs` on the server both
 * read the same `90` as 90 SECONDS. One field, two units, depending on which
 * surface the user happened to type into.
 *
 * The three cases below are the three sentences in the ticket's expected
 * behaviour, plus the flag-off arm: `Number(draft)` is still exactly what a
 * DURATION field gets while the closed-by-default gate is shut, so the gate is
 * proved to be a gate rather than a comment.
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
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { CUSTOM_FIELD_DURATION_FORMAT_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FeatureFlagAdapterProvider } from "../../../shared/feature-flags/provider";
import { CustomFieldTableCell } from "../custom-field-table-cell";

const EDIT_LABEL = "Edit Cycle time for Session one";
const NOT_A_DURATION_PATTERN = /isn't a duration/i;

const DURATION_FIELD: CustomFieldWithOptions = {
  createdAt: new Date("2026-08-25T12:00:00.000Z"),
  createdById: "user-1",
  currencyCode: null,
  customLabel: null,
  customLabelPosition: null,
  description: null,
  entityTypes: [CustomFieldEntityType.Session],
  enumOptions: [],
  fieldType: CustomFieldType.Number,
  id: "cycle-time",
  isGlobalToOrg: false,
  isSearchable: false,
  isSortable: true,
  name: "Cycle time",
  numberFormat: NumberFormat.Duration,
  organizationId: "org-1",
  precision: 0,
  referenceTargetSources: [],
  showInTable: true,
  updatedAt: new Date("2026-08-25T12:00:00.000Z"),
};

const DURATION_VALUE: CustomFieldValueDetail = {
  customFieldId: DURATION_FIELD.id,
  dateValue: null,
  entityId: "session-1",
  displayValue: "1h 12m",
  enumValue: null,
  fieldType: CustomFieldType.Number,
  id: "cycle-time-value",
  multiEnumValues: [],
  name: DURATION_FIELD.name,
  numberValue: 4_320_000,
  peopleValues: [],
  referenceValues: [],
  showInTable: true,
  textValue: null,
};

async function openDurationCell(
  enabledFlags: readonly string[],
  value?: CustomFieldValueDetail
) {
  const onValueChange = vi.fn();
  render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({ enabledFlags })}
    >
      <CustomFieldTableCell
        field={DURATION_FIELD}
        itemLabel="Session one"
        onValueChange={onValueChange}
        ownerEntityId="session-1"
        value={value}
      />
    </FeatureFlagAdapterProvider>
  );

  await userEvent.click(screen.getByRole("button", { name: EDIT_LABEL }));
  return {
    input: screen.getByRole("textbox", { name: EDIT_LABEL }),
    onValueChange,
  };
}

function commit(input: HTMLElement, text: string) {
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: "Enter" });
}

describe("CustomFieldTableCell DURATION editing (ISS-8213)", () => {
  it("stores a human span as whole milliseconds", async () => {
    const { input, onValueChange } = await openDurationCell([
      CUSTOM_FIELD_DURATION_FORMAT_FEATURE_FLAG_KEY,
    ]);

    commit(input, "1h 12m");

    expect(onValueChange).toHaveBeenLastCalledWith(4_320_000);
  });

  it("reads a bare number as SECONDS, matching the duration parser", async () => {
    const { input, onValueChange } = await openDurationCell([
      CUSTOM_FIELD_DURATION_FORMAT_FEATURE_FLAG_KEY,
    ]);

    // The unit defect in one assertion: `Number(draft)` committed 90 here.
    commit(input, "90");

    expect(onValueChange).toHaveBeenLastCalledWith(90_000);
  });

  it("opens on the stored span rather than raw milliseconds", async () => {
    const { input } = await openDurationCell(
      [CUSTOM_FIELD_DURATION_FORMAT_FEATURE_FLAG_KEY],
      DURATION_VALUE
    );

    expect(input).toHaveValue("1h 12m");
  });

  it("refuses unparseable text and keeps it on screen instead of clearing", async () => {
    const { input, onValueChange } = await openDurationCell([
      CUSTOM_FIELD_DURATION_FORMAT_FEATURE_FLAG_KEY,
    ]);

    commit(input, "not a duration");

    expect(onValueChange).not.toHaveBeenCalled();
    expect(input).toHaveAccessibleDescription(NOT_A_DURATION_PATTERN);
    expect(screen.getByRole("alert")).toHaveTextContent(NOT_A_DURATION_PATTERN);
    expect(input).toHaveValue("not a duration");
  });

  it("clears the value when the user empties the cell", async () => {
    const { input, onValueChange } = await openDurationCell(
      [CUSTOM_FIELD_DURATION_FORMAT_FEATURE_FLAG_KEY],
      DURATION_VALUE
    );

    commit(input, "");

    expect(onValueChange).toHaveBeenLastCalledWith(null);
  });

  // codex P1 (PR #7220). The draft is a RENDERING of the stored value: a
  // duration caps at two units, so a stored 4,350,500 ms opens as "1h 12m" and
  // re-parses to 4,320,000. Committing on a blur the user never typed into
  // silently rewrote the row to that rounded number — still a plausible
  // measurement, and 500 ms further from the truth on every open.
  it("does not rewrite an exact stored value on an untouched blur", async () => {
    const { input, onValueChange } = await openDurationCell(
      [CUSTOM_FIELD_DURATION_FORMAT_FEATURE_FLAG_KEY],
      { ...DURATION_VALUE, numberValue: 4_350_500 }
    );

    expect(input).toHaveValue("1h 12m");
    fireEvent.blur(input);

    expect(onValueChange).not.toHaveBeenCalled();

    // Positive control on the SAME cell and the same blur: an edited draft
    // still commits, so the assertion above is the untouched case and not a
    // commit path that stopped working.
    await userEvent.click(screen.getByRole("button", { name: EDIT_LABEL }));
    const reopened = screen.getByRole("textbox", { name: EDIT_LABEL });
    fireEvent.change(reopened, { target: { value: "1h 12m 30s" } });
    fireEvent.blur(reopened);

    expect(onValueChange).toHaveBeenCalledExactlyOnceWith(4_350_000);
  });

  it("still commits raw milliseconds while the gate is shut", async () => {
    // The flag-off arm, asserted so the closed-by-default gate is a gate: with
    // it shut a DURATION field is an ordinary NUMBER field, byte-identical to
    // the behaviour that shipped.
    const { input, onValueChange } = await openDurationCell([]);

    commit(input, "4320000");

    expect(onValueChange).toHaveBeenLastCalledWith(4_320_000);
  });
});
