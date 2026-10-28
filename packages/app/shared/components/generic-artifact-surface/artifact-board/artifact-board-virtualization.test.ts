import { describe, expect, it } from "vitest";
import {
  ARTIFACT_BOARD_CARD_VIRTUALIZATION_THRESHOLD,
  ARTIFACT_BOARD_LANE_VIRTUALIZATION_THRESHOLD,
  artifactBoardPinnedIds,
  artifactBoardPinnedIndexes,
  artifactBoardPinnedRange,
  shouldVirtualizeArtifactBoardCards,
  shouldVirtualizeArtifactBoardLanes,
} from "./artifact-board-virtualization";

describe("CT-16 AC-004 Artifact Board virtualization policy", () => {
  it("does not virtualize at either measured threshold", () => {
    expect(
      shouldVirtualizeArtifactBoardLanes(
        ARTIFACT_BOARD_LANE_VIRTUALIZATION_THRESHOLD
      )
    ).toBe(false);
    expect(
      shouldVirtualizeArtifactBoardCards(
        ARTIFACT_BOARD_CARD_VIRTUALIZATION_THRESHOLD
      )
    ).toBe(false);
  });

  it("virtualizes only after each measured threshold", () => {
    expect(
      shouldVirtualizeArtifactBoardLanes(
        ARTIFACT_BOARD_LANE_VIRTUALIZATION_THRESHOLD + 1
      )
    ).toBe(true);
    expect(
      shouldVirtualizeArtifactBoardCards(
        ARTIFACT_BOARD_CARD_VIRTUALIZATION_THRESHOLD + 1
      )
    ).toBe(true);
  });

  it("pins selected, focused, active-drag, and destination indexes outside the window", () => {
    const ids = ["selected", "focused", "dragged", "destination", "other"];
    const pinnedIds = artifactBoardPinnedIds({
      activeRootId: "dragged",
      destinationRootId: "destination",
      focusedRootId: "focused",
      selectedIds: ["selected"],
    });
    const pinned = artifactBoardPinnedIndexes(ids, pinnedIds);
    expect(pinned).toEqual([0, 1, 2, 3]);
    expect(
      artifactBoardPinnedRange(
        { count: 100, endIndex: 24, overscan: 1, startIndex: 20 },
        [0, 1, 2, 3, 99, 100]
      )
    ).toEqual([0, 1, 2, 3, 19, 20, 21, 22, 23, 24, 25, 99]);
  });
});
