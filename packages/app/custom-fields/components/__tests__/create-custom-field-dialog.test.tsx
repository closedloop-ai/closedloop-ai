/**
 * Component tests for CreateCustomFieldDialog.
 *
 * Covers the "Applies to" checkbox + "Display options" switch wiring: clicking
 * an entity label and a display-option label updates the controls and the
 * submitted create payload reflects those choices.
 */

import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CreateCustomFieldDialog } from "../create-custom-field-dialog";

const mockCreateMutate = vi.fn();
const mockUpdateMutate = vi.fn();

// Default fieldType is Text, so only the create/update mutation hooks are
// exercised — the enum/number sub-sections (and their hooks) never mount.
vi.mock("@repo/app/custom-fields/hooks/use-custom-fields", () => ({
  useCreateCustomField: () => ({ mutate: mockCreateMutate, isPending: false }),
  useUpdateCustomField: () => ({ mutate: mockUpdateMutate, isPending: false }),
}));

const PROJECTS_LABEL_RE = /^Projects$/;
const SHOW_IN_TABLE_RE = /Show in table views/i;
const NAME_PLACEHOLDER_RE = /e\.g\. Priority/i;
const CREATE_FIELD_RE = /Create field/i;

afterEach(() => {
  vi.clearAllMocks();
});

describe("CreateCustomFieldDialog control wiring", () => {
  it("submits entity-type and display-option choices from label clicks", async () => {
    render(
      <CreateCustomFieldDialog
        field={undefined}
        onOpenChange={vi.fn()}
        open={true}
      />
    );

    // Required name field.
    fireEvent.change(screen.getByPlaceholderText(NAME_PLACEHOLDER_RE), {
      target: { value: "Priority" },
    });

    // "Applies to" is a checkbox — clicking the label selects Projects.
    const projectsCheckbox = screen.getByRole("checkbox", {
      name: PROJECTS_LABEL_RE,
    });
    fireEvent.click(projectsCheckbox);
    expect(projectsCheckbox.getAttribute("aria-checked")).toBe("true");

    // "Display options" is switches — toggling "Show in table views".
    const showInTableSwitch = screen.getByRole("switch", {
      name: SHOW_IN_TABLE_RE,
    });
    fireEvent.click(showInTableSwitch);
    expect(showInTableSwitch.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: CREATE_FIELD_RE }));

    // handleSubmit runs async validation before invoking the mutation.
    await waitFor(() => expect(mockCreateMutate).toHaveBeenCalledTimes(1));
    const payload = mockCreateMutate.mock.calls[0][0];
    expect(payload.entityTypes).toEqual([CustomFieldEntityType.Project]);
    expect(payload.showInTable).toBe(true);
    expect(payload.isSearchable).toBe(false);
    expect(payload.name).toBe("Priority");
  });
});
