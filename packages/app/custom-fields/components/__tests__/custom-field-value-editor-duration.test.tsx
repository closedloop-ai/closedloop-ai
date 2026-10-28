/**
 * ISS-7210 — DURATION-formatted NUMBER fields get a human-span text editor
 * instead of the raw-milliseconds numeric input, gated by the same
 * ISS-4779 closed-by-default flag as the "Duration" radio in
 * number-format-config.tsx (CUSTOM_FIELD_DURATION_FORMAT_FEATURE_FLAG_KEY,
 * declared in shared/lib/feature-flags.ts since ISS-8213).
 *
 * Covers: flag-off falls back to the plain numeric editor even for a
 * DURATION field; the parse round trip on submit; a stored 0 renders "0s"
 * while an unset value renders empty (distinct, per the storage contract in
 * custom-field-duration.ts); and unparseable input surfaces an error and
 * never submits.
 */
import type { CustomFieldSettingWithOptions } from "@repo/api/src/types/custom-field";
import {
  CustomFieldEntityType,
  CustomFieldType,
  NumberFormat,
} from "@repo/api/src/types/custom-field";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { CUSTOM_FIELD_DURATION_FORMAT_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeatureFlagAdapterProvider } from "../../../shared/feature-flags/provider";
import { CustomFieldValueEditor } from "../custom-field-value-editor";

const mockMutate = vi.fn();
const ISNT_A_DURATION_RE = /isn't a duration/i;

vi.mock("@repo/app/custom-fields/hooks/use-custom-fields", () => ({
  useUpdateCustomFieldValue: () => ({
    mutate: mockMutate,
    isPending: false,
    isError: false,
    isSuccess: false,
    isIdle: true,
    error: null,
    data: undefined,
    reset: vi.fn(),
    status: "idle",
  }),
}));

function makeDurationSetting(): CustomFieldSettingWithOptions {
  return {
    id: "setting-1",
    customFieldId: "field-1",
    entityType: CustomFieldEntityType.Project,
    entityId: "proj-1",
    isImportant: false,
    isRequired: false,
    sortOrder: 0,
    createdAt: new Date(),
    customField: {
      id: "field-1",
      organizationId: "org-1",
      name: "Cycle time",
      description: null,
      fieldType: CustomFieldType.Number,
      createdById: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      precision: null,
      numberFormat: NumberFormat.Duration,
      currencyCode: null,
      customLabel: null,
      customLabelPosition: null,
      isGlobalToOrg: false,
      entityTypes: [CustomFieldEntityType.Project],
      showInTable: false,
      isSearchable: false,
      isSortable: false,
      referenceTargetSources: [],
      enumOptions: [],
    },
  };
}

function renderEditor(
  enabledFlags: readonly string[],
  value?: Parameters<typeof CustomFieldValueEditor>[0]["value"]
) {
  return render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({ enabledFlags })}
    >
      <CustomFieldValueEditor
        entityId="proj-1"
        entityType={CustomFieldEntityType.Project}
        setting={makeDurationSetting()}
        value={value}
      />
    </FeatureFlagAdapterProvider>
  );
}

describe("CustomFieldValueEditor — DURATION format", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back to the plain numeric editor for a DURATION field when the flag is off", () => {
    renderEditor([]);

    const input = screen.getByRole("textbox", { name: "Cycle time" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "4320000" } });
    fireEvent.blur(input);

    // Flag off: no span parsing — raw numeric input, same as any other NUMBER field.
    expect(mockMutate).toHaveBeenCalledWith({
      fieldId: "field-1",
      value: 4_320_000,
    });
  });

  it("parses a human span and submits whole milliseconds", () => {
    renderEditor([CUSTOM_FIELD_DURATION_FORMAT_FEATURE_FLAG_KEY]);

    const input = screen.getByRole("textbox", { name: "Cycle time" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "1h 12m" } });
    fireEvent.blur(input);

    expect(mockMutate).toHaveBeenCalledWith({
      fieldId: "field-1",
      value: 4_320_000,
    });
  });

  it("renders a stored 0 as '0s'", () => {
    renderEditor([CUSTOM_FIELD_DURATION_FORMAT_FEATURE_FLAG_KEY], {
      id: "v1",
      customFieldId: "field-1",
      entityId: "proj-1",
      name: "Cycle time",
      fieldType: CustomFieldType.Number,
      displayValue: null,
      showInTable: false,
      textValue: null,
      numberValue: 0,
      dateValue: null,
      enumValue: null,
      multiEnumValues: [],
      peopleValues: [],
      referenceValues: [],
    });

    const input = screen.getByRole("textbox", {
      name: "Cycle time",
    }) as HTMLInputElement;
    expect(input.value).toBe("0s");
  });

  it("renders an unset value as empty, distinct from a stored 0", () => {
    renderEditor([CUSTOM_FIELD_DURATION_FORMAT_FEATURE_FLAG_KEY]);

    const input = screen.getByRole("textbox", {
      name: "Cycle time",
    }) as HTMLInputElement;
    expect(input.value).toBe("");
  });

  it("clears the value on blur when input is emptied", () => {
    renderEditor([CUSTOM_FIELD_DURATION_FORMAT_FEATURE_FLAG_KEY], {
      id: "v1",
      customFieldId: "field-1",
      entityId: "proj-1",
      name: "Cycle time",
      fieldType: CustomFieldType.Number,
      displayValue: null,
      showInTable: false,
      textValue: null,
      numberValue: 4_320_000,
      dateValue: null,
      enumValue: null,
      multiEnumValues: [],
      peopleValues: [],
      referenceValues: [],
    });

    const input = screen.getByRole("textbox", { name: "Cycle time" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);

    expect(mockMutate).toHaveBeenCalledWith({
      fieldId: "field-1",
      value: null,
    });
  });

  it("surfaces an error and does not submit on unparseable input", () => {
    renderEditor([CUSTOM_FIELD_DURATION_FORMAT_FEATURE_FLAG_KEY]);

    const input = screen.getByRole("textbox", { name: "Cycle time" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "not a duration" } });
    fireEvent.blur(input);

    expect(mockMutate).not.toHaveBeenCalled();
    expect(input).toHaveAccessibleDescription(ISNT_A_DURATION_RE);
    expect(screen.getByRole("alert")).toHaveTextContent(ISNT_A_DURATION_RE);
    expect(input).toHaveAttribute("aria-invalid", "true");
  });
});
