// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ArtifactBoard } from "../artifact-board";
import {
  type ArtifactBoardItem,
  ArtifactBoardMutationState,
} from "../artifact-board-model";

const ITEM_ID = "01a1606c-0000-7000-8000-000000000101";
const ITEM_TITLE = "Delivery plan";
const LANE_ID = "lane-todo";
const LANE_LABEL = "To do";

const item: ArtifactBoardItem = {
  fieldValues: {},
  id: ITEM_ID,
  laneId: LANE_ID,
  parentId: null,
  rootId: ITEM_ID,
  slug: "ISS-1",
  title: ITEM_TITLE,
  typeLabel: "Issue",
};

describe("ArtifactBoard drag announcements (ISS-12905)", () => {
  it("names the picked-up card by its title, never its id", async () => {
    render(
      <ArtifactBoard
        feedback={{ state: ArtifactBoardMutationState.Idle }}
        fields={[]}
        getDropTargetLabel={() => LANE_LABEL}
        items={[item]}
        lanes={[{ id: LANE_ID, label: LANE_LABEL, rootIds: [ITEM_ID] }]}
        onMove={vi.fn()}
        onOpen={vi.fn()}
        onSelectionChange={vi.fn()}
        primaryGroupFieldId="status"
        secondaryGroupFieldId={null}
        selectedIds={[]}
        visibleFieldIds={[]}
      />
    );

    const source = document.querySelector(
      `[data-artifact-board-drag-source="${ITEM_ID}"]`
    );
    if (!(source instanceof HTMLElement)) {
      throw new Error("The board rendered no drag source for the card");
    }
    fireEvent.keyDown(source, { code: "Space", key: " " });

    const liveRegion = screen.getByRole("status", { hidden: true });
    await waitFor(() => expect(liveRegion).toHaveTextContent(ITEM_TITLE));
    expect(liveRegion.textContent).not.toContain(ITEM_ID);

    // Dropping is announced too, by title: no board host announces a settled
    // move, so a silent drop would leave the user with no outcome at all.
    const pickedUp = liveRegion.textContent;
    fireEvent.keyDown(source, { code: "Space", key: " " });
    await waitFor(() => expect(liveRegion.textContent).not.toBe(pickedUp));
    expect(liveRegion).toHaveTextContent(ITEM_TITLE);
    expect(liveRegion.textContent).not.toContain(ITEM_ID);
  });
});
