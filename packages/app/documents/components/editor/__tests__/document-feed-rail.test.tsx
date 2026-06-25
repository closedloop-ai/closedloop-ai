import { LIVEBLOCKS_COMMENT_SOURCE_ID } from "@repo/app/documents/components/feed-sidebar/sources/liveblocks-comment-source";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, test, vi } from "vitest";

const mockFeedSidebar = vi.fn();
const mockProviderValue = vi.fn();

vi.mock("@repo/app/documents/components/feed-sidebar/feed-sidebar", () => {
  const FeedTab = {
    Feed: "feed",
    Chat: "chat",
  } as const;

  return {
    FeedTab,
    FeedSidebar: (props: Record<string, unknown>) => {
      mockFeedSidebar(props);
      return <div data-testid="feed-sidebar" />;
    },
  };
});

vi.mock(
  "@repo/app/documents/components/feed-sidebar/sources/liveblocks-source-provider",
  () => ({
    LiveblocksSourceProvider: ({
      children,
      value,
    }: {
      children: ReactNode;
      value: unknown;
    }) => {
      mockProviderValue(value);
      return <div data-testid="liveblocks-provider">{children}</div>;
    },
  })
);

import {
  buildDocumentFeedRailInitialSourceState,
  DocumentFeedRail,
} from "../document-feed-rail";

describe("buildDocumentFeedRailInitialSourceState", () => {
  test("returns undefined when the viewer is on the live version", () => {
    expect(
      buildDocumentFeedRailInitialSourceState({
        currentVersion: 4,
        isViewingHistorical: false,
      })
    ).toBeUndefined();
  });

  test("seeds the liveblocks version filter for historical views", () => {
    expect(
      buildDocumentFeedRailInitialSourceState({
        currentVersion: 3,
        isViewingHistorical: true,
      })
    ).toEqual({
      [LIVEBLOCKS_COMMENT_SOURCE_ID]: {
        commentType: "all",
        versionFilter: 3,
        versionOfOrigin: "all",
      },
    });
  });
});

describe("DocumentFeedRail", () => {
  test("renders nothing when the rail is disabled", () => {
    render(
      <DocumentFeedRail
        artifactType="PRD"
        currentVersion={1}
        enabled={false}
        isViewingHistorical={false}
        latestVersion={1}
        onClose={() => undefined}
        organizationId="org-1"
        visible
      />
    );

    expect(screen.queryByTestId("feed-sidebar")).not.toBeInTheDocument();
  });

  test("passes seeded historical state and liveblocks context into FeedSidebar", () => {
    const onCommentClick = vi.fn();

    render(
      <DocumentFeedRail
        artifactType="PRD"
        chatPanel={<div>Chat</div>}
        currentVersion={2}
        enabled
        isViewingHistorical
        latestVersion={5}
        onClose={() => undefined}
        onCommentClick={onCommentClick}
        organizationId="org-1"
        visible
      />
    );

    expect(screen.getByTestId("feed-sidebar")).toBeInTheDocument();
    expect(mockProviderValue).toHaveBeenCalledWith({
      latestVersion: 5,
      onCommentClick,
    });
    expect(mockFeedSidebar).toHaveBeenCalledWith(
      expect.objectContaining({
        activeTab: "feed",
        artifactType: "PRD",
        chatPanel: expect.any(Object),
        initialSourceState: {
          [LIVEBLOCKS_COMMENT_SOURCE_ID]: {
            commentType: "all",
            versionFilter: 2,
            versionOfOrigin: "all",
          },
        },
        organizationId: "org-1",
        visible: true,
      })
    );
  });
});
