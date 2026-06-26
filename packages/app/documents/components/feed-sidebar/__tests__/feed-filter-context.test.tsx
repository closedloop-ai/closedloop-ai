// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { MessageSquare } from "lucide-react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CommentPermalinkProvider } from "../comment-permalink-context";
import {
  ACTIVE_KIND_ALL,
  type FeedFilterContextValue,
  FeedFilterProvider,
  FeedFilterSort,
  useFeedFilter,
} from "../feed-filter-context";
import { FeedItemKind } from "../feed-item";
import type { AnyFeedSource } from "../feed-source";
import { FeedSourcesProvider } from "../feed-sources-context";

type StubFilter = { tag: "all" | "pending" };

function makeSource(id: string): AnyFeedSource {
  return {
    id,
    kind: FeedItemKind.PrComment,
    label: id,
    Icon: MessageSquare,
    useItems: () => ({ items: [], isLoading: false, isError: false }),
    defaultFilterState: { tag: "all" } satisfies StubFilter,
    applyFilter: (items) => items,
    isFiltered: (state: StubFilter) => state.tag !== "all",
    renderItem: () => null,
  };
}

type WrapperProps = {
  scrollToThreadId?: string;
  sources?: readonly AnyFeedSource[];
  initialSourceState?: Record<string, unknown>;
  children: ReactNode;
};

const DEFAULT_SOURCES: readonly AnyFeedSource[] = [makeSource("stub")];

function Wrapper({
  scrollToThreadId,
  sources = DEFAULT_SOURCES,
  initialSourceState,
  children,
}: WrapperProps) {
  return (
    <CommentPermalinkProvider
      buildPermalinkUrl={undefined}
      scrollToThreadId={scrollToThreadId}
    >
      <FeedSourcesProvider sources={sources}>
        <FeedFilterProvider initialSourceState={initialSourceState}>
          {children}
        </FeedFilterProvider>
      </FeedSourcesProvider>
    </CommentPermalinkProvider>
  );
}

function mountProvider(args?: {
  scrollToThreadId?: string;
  initialSourceState?: Record<string, unknown>;
}) {
  const ref: { current: FeedFilterContextValue | null } = { current: null };
  function Probe() {
    ref.current = useFeedFilter();
    return null;
  }
  const utils = render(
    <Wrapper
      initialSourceState={args?.initialSourceState}
      scrollToThreadId={args?.scrollToThreadId}
    >
      <Probe />
    </Wrapper>
  );
  return {
    ...utils,
    get value(): FeedFilterContextValue {
      if (!ref.current) {
        throw new Error("provider not mounted");
      }
      return ref.current;
    },
    rerenderWithPermalink(nextId: string | undefined) {
      utils.rerender(
        <Wrapper
          initialSourceState={args?.initialSourceState}
          scrollToThreadId={nextId}
        >
          <Probe />
        </Wrapper>
      );
    },
  };
}

