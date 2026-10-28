import { LEADING_COLUMN_DATA_ID } from "@repo/design-system/lib/grid-table-v2-rows";
import { composeStory } from "@storybook/react";
import { userEvent, within } from "storybook/test";
import { describe, expect, it } from "vitest";
import {
  type ArtifactCustomFieldDefinition,
  artifactColumnDefinitions,
  initialCustomFields,
} from "../../../packages/app/shared/components/generic-artifact-surface/fixtures";
import { GenericArtifactTableDemo } from "../../../packages/app/shared/components/generic-artifact-surface/generic-artifact-table";

/**
 * ISS-9095 contract items 1 and 2, asserted through the PRODUCTION render rather
 * than against the helper. `GenericArtifactTableDemo` is the Gridview column
 * system's reference host; it used to build its column array, its width map and
 * its `gridTemplateColumns` string in three places, so a column could be present
 * in one and absent from another. These assertions fail if the demo goes back to
 * deriving the track from anything but the declaration set.
 */

/**
 * The favorite track, the 280px identity column, one track per declared column at
 * its declared default, then the Add-field track. Written out rather than
 * recomputed from the declarations: a re-derivation would pass against whatever
 * the declarations happen to say, which is the thing under test.
 */
const EXPECTED_TRACK = [
  "36px",
  "280px",
  "130px",
  "120px",
  "130px",
  "304px",
  "220px",
  "100px",
  "100px",
  "140px",
  "160px",
  "180px",
  "180px",
  "120px",
  "140px",
  "40px",
].join(" ");

/**
 * The header row by ROLE, not by its utility classes. A class selector here ties
 * a test about column tracks to the header's stickiness and stacking tier, so
 * restyling either reddens it with a message that says nothing about columns.
 */
const HEADER_ROW_SELECTOR = '[role="row"]:has(> [role="columnheader"])';

async function renderTable(
  fields: readonly ArtifactCustomFieldDefinition[] = []
) {
  const Story = composeStory(
    {
      render: () => <GenericArtifactTableDemo initialFields={fields} />,
    },
    {
      component: GenericArtifactTableDemo,
      title: "Test/GenericArtifactTableRegistryTrack",
    }
  );
  await Story.run();
  return within(document.body);
}

function headerRowTrack(): string {
  const header = document.querySelector<HTMLElement>(HEADER_ROW_SELECTOR);
  if (!header) {
    throw new Error("the grid header row was not rendered");
  }
  return header.style.gridTemplateColumns;
}

/**
 * The DATA columns in painted order. The leading identity column is chrome with
 * its own track, not a registry declaration, so it carries the sentinel id the
 * grid reserves for it and is excluded here.
 */
function columnIdsInPaintedOrder(): string[] {
  return [
    ...document.querySelectorAll<HTMLElement>(
      '[role="columnheader"][data-column-id]'
    ),
  ]
    .map((cell) => cell.dataset.columnId ?? "")
    .filter((columnId) => columnId !== LEADING_COLUMN_DATA_ID);
}

/** The submenu that holds the four placements, matched on its exact text. */
function menuItem(text: string): HTMLElement {
  const item = within(document.body)
    .queryAllByRole("menuitem")
    .find((candidate) => candidate.textContent?.trim() === text);
  if (!item) {
    throw new Error(`no menu item labelled "${text}"`);
  }
  return item;
}

describe("GenericArtifactTableDemo column registry wiring", () => {
  it("paints one track per declared column, at the declared default width", async () => {
    await renderTable();
    expect(headerRowTrack()).toBe(EXPECTED_TRACK);
  });

  it("paints a header cell for every declared column and nothing else", async () => {
    await renderTable();
    expect(columnIdsInPaintedOrder()).toEqual(
      artifactColumnDefinitions.map((definition) => definition.id)
    );
  });

  /**
   * The custom-field bridge carries each field's DECLARED width, not one blanket
   * number. `custom-is-implemented-by` holds three references on the demo's own
   * rows and has been 220px since before the registry existed; the sibling
   * Reference field beside it takes the 180px default, so this pins the
   * exception AND the default off the same render.
   */
  it("paints each custom column at its declared width, not one blanket width", async () => {
    await renderTable(initialCustomFields);
    const painted = columnIdsInPaintedOrder();
    const track = headerRowTrack().split(" ");
    // Two leading tracks (favorite, identity) sit before the first data column.
    const widthOf = (columnId: string) => {
      const index = painted.indexOf(columnId);
      if (index === -1) {
        throw new Error(`the column "${columnId}" was not painted`);
      }
      return track[index + 2];
    };
    expect(widthOf("custom-is-implemented-by")).toBe("220px");
    expect(widthOf("custom-parent-artifact")).toBe("180px");
  });

  it("keeps the track and the painted columns in step after a move", async () => {
    const screen = await renderTable();
    await userEvent.click(screen.getByLabelText("Status column options"));
    await userEvent.click(menuItem("Move column"));
    await userEvent.click(menuItem("Move to start"));
    const painted = columnIdsInPaintedOrder();
    expect(painted[0]).toBe("status");
    // One track per painted column plus the three the host brackets them with.
    expect(headerRowTrack().split(" ")).toHaveLength(painted.length + 3);
    // 304px is Status's declared default and it moved with the column, which a
    // hand-built track keyed on position would not have done.
    expect(headerRowTrack().split(" ")[2]).toBe("304px");
  });
});
