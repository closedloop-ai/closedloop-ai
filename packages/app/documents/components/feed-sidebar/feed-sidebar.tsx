"use client";

import {
  FeedRail,
  FeedRailTab,
} from "@repo/design-system/components/ui/feed-rail";
import type { ReactNode } from "react";
import { FeedComposerSlot } from "./feed-composer-slot";
import { FeedFilterBar } from "./feed-filter-bar";
import { FeedFilterProvider } from "./feed-filter-context";
import { useFeedRailWidth } from "./feed-rail-width-store";
import type { AnyFeedSource } from "./feed-source";
import { FeedSourcesProvider } from "./feed-sources-context";
import { FeedStream } from "./feed-stream";
import { FeedRuntime } from "./source-items-registry";
import type { FeedArtifactType } from "./types";

export const FeedTab = FeedRailTab;
export type FeedTab = FeedRailTab;

export type FeedSidebarProps = {
  artifactType: FeedArtifactType;
  organizationId: string;
  visible: boolean;
  onClose: () => void;
  /**
   * Active source list. **Caller MUST memoize this array** — the
   * filter-state provider initializes per-source defaults from this
   * array on mount and re-mounts when its identity changes.
   */
  sources: readonly AnyFeedSource[];
  /**
   * Caller-provided initial state for any source whose `defaultFilterState`
   * isn't appropriate (e.g. doc-side historical view seeds the
   * Liveblocks source's `versionFilter`). Keyed by `source.id`. Read
   * once on `FeedFilterProvider` mount; later mutations go through the
   * provider's `setSourceState`. Caller MUST also memoize this object.
   */
  initialSourceState?: Record<string, unknown>;
  /**
   * Optional chat content. When omitted, only the Feed tab is shown.
   */
  chatPanel?: ReactNode;
  activeTab: FeedTab;
  onActiveTabChange: (next: FeedTab) => void;
};

/**
 * Right-rail feed sidebar. Hosts one or more heterogeneous data
 * sources via the `FeedSource` adapter pattern. Adding a new source
 * (activity, agent jobs, …) is purely additive — implement
 * `FeedSource` and include it in the artifact-specific `sources` prop.
 *
 * Mounting layout: FeedSourcesProvider → FeedFilterProvider →
 * FeedRuntime (registers items + Suspense boundary) → FeedFilterBar +
 * FeedStream + FeedComposerSlot.
 *
 * Responsive behavior: above 1024px the rail uses a user-resizable
 * width persisted via `useFeedRailWidth`; below 1024px it renders as a
 * fixed-position overlay with a click-to-close backdrop.
 */
export function FeedSidebar({
  artifactType,
  organizationId,
  visible,
  onClose,
  sources,
  initialSourceState,
  chatPanel,
  activeTab,
  onActiveTabChange,
}: Readonly<FeedSidebarProps>) {
  const [width, setWidth] = useFeedRailWidth(organizationId, artifactType);

  const hasChat = chatPanel !== undefined && chatPanel !== null;
  const effectiveTab: FeedTab = hasChat ? activeTab : FeedTab.Feed;

  const feedPanel = (
    <FeedSourcesProvider sources={sources}>
      <FeedFilterProvider initialSourceState={initialSourceState}>
        <FeedRuntime fallback={<StreamSkeleton />} sources={sources}>
          <FeedFilterBar />
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            <FeedStream />
          </div>
          <FeedComposerSlot />
        </FeedRuntime>
      </FeedFilterProvider>
    </FeedSourcesProvider>
  );

  return (
    <FeedRail
      activeTab={effectiveTab}
      chatPanel={chatPanel ?? null}
      feedPanel={feedPanel}
      hasChat={hasChat}
      onClose={onClose}
      onTabChange={onActiveTabChange}
      onWidthChange={setWidth}
      visible={visible}
      width={width}
    />
  );
}

function StreamSkeleton() {
  return (
    <div className="flex flex-col gap-2 p-3">
      {["s0", "s1", "s2"].map((id) => (
        <div
          className="h-20 animate-pulse rounded-lg border bg-muted/30"
          key={id}
        />
      ))}
    </div>
  );
}