describe("FeedFilterProvider (new shape)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("default state", () => {
    it("starts with activeKind='all' + isFiltered=false", () => {
      const probe = mountProvider();
      expect(probe.value.activeKind).toBe(ACTIVE_KIND_ALL);
      expect(probe.value.sort).toBe(FeedFilterSort.Newest);
      expect(probe.value.isFiltered).toBe(false);
    });

    it("seeds source state from defaultFilterState", () => {
      const probe = mountProvider();
      expect(probe.value.getSourceState<StubFilter>("stub")).toEqual({
        tag: "all",
      });
    });

    it("overrides default with initialSourceState", () => {
      const probe = mountProvider({
        initialSourceState: { stub: { tag: "pending" } satisfies StubFilter },
      });
      expect(probe.value.getSourceState<StubFilter>("stub")).toEqual({
        tag: "pending",
      });
      // isFiltered reflects non-default state at boot
      expect(probe.value.isFiltered).toBe(true);
    });
  });

  describe("setters", () => {
    it("setActiveKind flips isFiltered when not ALL", () => {
      const probe = mountProvider();
      act(() => probe.value.setActiveKind(FeedItemKind.PrComment));
      expect(probe.value.activeKind).toBe(FeedItemKind.PrComment);
      expect(probe.value.isFiltered).toBe(true);
    });

    it("setSourceState updates state and flips isFiltered", () => {
      const probe = mountProvider();
      act(() =>
        probe.value.setSourceState<StubFilter>("stub", { tag: "pending" })
      );
      expect(probe.value.getSourceState<StubFilter>("stub")).toEqual({
        tag: "pending",
      });
      expect(probe.value.isFiltered).toBe(true);
    });

    it("setSort does NOT flip isFiltered", () => {
      const probe = mountProvider();
      act(() => probe.value.setSort(FeedFilterSort.Oldest));
      expect(probe.value.sort).toBe(FeedFilterSort.Oldest);
      expect(probe.value.isFiltered).toBe(false);
    });
  });

  describe("clearFilter", () => {
    it("resets activeKind + every source state to default (NOT to initialSourceState)", () => {
      const probe = mountProvider({
        initialSourceState: { stub: { tag: "pending" } satisfies StubFilter },
      });
      act(() => probe.value.setActiveKind(FeedItemKind.PrComment));
      act(() => probe.value.clearFilter());
      expect(probe.value.activeKind).toBe(ACTIVE_KIND_ALL);
      // Cleared to default ({tag:"all"}), NOT back to initial ({tag:"pending"})
      expect(probe.value.getSourceState<StubFilter>("stub")).toEqual({
        tag: "all",
      });
    });
  });

  describe("kind switch resets sub-filter to seed", () => {
    it("clears a user-toggled sub-filter when activeKind changes back to ALL", () => {
      const probe = mountProvider();
      // Focus a kind and toggle the sub-filter.
      act(() => probe.value.setActiveKind(FeedItemKind.PrComment));
      act(() =>
        probe.value.setSourceState<StubFilter>("stub", { tag: "pending" })
      );
      expect(probe.value.getSourceState<StubFilter>("stub")).toEqual({
        tag: "pending",
      });
      // Return to ALL — sub-filter should reset (otherwise it persists invisibly).
      act(() => probe.value.setActiveKind(ACTIVE_KIND_ALL));
      expect(probe.value.activeKind).toBe(ACTIVE_KIND_ALL);
      expect(probe.value.getSourceState<StubFilter>("stub")).toEqual({
        tag: "all",
      });
      expect(probe.value.isFiltered).toBe(false);
    });

    it("preserves initialSourceState (historical seed) on kind switch", () => {
      const probe = mountProvider({
        initialSourceState: { stub: { tag: "pending" } satisfies StubFilter },
      });
      // Seeded sub-filter is the baseline.
      expect(probe.value.getSourceState<StubFilter>("stub")).toEqual({
        tag: "pending",
      });
      // Switching kinds should not wipe the seed.
      act(() => probe.value.setActiveKind(FeedItemKind.PrComment));
      expect(probe.value.getSourceState<StubFilter>("stub")).toEqual({
        tag: "pending",
      });
      act(() => probe.value.setActiveKind(ACTIVE_KIND_ALL));
      expect(probe.value.getSourceState<StubFilter>("stub")).toEqual({
        tag: "pending",
      });
    });

    it("is a no-op when setActiveKind is called with the current value", () => {
      const probe = mountProvider();
      act(() =>
        probe.value.setSourceState<StubFilter>("stub", { tag: "pending" })
      );
      act(() => probe.value.setActiveKind(ACTIVE_KIND_ALL));
      // Already on ALL — sub-filter should NOT be reset by the no-op call.
      expect(probe.value.getSourceState<StubFilter>("stub")).toEqual({
        tag: "pending",
      });
    });
  });

  describe("permalink auto-clear", () => {
    it("clears an active filter when scrollToThreadId transitions to defined", () => {
      const probe = mountProvider();
      act(() =>
        probe.value.setSourceState<StubFilter>("stub", { tag: "pending" })
      );
      expect(probe.value.isFiltered).toBe(true);
      act(() => probe.rerenderWithPermalink("th_perma"));
      expect(probe.value.isFiltered).toBe(false);
    });

    it("does not re-clear when the same permalink target re-renders", () => {
      const probe = mountProvider({ scrollToThreadId: "th_perma" });
      act(() =>
        probe.value.setSourceState<StubFilter>("stub", { tag: "pending" })
      );
      expect(probe.value.isFiltered).toBe(true);
      act(() => probe.rerenderWithPermalink("th_perma"));
      expect(probe.value.isFiltered).toBe(true);
    });

    it("fires again for a new permalink target", () => {
      const probe = mountProvider({ scrollToThreadId: "th_first" });
      act(() =>
        probe.value.setSourceState<StubFilter>("stub", { tag: "pending" })
      );
      act(() => probe.rerenderWithPermalink("th_second"));
      expect(probe.value.isFiltered).toBe(false);
    });
  });

  describe("no-op default outside provider", () => {
    it("useFeedFilter without a provider returns no-op defaults", () => {
      const ref: { current: FeedFilterContextValue | null } = { current: null };
      function Probe() {
        ref.current = useFeedFilter();
        return null;
      }
      render(<Probe />);
      expect(ref.current?.activeKind).toBe(ACTIVE_KIND_ALL);
      expect(ref.current?.isFiltered).toBe(false);
      act(() => {
        ref.current?.setActiveKind(FeedItemKind.LiveblocksComment);
        ref.current?.clearFilter();
      });
      expect(ref.current?.activeKind).toBe(ACTIVE_KIND_ALL);
    });
  });
});
