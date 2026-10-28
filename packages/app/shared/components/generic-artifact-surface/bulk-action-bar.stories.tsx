/**
 * The bulk action bar's own state matrix, which the parity demo cannot show:
 * there the bar exists only while rows are selected, so its singular wording,
 * its plural wording, and the empty announcement a clear leaves behind can
 * never be seen side by side. Standalone is also the only way to review its
 * INVERTED surface in both themes without driving a selection first.
 */

import type { Meta, StoryObj } from "@storybook/react";
import { expect, screen, userEvent, within } from "storybook/test";
import {
  ArtifactBulkActionBar,
  ArtifactSelectionAnnouncer,
} from "./bulk-action-bar";
import { demoArtifactBulkActions } from "./demo-bulk-actions";
import { artifactPeople } from "./fixtures";

/** A selection of `count` rows, as the ids the rail hands every descriptor. */
function selectionOf(count: number): readonly string[] {
  return Array.from({ length: count }, (_value, index) => `artifact-${index}`);
}

function railArgs(count: number) {
  return {
    actions: demoArtifactBulkActions({
      count,
      onAssignOwner: () => undefined,
      onFavorite: () => undefined,
      people: artifactPeople,
    }),
    onClear: () => undefined,
    onRetainSelection: () => undefined,
    rowIds: selectionOf(count),
  };
}

const meta = {
  title: "Composites v1.0/App Shell/Bulk Action Bar",
  component: ArtifactBulkActionBar,
  tags: ["deprecated", "autodocs"],
  parameters: { layout: "fullscreen" },
  args: railArgs(1),
} satisfies Meta<typeof ArtifactBulkActionBar>;

export default meta;

type Story = StoryObj<typeof meta>;

/** One row: every accessible name is singular. */
export const SingleSelection: Story = {
  args: railArgs(1),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("toolbar", { name: "1 artifact selected" })
    ).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Favorite 1 artifact selected" })
    ).toBeVisible();
  },
};

/** Several rows: the same names pluralize, so no label reads "1 artifacts". */
export const MultipleSelection: Story = {
  args: railArgs(12),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: "Favorite 12 artifacts selected" })
    ).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Clear selection" })
    ).toBeVisible();
  },
};

/** The owner menu, the one control whose content comes from a prop. */
export const OwnerMenuOpen: Story = {
  args: railArgs(3),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", {
        name: "Assign owner of 3 artifacts selected",
      })
    );
    // The menu portals out of the canvas, so it is found on the document.
    for (const person of artifactPeople) {
      await expect(
        await screen.findByRole("menuitem", { name: person.name })
      ).toBeVisible();
    }
  },
};

/**
 * The announcer WITHOUT the bar — the state a clear leaves behind. It is the
 * one statement in the accessibility tree that survives the bar unmounting, so
 * a screen-reader user hears "No artifacts selected" rather than silence.
 */
export const ClearedAnnouncement: Story = {
  args: railArgs(0),
  render: () => <ArtifactSelectionAnnouncer count={0} />,
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("status")).toHaveTextContent(
      "No artifacts selected"
    );
  },
};
