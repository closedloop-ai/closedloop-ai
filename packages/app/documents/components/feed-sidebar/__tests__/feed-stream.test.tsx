// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { MessageSquare } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const ROW_TESTID_RE = /^row-/;
const MISSING_THREAD_TEXT = "Comment not found";

import {
  CommentPermalinkProvider,
  useCommentPermalink,
} from "../comment-permalink-context";
import {
  FeedFilterProvider,
  FeedFilterSort,
  useFeedFilter,
} from "../feed-filter-context";
import { FeedItemKind } from "../feed-item";
import type { FeedSource } from "../feed-source";
import { FeedSourcesProvider } from "../feed-sources-context";
import { FeedStream } from "../feed-stream";
import { FeedRuntime } from "../source-items-registry";

type StubItem = {
  id: string;
  kind:
    | typeof FeedItemKind.LiveblocksComment
    | typeof FeedItemKind.NativeDocumentComment
    | typeof FeedItemKind.PrComment
    | typeof FeedItemKind.Activity;
  sourceId: string;
  createdAt: Date;
  label: string;
};

type StubFilterState = { tag: "all" };

function makeStubSource(
  id: string,
  kind: StubItem["kind"],
  items: readonly StubItem[],
  options: Readonly<{
    isError?: boolean;
    isLoading?: boolean;
    StatusBanner?: () => ReactNode;
    Footer?: () => ReactNode;
    stateCopy?: FeedSource<StubItem, StubFilterState>["stateCopy"];
  }> = {}
): FeedSource<StubItem, StubFilterState> {
  return {
    id,
    kind,
    label: id,
    Icon: MessageSquare,
    useItems: () => ({
      items,
      isLoading: options.isLoading ?? false,
      isError: options.isError ?? false,
    }),
    defaultFilterState: { tag: "all" },
    applyFilter: (i) => i,
    isFiltered: () => false,
    StatusBanner: options.StatusBanner,
    Footer: options.Footer,
    stateCopy: options.stateCopy,
    renderItem: (item) => (
      <span data-testid={`row-${item.sourceId}-${item.id}`}>{item.label}</span>
    ),
  };
}

type ForceSortProps = Readonly<{
  sort: FeedFilterSort;
  children: ReactNode;
}>;

function ForceSort({ sort, children }: ForceSortProps) {
  const { sort: currentSort, setSort } = useFeedFilter();
  useEffect(() => {
    if (currentSort !== sort) {
      setSort(sort);
    }
  }, [currentSort, sort, setSort]);
  return <>{children}</>;
}

function renderWith(
  sources: readonly FeedSource<StubItem, StubFilterState>[],
  sort: FeedFilterSort = FeedFilterSort.Newest,
  scrollToThreadId?: string
) {
  return render(
    <CommentPermalinkProvider
      buildPermalinkUrl={undefined}
      scrollToThreadId={scrollToThreadId}
    >
      <FeedSourcesProvider sources={sources}>
        <FeedFilterProvider>
          <FeedRuntime fallback={null} sources={sources}>
            <ForceSort sort={sort}>
              <FeedStream />
            </ForceSort>
          </FeedRuntime>
        </FeedFilterProvider>
      </FeedSourcesProvider>
    </CommentPermalinkProvider>
  );
}

