"use client";

import type { ThreadData } from "@liveblocks/client";
import {
  FeedSidebar,
  FeedTab,
} from "@repo/app/documents/components/feed-sidebar/feed-sidebar";
import {
  DEFAULT_LIVEBLOCKS_FILTER_STATE,
  type LiveblocksFilterState,
} from "@repo/app/documents/components/feed-sidebar/sources/apply-liveblocks-filter";
import {
  LIVEBLOCKS_COMMENT_SOURCE_ID,
  liveblocksCommentSource,
} from "@repo/app/documents/components/feed-sidebar/sources/liveblocks-comment-source";
import { LiveblocksSourceProvider } from "@repo/app/documents/components/feed-sidebar/sources/liveblocks-source-provider";
import type { FeedArtifactType } from "@repo/app/documents/components/feed-sidebar/types";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";

type DocumentFeedRailProps = {
  artifactType: FeedArtifactType;
  organizationId: string;
  /**
   * When false, renders nothing. Lets callers gate the rail on a
   * feature flag without scattering conditionals at every callsite.
   */
  enabled: boolean;
  visible: boolean;
  onClose: () => void;
  /**
   * Required by `LiveblocksSourceProvider` for version-attribution
   * badges and the artifact-level composer's metadata stamp.
   */
  latestVersion: number;
  /**
   * When `isViewingHistorical === true`, the rail seeds the Liveblocks
   * source's `versionFilter` so the user sees a version-pinned slice.
   */
  currentVersion: number;
  isViewingHistorical: boolean;
  /**
   * Scaffold-side click handler — scrolls the doc editor to the
   * thread's anchor for anchored threads. Threaded into the Liveblocks
   * source via `LiveblocksSourceProvider`.
   */
  onCommentClick?: (thread: ThreadData) => void;
  /**
   * Optional chat tab. When omitted, only the Feed tab renders.
   */
  chatPanel?: ReactNode;
};

const DOC_SOURCES = [liveblocksCommentSource] as const;

export function buildDocumentFeedRailInitialSourceState({
  currentVersion,
  isViewingHistorical,
}: Readonly<{
  currentVersion: number;
  isViewingHistorical: boolean;
}>): Record<string, unknown> | undefined {
  if (!isViewingHistorical) {
    return undefined;
  }

  return {
    [LIVEBLOCKS_COMMENT_SOURCE_ID]: {
      ...DEFAULT_LIVEBLOCKS_FILTER_STATE,
      versionFilter: currentVersion,
    } satisfies LiveblocksFilterState,
  };
}

export function DocumentFeedRail({
  artifactType,
  organizationId,
  enabled,
  visible,
  onClose,
  latestVersion,
  currentVersion,
  isViewingHistorical,
  onCommentClick,
  chatPanel,
}: Readonly<DocumentFeedRailProps>) {
  const [activeTab, setActiveTab] = useState<FeedTab>(FeedTab.Feed);

  const initialSourceState = useMemo<Record<string, unknown> | undefined>(
    () =>
      buildDocumentFeedRailInitialSourceState({
        currentVersion,
        isViewingHistorical,
      }),
    [isViewingHistorical, currentVersion]
  );

  const sourceContextValue = useMemo(
    () => ({ latestVersion, onCommentClick }),
    [latestVersion, onCommentClick]
  );

  // FeedFilterProvider seeds per-source state from initialSourceState
  // exactly once via a lazy useState initializer; later prop changes are
  // ignored. Force a remount when the historical seed changes so the
  // viewer always sees a slice that matches the selected version (and
  // so the artifact-level composer reappears on return to live mode).
  const filterSeedKey = isViewingHistorical
    ? `historical-${currentVersion}`
    : "live";

  if (!enabled) {
    return null;
  }
  return (
    <LiveblocksSourceProvider value={sourceContextValue}>
      <FeedSidebar
        activeTab={activeTab}
        artifactType={artifactType}
        chatPanel={chatPanel ?? null}
        initialSourceState={initialSourceState}
        key={filterSeedKey}
        onActiveTabChange={setActiveTab}
        onClose={onClose}
        organizationId={organizationId}
        sources={DOC_SOURCES}
        visible={visible}
      />
    </LiveblocksSourceProvider>
  );
}
