import { ArtifactActivityAction } from "@repo/api/src/types/artifact-activity";
import {
  ActivityFeedActorKind,
  ActivityFeedItemSource,
  type ArtifactActivityFeedItem,
} from "@repo/api/src/types/artifact-activity-feed";
import { render } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityArtifactKind } from "../../feed-sidebar/sources/activity-card";
import type { ActivityTimeline } from "../activity-timeline";
import {
  ArtifactActivityPanel,
  type ArtifactActivityPanelFeed,
} from "../artifact-activity-panel";

type TimelineProps = ComponentProps<typeof ActivityTimeline>;

const { timelineProps } = vi.hoisted(() => ({
  timelineProps: vi.fn<(props: TimelineProps) => void>(),
}));

vi.mock("../activity-timeline", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../activity-timeline")>()),
  ActivityTimeline: (props: TimelineProps) => {
    timelineProps(props);
    return null;
  },
}));

const RENAME: ArtifactActivityFeedItem = {
  id: "event:1",
  source: ActivityFeedItemSource.Event,
  action: ArtifactActivityAction.FieldChange,
  actor: { kind: ActivityFeedActorKind.System, id: null },
  before: { name: "feat/a" },
  after: { name: "feat/b" },
  payload: null,
  createdAt: new Date("2026-10-02T00:00:00Z"),
};

function feedOf(
  overrides: Partial<ArtifactActivityPanelFeed>
): ArtifactActivityPanelFeed {
  return {
    data: [],
    fetchNextPage: vi.fn().mockResolvedValue(undefined),
    hasNextPage: false,
    isError: false,
    isFetchingNextPage: false,
    isFetchNextPageError: false,
    isPending: false,
    isRefetchError: false,
    refetch: vi.fn().mockResolvedValue(undefined),
    supported: true,
    ...overrides,
  };
}

function renderPanel(feed: ArtifactActivityPanelFeed) {
  render(
    <ArtifactActivityPanel
      artifactKind={ActivityArtifactKind.Branch}
      buildCommentHref={({ threadId }) => `/x?comment=${threadId}`}
      feed={feed}
    />
  );
  return timelineProps.mock.calls.map(([props]) => props);
}

beforeEach(() => {
  timelineProps.mockClear();
});

/**
 * PR #8601 review: the Session and Branch tabs share this panel, so the
 * feed-to-timeline state mapping is pinned once here.
 */
describe("ArtifactActivityPanel", () => {
  it("hands the timeline the host's kind, the mapped rows, and the feed's paging state", () => {
    const feed = feedOf({
      data: [RENAME],
      hasNextPage: true,
      isFetchingNextPage: true,
      isFetchNextPageError: true,
    });

    const [timeline] = renderPanel(feed);

    expect(timeline).toMatchObject({
      artifactKind: ActivityArtifactKind.Branch,
      error: false,
      hasMore: true,
      loading: false,
      loadingMore: true,
      loadMoreError: true,
    });
    expect(timeline.rows).toHaveLength(1);
    timeline.onLoadMore?.();
    timeline.onRetry?.();
    expect(feed.fetchNextPage).toHaveBeenCalledTimes(1);
    expect(feed.refetch).toHaveBeenCalledTimes(1);
  });

  it("reports loading only for a source that serves activity", () => {
    expect(renderPanel(feedOf({ isPending: true }))[0].loading).toBe(true);
    timelineProps.mockClear();
    expect(
      renderPanel(feedOf({ isPending: true, supported: false }))[0].loading
    ).toBe(false);
  });

  it("keeps cached rows under a retry banner when a refresh fails", () => {
    const feed = feedOf({
      data: [RENAME],
      isError: true,
      isRefetchError: true,
    });

    const [banner, timeline] = renderPanel(feed);

    expect(banner).toMatchObject({ error: true, rows: [] });
    expect(timeline).toMatchObject({ error: false });
    expect(timeline.rows).toHaveLength(1);
    banner.onRetry?.();
    expect(feed.refetch).toHaveBeenCalledTimes(1);
  });

  it("renders the error state, without a banner, when a failed read has no rows", () => {
    const calls = renderPanel(feedOf({ isError: true, isRefetchError: true }));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ error: true, rows: [] });
  });
});
