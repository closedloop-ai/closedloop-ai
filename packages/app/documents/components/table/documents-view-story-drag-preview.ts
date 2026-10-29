import {
  createStoryDataTransfer,
  fireStoryDrag,
  storyRowDropRect,
} from "@repo/app/shared/storybook/story-drag";
import { expect, within } from "storybook/test";
import {
  assertTitleAwareDragAnnouncement,
  beginPointerDrag,
  DRAG_REORDER_PATTERN,
  layOutPointerRows,
  storyGridRow,
} from "./documents-view-story-interactions";

/** Proves the sortable Documents path uses the shared compact preview. */
export async function playDocumentsDragging(
  canvasElement: HTMLElement,
  documentIds: string[]
) {
  const source = within(canvasElement).getAllByRole("button", {
    name: DRAG_REORDER_PATTERN,
  })[0];
  if (!source) {
    return;
  }
  layOutPointerRows(source);
  await beginPointerDrag(source);
  const subtree = source.closest<HTMLElement>("[data-dragging='true']");
  await expect(subtree).not.toBeNull();
  await expect(subtree).toHaveClass("bg-accent/40");
  await expect(subtree?.style.transform).toBe("");
  const sourceGridRow = subtree?.querySelector<HTMLElement>(
    "[data-column-id='name']"
  )?.parentElement;
  await expect(sourceGridRow).toHaveClass(
    "[[data-dragging=true]_&]:bg-accent/40"
  );
  const chip = canvasElement.ownerDocument.body.querySelector<HTMLElement>(
    "[data-drag-preview-chip]"
  );
  await expect(chip).not.toBeNull();
  await expect(chip).toHaveTextContent("Test PRD");
  await expect(chip?.querySelector("svg")).toHaveClass("lucide-grip-vertical");
  await expect(chip).toHaveClass(
    "bg-background",
    "border-primary",
    "rounded-md"
  );
  await expect(chip?.querySelector("[data-drag-preview-title]")).toHaveClass(
    "truncate"
  );
  await expect(chip?.style.left).toBe(
    `${source.getBoundingClientRect().left}px`
  );
  await expect(chip?.style.width).toBe("max-content");
  await expect(chip?.style.maxWidth).toContain("var(--container-sm)");
  await assertTitleAwareDragAnnouncement(canvasElement, documentIds);
}

/** Proves native hierarchy drag does not displace rows beneath its preview. */
export async function playDocumentsDragOver(
  canvasElement: HTMLElement,
  sourceName: string,
  targetName: string
) {
  const sourceRow = storyGridRow(canvasElement, sourceName);
  const targetRow = storyGridRow(canvasElement, targetName);
  const rowsBefore = canvasElement.querySelectorAll("[data-grid-row]").length;
  const dataTransfer = createStoryDataTransfer();
  const targetRect = storyRowDropRect(targetRow);
  targetRow.getBoundingClientRect = () => targetRect;
  fireStoryDrag(sourceRow, "dragstart", targetRect.left, 0, dataTransfer);
  fireStoryDrag(
    targetRow,
    "dragover",
    targetRect.left,
    targetRect.bottom - 1,
    dataTransfer
  );
  await expect(sourceRow).toHaveAttribute("data-dragging", "true");
  await expect(sourceRow).toHaveClass("data-[dragging=true]:bg-accent/40");
  await expect(sourceRow.style.transform).toBe("");
  await expect(
    canvasElement.ownerDocument.body.querySelector("[data-drag-preview-chip]")
  ).not.toBeNull();
  await expect(targetRow).toHaveAttribute("data-row-drop", "after");
  await expect(targetRow).toHaveClass(
    "data-[row-drop=after]:border-b",
    "data-[row-drop=after]:border-b-primary"
  );
  for (const row of canvasElement.querySelectorAll<HTMLElement>(
    "[data-grid-row]"
  )) {
    await expect(row.style.transform).toBe("");
  }
  await expect(canvasElement.querySelectorAll("[data-grid-row]")).toHaveLength(
    rowsBefore
  );
}
