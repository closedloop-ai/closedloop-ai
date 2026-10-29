import { composeStory } from "@storybook/react";
import { fireEvent, userEvent, within } from "storybook/test";
import { describe, expect, it, vi } from "vitest";
import {
  EditableArtifactIdentityCell,
  EditableOwnerTableCell,
  EditablePeopleTableCell,
  EditableStatusTableCell,
  EditableTagsTableCell,
  EditableTextTableCell,
} from "../../../packages/app/shared/components/generic-artifact-surface/editable-cells";
import {
  ArtifactStatus,
  artifactPeople,
  initialArtifactRows,
  tagOptions,
} from "../../../packages/app/shared/components/generic-artifact-surface/fixtures";

const EM_DASH = "—";
const SAM_CHEN_NAME_PATTERN = /Sam Chen/;
const OTTILIE_EASTWICK_NAME_PATTERN = /Ottilie Eastwick/;
const CREATE_TAG_BUTTON_PATTERN = /Create tag/;
const RUNNING_REFUSAL_NAME = /Running.*cannot be changed here/i;
const [firstArtifact] = initialArtifactRows;
const tagLabels = tagOptions.map((option) => option.label);
const [ottilieEastwick, pascoeBirchall, samChen] = artifactPeople;

describe("EditableArtifactIdentityCell", () => {
  const editLabel = `Edit artifact name for ${firstArtifact.slug}`;

  function renderIdentityCell() {
    const onOpen = vi.fn();
    const onTitleChange = vi.fn();
    const Story = composeStory(
      {
        render: () => (
          <EditableArtifactIdentityCell
            artifact={firstArtifact}
            onOpen={onOpen}
            onTitleChange={onTitleChange}
          />
        ),
      },
      {
        title: "Test/EditableArtifactIdentityCell",
        component: EditableArtifactIdentityCell,
      }
    );
    return { onOpen, onTitleChange, Story };
  }

  it("renders view mode with the slug, title, and an edit control", async () => {
    const { Story } = renderIdentityCell();
    await Story.run();
    const screen = within(document.body);

    expect(screen.getByText(firstArtifact.slug)).toBeTruthy();
    expect(screen.getByText(firstArtifact.title)).toBeTruthy();
    expect(screen.getByRole("button", { name: editLabel })).toBeTruthy();
  });

  it("clicking the pencil enters edit mode with a focused, pre-filled input", async () => {
    const { Story } = renderIdentityCell();
    await Story.run();
    const screen = within(document.body);

    await userEvent.click(screen.getByRole("button", { name: editLabel }));

    const input = screen.getByRole("textbox", { name: editLabel });
    expect(input).toHaveValue(firstArtifact.title);
    expect(input).toHaveFocus();
  });

  it("Enter saves the trimmed title", async () => {
    const { Story, onTitleChange } = renderIdentityCell();
    await Story.run();
    const screen = within(document.body);

    await userEvent.click(screen.getByRole("button", { name: editLabel }));
    const input = screen.getByRole("textbox", { name: editLabel });
    await userEvent.clear(input);
    await userEvent.type(input, "  Renamed artifact  {Enter}");

    expect(onTitleChange).toHaveBeenCalledWith("Renamed artifact");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("Escape cancels the edit without saving", async () => {
    const { Story, onTitleChange } = renderIdentityCell();
    await Story.run();
    const screen = within(document.body);

    await userEvent.click(screen.getByRole("button", { name: editLabel }));
    const input = screen.getByRole("textbox", { name: editLabel });
    await userEvent.clear(input);
    await userEvent.type(input, "Discarded draft{Escape}");

    expect(onTitleChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText(firstArtifact.title)).toBeTruthy();
  });

  it("blur saves the trimmed title", async () => {
    const { Story, onTitleChange } = renderIdentityCell();
    await Story.run();
    const screen = within(document.body);

    await userEvent.click(screen.getByRole("button", { name: editLabel }));
    const input = screen.getByRole("textbox", { name: editLabel });
    await userEvent.clear(input);
    await userEvent.type(input, "  Blurred title  ");
    // React only listens for the native "focusout" event (which bubbles) to
    // drive onBlur, not "blur" itself, which does not bubble.
    fireEvent.focusOut(input);

    expect(onTitleChange).toHaveBeenCalledWith("Blurred title");
  });

  it("does not save an empty or whitespace-only title", async () => {
    const { Story, onTitleChange } = renderIdentityCell();
    await Story.run();
    const screen = within(document.body);

    await userEvent.click(screen.getByRole("button", { name: editLabel }));
    const input = screen.getByRole("textbox", { name: editLabel });
    await userEvent.clear(input);
    await userEvent.type(input, "   {Enter}");

    expect(onTitleChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText(firstArtifact.title)).toBeTruthy();
  });

  it("clicking the artifact name calls onOpen", async () => {
    const { Story, onOpen } = renderIdentityCell();
    await Story.run();
    const screen = within(document.body);

    const identityButton = screen
      .getAllByRole("button")
      .find(
        (button) =>
          button.textContent?.includes(firstArtifact.title) &&
          button.getAttribute("aria-label") !== editLabel
      );
    if (!identityButton) {
      throw new Error("identity button not found");
    }
    await userEvent.click(identityButton);

    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe("EditableOwnerTableCell", () => {
  function renderOwnerCell(owner: (typeof artifactPeople)[number] | null) {
    const onChange = vi.fn();
    const Story = composeStory(
      {
        render: () => (
          <EditableOwnerTableCell
            onChange={onChange}
            options={artifactPeople}
            owner={owner}
          />
        ),
      },
      {
        title: "Test/EditableOwnerTableCell",
        component: EditableOwnerTableCell,
      }
    );
    return { onChange, Story };
  }

  it("renders the current owner's name", async () => {
    const { Story } = renderOwnerCell(samChen);
    await Story.run();
    const screen = within(document.body);

    expect(
      screen.getByRole("button", {
        name: "Edit owner, currently Sam Chen",
      })
    ).toBeTruthy();
    expect(screen.getByText("Sam Chen")).toBeTruthy();
  });

  it("renders empty when owner is null", async () => {
    const { Story } = renderOwnerCell(null);
    await Story.run();
    const screen = within(document.body);

    expect(
      screen.getByRole("button", {
        name: "Edit owner, currently empty",
      })
    ).toBeTruthy();
    expect(screen.getByText(EM_DASH)).toBeTruthy();
  });

  it("selecting an option from the dropdown calls onChange", async () => {
    const { Story, onChange } = renderOwnerCell(ottilieEastwick);
    await Story.run();
    const screen = within(document.body);

    await userEvent.click(
      screen.getByRole("button", {
        name: "Edit owner, currently Ottilie Eastwick",
      })
    );
    await userEvent.click(
      screen.getByRole("menuitemradio", { name: SAM_CHEN_NAME_PATTERN })
    );

    expect(onChange).toHaveBeenCalledWith(samChen);
  });
});

describe("EditablePeopleTableCell", () => {
  function renderPeopleCell(people: (typeof artifactPeople)[number][]) {
    const onChange = vi.fn();
    const Story = composeStory(
      {
        render: () => (
          <EditablePeopleTableCell
            onChange={onChange}
            options={artifactPeople}
            people={people}
          />
        ),
      },
      {
        title: "Test/EditablePeopleTableCell",
        component: EditablePeopleTableCell,
      }
    );
    return { onChange, Story };
  }

  it("renders avatars when people are present", async () => {
    const { Story } = renderPeopleCell([pascoeBirchall, samChen]);
    await Story.run();
    const screen = within(document.body);

    expect(
      screen.getByRole("button", {
        name: "Edit collaborators: Pascoe Birchall, Sam Chen",
      })
    ).toBeTruthy();
    expect(screen.getByText("People: Pascoe Birchall, Sam Chen")).toBeTruthy();
    // One initial on every avatar (Nerys, 2026-10-22).
    expect(screen.getByText("P")).toBeTruthy();
    expect(screen.getByText("S")).toBeTruthy();
  });

  it("renders empty when there are no people", async () => {
    const { Story } = renderPeopleCell([]);
    await Story.run();
    const screen = within(document.body);

    expect(
      screen.getByRole("button", { name: "Edit collaborators: none" })
    ).toBeTruthy();
    expect(screen.getByText(EM_DASH)).toBeTruthy();
  });

  it("clicking an unselected person in the popover adds them", async () => {
    const { Story, onChange } = renderPeopleCell([pascoeBirchall, samChen]);
    await Story.run();
    const screen = within(document.body);

    await userEvent.click(
      screen.getByRole("button", {
        name: "Edit collaborators: Pascoe Birchall, Sam Chen",
      })
    );
    await userEvent.click(
      screen.getByRole("button", { name: OTTILIE_EASTWICK_NAME_PATTERN })
    );

    expect(onChange).toHaveBeenCalledWith([
      pascoeBirchall,
      samChen,
      ottilieEastwick,
    ]);
    // Popover does not auto-close on item click (unlike DropdownMenu), so
    // close it explicitly: an orphaned open popover's floating-ui/dismiss
    // cleanup can otherwise fire asynchronously into a later test.
    await userEvent.keyboard("{Escape}");
  });

  it("clicking a selected person in the popover removes them", async () => {
    const { Story, onChange } = renderPeopleCell([pascoeBirchall, samChen]);
    await Story.run();
    const screen = within(document.body);

    await userEvent.click(
      screen.getByRole("button", {
        name: "Edit collaborators: Pascoe Birchall, Sam Chen",
      })
    );
    // The popover trigger also matches "Pascoe Birchall" so we need the
    // option button inside the popover content, not the trigger.
    const popoverButtons = screen
      .getAllByRole("button")
      .filter(
        (button) =>
          button.textContent?.includes("Pascoe Birchall") &&
          !button.hasAttribute("aria-controls")
      );
    await userEvent.click(popoverButtons[0]);

    expect(onChange).toHaveBeenCalledWith([samChen]);
    await userEvent.keyboard("{Escape}");
  });
});

describe("EditableStatusTableCell", () => {
  function renderStatusCell(status: ArtifactStatus) {
    const onChange = vi.fn();
    const artifact = { ...firstArtifact, status };
    const Story = composeStory(
      {
        render: () => (
          <EditableStatusTableCell artifact={artifact} onChange={onChange} />
        ),
      },
      {
        title: "Test/EditableStatusTableCell",
        component: EditableStatusTableCell,
      }
    );
    return { onChange, Story };
  }

  it("renders the current status", async () => {
    const { Story } = renderStatusCell(ArtifactStatus.InReview);
    await Story.run();
    const screen = within(document.body);

    expect(
      screen.getByRole("button", {
        name: "Edit status, currently In review",
      })
    ).toBeTruthy();
    expect(screen.getByText("In review")).toBeTruthy();
  });

  it("selecting a different status calls onChange", async () => {
    const { Story, onChange } = renderStatusCell(ArtifactStatus.InReview);
    await Story.run();
    const screen = within(document.body);

    await userEvent.click(
      screen.getByRole("button", {
        name: "Edit status, currently In review",
      })
    );
    await userEvent.click(
      screen.getByRole("menuitem", { name: ArtifactStatus.Done })
    );

    expect(onChange).toHaveBeenCalledWith(ArtifactStatus.Done);
  });

  it("renders runtime-owned status as canonical read-only output", async () => {
    const onChange = vi.fn();
    const Story = composeStory(
      {
        render: () => (
          <EditableStatusTableCell
            artifact={initialArtifactRows[2]}
            onChange={onChange}
          />
        ),
      },
      {
        title: "Test/EditableStatusTableCellReadOnly",
        component: EditableStatusTableCell,
      }
    );
    await Story.run();
    const screen = within(document.body);

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Running")).toBeTruthy();
    const status = screen.getByLabelText(RUNNING_REFUSAL_NAME);
    expect(status).toHaveTextContent(
      "Set automatically, so it cannot be changed here."
    );
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("EditableTagsTableCell", () => {
  function renderTagsCell(tags: readonly string[]) {
    const onChange = vi.fn();
    const Story = composeStory(
      {
        render: () => (
          <EditableTagsTableCell
            onChange={onChange}
            optionLabels={tagLabels}
            tags={tags}
          />
        ),
      },
      { title: "Test/EditableTagsTableCell", component: EditableTagsTableCell }
    );
    return { onChange, Story };
  }

  function openTagsPopover(
    screen: ReturnType<typeof within>,
    tags: readonly string[]
  ) {
    const label = `Edit tags: ${tags.join(", ") || "none"}`;
    return userEvent.click(screen.getByRole("button", { name: label }));
  }

  it("renders tags in the trigger's accessible name", async () => {
    const { Story } = renderTagsCell(["Foundations", "UX"]);
    await Story.run();
    const screen = within(document.body);

    expect(
      screen.getByRole("button", { name: "Edit tags: Foundations, UX" })
    ).toBeTruthy();
  });

  it("renders 'none' when there are no tags", async () => {
    const { Story } = renderTagsCell([]);
    await Story.run();
    const screen = within(document.body);

    expect(
      screen.getByRole("button", { name: "Edit tags: none" })
    ).toBeTruthy();
    expect(screen.getByText(EM_DASH)).toBeTruthy();
  });

  it("adds a tag by clicking an unselected option", async () => {
    const { Story, onChange } = renderTagsCell(["Foundations"]);
    await Story.run();
    const screen = within(document.body);

    await openTagsPopover(screen, ["Foundations"]);
    await userEvent.click(screen.getByRole("button", { name: "Design" }));

    expect(onChange).toHaveBeenCalledWith(["Foundations", "Design"]);
    // Popover does not auto-close on item click (unlike DropdownMenu), so
    // close it explicitly: an orphaned open popover's floating-ui/dismiss
    // cleanup can otherwise fire asynchronously into a later test.
    await userEvent.keyboard("{Escape}");
  });

  it("removes a tag via its chip's X button", async () => {
    const { Story, onChange } = renderTagsCell(["Foundations", "UX"]);
    await Story.run();
    const screen = within(document.body);

    await openTagsPopover(screen, ["Foundations", "UX"]);
    await userEvent.click(
      screen.getByRole("button", { name: "Remove Foundations" })
    );

    expect(onChange).toHaveBeenCalledWith(["UX"]);
    await userEvent.keyboard("{Escape}");
  });

  it("removes a tag by clicking its already-selected option", async () => {
    const { Story, onChange } = renderTagsCell(["Foundations", "UX"]);
    await Story.run();
    const screen = within(document.body);

    await openTagsPopover(screen, ["Foundations", "UX"]);
    await userEvent.click(screen.getByRole("button", { name: "Foundations" }));

    expect(onChange).toHaveBeenCalledWith(["UX"]);
    await userEvent.keyboard("{Escape}");
  });

  it("creates a new tag via form submit when the query has no match", async () => {
    const { Story, onChange } = renderTagsCell(["Foundations"]);
    await Story.run();
    const screen = within(document.body);

    await openTagsPopover(screen, ["Foundations"]);
    const input = screen.getByLabelText("Search or create tags");
    await userEvent.type(input, "Special Ops");
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    expect(onChange).toHaveBeenCalledWith(["Foundations", "Special Ops"]);
    await userEvent.keyboard("{Escape}");
  });

  it("selects the first matching option via form submit", async () => {
    const { Story, onChange } = renderTagsCell(["Foundations"]);
    await Story.run();
    const screen = within(document.body);

    await openTagsPopover(screen, ["Foundations"]);
    const input = screen.getByLabelText("Search or create tags");
    await userEvent.type(input, "gov");
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    expect(onChange).toHaveBeenCalledWith(["Foundations", "Governance"]);
    await userEvent.keyboard("{Escape}");
  });

  it("shows a 'Create tag' option when the query has no exact match", async () => {
    const { Story } = renderTagsCell([]);
    await Story.run();
    const screen = within(document.body);

    await openTagsPopover(screen, []);
    const input = screen.getByLabelText("Search or create tags");
    await userEvent.type(input, "Marketing");

    expect(
      screen.getByRole("button", { name: CREATE_TAG_BUTTON_PATTERN })
    ).toBeTruthy();
    await userEvent.keyboard("{Escape}");
  });

  it("hides the 'Create tag' option when the query exactly matches an option", async () => {
    const { Story } = renderTagsCell([]);
    await Story.run();
    const screen = within(document.body);

    await openTagsPopover(screen, []);
    const input = screen.getByLabelText("Search or create tags");
    await userEvent.type(input, "governance");

    expect(
      screen.queryByRole("button", { name: CREATE_TAG_BUTTON_PATTERN })
    ).toBeNull();
    await userEvent.keyboard("{Escape}");
  });
});

describe("EditableTextTableCell", () => {
  const ariaLabel = "Edit summary for FEA-2481";

  function renderTextCell(value: string) {
    const onChange = vi.fn();
    const Story = composeStory(
      {
        render: () => (
          <EditableTextTableCell
            ariaLabel={ariaLabel}
            onChange={onChange}
            value={value}
          />
        ),
      },
      { title: "Test/EditableTextTableCell", component: EditableTextTableCell }
    );
    return { onChange, Story };
  }

  it("renders the text value", async () => {
    const { Story } = renderTextCell("Some text");
    await Story.run();
    const screen = within(document.body);

    expect(screen.getByRole("button", { name: ariaLabel })).toBeTruthy();
    expect(screen.getByText("Some text")).toBeTruthy();
  });

  it("renders 'Add' when the value is empty", async () => {
    const { Story } = renderTextCell("");
    await Story.run();
    const screen = within(document.body);

    expect(screen.getByRole("button", { name: ariaLabel })).toBeTruthy();
    expect(screen.getByText("Add")).toBeTruthy();
  });

  it("clicking enters edit mode with a focused, pre-filled input", async () => {
    const { Story } = renderTextCell("Some text");
    await Story.run();
    const screen = within(document.body);

    await userEvent.click(screen.getByRole("button", { name: ariaLabel }));

    const input = screen.getByRole("textbox", { name: ariaLabel });
    expect(input).toHaveValue("Some text");
    expect(input).toHaveFocus();
  });

  it("Enter saves the trimmed value", async () => {
    const { Story, onChange } = renderTextCell("Some text");
    await Story.run();
    const screen = within(document.body);

    await userEvent.click(screen.getByRole("button", { name: ariaLabel }));
    const input = screen.getByRole("textbox", { name: ariaLabel });
    await userEvent.clear(input);
    await userEvent.type(input, "  Updated text  {Enter}");

    expect(onChange).toHaveBeenCalledWith("Updated text");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("Escape cancels the edit without saving", async () => {
    const { Story, onChange } = renderTextCell("Some text");
    await Story.run();
    const screen = within(document.body);

    await userEvent.click(screen.getByRole("button", { name: ariaLabel }));
    const input = screen.getByRole("textbox", { name: ariaLabel });
    await userEvent.clear(input);
    await userEvent.type(input, "Discarded draft{Escape}");

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("Some text")).toBeTruthy();
  });

  it("blur saves the trimmed value", async () => {
    const { Story, onChange } = renderTextCell("Some text");
    await Story.run();
    const screen = within(document.body);

    await userEvent.click(screen.getByRole("button", { name: ariaLabel }));
    const input = screen.getByRole("textbox", { name: ariaLabel });
    await userEvent.clear(input);
    await userEvent.type(input, "  Blurred value  ");
    // React only listens for the native "focusout" event (which bubbles) to
    // drive onBlur, not "blur" itself, which does not bubble.
    fireEvent.focusOut(input);

    expect(onChange).toHaveBeenCalledWith("Blurred value");
  });
});