function MissingThreadProbe() {
  const { bannerVisible } = useCommentPermalink();
  return bannerVisible ? <div>{MISSING_THREAD_TEXT}</div> : null;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("FeedStream merge + sort", () => {
  it("merges items from multiple sources and sorts by createdAt desc (Newest)", () => {
    const t0 = new Date("2026-01-01T00:00:00Z").getTime();
    const sources = [
      makeStubSource("lb", FeedItemKind.LiveblocksComment, [
        {
          id: "L1",
          kind: FeedItemKind.LiveblocksComment,
          sourceId: "lb",
          createdAt: new Date(t0 + 1000),
          label: "L1",
        },
      ]),
      makeStubSource("pr", FeedItemKind.PrComment, [
        {
          id: "P1",
          kind: FeedItemKind.PrComment,
          sourceId: "pr",
          createdAt: new Date(t0 + 2000),
          label: "P1",
        },
      ]),
    ];

    renderWith(sources, FeedFilterSort.Newest);
    const items = screen.getAllByTestId(ROW_TESTID_RE);
    expect(items.map((el) => el.textContent)).toEqual(["P1", "L1"]);
  });

  it("flips to ascending createdAt under Oldest sort", () => {
    const t0 = new Date("2026-01-01T00:00:00Z").getTime();
    const sources = [
      makeStubSource("lb", FeedItemKind.LiveblocksComment, [
        {
          id: "L1",
          kind: FeedItemKind.LiveblocksComment,
          sourceId: "lb",
          createdAt: new Date(t0 + 1000),
          label: "L1",
        },
      ]),
      makeStubSource("pr", FeedItemKind.PrComment, [
        {
          id: "P1",
          kind: FeedItemKind.PrComment,
          sourceId: "pr",
          createdAt: new Date(t0 + 2000),
          label: "P1",
        },
      ]),
    ];

    renderWith(sources, FeedFilterSort.Oldest);
    const items = screen.getAllByTestId(ROW_TESTID_RE);
    expect(items.map((el) => el.textContent)).toEqual(["L1", "P1"]);
  });

  it("breaks createdAt ties deterministically by sourceId then item id", () => {
    const sameTs = new Date("2026-03-01T00:00:00Z");
    const sources = [
      makeStubSource("pr", FeedItemKind.PrComment, [
        {
          id: "b",
          kind: FeedItemKind.PrComment,
          sourceId: "pr",
          createdAt: sameTs,
          label: "pr-b",
        },
        {
          id: "a",
          kind: FeedItemKind.PrComment,
          sourceId: "pr",
          createdAt: sameTs,
          label: "pr-a",
        },
      ]),
      makeStubSource("lb", FeedItemKind.LiveblocksComment, [
        {
          id: "z",
          kind: FeedItemKind.LiveblocksComment,
          sourceId: "lb",
          createdAt: sameTs,
          label: "lb-z",
        },
      ]),
    ];

    renderWith(sources, FeedFilterSort.Newest);
    const items = screen
      .getAllByTestId(ROW_TESTID_RE)
      .map((el) => el.textContent);
    // All items share createdAt — order falls through to (sourceId, id):
    // "lb" < "pr"; within "pr" items, "a" < "b".
    expect(items).toEqual(["lb-z", "pr-a", "pr-b"]);
  });

  it("waits for active source loading before resolving a permalink as not found", () => {
    vi.useFakeTimers();
    const loadingSources = [
      makeStubSource("native", FeedItemKind.NativeDocumentComment, [], {
        isLoading: true,
        StatusBanner: MissingThreadProbe,
      }),
    ];

    const { rerender } = renderWith(
      loadingSources,
      FeedFilterSort.Newest,
      "target-thread"
    );

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.queryByText(MISSING_THREAD_TEXT)).toBeNull();

    const readySources = [
      makeStubSource("native", FeedItemKind.NativeDocumentComment, [], {
        StatusBanner: MissingThreadProbe,
      }),
    ];

    rerender(
      <CommentPermalinkProvider
        buildPermalinkUrl={undefined}
        scrollToThreadId="target-thread"
      >
        <FeedSourcesProvider sources={readySources}>
          <FeedFilterProvider>
            <FeedRuntime fallback={null} sources={readySources}>
              <ForceSort sort={FeedFilterSort.Newest}>
                <FeedStream />
              </ForceSort>
            </FeedRuntime>
          </FeedFilterProvider>
        </FeedSourcesProvider>
      </CommentPermalinkProvider>
    );

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.getByText(MISSING_THREAD_TEXT)).toBeInTheDocument();
  });

  it("shows loading instead of a false empty state while active sources load", () => {
    renderWith([
      makeStubSource("native", FeedItemKind.NativeDocumentComment, [], {
        isLoading: true,
      }),
    ]);

    expect(screen.getByText("Loading feed...")).toBeInTheDocument();
    expect(screen.queryByText("No items yet")).toBeNull();
  });

  it("surfaces active source errors instead of a false empty state", () => {
    renderWith([
      makeStubSource("native", FeedItemKind.NativeDocumentComment, [], {
        isError: true,
      }),
    ]);

    expect(screen.getByText("Unable to load this feed")).toBeInTheDocument();
    expect(screen.queryByText("No items yet")).toBeNull();
  });

  it("renders a source's custom loading copy in place of the comments default", () => {
    renderWith([
      makeStubSource("activity", FeedItemKind.PrComment, [], {
        isLoading: true,
        stateCopy: {
          error: "Unable to load activity",
          loading: "Loading activity…",
        },
      }),
    ]);

    expect(screen.getByText("Loading activity…")).toBeInTheDocument();
    expect(screen.queryByText("Loading comments...")).toBeNull();
  });

  it("renders a source's custom error copy in place of the comments default", () => {
    renderWith([
      makeStubSource("activity", FeedItemKind.PrComment, [], {
        isError: true,
        stateCopy: {
          error: "Unable to load activity",
          loading: "Loading activity…",
        },
      }),
    ]);

    expect(screen.getByText("Unable to load activity")).toBeInTheDocument();
    expect(screen.queryByText("Unable to load comments")).toBeNull();
  });

  it("renders a source's custom empty copy in place of the comments default", () => {
    renderWith([
      makeStubSource("activity", FeedItemKind.PrComment, [], {
        stateCopy: {
          empty: "No activity yet",
          error: "Unable to load activity",
          loading: "Loading activity…",
        },
      }),
    ]);

    expect(screen.getByText("No activity yet")).toBeInTheDocument();
    expect(screen.queryByText("No items yet")).toBeNull();
  });

  it("falls back to the default empty copy when a source omits stateCopy.empty", () => {
    renderWith([
      makeStubSource("comments", FeedItemKind.NativeDocumentComment, []),
    ]);

    expect(screen.getByText("No items yet")).toBeInTheDocument();
  });

  it("does not resolve a permalink as not found when an active source failed", () => {
    vi.useFakeTimers();

    renderWith(
      [
        makeStubSource("native", FeedItemKind.NativeDocumentComment, [], {
          isError: true,
          StatusBanner: MissingThreadProbe,
        }),
      ],
      FeedFilterSort.Newest,
      "target-thread"
    );

    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(screen.getByText("Unable to load this feed")).toBeInTheDocument();
    expect(screen.queryByText(MISSING_THREAD_TEXT)).toBeNull();
  });
});

