import {
  TableAddFieldDialog as AddFieldDialog,
  type TableCustomFieldDefinition as CustomFieldDefinition,
  type TableCustomFieldType as CustomFieldType,
} from "@repo/design-system/components/ui/table-add-field-dialog";
import { composeStory } from "@storybook/react";
import {
  GitBranchIcon,
  HistoryIcon,
  Layers2Icon,
  SquareCheckIcon,
} from "lucide-react";
import { userEvent, within } from "storybook/test";
import { describe, expect, it, vi } from "vitest";

const META = { title: "Test/AddFieldDialog", component: AddFieldDialog };

/**
 * The promoted `TableAddFieldDialog` takes its reference sources from the HOST
 * rather than hardcoding them the way the storybook demo did, so a dialog with
 * no sources offers no radios at all. These stand in for the ones the demo used
 * to own, so the Reference cases still exercise a real choice.
 */
const REFERENCE_SOURCES = [
  { icon: Layers2Icon, label: "Artifacts", value: "artifact" },
  { icon: HistoryIcon, label: "Sessions", value: "session" },
  { icon: SquareCheckIcon, label: "Issues", value: "issue" },
  { icon: GitBranchIcon, label: "Branches", value: "branch" },
] as const;

const TITLE_PLACEHOLDER = "Priority, Stage, Status…";
const OPTION_PLACEHOLDER = "Type an option name";
const OPTIONS_HEADING_PATTERN = /Options/;
const SOURCE_HEADING_PATTERN = /Source/;
const MULTIPLE_RECORDS_ALLOWED_PATTERN =
  /multiple records of that type allowed/;

// No manual cleanup — this project hands Storybook `@testing-library/react`'s
// `render` through `testingLibraryRender` (see `vitest.setup.ts`), so RTL's
// auto-cleanup unmounts each story's root. Manual DOM manipulation conflicts
// with React's internal tree and causes "NotFoundError: node to be removed is
// not a child" cascades. This comment used to claim portable stories did that on
// their own; they do not, and ISS-9661 is what that cost.

describe("canCreate guard", () => {
  it("disables Create field when the title is empty", async () => {
    const { screen } = await renderDialog();

    expect(screen.getByRole("button", { name: "Create field" })).toBeDisabled();
  });

  it("disables Create field when the title is only whitespace", async () => {
    const { screen } = await renderDialog();

    await userEvent.type(screen.getByPlaceholderText(TITLE_PLACEHOLDER), "   ");

    expect(screen.getByRole("button", { name: "Create field" })).toBeDisabled();
  });

  it("enables Create field once a title and a select option are present", async () => {
    const { screen } = await renderDialog();

    await userEvent.type(
      screen.getByPlaceholderText(TITLE_PLACEHOLDER),
      "Stage"
    );
    await userEvent.type(
      screen.getAllByPlaceholderText(OPTION_PLACEHOLDER)[0],
      "Backlog"
    );

    expect(
      screen.getByRole("button", { name: "Create field" })
    ).not.toBeDisabled();
  });

  it("disables Create field for a Reference type with no source chosen", async () => {
    const { screen } = await renderDialog();

    await userEvent.type(
      screen.getByPlaceholderText(TITLE_PLACEHOLDER),
      "Related item"
    );
    await changeFieldType(screen, "Reference");

    expect(screen.getByRole("button", { name: "Create field" })).toBeDisabled();
  });

  it("enables Create field for a Reference type once a source is chosen", async () => {
    const { screen } = await renderDialog();

    await userEvent.type(
      screen.getByPlaceholderText(TITLE_PLACEHOLDER),
      "Related item"
    );
    await changeFieldType(screen, "Reference");
    await userEvent.click(screen.getByRole("radio", { name: "Artifacts" }));

    expect(
      screen.getByRole("button", { name: "Create field" })
    ).not.toBeDisabled();
  });
});

describe("field type sections", () => {
  it("shows the Options section for select types", async () => {
    const { screen } = await renderDialog();

    // Default type is Single-select.
    expect(
      screen.getByRole("heading", { name: OPTIONS_HEADING_PATTERN })
    ).toBeVisible();

    await changeFieldType(screen, "Multi-select");
    expect(
      screen.getByRole("heading", { name: OPTIONS_HEADING_PATTERN })
    ).toBeVisible();
  });

  it("hides the Options section for a non-select type", async () => {
    const { screen } = await renderDialog();

    await changeFieldType(screen, "Date");

    expect(
      screen.queryByRole("heading", { name: OPTIONS_HEADING_PATTERN })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: SOURCE_HEADING_PATTERN })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Format" })
    ).not.toBeInTheDocument();
  });

  it("shows the Reference source section for a Reference type", async () => {
    const { screen } = await renderDialog();

    await changeFieldType(screen, "Reference");

    expect(
      screen.getByRole("heading", { name: SOURCE_HEADING_PATTERN })
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: OPTIONS_HEADING_PATTERN })
    ).not.toBeInTheDocument();
  });

  it("shows the Time format section for a Time type", async () => {
    const { screen } = await renderDialog();

    await changeFieldType(screen, "Time");

    expect(screen.getByRole("heading", { name: "Format" })).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: OPTIONS_HEADING_PATTERN })
    ).not.toBeInTheDocument();
  });
});

