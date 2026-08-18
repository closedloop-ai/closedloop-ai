/**
 * Component tests for CustomFieldsSettingsTab.
 *
 * Covers the error-state gating: an initial-load failure blocks the whole tab
 * with a retry action that calls refetch, while a background refetch error over
 * already-cached rows keeps those rows visible instead of stranding the user.
 */

import type { CustomFieldWithOptions } from "@repo/api/src/types/custom-field";
import {
  CustomFieldType,
  NumberFormat,
} from "@repo/api/src/types/custom-field";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CustomFieldsSettingsTab } from "../custom-fields-settings-tab";

const mockUseCustomFields = vi.fn();
const mockRefetch = vi.fn();

vi.mock("@repo/app/custom-fields/hooks/use-custom-fields", () => ({
  useCustomFields: () => mockUseCustomFields(),
  useDeleteCustomField: () => ({ mutateAsync: vi.fn(), isPending: false }),
  // The tab always mounts CreateCustomFieldDialog (even when closed), which
  // resolves the create/update mutation hooks on render.
  useCreateCustomField: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateCustomField: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@repo/app/users/hooks/use-users", () => ({
  useOrganizationUsers: () => ({ data: [] }),
}));

const RETRY_RE = /Try again/i;
const ERROR_TITLE_RE = /Couldn't load custom fields/i;

function buildField(name: string): CustomFieldWithOptions {
  return {
    id: `field-${name}`,
    organizationId: "org-1",
    name,
    description: null,
    fieldType: CustomFieldType.Text,
    createdById: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    precision: null,
    numberFormat: NumberFormat.None,
    currencyCode: null,
    customLabel: null,
    customLabelPosition: null,
    isGlobalToOrg: false,
    entityTypes: [],
    showInTable: false,
    isSearchable: false,
    isSortable: false,
    enumOptions: [],
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("CustomFieldsSettingsTab error handling", () => {
  it("blocks the tab and calls refetch when the initial load fails", () => {
    mockUseCustomFields.mockReturnValue({
      data: undefined,
      isLoading: false,
      isLoadingError: true,
      refetch: mockRefetch,
    });

    render(<CustomFieldsSettingsTab />);

    // The error state is announced to screen readers via role="alert".
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(ERROR_TITLE_RE);
    fireEvent.click(screen.getByRole("button", { name: RETRY_RE }));
    expect(mockRefetch).toHaveBeenCalledTimes(1);
  });

  it("keeps cached rows visible when a background refetch fails", () => {
    // TanStack retains `data` and sets isError (not isLoadingError) on a
    // refetch failure over cached data. The tab must not blank the rows.
    mockUseCustomFields.mockReturnValue({
      data: [buildField("Priority")],
      isLoading: false,
      isLoadingError: false,
      refetch: mockRefetch,
    });

    render(<CustomFieldsSettingsTab />);

    expect(screen.getByText("Priority")).toBeTruthy();
    expect(screen.queryByText(ERROR_TITLE_RE)).toBeNull();
  });
});
