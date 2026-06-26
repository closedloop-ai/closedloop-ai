import {
  FeedFilterCommentType,
  FeedFilterVersionOfOrigin,
} from "../feed-filter-context";

/**
 * Filter state owned by the Liveblocks source. Sort is NOT part of
 * this shape: the global feed-stream handles cross-source sort via
 * `FeedItem.createdAt`.
 */
export type LiveblocksFilterState = {
  versionOfOrigin: FeedFilterVersionOfOrigin;
  commentType: FeedFilterCommentType;
  /**
   * Pin to a specific version (historical view). `undefined` in live
   * mode. Seeded via `FeedSidebar.initialSourceState` from the doc
   * editor scaffold when the user is viewing a non-latest version.
   */
  versionFilter: number | undefined;
};

export const DEFAULT_LIVEBLOCKS_FILTER_STATE: LiveblocksFilterState = {
  versionOfOrigin: FeedFilterVersionOfOrigin.All,
  commentType: FeedFilterCommentType.All,
  versionFilter: undefined,
};

/**
 * Pre-computed classification carried on each `LiveblocksCommentItem`.
 * Hoisted out of the filter call site so `applyFilter` can stay a pure
 * function that doesn't need access to React context (where the source
 * fetches `latestVersion`).
 */
export type LiveblocksItemClassification = {
  /** `thread.metadata.version` verbatim (`undefined` for legacy threads). */
  threadVersion: number | undefined;
  /**
   * `true` when the thread's origin version is at or above the current
   * `latestVersion` — used by the version-of-origin filter to keep
   * "current" vs "prior" deterministic without consulting `latestVersion`
   * at filter time.
   */
  isCurrentVersion: boolean;
  /**
   * Effective anchor status. "anchored" matches the Anchored sub-filter;
   * "floating" + "artifact-level" both match Document-level.
   */
  anchorStatus: "anchored" | "floating" | "artifact-level";
};

export function passesLiveblocksFilter(
  classification: LiveblocksItemClassification,
  filter: LiveblocksFilterState
): boolean {
  if (
    !passesHistoricalFilter(classification.threadVersion, filter.versionFilter)
  ) {
    return false;
  }
  if (
    !passesVersionOfOrigin(
      classification.isCurrentVersion,
      filter.versionOfOrigin
    )
  ) {
    return false;
  }
  if (!passesCommentType(classification.anchorStatus, filter.commentType)) {
    return false;
  }
  return true;
}

export function isLiveblocksFilterActive(
  filter: LiveblocksFilterState
): boolean {
  return (
    filter.versionOfOrigin !== FeedFilterVersionOfOrigin.All ||
    filter.commentType !== FeedFilterCommentType.All ||
    filter.versionFilter !== undefined
  );
}

function passesHistoricalFilter(
  threadVersion: number | undefined,
  versionFilter: number | undefined
): boolean {
  if (versionFilter === undefined) {
    return true;
  }
  return threadVersion === undefined || threadVersion <= versionFilter;
}

function passesVersionOfOrigin(
  isCurrentVersion: boolean,
  versionOfOrigin: LiveblocksFilterState["versionOfOrigin"]
): boolean {
  if (versionOfOrigin === FeedFilterVersionOfOrigin.All) {
    return true;
  }
  return versionOfOrigin === FeedFilterVersionOfOrigin.Current
    ? isCurrentVersion
    : !isCurrentVersion;
}

function passesCommentType(
  anchorStatus: LiveblocksItemClassification["anchorStatus"],
  commentType: LiveblocksFilterState["commentType"]
): boolean {
  if (commentType === FeedFilterCommentType.All) {
    return true;
  }
  if (commentType === FeedFilterCommentType.Anchored) {
    return anchorStatus === "anchored";
  }
  return anchorStatus === "floating" || anchorStatus === "artifact-level";
}
