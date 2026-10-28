import {
  KANBAN_COLUMN_GAP_PX,
  KANBAN_COLUMN_WIDTH_PX,
} from "@repo/design-system/components/ui/layout/kanban-board";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactBoard } from "./artifact-board";
import {
  ArtifactBoardDropPosition,
  type ArtifactBoardItem,
  type ArtifactBoardLane,
  type ArtifactBoardMove,
  ArtifactBoardMutationState,
} from "./artifact-board-model";
import {
  ARTIFACT_BOARD_CARD_ESTIMATE_PX,
  ARTIFACT_BOARD_CARD_VIRTUALIZATION_THRESHOLD,
  ARTIFACT_BOARD_LANE_VIRTUALIZATION_THRESHOLD,
} from "./artifact-board-virtualization";

const ISSUE_CARD_PATTERN = /^ISS-/;
const SELECTED_CARD_PATTERN = /selected$/;

const FIELD = { id: "owner", label: "Owner", tier: "primary" } as const;
const CARD_ZERO_PATTERN = /Card 0/;
let restoreRect: (() => void) | null = null;

afterEach(() => {
  restoreRect?.();
  restoreRect = null;
});

describe("CT-16 AC-002/AC-004 Artifact Board virtualization", () => {
  it("keeps threshold-sized boards fully mounted", () => {
    const fixture = boardFixture(
      ARTIFACT_BOARD_LANE_VIRTUALIZATION_THRESHOLD,
      1
    );
    renderBoard(fixture);

    expect(
      document.querySelectorAll("[data-artifact-board-lane]")
    ).toHaveLength(ARTIFACT_BOARD_LANE_VIRTUALIZATION_THRESHOLD);
    expect(
      document.querySelector("[data-artifact-board-lane-virtual-index]")
    ).toBeNull();
  });

  it("windows a board wider than the lane threshold", () => {
    const laneCount = ARTIFACT_BOARD_LANE_VIRTUALIZATION_THRESHOLD + 1;
    renderBoard(boardFixture(laneCount, 1));

    const painted = document.querySelectorAll(
      "[data-artifact-board-lane-virtual-index]"
    );
    expect(painted.length).toBeGreaterThan(0);
    expect(painted.length).toBeLessThan(laneCount);
  });

  it("advances the horizontal lane window with the board scroller", async () => {
    const laneCount = 40;
    renderBoard(boardFixture(laneCount, 1));
    const scroller = document.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]'
    );
    if (!scroller) {
      throw new Error("lane scroller was not mounted");
    }
    const before = virtualLaneIndexes();

    await act(async () => {
      scroller.scrollLeft =
        20 * (KANBAN_COLUMN_WIDTH_PX + KANBAN_COLUMN_GAP_PX);
      fireEvent.scroll(scroller);
      await nextFrame();
    });

    await waitFor(() => {
      const after = virtualLaneIndexes();
      expect(Math.max(...after)).toBeGreaterThan(Math.max(...before));
      expect(after).not.toContain(0);
    });
  });

  it("keeps one default page whole and windows a deeper lane", () => {
    const boundary = boardFixture(
      1,
      ARTIFACT_BOARD_CARD_VIRTUALIZATION_THRESHOLD
    );
    const boundaryRender = renderBoard(boundary);
    expect(
      screen.getAllByRole("group", { name: ISSUE_CARD_PATTERN })
    ).toHaveLength(ARTIFACT_BOARD_CARD_VIRTUALIZATION_THRESHOLD);
    expect(
      document.querySelector("[data-artifact-board-card-window]")
    ).toBeNull();
    boundaryRender.unmount();

    const deepCount = ARTIFACT_BOARD_CARD_VIRTUALIZATION_THRESHOLD + 1;
    renderBoard(boardFixture(1, deepCount));
    expect(
      document.querySelector("[data-artifact-board-card-window]")
    ).not.toBeNull();
    expect(
      screen.getAllByRole("group", { name: ISSUE_CARD_PATTERN }).length
    ).toBeLessThan(deepCount);
  });

  it("pins an off-window selected card and preserves whole-population semantics", () => {
    const cardCount = ARTIFACT_BOARD_CARD_VIRTUALIZATION_THRESHOLD + 1;
    const fixture = boardFixture(1, cardCount);
    const pinnedId = fixture.lanes[0]?.rootIds.at(-1) ?? "";
    renderBoard(fixture, [pinnedId]);

    const pinned = screen.getByRole("group", {
      name: SELECTED_CARD_PATTERN,
    });
    expect(pinned).toHaveAttribute("data-artifact-board-card", pinnedId);
    expect(pinned).toHaveAttribute("data-position-in-set", String(cardCount));
    expect(pinned).toHaveAttribute("data-set-size", String(cardCount));
  });

  it("keeps a focused card mounted while the lane scroll window moves", async () => {
    const cardCount = 100;
    renderBoard(boardFixture(1, cardCount));
    const first = screen.getByRole("group", { name: CARD_ZERO_PATTERN });
    act(() => first.focus());
    const cardWindow = document.querySelector(
      "[data-artifact-board-card-window]"
    );
    const scroller = cardWindow?.parentElement;
    if (!scroller) {
      throw new Error("card scroller was not mounted");
    }

    await act(async () => {
      scroller.scrollTop = 70 * ARTIFACT_BOARD_CARD_ESTIMATE_PX;
      fireEvent.scroll(scroller);
      await nextFrame();
    });

    expect(document.activeElement).toBe(first);
    expect(first).toBeInTheDocument();
    expect(
      Array.from(
        document.querySelectorAll<HTMLElement>(
          "[data-artifact-board-card-virtual-index]"
        )
      ).some(
        (element) => Number(element.dataset.artifactBoardCardVirtualIndex) > 0
      )
    ).toBe(true);
  });

  it("keeps exact visible card-edge/lane-end targets and honest partial counts", () => {
    const fixture = boardFixture(
      1,
      ARTIFACT_BOARD_CARD_VIRTUALIZATION_THRESHOLD + 1
    );
    fixture.lanes[0] = { ...fixture.lanes[0]!, count: 100 };
    renderBoard(fixture);

    expect(screen.getByText("100")).toBeVisible();
    expect(
      document.querySelector(
        '[data-artifact-board-drop-target="artifact-board-drop:lane-0:before:lane-0-card-0"]'
      )
    ).not.toBeNull();
    expect(
      document.querySelector(
        '[data-artifact-board-drop-target="artifact-board-drop:lane-0:after:lane-0-card-0"]'
      )
    ).not.toBeNull();
    expect(
      document.querySelector(
        '[data-artifact-board-drop-target="artifact-board-drop:lane-0:end:lane"]'
      )
    ).not.toBeNull();
  });

  it("keeps an empty lane's insertion target without starting a card window", () => {
    renderBoard(boardFixture(1, 0));

    expect(
      document.querySelector("[data-artifact-board-card-window]")
    ).toBeNull();
    expect(
      document.querySelector(
        '[data-artifact-board-drop-target="artifact-board-drop:lane-0:end:lane"]'
      )
    ).toHaveClass("min-h-34");
  });

  it("keeps the virtualized destination pinned through a real pointer drop", async () => {
    const fixture = boardFixture(1, 100);
    const sourceId = fixture.lanes[0]?.rootIds[0] ?? "";
    const destinationId = fixture.lanes[0]?.rootIds.at(-1) ?? "";
    const view = renderBoard(fixture, [destinationId]);
    installDragRects(sourceId, destinationId);
    const source = document.querySelector<HTMLElement>(
      `[data-artifact-board-card="${sourceId}"]`
    );
    const destinationSelector = `[data-artifact-board-drop-target="artifact-board-drop:lane-0:before:${destinationId}"]`;
    const destination =
      document.querySelector<HTMLElement>(destinationSelector);
    if (!(source && destination)) {
      throw new Error("drag endpoints were not mounted");
    }

    fireEvent.mouseDown(source, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.mouseMove(source.ownerDocument, { clientX: 30, clientY: 30 });
    await waitFor(() => {
      const dragOrigin = document
        .querySelector(`[data-artifact-board-card="${sourceId}"]`)
        ?.closest(".touch-pan-y");
      expect(dragOrigin).toHaveClass("ring-primary/60");
      expect(dragOrigin).not.toHaveAttribute("style");
      expect(screen.getByTestId("drag-preview-chip")).toHaveTextContent(
        "Card 0"
      );
      expect(
        screen
          .getByTestId("drag-preview-chip")
          .querySelector("button, fieldset")
      ).toBeNull();
    });

    fireEvent.mouseMove(destination, { clientX: 220, clientY: 210 });
    await waitFor(() => expect(destination).toHaveClass("before:bg-primary"));
    view.rerenderBoard([]);
    expect(document.querySelector(destinationSelector)).not.toBeNull();

    const cardWindow = document.querySelector(
      "[data-artifact-board-card-window]"
    );
    const scroller = cardWindow?.parentElement;
    if (!scroller) {
      throw new Error("card scroller was not mounted");
    }
    await act(async () => {
      scroller.scrollTop = 50 * ARTIFACT_BOARD_CARD_ESTIMATE_PX;
      fireEvent.scroll(scroller);
      await nextFrame();
    });
    expect(document.querySelector(destinationSelector)).not.toBeNull();
    expect(
      document
        .querySelector(`[data-artifact-board-card="${sourceId}"]`)
        ?.closest(".touch-pan-y")
    ).toHaveClass("ring-primary/60");

    fireEvent.mouseUp(destination, { clientX: 220, clientY: 210 });
    await waitFor(() => {
      expect(view.onMove).toHaveBeenCalledWith({
        rootIds: [sourceId],
        sourceLaneId: "lane-0",
        target: {
          laneId: "lane-0",
          position: ArtifactBoardDropPosition.Before,
          referenceRootId: destinationId,
        },
      });
    });
    expect(screen.queryByTestId("drag-preview-chip")).toBeNull();
  });
});

