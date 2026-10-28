import { DocumentThreadAnchorStatus } from "@repo/api/src/types/comment";
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
    anchorStatus: DocumentThreadAnchorStatus.ArtifactLevel,
    ...overrides,
  };
}

function filter(
  overrides: Partial<LiveblocksFilterState> = {}
): LiveblocksFilterState {
  return { ...DEFAULT_LIVEBLOCKS_FILTER_STATE, ...overrides };
}

describe("DEFAULT_LIVEBLOCKS_FILTER_STATE", () => {
  it("defaults to All/All/no version pin", () => {
    expect(DEFAULT_LIVEBLOCKS_FILTER_STATE).toEqual({
      versionOfOrigin: FeedFilterVersionOfOrigin.All,
      commentType: FeedFilterCommentType.All,
      versionFilter: undefined,
    });
  });
});

describe("passesLiveblocksFilter", () => {
  describe("historical filter (versionFilter)", () => {
    it("keeps everything when versionFilter is undefined", () => {
      expect(
        passesLiveblocksFilter(
          classification({ threadVersion: 5 }),
          filter({ versionFilter: undefined })
        )
      ).toBe(true);
      expect(
        passesLiveblocksFilter(
          classification({ threadVersion: undefined }),
          filter({ versionFilter: undefined })
        )
      ).toBe(true);
    });

    it("keeps a thread whose version is strictly below the pin", () => {
      expect(
        passesLiveblocksFilter(
          classification({ threadVersion: 2 }),
          filter({ versionFilter: 5 })
        )
      ).toBe(true);
    });

    it("keeps a thread whose version exactly equals the pin", () => {
      expect(
        passesLiveblocksFilter(
          classification({ threadVersion: 5 }),
          filter({ versionFilter: 5 })
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
      expect(
        passesLiveblocksFilter(
          classification({ threadVersion: 6 }),
          filter({ versionFilter: 5 })
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
    it("All keeps both current and prior", () => {
      expect(
        passesLiveblocksFilter(
          classification({ isCurrentVersion: true }),
          filter({ versionOfOrigin: FeedFilterVersionOfOrigin.All })
        )
      ).toBe(true);
      expect(
        passesLiveblocksFilter(
          classification({ isCurrentVersion: false }),
          filter({ versionOfOrigin: FeedFilterVersionOfOrigin.All })
        )
      ).toBe(true);
    });

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
    it("All keeps every anchor status", () => {
      for (const anchorStatus of [
        DocumentThreadAnchorStatus.Anchored,
        DocumentThreadAnchorStatus.Floating,
        DocumentThreadAnchorStatus.ArtifactLevel,
      ]) {
        expect(
          passesLiveblocksFilter(
            classification({ anchorStatus }),
            filter({ commentType: FeedFilterCommentType.All })
          )
        ).toBe(true);
      }
    });

    it("Anchored keeps anchored only", () => {
      expect(
        passesLiveblocksFilter(
          classification({ anchorStatus: DocumentThreadAnchorStatus.Anchored }),
          filter({ commentType: FeedFilterCommentType.Anchored })
        )
      ).toBe(true);
      expect(
        passesLiveblocksFilter(
          classification({ anchorStatus: DocumentThreadAnchorStatus.Floating }),
          filter({ commentType: FeedFilterCommentType.Anchored })
        )
      ).toBe(false);
      expect(
        passesLiveblocksFilter(
          classification({
            anchorStatus: DocumentThreadAnchorStatus.ArtifactLevel,
          }),
          filter({ commentType: FeedFilterCommentType.Anchored })
        )
      ).toBe(false);
    });

    it("DocumentLevel collapses floating and artifact-level", () => {
      expect(
        passesLiveblocksFilter(
          classification({ anchorStatus: DocumentThreadAnchorStatus.Floating }),
          filter({ commentType: FeedFilterCommentType.DocumentLevel })
        )
      ).toBe(true);
      expect(
        passesLiveblocksFilter(
          classification({
            anchorStatus: DocumentThreadAnchorStatus.ArtifactLevel,
          }),
          filter({ commentType: FeedFilterCommentType.DocumentLevel })
        )
      ).toBe(true);
      expect(
        passesLiveblocksFilter(
          classification({ anchorStatus: DocumentThreadAnchorStatus.Anchored }),
          filter({ commentType: FeedFilterCommentType.DocumentLevel })
        )
      ).toBe(false);
    });
  });

  describe("short-circuit composition", () => {
    it("fails on the historical check before versionOfOrigin or commentType are evaluated", () => {
      expect(
        passesLiveblocksFilter(
          classification({
            threadVersion: 10,
            isCurrentVersion: true,
            anchorStatus: DocumentThreadAnchorStatus.Anchored,
          }),
          filter({
            versionFilter: 1,
            versionOfOrigin: FeedFilterVersionOfOrigin.Current,
            commentType: FeedFilterCommentType.Anchored,
          })
        )
      ).toBe(false);
    });

    it("passes the historical check but fails on versionOfOrigin before commentType is evaluated", () => {
      expect(
        passesLiveblocksFilter(
          classification({
            threadVersion: 1,
            isCurrentVersion: false,
            anchorStatus: DocumentThreadAnchorStatus.Anchored,
          }),
          filter({
            versionFilter: 5,
            versionOfOrigin: FeedFilterVersionOfOrigin.Current,
            commentType: FeedFilterCommentType.Anchored,
          })
        )
      ).toBe(false);
    });

    it("passes historical and versionOfOrigin but fails on commentType", () => {
      expect(
        passesLiveblocksFilter(
          classification({
            threadVersion: 1,
            isCurrentVersion: true,
            anchorStatus: DocumentThreadAnchorStatus.Floating,
          }),
          filter({
            versionFilter: 5,
            versionOfOrigin: FeedFilterVersionOfOrigin.Current,
            commentType: FeedFilterCommentType.Anchored,
          })
        )
      ).toBe(false);
    });

    it("passes when every check independently passes", () => {
      expect(
        passesLiveblocksFilter(
          classification({
            threadVersion: 3,
            isCurrentVersion: true,
            anchorStatus: DocumentThreadAnchorStatus.Anchored,
          }),
          filter({
            versionFilter: 5,
            versionOfOrigin: FeedFilterVersionOfOrigin.Current,
            commentType: FeedFilterCommentType.Anchored,
          })
        )
      ).toBe(true);
    });
  });
});

describe("isLiveblocksFilterActive", () => {
  it("returns false for default state", () => {
    expect(isLiveblocksFilterActive(DEFAULT_LIVEBLOCKS_FILTER_STATE)).toBe(
      false
    );
  });

  it("returns false when explicitly rebuilt with every field at its default", () => {
    expect(
      isLiveblocksFilterActive(
        filter({
          versionOfOrigin: FeedFilterVersionOfOrigin.All,
          commentType: FeedFilterCommentType.All,
          versionFilter: undefined,
        })
      )
    ).toBe(false);
  });

  it("returns true when versionOfOrigin is Current", () => {
    expect(
      isLiveblocksFilterActive(
        filter({ versionOfOrigin: FeedFilterVersionOfOrigin.Current })
      )
    ).toBe(true);
  });

  it("returns true when versionOfOrigin is Prior", () => {
    expect(
      isLiveblocksFilterActive(
        filter({ versionOfOrigin: FeedFilterVersionOfOrigin.Prior })
      )
    ).toBe(true);
  });

  it("returns true when commentType is Anchored", () => {
    expect(
      isLiveblocksFilterActive(
        filter({ commentType: FeedFilterCommentType.Anchored })
      )
    ).toBe(true);
  });

  it("returns true when commentType is DocumentLevel", () => {
    expect(
      isLiveblocksFilterActive(
        filter({ commentType: FeedFilterCommentType.DocumentLevel })
      )
    ).toBe(true);
  });

  it("returns true when versionFilter is set (historical view)", () => {
    expect(isLiveblocksFilterActive(filter({ versionFilter: 3 }))).toBe(true);
  });

  it("returns true when versionFilter is pinned to version 0", () => {
    expect(isLiveblocksFilterActive(filter({ versionFilter: 0 }))).toBe(true);
  });

  it("returns true when multiple fields are simultaneously non-default", () => {
    expect(
      isLiveblocksFilterActive(
        filter({
          versionOfOrigin: FeedFilterVersionOfOrigin.Prior,
          commentType: FeedFilterCommentType.DocumentLevel,
          versionFilter: 2,
        })
      )
    ).toBe(true);
  });
});
