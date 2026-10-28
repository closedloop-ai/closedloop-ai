import type { TableCustomFieldDefinition as CustomFieldDefinition } from "@repo/design-system/components/ui/table-add-field-dialog";
import { composeStory } from "@storybook/react";
import { fireEvent, userEvent, within } from "storybook/test";
import { describe, expect, it, vi } from "vitest";
import { CustomFieldCell } from "../../../packages/app/shared/components/generic-artifact-surface/custom-field-cells";
import { initialArtifactRows } from "../../../packages/app/shared/components/generic-artifact-surface/fixtures";
import { cloneArtifact } from "../../../packages/app/shared/components/generic-artifact-surface/model";

const EDIT_STAGE_CURRENTLY_BUILD_PATTERN = /edit stage, currently build/i;
const EDIT_STAGE_CURRENTLY_EMPTY_PATTERN = /edit stage, currently empty/i;
const EDIT_CAPABILITIES_PATTERN = /edit capabilities/i;
const EDIT_DUE_DATE_FOR_FEA_2481_PATTERN = /edit due date for fea-2481/i;
const EDIT_OWNER_PATTERN = /edit owner/i;
const EDIT_ISSUES_REFERENCE_PATTERN = /edit issues reference/i;
const EDIT_ARTIFACTS_REFERENCE_PATTERN = /edit artifacts reference/i;
const EDIT_CYCLE_TIME_FOR_FEA_2481_PATTERN = /edit cycle time for fea-2481/i;
const EDIT_SUMMARY_FOR_FEA_2481_PATTERN = /edit summary for fea-2481/i;
const EDIT_REVISION_COUNT_FOR_FEA_2481_PATTERN =
  /edit revision count for fea-2481/i;
const EDIT_REVISION_COUNT_FOR_SES_7B91_PATTERN =
  /edit revision count for ses-7b91/i;
const AUG_27_2026_PATTERN = /Aug 27, 2026/;
const AUG_20_2026_PATTERN = /Aug 20, 2026/i;
const EDIT_SUMMARY_PATTERN = /edit summary/i;
const EDIT_STAGE_PATTERN = /edit stage/i;
const DISCOVERY_PATTERN = /discovery/i;

function renderFieldCell(
  field: CustomFieldDefinition,
  artifactIndex = 0,
  overrides: Partial<Record<string, unknown>> = {}
) {
  const onArtifactChange = vi.fn();
  const artifact = cloneArtifact(initialArtifactRows[artifactIndex]);
  if (overrides.customValues) {
    Object.assign(artifact.customValues, overrides.customValues);
  }
  const Story = composeStory(
    {
      render: () => (
        <CustomFieldCell
          artifact={artifact}
          field={field}
          onArtifactChange={onArtifactChange}
        />
      ),
    },
    { title: "Test/CustomFieldCell", component: CustomFieldCell }
  );
  return { Story, onArtifactChange, artifact };
}

