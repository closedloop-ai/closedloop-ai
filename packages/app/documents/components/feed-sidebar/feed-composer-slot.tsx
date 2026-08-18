"use client";

import { ACTIVE_KIND_ALL, useFeedFilter } from "./feed-filter-context";
import { useFeedSources } from "./feed-sources-context";

/**
 * Sticky bottom composer host. Renders the selected source composer, or the
 * only composer-capable source when the feed is showing all item kinds. This
 * keeps source-specific composers available as read-only sources are added to
 * the same feed without guessing between multiple writable sources.
 */
export function FeedComposerSlot() {
  const sources = useFeedSources();
  const { activeKind } = useFeedFilter();
  const composerSources = sources.filter(
    (candidate) => candidate.Composer !== undefined
  );
  const source =
    activeKind === ACTIVE_KIND_ALL
      ? getOnlyComposerSource(composerSources)
      : composerSources.find((candidate) => candidate.kind === activeKind);

  if (source?.Composer === undefined) {
    return null;
  }
  const Composer = source.Composer;
  // The wrapping container (border-t / padding) is the source's
  // responsibility — when a Composer returns null (e.g. Liveblocks
  // historical mode), we want it to render nothing at all, not an
  // empty bordered strip at the bottom of the feed.
  return <Composer />;
}

function getOnlyComposerSource<T>(sources: readonly T[]): T | undefined {
  if (sources.length !== 1) {
    return undefined;
  }
  return sources[0];
}