function renderBoard(
  fixture: ReturnType<typeof boardFixture>,
  selectedIds: readonly string[] = []
) {
  const onMove = vi.fn<(move: ArtifactBoardMove) => void>();
  const rendered = render(artifactBoardElement(fixture, selectedIds, onMove));
  return {
    ...rendered,
    onMove,
    rerenderBoard(nextSelectedIds: readonly string[]) {
      rendered.rerender(artifactBoardElement(fixture, nextSelectedIds, onMove));
    },
  };
}

function artifactBoardElement(
  fixture: ReturnType<typeof boardFixture>,
  selectedIds: readonly string[],
  onMove: (move: ArtifactBoardMove) => void
) {
  return (
    <ArtifactBoard
      feedback={{ state: ArtifactBoardMutationState.Idle }}
      fields={[FIELD]}
      getDropTargetLabel={(target) => target.laneId}
      items={fixture.items}
      lanes={fixture.lanes}
      onMove={onMove}
      onOpen={vi.fn()}
      onSelectionChange={vi.fn()}
      primaryGroupFieldId="status"
      secondaryGroupFieldId={null}
      selectedIds={selectedIds}
      visibleFieldIds={[FIELD.id]}
    />
  );
}

function boardFixture(
  laneCount: number,
  cardsPerLane: number
): { items: ArtifactBoardItem[]; lanes: ArtifactBoardLane[] } {
  const items: ArtifactBoardItem[] = [];
  const lanes = Array.from({ length: laneCount }, (_, laneIndex) => {
    const laneId = `lane-${laneIndex}`;
    const rootIds = Array.from({ length: cardsPerLane }, (_, cardIndex) => {
      const id = `${laneId}-card-${cardIndex}`;
      items.push({
        fieldValues: { owner: "Ada" },
        id,
        laneId,
        parentId: null,
        rootId: id,
        slug: `ISS-${cardIndex}`,
        title: `Card ${cardIndex}`,
        typeLabel: "Issue",
      });
      return id;
    });
    return { id: laneId, label: `Lane ${laneIndex}`, rootIds };
  });
  return { items, lanes };
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    globalThis.requestAnimationFrame(() => resolve());
  });
}

function virtualLaneIndexes(): number[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      "[data-artifact-board-lane-virtual-index]"
    )
  ).map((element) => Number(element.dataset.artifactBoardLaneVirtualIndex));
}

function installDragRects(sourceId: string, destinationId: string): void {
  const original = Element.prototype.getBoundingClientRect;
  restoreRect = () => {
    Element.prototype.getBoundingClientRect = original;
  };
  Element.prototype.getBoundingClientRect = function dragRect(this: Element) {
    const element = this as HTMLElement;
    if (
      element.dataset.artifactBoardDropTarget ===
      `artifact-board-drop:lane-0:before:${destinationId}`
    ) {
      return domRect(200, 200, 300, 240);
    }
    if (element.querySelector(`[data-artifact-board-card="${sourceId}"]`)) {
      return domRect(0, 0, 100, 100);
    }
    return original.call(this);
  };
}

function domRect(
  left: number,
  top: number,
  right: number,
  bottom: number
): DOMRect {
  return {
    bottom,
    height: bottom - top,
    left,
    right,
    toJSON: () => ({}),
    top,
    width: right - left,
    x: left,
    y: top,
  } as DOMRect;
}
