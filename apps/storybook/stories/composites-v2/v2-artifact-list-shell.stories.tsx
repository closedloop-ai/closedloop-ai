import { selectionSentence } from "@repo/app/shared/components/generic-artifact-surface/bulk-action-bar";
import {
  buildFilterViewModel,
  genericArtifactColumns,
} from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-list-model";
import { GenericArtifactListShell } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-shells";
import { genericArtifacts } from "@repo/app/shared/components/generic-artifact-surface/preview/fixtures";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, fireEvent, screen, within } from "storybook/test";

const STORY_ARTIFACTS = genericArtifacts.slice(0, 3);
const STORY_CURRENT_USER = { id: "story-user", name: "Story User" };
const FIRST = STORY_ARTIFACTS[0]!;
const SECOND = STORY_ARTIFACTS[1]!;
const OWNER_COLUMN = genericArtifactColumns.find(({ id }) => id === "owner");
if (!OWNER_COLUMN) {
  throw new Error("Expected the canonical artifact Owner column");
}
const FIRST_OWNER_PATTERN = new RegExp(FIRST.owner);
const NO_SELECTION = "No artifacts selected";
const ONE_ARTIFACT_SELECTED = selectionSentence(1);
const TWO_ARTIFACTS_SELECTED = selectionSentence(2);
const THREE_ARTIFACTS_SELECTED = selectionSentence(3);
const CREATED_BY_ME = buildFilterViewModel(STORY_ARTIFACTS, STORY_CURRENT_USER)
  .labels?.assignToMe;
if (!CREATED_BY_ME) {
  throw new Error("Expected the canonical artifact current-user filter label");
}
const CREATED_BY_ME_PATTERN = new RegExp(`${CREATED_BY_ME}$`);

const meta = {
  title: "Composites/Shared/Artifact List/Artifact List Shell",
  tags: ["stable", "autodocs"],
  component: GenericArtifactListShell,
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
  },
} satisfies Meta<typeof GenericArtifactListShell>;

export default meta;

// No controls: the real shell's fixtures own its rows, columns, filters and layout transitions.
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    artifacts: STORY_ARTIFACTS,
    currentUser: STORY_CURRENT_USER,
    onOpenArtifact: () => undefined,
  },
};

export const SelectionReconciliation: Story = {
  args: {
    artifacts: STORY_ARTIFACTS,
    controlledFavoriteIds: new Set<string>(),
    currentUser: STORY_CURRENT_USER,
    onOpenArtifact: () => undefined,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    openMenu(
      canvas.getByRole("button", {
        name: `${OWNER_COLUMN.label} column options`,
      })
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Group" }));
    await selectRow(canvasElement, FIRST.id);
    await selectRow(canvasElement, SECOND.id, { ctrlKey: true });
    await expect(selectionStatus(canvasElement)).toHaveTextContent(
      TWO_ARTIFACTS_SELECTED
    );
    await expect(
      canvas.getByRole("toolbar", {
        name: TWO_ARTIFACTS_SELECTED,
      })
    ).toBeInTheDocument();
    await fireEvent.click(groupToggle(canvas, FIRST_OWNER_PATTERN));
    await expect(selectionStatus(canvasElement)).toHaveTextContent(
      ONE_ARTIFACT_SELECTED
    );

    openMenu(canvas.getAllByRole("button", { name: "Filters" })[0]!);
    fireEvent.click(
      screen.getByRole("menuitem", { name: CREATED_BY_ME_PATTERN })
    );
    closeMenu(canvasElement);
    await expect(selectionStatus(canvasElement)).toHaveTextContent(
      NO_SELECTION
    );
    await expect(canvas.queryByRole("toolbar")).not.toBeInTheDocument();
    await expect(
      canvas.queryByRole("button", { name: "Favorite" })
    ).not.toBeInTheDocument();
    openMenu(canvas.getAllByRole("button", { name: "Filters" })[0]!);
    fireEvent.click(
      screen.getByRole("menuitem", { name: CREATED_BY_ME_PATTERN })
    );
    closeMenu(canvasElement);
    await fireEvent.click(groupToggle(canvas, FIRST_OWNER_PATTERN));

    await fireEvent.keyDown(artifactCell(canvasElement, FIRST.id), {
      ctrlKey: true,
      key: "a",
    });
    await expect(selectionStatus(canvasElement)).toHaveTextContent(
      THREE_ARTIFACTS_SELECTED
    );
    await expect(
      canvas.getByRole("toolbar", { name: THREE_ARTIFACTS_SELECTED })
    ).toBeInTheDocument();
    fireEvent.click(canvas.getAllByRole("radio", { name: "Board view" })[0]!);
    await expect(selectionStatus(canvasElement)).toHaveTextContent(
      NO_SELECTION
    );
    await expect(canvas.queryByRole("toolbar")).not.toBeInTheDocument();
    await expect(
      canvas.queryByRole("button", { name: "Favorite" })
    ).not.toBeInTheDocument();
  },
};

async function selectRow(
  canvasElement: HTMLElement,
  rowId: string,
  modifiers: { ctrlKey?: boolean } = {}
) {
  const cell = artifactCell(canvasElement, rowId);
  await fireEvent.click(cell, modifiers);
}

function artifactCell(canvasElement: HTMLElement, rowId: string): HTMLElement {
  const cell = canvasElement.querySelector<HTMLElement>(
    `[data-grid-row-id="${rowId}"] [data-column-id="updated"]`
  );
  if (!cell) {
    throw new Error(`Expected selectable row ${rowId}`);
  }
  return cell;
}

function openMenu(trigger: HTMLElement): void {
  fireEvent.pointerDown(trigger, {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
}

function closeMenu(canvasElement: HTMLElement): void {
  const target = canvasElement.ownerDocument.activeElement ?? canvasElement;
  fireEvent.keyDown(target, { key: "Escape" });
}

function selectionStatus(canvasElement: HTMLElement): HTMLElement {
  const status = canvasElement.querySelector<HTMLElement>("output[aria-live]");
  if (!status) {
    throw new Error("Expected the artifact selection status");
  }
  return status;
}

function groupToggle(
  canvas: ReturnType<typeof within>,
  name: RegExp
): HTMLElement {
  const toggle = canvas
    .getAllByRole("button", { name })
    .find((candidate) => candidate.hasAttribute("aria-expanded"));
  if (!toggle) {
    throw new Error(`Expected group toggle ${name.source}`);
  }
  return toggle;
}
