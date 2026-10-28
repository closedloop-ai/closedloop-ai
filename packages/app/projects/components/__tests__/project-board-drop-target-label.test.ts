import {
  ArtifactBoardDropPosition,
  type ArtifactBoardItem,
} from "@repo/app/shared/components/generic-artifact-surface/artifact-board/artifact-board-model";
import { describe, expect, it } from "vitest";
import { projectBoardDropTargetLabeler } from "../project-artifact-board-model";

const CARD_ID = "01a1606c-0000-7000-8000-000000000101";
const LANE_ID = "01a1606c-0000-7000-8000-00000000aaaa";

const card: ArtifactBoardItem = {
  fieldValues: {},
  id: CARD_ID,
  laneId: LANE_ID,
  parentId: null,
  rootId: CARD_ID,
  slug: "ISS-1",
  title: "Delivery plan",
  typeLabel: "Issue",
};

describe("projectBoardDropTargetLabeler (ISS-12905)", () => {
  const label = projectBoardDropTargetLabeler(
    [card],
    [{ id: LANE_ID, label: "To do", rootIds: [CARD_ID] }]
  );

  it("names a card target by its title and a lane end by its label", () => {
    const beside = label({
      laneId: LANE_ID,
      position: ArtifactBoardDropPosition.Before,
      referenceRootId: CARD_ID,
    });
    const end = label({
      laneId: LANE_ID,
      position: ArtifactBoardDropPosition.End,
    });

    expect(beside).toContain(card.title);
    expect(end).toContain("To do");
    expect(`${beside} ${end}`).not.toContain(CARD_ID);
    expect(`${beside} ${end}`).not.toContain(LANE_ID);
  });

  it("falls back to the position, never an id, for an unknown target", () => {
    const unknownCard = label({
      laneId: LANE_ID,
      position: ArtifactBoardDropPosition.After,
      referenceRootId: "01a1606c-0000-7000-8000-00000000ffff",
    });
    const unknownLane = label({
      laneId: "01a1606c-0000-7000-8000-00000000eeee",
      position: ArtifactBoardDropPosition.End,
    });

    expect(unknownCard).toBe(ArtifactBoardDropPosition.After);
    expect(unknownLane).toBe(ArtifactBoardDropPosition.End);
  });
});