describe("createField payload", () => {
  it("Text field carries no options, sources, or timeFormat", async () => {
    const { screen, onCreate } = await renderDialog();

    await userEvent.type(
      screen.getByPlaceholderText(TITLE_PLACEHOLDER),
      "Just Text"
    );
    await changeFieldType(screen, "Text");
    await userEvent.click(screen.getByRole("button", { name: "Create field" }));

    expect(onCreate).toHaveBeenCalledTimes(1);
    const field = onCreate.mock.calls[0][0] as CustomFieldDefinition;
    expect(field).toMatchObject({
      label: "Just Text",
      type: "Text",
      description: undefined,
      options: undefined,
      optionColors: undefined,
      sources: undefined,
      timeFormat: undefined,
    });
  });

  it("Single-select carries filtered options and matching optionColors", async () => {
    const { screen, onCreate } = await renderDialog();

    await userEvent.type(
      screen.getByPlaceholderText(TITLE_PLACEHOLDER),
      "Stage"
    );
    const optionInputs = screen.getAllByPlaceholderText(OPTION_PLACEHOLDER);
    await userEvent.type(optionInputs[0], "Alpha");
    await userEvent.type(optionInputs[1], "Beta");
    // A third, left-blank option must be filtered out of both arrays.
    await userEvent.click(
      screen.getByRole("button", { name: "Add an option" })
    );

    await userEvent.click(screen.getByRole("button", { name: "Create field" }));

    expect(onCreate).toHaveBeenCalledTimes(1);
    const field = onCreate.mock.calls[0][0] as CustomFieldDefinition;
    expect(field.type).toBe("Single-select");
    expect(field.options).toEqual(["Alpha", "Beta"]);
    expect(field.optionColors).toEqual(["bg-success", "bg-warning"]);
    expect(field.sources).toBeUndefined();
    expect(field.timeFormat).toBeUndefined();
  });

  it("changes only the targeted option color", async () => {
    const { screen, onCreate } = await renderDialog();

    await userEvent.type(
      screen.getByPlaceholderText(TITLE_PLACEHOLDER),
      "Stage"
    );
    const optionInputs = screen.getAllByPlaceholderText(OPTION_PLACEHOLDER);
    await userEvent.type(optionInputs[0], "Alpha");
    await userEvent.type(optionInputs[1], "Beta");
    await userEvent.click(
      screen.getByRole("button", { name: "Choose color for option 1" })
    );
    await userEvent.click(screen.getByRole("menuitem", { name: "Color 3" }));

    await userEvent.click(screen.getByRole("button", { name: "Create field" }));

    const field = onCreate.mock.calls[0][0] as CustomFieldDefinition;
    expect(field.options).toEqual(["Alpha", "Beta"]);
    expect(field.optionColors).toEqual(["bg-primary", "bg-warning"]);
  });

  it("Reference carries the chosen source", async () => {
    const { screen, onCreate } = await renderDialog();

    await userEvent.type(
      screen.getByPlaceholderText(TITLE_PLACEHOLDER),
      "Related"
    );
    await changeFieldType(screen, "Reference");
    await userEvent.click(screen.getByRole("radio", { name: "Sessions" }));

    await userEvent.click(screen.getByRole("button", { name: "Create field" }));

    expect(onCreate).toHaveBeenCalledTimes(1);
    const field = onCreate.mock.calls[0][0] as CustomFieldDefinition;
    expect(field.type).toBe("Reference");
    expect(field.sources).toEqual(["session"]);
    expect(field.options).toBeUndefined();
    expect(field.optionColors).toBeUndefined();
    expect(field.timeFormat).toBeUndefined();
  });

  it("Time carries the current timeFormat", async () => {
    const { screen, onCreate } = await renderDialog();

    await userEvent.type(
      screen.getByPlaceholderText(TITLE_PLACEHOLDER),
      "Duration Field"
    );
    await changeFieldType(screen, "Time");
    const [, formatTrigger] = screen.getAllByRole("combobox");
    await userEvent.click(formatTrigger);
    await userEvent.click(
      await screen.findByRole("option", { name: "0.00 hours" })
    );

    await userEvent.click(screen.getByRole("button", { name: "Create field" }));

    expect(onCreate).toHaveBeenCalledTimes(1);
    const field = onCreate.mock.calls[0][0] as CustomFieldDefinition;
    expect(field.type).toBe("Time");
    expect(field.timeFormat).toBe("decimal");
    expect(field.options).toBeUndefined();
    expect(field.optionColors).toBeUndefined();
    expect(field.sources).toBeUndefined();
  });
});

