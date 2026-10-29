// @vitest-environment jsdom
import type { ThreadData } from "@liveblocks/client";
import { DocumentThreadAnchorStatus } from "@repo/api/src/types/comment";
import { fireEvent, render, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockThreads: { threads: ThreadData[] } = { threads: [] };
vi.mock("@liveblocks/react/suspense", () => ({
  useThreads: () => mockThreads,
}));

import { createLiveblocksUiMock } from "../__helpers__/liveblocks-ui-mock";

vi.mock("@liveblocks/react-ui", () => createLiveblocksUiMock());
vi.mock("@liveblocks/react", () => ({
  useUser: () => ({ user: undefined, isLoading: true, error: undefined }),
}));
vi.mock("../../sources/liveblocks-composer", () => ({
  LiveblocksComposer: () => <div data-testid="lb-composer" />,
}));

import { eraseFeedSource } from "../../erase-feed-source";
import {
  FeedFilterCommentType,
  FeedFilterProvider,
  FeedFilterVersionOfOrigin,
} from "../../feed-filter-context";
import { FeedSourcesProvider } from "../../feed-sources-context";
import {
  DEFAULT_LIVEBLOCKS_FILTER_STATE,
  type LiveblocksFilterState,
} from "../../sources/apply-liveblocks-filter";
import {
  LIVEBLOCKS_COMMENT_SOURCE_ID,
  type LiveblocksCommentItem,
  liveblocksCommentSource,
} from "../../sources/liveblocks-comment-source";
import {
  type LiveblocksSourceContextValue,
  LiveblocksSourceProvider,
} from "../../sources/liveblocks-source-provider";
import { makeThread } from "../__helpers__/thread-factory";

function wrapperFor(value: LiveblocksSourceContextValue) {
  return ({ children }: { children: ReactNode }) => (
    <LiveblocksSourceProvider value={value}>
      {children}
    </LiveblocksSourceProvider>
  );
}

function itemsFor(latestVersion: number): readonly LiveblocksCommentItem[] {
  const { result } = renderHook(() => liveblocksCommentSource.useItems(), {
    wrapper: wrapperFor({ latestVersion }),
  });
  return result.current.items;
}

describe("liveblocksCommentSource.useItems", () => {
  beforeEach(() => {
    mockThreads.threads = [];
  });

  it("classifies version labels and anchor status per thread", () => {
    mockThreads.threads = [
      makeThread({ id: "legacy", metadata: {} }),
      makeThread({
        id: "old",
        metadata: { version: 1, anchorPreview: "quoted" },
      }),
      makeThread({ id: "current", metadata: { version: 3 } }),
    ];
    const items = itemsFor(3);
    expect(
      items.map((item) => [
        item.id,
        item.versionLabel,
        item.anchorPreview,
        item.classification,
      ])
    ).toEqual([
      [
        "legacy",
        "from a prior version",
        null,
        {
          threadVersion: undefined,
          isCurrentVersion: false,
          anchorStatus: DocumentThreadAnchorStatus.ArtifactLevel,
        },
      ],
      [
        "old",
        "from v1",
        "quoted",
        {
          threadVersion: 1,
          isCurrentVersion: false,
          anchorStatus: DocumentThreadAnchorStatus.Anchored,
        },
      ],
      [
        "current",
        undefined,
        null,
        {
          threadVersion: 3,
          isCurrentVersion: true,
          anchorStatus: DocumentThreadAnchorStatus.ArtifactLevel,
        },
      ],
    ]);
  });

  it("omits the prior-version label for a legacy thread when only v1 exists", () => {
    mockThreads.threads = [makeThread({ id: "legacy", metadata: {} })];
    expect(itemsFor(1)[0]?.versionLabel).toBeUndefined();
  });

  it("returns a stable result object across rerenders", () => {
    mockThreads.threads = [makeThread({ id: "a" })];
    const { result, rerender } = renderHook(
      () => liveblocksCommentSource.useItems(),
      { wrapper: wrapperFor({ latestVersion: 1 }) }
    );
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
    expect(first.isLoading).toBe(false);
    expect(first.isError).toBe(false);
  });
});

describe("liveblocksCommentSource.applyFilter", () => {
  beforeEach(() => {
    mockThreads.threads = [
      makeThread({ id: "old", metadata: { version: 1 } }),
      makeThread({ id: "current", metadata: { version: 2 } }),
    ];
  });

  it("returns the same array when no filter is active", () => {
    const items = itemsFor(2);
    expect(
      liveblocksCommentSource.applyFilter(
        items,
        DEFAULT_LIVEBLOCKS_FILTER_STATE
      )
    ).toBe(items);
  });

  it("keeps only items passing an active filter", () => {
    const items = itemsFor(2);
    const filter: LiveblocksFilterState = {
      versionOfOrigin: FeedFilterVersionOfOrigin.Prior,
      commentType: FeedFilterCommentType.All,
      versionFilter: undefined,
    };
    expect(
      liveblocksCommentSource.applyFilter(items, filter).map((i) => i.id)
    ).toEqual(["old"]);
  });
});

describe("liveblocksCommentSource.renderItem", () => {
  it("forwards card clicks to the context click handler with the thread", () => {
    const thread = makeThread({
      id: "clicked",
      comments: [],
      metadata: { version: 1 },
    });
    mockThreads.threads = [thread];
    const onCommentClick = vi.fn();
    const [item] = itemsFor(1);
    if (item === undefined) {
      throw new Error("expected one item");
    }
    render(
      <LiveblocksSourceProvider value={{ latestVersion: 1, onCommentClick }}>
        {liveblocksCommentSource.renderItem(item)}
      </LiveblocksSourceProvider>
    );
    fireEvent.click(screen.getByTestId("lb-thread"));
    expect(onCommentClick).toHaveBeenCalledWith(thread);
  });

  it("opens the composer on click when the context has no click handler", () => {
    mockThreads.threads = [makeThread({ id: "plain", metadata: {} })];
    const [item] = itemsFor(1);
    if (item === undefined) {
      throw new Error("expected one item");
    }
    render(liveblocksCommentSource.renderItem(item));
    const thread = screen.getByTestId("lb-thread");
    fireEvent.click(thread);
    expect(thread.textContent).toContain("plain");
    expect(thread.closest("[tabindex]")?.getAttribute("tabindex")).toBe("-1");
  });
});

describe("liveblocksCommentSource.Composer", () => {
  function renderComposer(initialSourceState?: Record<string, unknown>) {
    const Composer = liveblocksCommentSource.Composer;
    if (Composer === undefined) {
      throw new Error("source must expose a Composer");
    }
    render(
      <FeedSourcesProvider sources={[eraseFeedSource(liveblocksCommentSource)]}>
        <FeedFilterProvider initialSourceState={initialSourceState}>
          <Composer />
        </FeedFilterProvider>
      </FeedSourcesProvider>
    );
  }

  it("renders the composer in live mode", () => {
    renderComposer();
    expect(screen.getByTestId("lb-composer")).toBeInTheDocument();
  });

  it("hides the composer when a historical version filter is pinned", () => {
    renderComposer({
      [LIVEBLOCKS_COMMENT_SOURCE_ID]: {
        ...DEFAULT_LIVEBLOCKS_FILTER_STATE,
        versionFilter: 1,
      },
    });
    expect(screen.queryByTestId("lb-composer")).toBeNull();
  });
});
