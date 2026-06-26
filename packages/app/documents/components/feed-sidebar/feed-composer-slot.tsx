"use client";

import { useFeedSources } from "./feed-sources-context";

/**
 * Sticky bottom composer host. Renders the active source's `Composer`
 * component when (and only when) the source list contains exactly one
 * source with a Composer defined. Multi-source contexts get no
 * composer until the design specifies one — single-artifact pages
 * (branch, document) are single-source today.
 */
export function FeedComposerSlot() {
  const sources = useFeedSources();
  if (sources.length !== 1) {
    return null;
  }
  const [only] = sources;
  if (only.Composer === undefined) {
    return null;
  }
  const Composer = only.Composer;
  // The wrapping container (border-t / padding) is the source's
  // responsibility — when a Composer returns null (e.g. Liveblocks
  // historical mode), we want it to render nothing at all, not an
  // empty bordered strip at the bottom of the feed.
  return <Composer />;
}
