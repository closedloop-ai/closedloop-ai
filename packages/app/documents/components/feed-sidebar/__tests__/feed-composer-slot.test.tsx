// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { MessageSquare } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect } from "react";
import { describe, expect, it } from "vitest";

import { CommentPermalinkProvider } from "../comment-permalink-context";
import { FeedComposerSlot } from "../feed-composer-slot";
import {
  ACTIVE_KIND_ALL,
  type ActiveKind,
  FeedFilterProvider,
  useFeedFilter,
} from "../feed-filter-context";
import { FeedItemKind } from "../feed-item";
import type { AnyFeedSource } from "../feed-source";
import { FeedSourcesProvider } from "../feed-sources-context";

function makeSource(
  id: string,
  kind: FeedItemKind,
  Composer?: () => ReactNode
): AnyFeedSource {
  return {
    id,
    kind,
    label: id,
    Icon: MessageSquare,
    useItems: () => ({ items: [], isLoading: false, isError: false }),
    defaultFilterState: {},
    applyFilter: (items) => items,
    isFiltered: () => false,
    Composer,
    renderItem: () => null,
  };
}

function ForceActiveKind({ activeKind }: Readonly<{ activeKind: ActiveKind }>) {
  const { activeKind: currentActiveKind, setActiveKind } = useFeedFilter();
  useEffect(() => {
    if (currentActiveKind !== activeKind) {
      setActiveKind(activeKind);
    }
  }, [activeKind, currentActiveKind, setActiveKind]);
  return null;
}

function renderSlot({
  activeKind = ACTIVE_KIND_ALL,
  sources,
}: Readonly<{
  activeKind?: ActiveKind;
  sources: readonly AnyFeedSource[];
}>) {
  render(
    <CommentPermalinkProvider
      buildPermalinkUrl={undefined}
      scrollToThreadId={undefined}
    >
      <FeedSourcesProvider sources={sources}>
        <FeedFilterProvider>
          <ForceActiveKind activeKind={activeKind} />
          <FeedComposerSlot />
        </FeedFilterProvider>
      </FeedSourcesProvider>
    </CommentPermalinkProvider>
  );
}

describe("FeedComposerSlot", () => {
  it("keeps the liveblocks composer in the all-comments view with read-only sources present", () => {
    renderSlot({
      sources: [
        makeSource("liveblocks", FeedItemKind.LiveblocksComment, () => (
          <div>Liveblocks composer</div>
        )),
        makeSource("native", FeedItemKind.NativeDocumentComment),
      ],
    });

    expect(screen.getByText("Liveblocks composer")).toBeInTheDocument();
  });

  it("keeps the liveblocks composer in the liveblocks-filtered view", () => {
    renderSlot({
      activeKind: FeedItemKind.LiveblocksComment,
      sources: [
        makeSource("liveblocks", FeedItemKind.LiveblocksComment, () => (
          <div>Liveblocks composer</div>
        )),
        makeSource("native", FeedItemKind.NativeDocumentComment),
      ],
    });

    expect(screen.getByText("Liveblocks composer")).toBeInTheDocument();
  });

  it("hides the composer for a native-filtered view with no native composer", () => {
    renderSlot({
      activeKind: FeedItemKind.NativeDocumentComment,
      sources: [
        makeSource("liveblocks", FeedItemKind.LiveblocksComment, () => (
          <div>Liveblocks composer</div>
        )),
        makeSource("native", FeedItemKind.NativeDocumentComment),
      ],
    });

    expect(screen.queryByText("Liveblocks composer")).toBeNull();
  });

  it("hides all composers in the all-comments view when multiple sources can write", () => {
    renderSlot({
      sources: [
        makeSource("liveblocks", FeedItemKind.LiveblocksComment, () => (
          <div>Liveblocks composer</div>
        )),
        makeSource("native", FeedItemKind.NativeDocumentComment, () => (
          <div>Native composer</div>
        )),
      ],
    });

    expect(screen.queryByText("Liveblocks composer")).toBeNull();
    expect(screen.queryByText("Native composer")).toBeNull();
  });

  it("renders the explicitly selected composer when multiple sources can write", () => {
    renderSlot({
      activeKind: FeedItemKind.NativeDocumentComment,
      sources: [
        makeSource("liveblocks", FeedItemKind.LiveblocksComment, () => (
          <div>Liveblocks composer</div>
        )),
        makeSource("native", FeedItemKind.NativeDocumentComment, () => (
          <div>Native composer</div>
        )),
      ],
    });

    expect(screen.queryByText("Liveblocks composer")).toBeNull();
    expect(screen.getByText("Native composer")).toBeInTheDocument();
  });

  it("does not render a source composer that suppresses itself in historical mode", () => {
    renderSlot({
      sources: [
        makeSource("liveblocks", FeedItemKind.LiveblocksComment, () => null),
      ],
    });

    expect(screen.queryByText("Liveblocks composer")).toBeNull();
  });
});
