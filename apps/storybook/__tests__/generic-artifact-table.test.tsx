import { restoreTimeZone } from "@repo/app/shared/test-fixtures/tz-utils";
import { composeStory } from "@storybook/react";
import { fireEvent, userEvent, within } from "storybook/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GenericArtifactTableDemo } from "../../../packages/app/shared/components/generic-artifact-surface/generic-artifact-table";

const EDIT_OWNER_PATTERN = /edit owner/i;
const EDIT_STATUS_PATTERN = /edit status/i;
const EDIT_PRIORITY_PATTERN = /edit priority/i;
const EDIT_TAGS_PATTERN = /edit tags/i;
const EDIT_COLLABORATORS_PATTERN = /edit collaborators/i;
const EDIT_ARTIFACT_NAME_PATTERN = /edit artifact name/i;
const RUNNING_REFUSAL_NAME = /Running.*cannot be changed here/i;
const OPEN_VERSION_PATTERN = /open version/i;
const UNDO_PATTERN = /^undo$/i;
const SELECTED_TAG = "Foundations";
const UNSELECTED_TAG = "Design system";
const REMAINING_TAG = "UX";
/**
 * The Related Sessions label is derived from each fixture session's
 * `occurredAt` and rendered in the viewer's zone, so the `07/31` assertion
 * below only means something against a pinned one. Unpinned it is green on a US
 * Central laptop and red from UTC+11 east, where `2026-07-31T09:02:00-05:00`
 * lands on the following local calendar day.
 */
const VIEWER_TIME_ZONE = "America/Chicago";
const ORIGINAL_TIME_ZONE = process.env.TZ;

async function renderTable(
  initialFields?: Parameters<
    typeof GenericArtifactTableDemo
  >[0]["initialFields"]
) {
  const Story = composeStory(
    {
      render: () => (
        <GenericArtifactTableDemo initialFields={initialFields ?? []} />
      ),
    },
    {
      title: "Test/GenericArtifactTable",
      component: GenericArtifactTableDemo,
    }
  );
  await Story.run();
  return within(document.body);
}

