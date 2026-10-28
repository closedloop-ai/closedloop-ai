import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import type {
  CustomFieldValueDetail,
  CustomFieldWithOptions,
} from "@repo/api/src/types/custom-field";
import {
  CustomFieldEntityType,
  CustomFieldType,
  NumberFormat,
} from "@repo/api/src/types/custom-field";
import { INLINE_SCALAR_NUMBER_INVALID_MESSAGE } from "@repo/app/shared/lib/inline-scalar-invalid-message";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CustomFieldsSection } from "../custom-fields-section";

const mockMutate = vi.fn();
const mockUseUpdateCustomFieldValue = vi.fn((..._args: unknown[]) => ({
  mutate: mockMutate,
  isPending: false,
  isError: false,
  isSuccess: false,
  isIdle: true,
  error: null,
  data: undefined,
  reset: vi.fn(),
  status: "idle",
}));

const SCORE_FIELD: CustomFieldWithOptions = {
  id: "field-score",
  organizationId: "org-1",
  name: "Score",
  description: null,
  fieldType: CustomFieldType.Number,
  createdById: null,
  createdAt: new Date("2026-08-25T12:00:00.000Z"),
  updatedAt: new Date("2026-08-25T12:00:00.000Z"),
  precision: null,
  numberFormat: NumberFormat.None,
  currencyCode: null,
  customLabel: null,
  customLabelPosition: null,
  isGlobalToOrg: false,
  entityTypes: [CustomFieldEntityType.Project],
  referenceTargetSources: [],
  showInTable: false,
  isSearchable: false,
  isSortable: false,
  enumOptions: [],
};

vi.mock("@repo/app/custom-fields/hooks/use-custom-fields", () => ({
  useCustomFieldsForEntityType: () => ({ data: [SCORE_FIELD] }),
  useUpdateCustomFieldValue: (...args: unknown[]) =>
    mockUseUpdateCustomFieldValue(...args),
}));

function scoreValue(
  entityId: string,
  numberValue: number
): CustomFieldValueDetail {
  return {
    id: `value-${entityId}`,
    customFieldId: SCORE_FIELD.id,
    entityId,
    name: SCORE_FIELD.name,
    fieldType: CustomFieldType.Number,
    showInTable: false,
    numberValue,
    displayValue: String(numberValue),
    textValue: null,
    dateValue: null,
    enumValue: null,
    multiEnumValues: [],
    peopleValues: [],
    referenceValues: [],
  };
}

describe("CustomFieldsSection", () => {
  beforeEach(() => {
    mockMutate.mockClear();
    mockUseUpdateCustomFieldValue.mockClear();
  });

  it("passes the known detail surface into the value write adapter", () => {
    render(
      <CustomFieldsSection
        entityId="issue-a"
        entityType={CustomFieldEntityType.Document}
        surface={ArtifactStatusEditSurface.Detail}
        values={[scoreValue("issue-a", 3)]}
      />
    );
    fireEvent.click(screen.getByRole("button", { expanded: false }));

    expect(mockUseUpdateCustomFieldValue).toHaveBeenCalledWith(
      CustomFieldEntityType.Document,
      "issue-a",
      ArtifactStatusEditSurface.Detail
    );
  });

  // A prop-driven rerender with a new entityId remounts every editor (the key
  // carries the entity identity), so a rejected draft for entity A cannot
  // survive onto entity B. This pins the key contract; it does not drive a
  // route navigation.
  it("discards a rejected number draft when the entity changes", () => {
    const { rerender } = render(
      <CustomFieldsSection
        entityId="proj-a"
        entityType={CustomFieldEntityType.Project}
        values={[scoreValue("proj-a", 3)]}
      />
    );
    fireEvent.click(screen.getByRole("button", { expanded: false }));

    const input = screen.getByRole("textbox", { name: "Score" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "1e999" } });
    fireEvent.blur(input);

    expect(screen.getByRole("alert")).toHaveTextContent(
      INLINE_SCALAR_NUMBER_INVALID_MESSAGE
    );
    expect(mockMutate).not.toHaveBeenCalled();

    rerender(
      <CustomFieldsSection
        entityId="proj-b"
        entityType={CustomFieldEntityType.Project}
        values={[scoreValue("proj-b", 7)]}
      />
    );

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Score" })).toHaveValue("7");
    expect(mockMutate).not.toHaveBeenCalled();
  });
});
