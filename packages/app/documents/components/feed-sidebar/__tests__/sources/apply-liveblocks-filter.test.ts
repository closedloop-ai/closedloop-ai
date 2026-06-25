import { describe, expect, it } from "vitest";

import {
  FeedFilterCommentType,
  FeedFilterVersionOfOrigin,
} from "../../feed-filter-context";
import {
  DEFAULT_LIVEBLOCKS_FILTER_STATE,
  isLiveblocksFilterActive,
  type LiveblocksFilterState,
  type LiveblocksItemClassification,
  passesLiveblocksFilter,
} from "../../sources/apply-liveblocks-filter";

function classification(
  overrides: Partial<LiveblocksItemClassification> = {}
): LiveblocksItemClassification {
  return {
    threadVersion: undefined,
    isCurrentVersion: false,
    anchorStatus: "artifact-level",
    ...overrides,
  };
}

function filter(
  overrides: Partial<LiveblocksFilterState> = {}
): LiveblocksFilterState {
  return { ...DEFAULT_LIVEBLOCKS_FILTER_STATE, ...overrides };
}

describe("passesLiveblocksFilter", () => {
  describe("historical filter (versionFilter)", () => {
    it("keeps everything when versionFilter is undefined", () => {
      expect(
        passesLiveblocksFilter(
          classification({ threadVersion: 5 }),
          filter({ versionFilter: undefined })
        )
      ).toBe(true);
    });

    it("drops threads from future versions", () => {
      expect(
        passesLiveblocksFilter(
          classification({ threadVersion: 3 }),
          filter({ versionFilter: 2 })
        )
      ).toBe(false);
    });

    it("keeps legacy threads (threadVersion undefined)", () => {
      expect(
        passesLiveblocksFilter(
          classification({ threadVersion: undefined }),
          filter({ versionFilter: 2 })
        )
      ).toBe(true);
    });
  });

  describe("versionOfOrigin", () => {
    it("Current keeps isCurrentVersion=true", () => {
      expect(
        passesLiveblocksFilter(
          classification({ isCurrentVersion: true }),
          filter({ versionOfOrigin: FeedFilterVersionOfOrigin.Current })
        )
      ).toBe(true);
      expect(
        passesLiveblocksFilter(
          classification({ isCurrentVersion: false }),
          filter({ versionOfOrigin: FeedFilterVersionOfOrigin.Current })
        )
      ).toBe(false);
    });

    it("Prior keeps isCurrentVersion=false", () => {
      expect(
        passesLiveblocksFilter(
          classification({ isCurrentVersion: false }),
          filter({ versionOfOrigin: FeedFilterVersionOfOrigin.Prior })
        )
      ).toBe(true);
      expect(
        passesLiveblocksFilter(
          classification({ isCurrentVersion: true }),
          filter({ versionOfOrigin: FeedFilterVersionOfOrigin.Prior })
        )
      ).toBe(false);
    });
  });

  describe("commentType", () => {
    it("Anchored keeps anchored only", () => {
      expect(
        passesLiveblocksFilter(
          classification({ anchorStatus: "anchored" }),
          filter({ commentType: FeedFilterCommentType.Anchored })
        )
      ).toBe(true);
      expect(
        passesLiveblocksFilter(
          classification({ anchorStatus: "floating" }),
          filter({ commentType: FeedFilterCommentType.Anchored })
        )
      ).toBe(false);
    });

    it("DocumentLevel collapses floating and artifact-level", () => {
      expect(
        passesLiveblocksFilter(
          classification({ anchorStatus: "floating" }),
          filter({ commentType: FeedFilterCommentType.DocumentLevel })
        )
      ).toBe(true);
      expect(
        passesLiveblocksFilter(
          classification({ anchorStatus: "artifact-level" }),
          filter({ commentType: FeedFilterCommentType.DocumentLevel })
        )
      ).toBe(true);
      expect(
        passesLiveblocksFilter(
          classification({ anchorStatus: "anchored" }),
          filter({ commentType: FeedFilterCommentType.DocumentLevel })
        )
      ).toBe(false);
    });
  });
});

describe("isLiveblocksFilterActive", () => {
  it("returns false for default state", () => {
    expect(isLiveblocksFilterActive(DEFAULT_LIVEBLOCKS_FILTER_STATE)).toBe(
      false
    );
  });

  it("returns true when versionOfOrigin is non-default", () => {
    expect(
      isLiveblocksFilterActive(
        filter({ versionOfOrigin: FeedFilterVersionOfOrigin.Current })
      )
    ).toBe(true);
  });

  it("returns true when commentType is non-default", () => {
    expect(
      isLiveblocksFilterActive(
        filter({ commentType: FeedFilterCommentType.Anchored })
      )
    ).toBe(true);
  });

  it("returns true when versionFilter is set (historical view)", () => {
    expect(isLiveblocksFilterActive(filter({ versionFilter: 3 }))).toBe(true);
  });
});
