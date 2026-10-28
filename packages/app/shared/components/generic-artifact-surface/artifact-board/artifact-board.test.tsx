import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ArtifactBoard } from "./artifact-board";
import {
  ArtifactBoardDropPosition,
  type ArtifactBoardItem,
  ArtifactBoardMutationState,
  ArtifactBoardSelectionIntent,
} from "./artifact-board-model";

const root: ArtifactBoardItem = {
  fieldValues: { owner: "Ada", status: "Todo" },
  id: "root",
  laneId: "todo",
  parentId: null,
  rootId: "root",
  slug: "ISS-1",
  title: "Root issue",
  typeLabel: "Issue",
};
const child: ArtifactBoardItem = {
  ...root,
  id: "child",
  parentId: "root",
  rootId: "root",
  slug: "ISS-2",
  title: "Hidden child",
};
const secondRoot: ArtifactBoardItem = {
  ...root,
  id: "second",
  rootId: "second",
  slug: "PRD-1",
  title: "Second root",
};

function renderBoard(
  overrides: Partial<Parameters<typeof ArtifactBoard>[0]> = {}
) {
  const onMove = vi.fn();
  const onOpen = vi.fn();
  const onSelectionChange = vi.fn();
  render(
    <ArtifactBoard
      feedback={{ state: ArtifactBoardMutationState.Idle }}
      fields={[
        { id: "status", label: "Status", tier: "primary" },
        { id: "owner", label: "Owner", tier: "secondary" },
      ]}
      getDropTargetLabel={(target) => `${target.position} ${target.laneId}`}
      items={[root, child, secondRoot]}
      lanes={[{ id: "todo", label: "Todo", rootIds: ["root", "second"] }]}
      onMove={onMove}
      onOpen={onOpen}
      onSelectionChange={onSelectionChange}
      primaryGroupFieldId="status"
      secondaryGroupFieldId={null}
      selectedIds={[]}
      visibleFieldIds={["status", "owner"]}
      {...overrides}
    />
  );
  return { onMove, onOpen, onSelectionChange };
}

describe("PRD-724 AC-001/AC-003 Artifact Board rendering", () => {
  it("renders root cards only and omits the primary grouped field", () => {
    renderBoard();
    expect(
      screen
        .getAllByRole("group")
        .filter((element) => element.hasAttribute("data-artifact-board-card"))
    ).toHaveLength(2);
    expect(screen.queryByText("Hidden child")).not.toBeInTheDocument();
    expect(
      document.querySelector('[data-artifact-board-field="status"]')
    ).toBeNull();
    expect(
      document.querySelector('[data-artifact-board-field="owner"]')
    ).not.toBeNull();
  });

  it("opens from the title while unused card surface selects", async () => {
    const user = userEvent.setup();
    const { onOpen, onSelectionChange } = renderBoard();
    await user.click(screen.getByRole("button", { name: "Root issue" }));
    expect(onOpen).toHaveBeenCalledWith(root);
    expect(onSelectionChange).not.toHaveBeenCalled();

    await user.click(
      document.querySelector('[data-artifact-board-card="root"]') as HTMLElement
    );
    expect(onSelectionChange).toHaveBeenCalledWith(
      "root",
      ArtifactBoardSelectionIntent.Replace
    );
  });

  it("selects from the card keyboard surface without opening the title", () => {
    const { onOpen, onSelectionChange } = renderBoard();
    const card = document.querySelector(
      '[data-artifact-board-card="root"]'
    ) as HTMLElement;
    fireEvent.keyDown(card, { key: "Enter" });
    expect(onSelectionChange).toHaveBeenCalledWith(
      "root",
      ArtifactBoardSelectionIntent.Replace
    );
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe("PRD-724 AC-002/AC-004 movement and authority", () => {
  it("extends the lane-end drop target into whitespace below the last root", () => {
    renderBoard();
    expect(
      document.querySelector(
        '[data-artifact-board-drop-target="artifact-board-drop:todo:end:lane"]'
      )
    ).toHaveClass("grow");
  });

  it("uses the same selected-root descriptor for a keyboard-accessible menu move", async () => {
    const user = userEvent.setup();
    const { onMove } = renderBoard({
      renderActions: (_item, move) => (
        <button
          onClick={() =>
            move({ laneId: "todo", position: ArtifactBoardDropPosition.End })
          }
          type="button"
        >
          Move card
        </button>
      ),
      selectedIds: ["root", "second"],
    });
    await user.click(screen.getAllByRole("button", { name: "Move card" })[0]!);
    expect(onMove).toHaveBeenCalledWith({
      rootIds: ["root", "second"],
      sourceLaneId: "todo",
      target: { laneId: "todo", position: ArtifactBoardDropPosition.End },
    });
  });

  it("disables the drag origin for source-managed artifacts", () => {
    renderBoard({ canMoveItem: () => false });
    const card = document.querySelector(
      '[data-artifact-board-card="root"]'
    ) as HTMLElement;
    expect(
      card.closest('[data-artifact-board-drag-disabled="true"]')
    ).not.toBeNull();
  });

  it("CT-18 routes a denied menu/keyboard target to one rejection result", async () => {
    const user = userEvent.setup();
    const onMoveRejected = vi.fn();
    const { onMove } = renderBoard({
      canMoveItemToTarget: () => false,
      onMoveRejected,
      renderActions: (_item, move) => (
        <button
          onClick={() =>
            move({ laneId: "todo", position: ArtifactBoardDropPosition.End })
          }
          type="button"
        >
          Move card
        </button>
      ),
    });

    await user.click(screen.getAllByRole("button", { name: "Move card" })[0]!);
    expect(onMove).not.toHaveBeenCalled();
    expect(onMoveRejected).toHaveBeenCalledWith(root, {
      laneId: "todo",
      position: ArtifactBoardDropPosition.End,
    });
  });

  it("exposes an empty-lane insertion slot", () => {
    renderBoard({
      lanes: [
        { id: "todo", label: "Todo", rootIds: ["root", "second"] },
        { id: "done", label: "Done", rootIds: [] },
      ],
    });
    expect(
      document.querySelector('[data-artifact-board-drop-target*="done:end"]')
    ).not.toBeNull();
  });
});