describe("GenericArtifactTableDemo", () => {
  beforeEach(() => {
    process.env.TZ = VIEWER_TIME_ZONE;
  });

  afterEach(() => {
    restoreTimeZone(ORIGINAL_TIME_ZONE);
  });

  it("renders the table with all three artifact rows", async () => {
    const screen = await renderTable();
    expect(screen.getByText("Unified artifact experience")).toBeTruthy();
    expect(screen.getByText("Artifact interaction principles")).toBeTruthy();
    expect(screen.getByText("Prototype generic artifact shells")).toBeTruthy();
  });

  it("renders with default initial custom fields when not overridden", async () => {
    const Story = composeStory(
      { render: () => <GenericArtifactTableDemo /> },
      {
        title: "Test/GenericArtifactTable",
        component: GenericArtifactTableDemo,
      }
    );
    await Story.run();
    const screen = within(document.body);
    expect(screen.getByText("Unified artifact experience")).toBeTruthy();
  });

  it("renders owner cells for each artifact", async () => {
    const screen = await renderTable();
    const ownerCells = screen.getAllByLabelText(EDIT_OWNER_PATTERN);
    expect(ownerCells.length).toBe(3);
  });

  it("renders repository cell with null repository for artifact-3", async () => {
    const screen = await renderTable();
    const repoTexts = screen.getAllByText("closedloop-ai");
    expect(repoTexts.length).toBe(2);
  });

  it("renders creationCost cells including null values", async () => {
    const screen = await renderTable();
    expect(screen.getByText("$42.18")).toBeTruthy();
    expect(screen.getByText("$18.40")).toBeTruthy();
  });

  it("renders lineChanges cells with additions and deletions", async () => {
    const screen = await renderTable();
    expect(screen.getByText("+184")).toBeTruthy();
  });

  it("renders status cells for each artifact", async () => {
    const screen = await renderTable();
    const statusButtons = screen.getAllByLabelText(EDIT_STATUS_PATTERN);
    expect(statusButtons.length).toBe(2);
    const readOnlyStatus = screen.getByLabelText(RUNNING_REFUSAL_NAME);
    expect(readOnlyStatus).toHaveTextContent(
      "Set automatically, so it cannot be changed here."
    );
  });

  it("renders priority cells for each artifact", async () => {
    const screen = await renderTable();
    const priorityButtons = screen.getAllByLabelText(EDIT_PRIORITY_PATTERN);
    expect(priorityButtons.length).toBe(3);
  });

  it("renders tags cells for each artifact", async () => {
    const screen = await renderTable();
    const tagButtons = screen.getAllByLabelText(EDIT_TAGS_PATTERN);
    expect(tagButtons.length).toBe(3);
  });

  it("renders collaborator cells for each artifact", async () => {
    const screen = await renderTable();
    const collabButtons = screen.getAllByLabelText(EDIT_COLLABORATORS_PATTERN);
    expect(collabButtons.length).toBe(3);
  });

  it("renders comments count for each artifact", async () => {
    const screen = await renderTable();
    expect(screen.getByLabelText("14 comments")).toBeTruthy();
    expect(screen.getByLabelText("8 comments")).toBeTruthy();
    expect(screen.getByLabelText("23 comments")).toBeTruthy();
  });

  it("renders version labels for each artifact", async () => {
    const screen = await renderTable();
    const versionButtons = screen.getAllByLabelText(OPEN_VERSION_PATTERN);
    expect(versionButtons.length).toBe(3);
  });

  it("renders model names for each artifact", async () => {
    const screen = await renderTable();
    expect(screen.getAllByText("claude-opus-4-6").length).toBe(2);
    expect(screen.getByText("gpt-5.6-sol")).toBeTruthy();
  });

  it("renders the identity cell with slug and title", async () => {
    const screen = await renderTable();
    expect(screen.getByText("FEA-2481")).toBeTruthy();
    expect(screen.getByText("DOC-184")).toBeTruthy();
    expect(screen.getByText("SES-7B91")).toBeTruthy();
  });

  it("renders related sessions for artifacts that have them", async () => {
    const screen = await renderTable();
    expect(screen.getAllByText("07/31").length).toBe(2);
  });

  it("renders edit pencil buttons for artifact names", async () => {
    const screen = await renderTable();
    const editButtons = screen.getAllByLabelText(EDIT_ARTIFACT_NAME_PATTERN);
    expect(editButtons.length).toBe(3);
  });

  it("enters edit mode on pencil click and saves on Enter", async () => {
    const screen = await renderTable();
    const editButtons = screen.getAllByLabelText(EDIT_ARTIFACT_NAME_PATTERN);
    await userEvent.click(editButtons[0]);
    const input = screen.getByRole("textbox", {
      name: EDIT_ARTIFACT_NAME_PATTERN,
    });
    await userEvent.clear(input);
    await userEvent.type(input, "Renamed artifact{Enter}");
    expect(screen.getByText("Renamed artifact")).toBeTruthy();
  });

  it("cancels title edit on Escape", async () => {
    const screen = await renderTable();
    const editButtons = screen.getAllByLabelText(EDIT_ARTIFACT_NAME_PATTERN);
    await userEvent.click(editButtons[0]);
    const input = screen.getByRole("textbox", {
      name: EDIT_ARTIFACT_NAME_PATTERN,
    });
    await userEvent.clear(input);
    await userEvent.type(input, "Discarded{Escape}");
    expect(screen.getByText("Unified artifact experience")).toBeTruthy();
    expect(screen.queryByText("Discarded")).toBeNull();
  });

  it("renders the add-field button", async () => {
    const screen = await renderTable();
    expect(screen.getByLabelText("Add field")).toBeTruthy();
  });

  it("renders three grid rows", async () => {
    await renderTable();
    const rows = document.querySelectorAll("[data-grid-row-id]");
    expect(rows.length).toBe(3);
  });

  it("renders selection surfaces for each row", async () => {
    await renderTable();
    const surfaces = document.querySelectorAll("[data-row-selection-surface]");
    expect(surfaces.length).toBe(3);
  });

  it("selects only the clicked row on a plain click", async () => {
    await renderTable();
    clickRow(0);
    expect(selectionMask()).toEqual([true, false, false]);
  });

  it("replaces the selection when a second row is plainly clicked", async () => {
    await renderTable();
    clickRow(0);
    clickRow(1);
    expect(selectionMask()).toEqual([false, true, false]);
  });

  it("adds a row to the selection on ctrl-click", async () => {
    await renderTable();
    clickRow(0);
    clickRow(2, { ctrlKey: true });
    expect(selectionMask()).toEqual([true, false, true]);
  });

  it("adds a row to the selection on meta-click", async () => {
    await renderTable();
    clickRow(0);
    clickRow(2, { metaKey: true });
    expect(selectionMask()).toEqual([true, false, true]);
  });

  it("removes an already-selected row on ctrl-click", async () => {
    await renderTable();
    clickRow(0);
    clickRow(2, { ctrlKey: true });
    clickRow(0, { ctrlKey: true });
    expect(selectionMask()).toEqual([false, false, true]);
  });

  it("selects the inclusive range on shift-click", async () => {
    await renderTable();
    clickRow(0);
    clickRow(2, { shiftKey: true });
    expect(selectionMask()).toEqual([true, true, true]);
  });

  it("selects the same range when shift-clicking upward", async () => {
    await renderTable();
    clickRow(2);
    clickRow(0, { shiftKey: true });
    expect(selectionMask()).toEqual([true, true, true]);
  });

  it("falls back to single selection when shift-clicking with no anchor", async () => {
    await renderTable();
    clickRow(1, { shiftKey: true });
    expect(selectionMask()).toEqual([false, true, false]);
  });

  it("reverts a renamed artifact through the toast's Undo action", async () => {
    const screen = await renderTable();
    await userEvent.click(
      screen.getAllByLabelText(EDIT_ARTIFACT_NAME_PATTERN)[0]
    );
    const input = screen.getByRole("textbox", {
      name: EDIT_ARTIFACT_NAME_PATTERN,
    });
    await userEvent.clear(input);
    await userEvent.type(input, "Temporarily renamed{Enter}");
    expect(screen.getByText("Temporarily renamed")).toBeTruthy();

    await userEvent.click(
      await screen.findByRole("button", { name: UNDO_PATTERN })
    );

    expect(screen.getByText("Unified artifact experience")).toBeTruthy();
    expect(screen.queryByText("Temporarily renamed")).toBeNull();
  });

  it("adds a tag that was not already on the artifact", async () => {
    const screen = await renderTable();
    const cell = screen.getAllByLabelText(EDIT_TAGS_PATTERN)[0];
    expect(cell.textContent).not.toContain(UNSELECTED_TAG);

    await userEvent.click(cell);
    await userEvent.click(screen.getByRole("button", { name: UNSELECTED_TAG }));
    await userEvent.keyboard("{Escape}");

    expect(
      screen.getAllByLabelText(EDIT_TAGS_PATTERN)[0].textContent
    ).toContain(UNSELECTED_TAG);
  });

  it("removes a tag the artifact already carries", async () => {
    const screen = await renderTable();
    expect(
      screen.getAllByLabelText(EDIT_TAGS_PATTERN)[0].textContent
    ).toContain(SELECTED_TAG);

    await userEvent.click(screen.getAllByLabelText(EDIT_TAGS_PATTERN)[0]);
    await userEvent.click(screen.getByRole("button", { name: SELECTED_TAG }));
    await userEvent.keyboard("{Escape}");

    const after = screen.getAllByLabelText(EDIT_TAGS_PATTERN)[0].textContent;
    expect(after).not.toContain(SELECTED_TAG);
    expect(after).toContain(REMAINING_TAG);
  });

  it("renders with custom fields passed in initialFields", async () => {
    const screen = await renderTable([
      {
        id: "custom-review-signal",
        label: "Review signal",
        type: "Text",
      },
    ]);
    expect(screen.getByText("Review signal")).toBeTruthy();
  });

  it("renders and updates the leading favorite control", async () => {
    const screen = await renderTable();
    const removeFavorite = screen.getByRole("button", {
      name: "Remove Unified artifact experience from favorites",
    });
    expect(removeFavorite.getAttribute("aria-pressed")).toBe("true");

    await userEvent.click(removeFavorite);

    expect(
      screen
        .getByRole("button", {
          name: "Add Unified artifact experience to favorites",
        })
        .getAttribute("aria-pressed")
    ).toBe("false");
  });
});

/**
 * Modifier-bearing clicks go through `fireEvent`, not `userEvent`: user-event
 * v14 ignores a `{ shiftKey }` / `{ ctrlKey }` object passed to `click()`, so
 * the modifier never reaches the handler and the range/toggle branches are
 * silently never taken.
 */
function clickRow(
  index: number,
  modifiers: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean } = {}
) {
  const rows = document.querySelectorAll("[data-grid-row-id]");
  fireEvent.click(rows[index] as HTMLElement, modifiers);
}

/** Which rows the grid currently reports as selected, in row order. */
function selectionMask() {
  return Array.from(document.querySelectorAll("[data-grid-row-id]")).map(
    (row) => row.getAttribute("aria-selected") === "true"
  );
}