describe("CustomFieldCell component rendering", () => {
  it("renders Single-select with current value", async () => {
    const field: CustomFieldDefinition = {
      id: "custom-stage",
      label: "Stage",
      type: "Single-select",
      options: ["Discovery", "Build", "Validate"],
      optionColors: ["bg-orange-600", "bg-blue-600", "bg-emerald-600"],
    };
    const { Story } = renderFieldCell(field);
    await Story.run();
    const screen = within(document.body);
    expect(
      screen.getByLabelText(EDIT_STAGE_CURRENTLY_BUILD_PATTERN)
    ).toBeTruthy();
  });

  it("renders Single-select with empty value when value is absent", async () => {
    const field: CustomFieldDefinition = {
      id: "custom-stage",
      label: "Stage",
      type: "Single-select",
      options: ["Discovery", "Build"],
      optionColors: ["bg-orange-600", "bg-blue-600"],
    };
    const { Story } = renderFieldCell(field, 2);
    await Story.run();
    const screen = within(document.body);
    expect(
      screen.getByLabelText(EDIT_STAGE_CURRENTLY_EMPTY_PATTERN)
    ).toBeTruthy();
  });

  it("renders Multi-select with choice list showing all selected values", async () => {
    const field: CustomFieldDefinition = {
      id: "custom-capabilities",
      label: "Capabilities",
      type: "Multi-select",
      options: ["Grid", "Editing", "Governance"],
      optionColors: ["bg-blue-600", "bg-emerald-600", "bg-orange-600"],
    };
    const { Story } = renderFieldCell(field);
    await Story.run();
    const screen = within(document.body);
    const trigger = screen.getByLabelText(EDIT_CAPABILITIES_PATTERN);
    expect(trigger).toBeTruthy();
    const triggerScope = within(trigger);
    expect(triggerScope.getByText("Grid")).toBeTruthy();
    expect(triggerScope.getByText("Editing")).toBeTruthy();
  });

  it("renders Date field with editable scalar cell", async () => {
    const field: CustomFieldDefinition = {
      id: "custom-due-date",
      label: "Due date",
      type: "Date",
    };
    const { Story } = renderFieldCell(field);
    await Story.run();
    const screen = within(document.body);
    expect(
      screen.getByLabelText(EDIT_DUE_DATE_FOR_FEA_2481_PATTERN)
    ).toBeTruthy();
  });

  it("renders People field with owner cell", async () => {
    const field: CustomFieldDefinition = {
      id: "custom-reviewer",
      label: "Reviewer",
      type: "People",
    };
    const { Story } = renderFieldCell(field);
    await Story.run();
    const screen = within(document.body);
    expect(screen.getByLabelText(EDIT_OWNER_PATTERN)).toBeTruthy();
  });

  it("renders Reference field", async () => {
    const field: CustomFieldDefinition = {
      id: "custom-parent-artifact",
      label: "Parent artifact",
      type: "Reference",
      sources: ["Issues"],
    };
    const { Story } = renderFieldCell(field);
    await Story.run();
    const screen = within(document.body);
    expect(screen.getByLabelText(EDIT_ISSUES_REFERENCE_PATTERN)).toBeTruthy();
  });

  it("renders Reference (multi) field", async () => {
    const field: CustomFieldDefinition = {
      id: "custom-is-implemented-by",
      label: "Is Implemented By",
      type: "Reference (multi)",
      sources: ["Artifacts"],
    };
    const { Story } = renderFieldCell(field);
    await Story.run();
    const screen = within(document.body);
    expect(
      screen.getByLabelText(EDIT_ARTIFACTS_REFERENCE_PATTERN)
    ).toBeTruthy();
  });

  it("renders Time field with scalar cell", async () => {
    const field: CustomFieldDefinition = {
      id: "custom-cycle-time",
      label: "Cycle time",
      type: "Time",
    };
    const { Story } = renderFieldCell(field);
    await Story.run();
    const screen = within(document.body);
    expect(
      screen.getByLabelText(EDIT_CYCLE_TIME_FOR_FEA_2481_PATTERN)
    ).toBeTruthy();
  });

  it("renders Text field with scalar cell", async () => {
    const field: CustomFieldDefinition = {
      id: "custom-summary",
      label: "Summary",
      type: "Text",
    };
    const { Story } = renderFieldCell(field);
    await Story.run();
    const screen = within(document.body);
    expect(
      screen.getByLabelText(EDIT_SUMMARY_FOR_FEA_2481_PATTERN)
    ).toBeTruthy();
  });

  it("renders Number field with scalar cell", async () => {
    const field: CustomFieldDefinition = {
      id: "custom-revision-count",
      label: "Revision count",
      type: "Number",
    };
    const { Story } = renderFieldCell(field);
    await Story.run();
    const screen = within(document.body);
    expect(
      screen.getByLabelText(EDIT_REVISION_COUNT_FOR_FEA_2481_PATTERN)
    ).toBeTruthy();
  });

  it("handles null custom value rendering an empty scalar cell", async () => {
    const field: CustomFieldDefinition = {
      id: "custom-revision-count",
      label: "Revision count",
      type: "Number",
    };
    const { Story } = renderFieldCell(field, 2);
    await Story.run();
    const screen = within(document.body);
    expect(
      screen.getByLabelText(EDIT_REVISION_COUNT_FOR_SES_7B91_PATTERN)
    ).toBeTruthy();
  });

  it("renders the correct time value for Time scalar cells", async () => {
    const field: CustomFieldDefinition = {
      id: "custom-cycle-time",
      label: "Cycle time",
      type: "Time",
      timeFormat: "duration",
    };
    const { Story } = renderFieldCell(field);
    await Story.run();
    const screen = within(document.body);
    expect(screen.getByText("02:14")).toBeTruthy();
  });

  it("Date field renders the formatted date value", async () => {
    const field: CustomFieldDefinition = {
      id: "custom-due-date",
      label: "Due date",
      type: "Date",
    };
    const { Story } = renderFieldCell(field, 1);
    await Story.run();
    const screen = within(document.body);
    expect(screen.getByText(AUG_27_2026_PATTERN)).toBeTruthy();
  });

  it("Text field renders the text value", async () => {
    const field: CustomFieldDefinition = {
      id: "custom-summary",
      label: "Summary",
      type: "Text",
    };
    const { Story } = renderFieldCell(field, 1);
    await Story.run();
    const screen = within(document.body);
    expect(screen.getByText("Promotion contract")).toBeTruthy();
  });

  it("Date scalar cell shows raw value for an invalid date", async () => {
    const field: CustomFieldDefinition = {
      id: "custom-due-date",
      label: "Due date",
      type: "Date",
    };
    const { Story } = renderFieldCell(field, 0, {
      customValues: { "custom-due-date": "not-a-date" },
    });
    await Story.run();
    const screen = within(document.body);
    expect(screen.getByText("not-a-date")).toBeTruthy();
  });
});

