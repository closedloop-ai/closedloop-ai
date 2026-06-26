"use client";

import { XIcon } from "lucide-react";
import { useCommentPermalink } from "../comment-permalink-context";

/**
 * Non-blocking banner shown above the Feed tab content when a permalink
 * URL points at a thread that is not in the current Liveblocks thread
 * set (deleted, cross-org, or never existed). Renders null when the
 * permalink resolution has not produced a not-found result, or when the
 * banner has been dismissed.
 *
 * Reads its own visibility from `useCommentPermalink()` — no props
 * needed. Mount once inside the Feed tab.
 */
export function LiveblocksMissingThreadBanner() {
  const { bannerVisible, dismissBanner } = useCommentPermalink();
  if (!bannerVisible) {
    return null;
  }
  return (
    <div
      className="flex shrink-0 items-start gap-2 border-b bg-muted/50 px-3 py-2 text-muted-foreground text-xs"
      role="status"
    >
      <p className="flex-1">Comment not found.</p>
      <button
        aria-label="Dismiss missing-comment banner"
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
        onClick={dismissBanner}
        type="button"
      >
        <XIcon className="h-3 w-3" />
      </button>
    </div>
  );
}