describe("FeedStream footer slot", () => {
  const FOOTER_TEXT = "Load earlier";

  it("renders a source Footer below the merged stream", () => {
    const sources = [
      makeStubSource(
        "act",
        FeedItemKind.Activity,
        [
          {
            id: "A1",
            kind: FeedItemKind.Activity,
            sourceId: "act",
            createdAt: new Date("2026-01-01T00:00:00Z"),
            label: "A1",
          },
        ],
        { Footer: () => <div>{FOOTER_TEXT}</div> }
      ),
    ];

    renderWith(sources);

    const list = screen.getByRole("list");
    const footer = screen.getByText(FOOTER_TEXT);
    expect(footer).toBeInTheDocument();
    // Footer renders after the <ol> in document order (grows content downward,
    // matching where newest-first pagination appends older rows). Both share the
    // stream container; assert the footer's index follows the list's.
    const container = list.parentElement;
    const ordered = Array.from(container?.querySelectorAll("ol, div") ?? []);
    expect(ordered.indexOf(footer)).toBeGreaterThan(ordered.indexOf(list));
  });

  it("hides a source Footer when its kind is not the active kind", () => {
    const sources = [
      makeStubSource(
        "act",
        FeedItemKind.Activity,
        [
          {
            id: "A1",
            kind: FeedItemKind.Activity,
            sourceId: "act",
            createdAt: new Date("2026-01-01T00:00:00Z"),
            label: "A1",
          },
        ],
        { Footer: () => <div>{FOOTER_TEXT}</div> }
      ),
      makeStubSource("lb", FeedItemKind.LiveblocksComment, [
        {
          id: "L1",
          kind: FeedItemKind.LiveblocksComment,
          sourceId: "lb",
          createdAt: new Date("2026-01-02T00:00:00Z"),
          label: "L1",
        },
      ]),
    ];

    render(
      <CommentPermalinkProvider
        buildPermalinkUrl={undefined}
        scrollToThreadId={undefined}
      >
        <FeedSourcesProvider sources={sources}>
          <FeedFilterProvider>
            <FeedRuntime fallback={null} sources={sources}>
              <ForceActiveKind kind={FeedItemKind.LiveblocksComment}>
                <FeedStream />
              </ForceActiveKind>
            </FeedRuntime>
          </FeedFilterProvider>
        </FeedSourcesProvider>
      </CommentPermalinkProvider>
    );

    expect(screen.queryByText(FOOTER_TEXT)).toBeNull();
  });
});

type ForceActiveKindProps = Readonly<{
  kind: FeedItemKind;
  children: ReactNode;
}>;

function ForceActiveKind({ kind, children }: ForceActiveKindProps) {
  const { activeKind, setActiveKind } = useFeedFilter();
  useEffect(() => {
    if (activeKind !== kind) {
      setActiveKind(kind);
    }
  }, [activeKind, kind, setActiveKind]);
  return <>{children}</>;
}