describe("description toggle", () => {
  it('shows a description input after clicking "Add description"', async () => {
    const { screen } = await renderDialog();

    expect(
      screen.getByRole("button", { name: "Add description" })
    ).toBeVisible();
    expect(
      screen.queryByRole("textbox", { name: "Field description" })
    ).not.toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "Add description" })
    );

    expect(
      screen.getByRole("textbox", { name: "Field description" })
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Add description" })
    ).not.toBeInTheDocument();
  });

  it("omits description from the payload when left empty", async () => {
    const { screen, onCreate } = await renderDialog();

    await userEvent.type(
      screen.getByPlaceholderText(TITLE_PLACEHOLDER),
      "Just Text"
    );
    await changeFieldType(screen, "Text");
    await userEvent.click(
      screen.getByRole("button", { name: "Add description" })
    );

    await userEvent.click(screen.getByRole("button", { name: "Create field" }));

    const field = onCreate.mock.calls[0][0] as CustomFieldDefinition;
    expect(field.description).toBeUndefined();
  });

  it("trims a non-empty description in the payload", async () => {
    const { screen, onCreate } = await renderDialog();

    await userEvent.type(
      screen.getByPlaceholderText(TITLE_PLACEHOLDER),
      "Just Text"
    );
    await changeFieldType(screen, "Text");
    await userEvent.click(
      screen.getByRole("button", { name: "Add description" })
    );
    await userEvent.type(
      screen.getByRole("textbox", { name: "Field description" }),
      "  Hello world  "
    );

    await userEvent.click(screen.getByRole("button", { name: "Create field" }));

    const field = onCreate.mock.calls[0][0] as CustomFieldDefinition;
    expect(field.description).toBe("Hello world");
  });
});

describe("option management", () => {
  it("adds an option row", async () => {
    const { screen } = await renderDialog();

    expect(screen.getAllByPlaceholderText(OPTION_PLACEHOLDER)).toHaveLength(2);

    await userEvent.click(
      screen.getByRole("button", { name: "Add an option" })
    );

    expect(screen.getAllByPlaceholderText(OPTION_PLACEHOLDER)).toHaveLength(3);
  });

  it("removes an option row", async () => {
    const { screen } = await renderDialog();

    const optionInputs = screen.getAllByPlaceholderText(OPTION_PLACEHOLDER);
    await userEvent.type(optionInputs[0], "Alpha");
    await userEvent.type(optionInputs[1], "Beta");

    await userEvent.click(
      screen.getByRole("button", { name: "Remove option 1" })
    );

    const remaining = screen.getAllByPlaceholderText(OPTION_PLACEHOLDER);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toHaveValue("Beta");
  });
});

describe("type change clears source", () => {
  it("clears the selected reference source when switching away and back to Reference", async () => {
    const { screen } = await renderDialog();

    await userEvent.type(
      screen.getByPlaceholderText(TITLE_PLACEHOLDER),
      "Related item"
    );
    await changeFieldType(screen, "Reference");
    await userEvent.click(screen.getByRole("radio", { name: "Issues" }));
    expect(screen.getByRole("radio", { name: "Issues" })).toBeChecked();

    await changeFieldType(screen, "Text");
    await changeFieldType(screen, "Reference");

    for (const radio of screen.getAllByRole("radio")) {
      expect(radio).not.toBeChecked();
    }
    expect(screen.getByRole("button", { name: "Create field" })).toBeDisabled();
  });
});

describe("cancel", () => {
  it("calls onOpenChange(false)", async () => {
    const { screen, onOpenChange } = await renderDialog();

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("Reference (multi) suffix", () => {
  it("shows the multiple-records suffix only for Reference (multi)", async () => {
    const { screen } = await renderDialog();

    await changeFieldType(screen, "Reference (multi)");
    expect(screen.getByText(MULTIPLE_RECORDS_ALLOWED_PATTERN)).toBeVisible();

    await changeFieldType(screen, "Reference");
    expect(
      screen.queryByText(MULTIPLE_RECORDS_ALLOWED_PATTERN)
    ).not.toBeInTheDocument();
  });
});

async function renderDialog() {
  const onOpenChange = vi.fn();
  const onCreate = vi.fn();
  const Story = composeStory(
    {
      render: () => (
        <AddFieldDialog
          onCreate={onCreate}
          onOpenChange={onOpenChange}
          open={true}
          referenceSources={REFERENCE_SOURCES}
        />
      ),
    },
    META
  );
  await Story.run();
  return { screen: within(document.body), onOpenChange, onCreate };
}

async function changeFieldType(
  screen: ReturnType<typeof within>,
  type: CustomFieldType
) {
  const [trigger] = screen.getAllByRole("combobox");
  await userEvent.click(trigger);
  await userEvent.click(await screen.findByRole("option", { name: type }));
}
