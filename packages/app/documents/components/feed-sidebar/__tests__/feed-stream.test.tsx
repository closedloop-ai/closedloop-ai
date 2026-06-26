// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { MessageSquare } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect } from "react";
import { describe, expect, it } from "vitest";

const ROW_TESTID_RE = /^row-/;

import { CommentPermalinkProvider } from "../comment-permalink-context";
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
  kind: typeof FeedItemKind.LiveblocksComment | typeof FeedItemKind.PrComment;
  sourceId: string;
  createdAt: Date;
  label: string;
};

type StubFilterState = { tag: "all" };

function makeStubSource(
  id: string,
  kind: StubItem["kind"],
  items: readonly StubItem[]
): FeedSource<StubItem, StubFilterState> {
  return {
    id,
    kind,
    label: id,
    Icon: MessageSquare,
    useItems: () => ({ items, isLoading: false, isError: false }),
    defaultFilterState: { tag: "all" },
    applyFilter: (i) => i,
    isFiltered: () => false,
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
  sort: FeedFilterSort = FeedFilterSort.Newest
) {
  return render(
    <CommentPermalinkProvider
      buildPermalinkUrl={undefined}
      scrollToThreadId={undefined}
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
});