describe("CustomFieldCell scalar interactions", () => {
  it("Number scalar cell parses numeric input and commits on Enter", async () => {
    const field: CustomFieldDefinition = {
      id: "custom-revision-count",
      label: "Revision count",
      type: "Number",
    };
    const { Story, onArtifactChange } = renderFieldCell(field);
    await Story.run();
    const screen = within(document.body);
    const button = screen.getByLabelText(
      EDIT_REVISION_COUNT_FOR_FEA_2481_PATTERN
    );
    await userEvent.click(button);
    const input = document.querySelector(
      "input[type='number']"
    ) as HTMLInputElement;
    expect(input).toBeTruthy();
    fireEvent.change(input, { target: { value: "42" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onArtifactChange).toHaveBeenCalledWith(
      "artifact-1",
      expect.objectContaining({
        customValues: expect.objectContaining({ "custom-revision-count": 42 }),
      })
    );
  });

  it("Number scalar cell does not commit non-finite input", async () => {
    const field: CustomFieldDefinition = {
      id: "custom-revision-count",
      label: "Revision count",
      type: "Number",
    };
    const { Story, onArtifactChange } = renderFieldCell(field);
    await Story.run();
    const screen = within(document.body);
    const button = screen.getByLabelText(
      EDIT_REVISION_COUNT_FOR_FEA_2481_PATTERN
    );
    await userEvent.click(button);
    const input = document.querySelector(
      "input[type='number']"
    ) as HTMLInputElement;
    expect(input).toBeTruthy();
    Object.defineProperty(input, "value", {
      configurable: true,
      value: "1e999",
      writable: true,
    });
    fireEvent.change(input);
    expect(input.value).toBe("1e999");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onArtifactChange).not.toHaveBeenCalled();
  });

  it("Scalar cell reverts on Escape without committing", async () => {
    const field: CustomFieldDefinition = {
      id: "custom-summary",
      label: "Summary",
      type: "Text",
    };
    const { Story, onArtifactChange } = renderFieldCell(field);
    await Story.run();
    const screen = within(document.body);
    const button = screen.getByLabelText(EDIT_SUMMARY_FOR_FEA_2481_PATTERN);
    await userEvent.click(button);
    const input = screen.getByRole("textbox", {
      name: EDIT_SUMMARY_PATTERN,
    }) as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, "Will be discarded{Escape}");
    expect(onArtifactChange).not.toHaveBeenCalled();
  });

  it("Scalar cell commits null when the input is emptied", async () => {
    const field: CustomFieldDefinition = {
      id: "custom-summary",
      label: "Summary",
      type: "Text",
    };
    const { Story, onArtifactChange } = renderFieldCell(field);
    await Story.run();
    const screen = within(document.body);
    const button = screen.getByLabelText(EDIT_SUMMARY_FOR_FEA_2481_PATTERN);
    await userEvent.click(button);
    const input = screen.getByRole("textbox", {
      name: EDIT_SUMMARY_PATTERN,
    }) as HTMLInputElement;
    await userEvent.clear(input);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onArtifactChange).toHaveBeenCalledWith(
      "artifact-1",
      expect.objectContaining({
        customValues: expect.objectContaining({ "custom-summary": null }),
      })
    );
  });

  it("Time scalar cell renders and accepts a time value", async () => {
    const field: CustomFieldDefinition = {
      id: "custom-cycle-time",
      label: "Cycle time",
      type: "Time",
    };
    const { Story, onArtifactChange } = renderFieldCell(field);
    await Story.run();
    const screen = within(document.body);
    const button = screen.getByLabelText(EDIT_CYCLE_TIME_FOR_FEA_2481_PATTERN);
    await userEvent.click(button);
    const input =
      document.querySelector<HTMLInputElement>("input[type='time']");
    if (!input) {
      throw new Error("Missing time editor");
    }
    fireEvent.change(input, { target: { value: "03:30" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onArtifactChange).toHaveBeenCalledWith(
      "artifact-1",
      expect.objectContaining({
        customValues: expect.objectContaining({
          "custom-cycle-time": "03:30",
        }),
      })
    );
  });

  it("Date scalar cell renders a formatted date value", async () => {
    const field: CustomFieldDefinition = {
      id: "custom-due-date",
      label: "Due date",
      type: "Date",
    };
    const { Story } = renderFieldCell(field);
    await Story.run();
    const screen = within(document.body);
    expect(screen.getByText(AUG_20_2026_PATTERN)).toBeTruthy();
  });
});

describe("CustomFieldCell dropdown interactions", () => {
  it("Single-select calls onArtifactChange when an option is selected", async () => {
    const field: CustomFieldDefinition = {
      id: "custom-stage",
      label: "Stage",
      type: "Single-select",
      options: ["Discovery", "Build", "Validate"],
      optionColors: ["bg-orange-600", "bg-blue-600", "bg-emerald-600"],
    };
    const { Story, artifact, onArtifactChange } = renderFieldCell(field);
    await Story.run();
    const screen = within(document.body);
    await userEvent.click(screen.getByLabelText(EDIT_STAGE_PATTERN));
    await userEvent.click(
      screen.getByRole("menuitemradio", { name: DISCOVERY_PATTERN })
    );
    expect(onArtifactChange).toHaveBeenCalledWith("artifact-1", {
      customValues: {
        ...artifact.customValues,
        "custom-stage": "Discovery",
      },
    });
  });

  it("Multi-select removes an already-selected option", async () => {
    const field: CustomFieldDefinition = {
      id: "custom-capabilities",
      label: "Capabilities",
      type: "Multi-select",
      options: ["Grid", "Editing", "Governance"],
      optionColors: ["bg-blue-600", "bg-emerald-600", "bg-orange-600"],
    };
    const { Story, artifact, onArtifactChange } = renderFieldCell(field);
    await Story.run();
    const screen = within(document.body);
    await userEvent.click(screen.getByLabelText(EDIT_CAPABILITIES_PATTERN));
    const items = screen.getAllByRole("menuitemcheckbox");
    await userEvent.click(items[0]);
    expect(onArtifactChange).toHaveBeenCalledWith("artifact-1", {
      customValues: {
        ...artifact.customValues,
        "custom-capabilities": ["Editing", "Governance"],
      },
    });
    await userEvent.keyboard("{Escape}");
  });

  it("Multi-select adds an unselected option", async () => {
    const field: CustomFieldDefinition = {
      id: "custom-capabilities",
      label: "Capabilities",
      type: "Multi-select",
      options: ["Grid", "Editing", "Governance"],
      optionColors: ["bg-blue-600", "bg-emerald-600", "bg-orange-600"],
    };
    const { Story, artifact, onArtifactChange } = renderFieldCell(field, 1);
    await Story.run();
    const screen = within(document.body);
    await userEvent.click(screen.getByLabelText(EDIT_CAPABILITIES_PATTERN));
    const items = screen.getAllByRole("menuitemcheckbox");
    await userEvent.click(items[0]);
    expect(onArtifactChange).toHaveBeenCalledWith("artifact-2", {
      customValues: {
        ...artifact.customValues,
        "custom-capabilities": ["Governance", "Grid"],
      },
    });
    await userEvent.keyboard("{Escape}");
  });
});
