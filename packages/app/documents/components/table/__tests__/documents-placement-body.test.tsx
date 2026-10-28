// @vitest-environment jsdom

import { ProjectArtifactPlacementPosition } from "@repo/api/src/types/project-artifact-placement";
import { SortableSubtree } from "@repo/design-system/components/ui/sortable-subtree";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DocumentsPlacementBody } from "../documents-placement-body";

const ROOT_ID = "11111111-1111-7111-8111-111111111111";
const TARGET_ID = "22222222-2222-7222-8222-222222222222";
const DROPPED_ANNOUNCEMENT = /was dropped/;

describe("DocumentsPlacementBody", () => {
  it("keeps the original stack-rank announcement when manual placement is off", async () => {
    const user = userEvent.setup();
    render(
      <DocumentsPlacementBody
        enabled
        itemIds={[ROOT_ID]}
        manualPlacementEnabled={false}
        onDragEnd={vi.fn()}
      >
        <SortableSubtree
          announcementLabel="Test PRD"
          handleLabel="Reorder row"
          id={ROOT_ID}
          renderRoot={({ buttonProps }) => <button {...buttonProps} />}
        />
      </DocumentsPlacementBody>
    );

    const handle = screen.getByRole("button", { name: "Reorder row" });
    handle.focus();
    await user.keyboard(" ");

    expect(
      screen.getByText(
        `Draggable item ${ROOT_ID} was moved over droppable area ${ROOT_ID}.`
      )
    ).toBeInTheDocument();
  });

  it("anchors the shared chip below the active Inside row ring", async () => {
    const user = userEvent.setup();
    render(
      <DocumentsPlacementBody
        enabled
        itemIds={[ROOT_ID, TARGET_ID]}
        manualPlacementEnabled
        onDragEnd={vi.fn()}
        placementPreview={{
          position: ProjectArtifactPlacementPosition.Inside,
          targetArtifactId: TARGET_ID,
        }}
      >
        <SortableSubtree
          announcementLabel="Source"
          handleLabel="Reorder source"
          id={ROOT_ID}
          renderRoot={({ buttonProps }) => <button {...buttonProps} />}
        />
        <SortableSubtree
          announcementLabel="Target"
          dropPosition="inside"
          handleLabel="Reorder target"
          id={TARGET_ID}
          renderRoot={({ buttonProps }) => <button {...buttonProps} />}
        />
      </DocumentsPlacementBody>
    );
    const target = globalThis.document.querySelector<HTMLElement>(
      `[data-sortable-subtree-id="${TARGET_ID}"] > div`
    );
    if (!target) {
      throw new Error("Missing target row");
    }
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
      bottom: 320,
    } as DOMRect);
    const source = screen.getByRole("button", { name: "Reorder source" });
    await user.pointer([
      { keys: "[MouseLeft>]", target: source },
      { coords: { clientX: 8, clientY: 290 }, target: source },
    ]);
    expect(screen.getByTestId("drag-preview-chip")).toHaveStyle({
      top: "320px",
    });
  });

  it("announces the row title without exposing its internal id", async () => {
    const user = userEvent.setup();
    renderPlacement();

    const handle = screen.getByRole("button", { name: "Reorder row" });
    handle.focus();
    await user.keyboard(" ");

    expect(
      screen.getByText(
        "Draggable item Test PRD was moved over droppable area Test PRD."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(ROOT_ID))).toBeNull();
  });

  it("leaves drop settlement copy to the placement mutation", async () => {
    const user = userEvent.setup();
    const onDragEnd = vi.fn();
    renderPlacement(onDragEnd);

    const handle = screen.getByRole("button", { name: "Reorder row" });
    handle.focus();
    await user.keyboard(" ");
    await user.keyboard(" ");

    expect(onDragEnd).toHaveBeenCalledOnce();
    expect(screen.queryByText(DROPPED_ANNOUNCEMENT)).toBeNull();
  });
});

function renderPlacement(onDragEnd = vi.fn()) {
  return render(
    <DocumentsPlacementBody
      enabled
      itemIds={[ROOT_ID]}
      manualPlacementEnabled
      onDragEnd={onDragEnd}
    >
      <SortableSubtree
        announcementLabel="Test PRD"
        handleLabel="Reorder row"
        id={ROOT_ID}
        renderRoot={({ buttonProps }) => <button {...buttonProps} />}
      />
    </DocumentsPlacementBody>
  );
}
