"use client";

import type { ThreadData } from "@liveblocks/client";
import { Comment, Thread } from "@liveblocks/react-ui";
import {
  CommentThreadAnchorPreview,
  CommentThreadBanner,
  CommentThreadCard,
} from "@repo/design-system/components/ui/comment-thread";
import { useCopyToClipboard } from "@repo/design-system/hooks/use-copy-to-clipboard";
import { activateOnEnterOrSpace } from "@repo/design-system/lib/keyboard-activation";
import { LinkIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCommentPermalink } from "../comment-permalink-context";

export type LiveblocksCommentCardProps = {
  thread: ThreadData;
  /**
   * Static preview of the anchored text, if any. Rendered as a quote chip
   * at the top of the card. `null` for threads with no inline anchor in
   * the current document.
   */
  anchorPreview: string | null;
  /**
   * Called when the user clicks the card body. Side-effect handler
   * controlled by the parent — typically used to scroll the document
   * editor to the thread's anchor for anchored threads. The parent is
   * responsible for deciding whether to do anything (e.g. no-op for
   * floating or artifact-level threads).
   *
   * The card always opens its inline reply composer on click regardless
   * of this prop. Keyboard activation (Enter / Space) intentionally does
   * NOT call this — it only opens the composer, matching today's UX. The
   * Comment Permalink feature (FR12) will own the focus-by-keyboard
   * scroll path on artifact load.
   */
  onCommentClick?: () => void;
  /**
   * Version-attribution label (e.g. "from v1", "from a prior version")
   * shown as a small badge in the card header. Undefined when the thread
   * originated on the current latest version — no badge renders. Derived
   * by `CommentStream` from `thread.metadata.version` vs. the artifact's
   * `latestVersion`.
   */
  versionLabel?: string;
};

export function LiveblocksCommentCard({
  thread,
  anchorPreview,
  onCommentClick,
  versionLabel,
}: Readonly<LiveblocksCommentCardProps>) {
  const [composerOpen, setComposerOpen] = useState(false);
  const [, copy] = useCopyToClipboard();
  const cardRef = useRef<HTMLDivElement | null>(null);

  const { buildPermalinkUrl, onPermalinkCopied } = useCommentPermalink();
  const permalinkUrl = useMemo(
    () => buildPermalinkUrl?.(thread.id),
    [buildPermalinkUrl, thread.id]
  );
  const rootCommentId = thread.comments[0]?.id;

  const onCardClick = useCallback(() => {
    if (composerOpen) {
      return;
    }
    onCommentClick?.();
    setComposerOpen(true);
  }, [composerOpen, onCommentClick]);

  const onKeyDown = useMemo(
    () =>
      activateOnEnterOrSpace<HTMLDivElement>(() => {
        if (composerOpen) {
          return;
        }
        setComposerOpen(true);
      }),
    [composerOpen]
  );

  const onCopyPermalink = useCallback(async () => {
    if (permalinkUrl === undefined) {
      return;
    }
    const success = await copy(permalinkUrl);
    if (success) {
      onPermalinkCopied();
    }
  }, [permalinkUrl, copy, onPermalinkCopied]);

  // Augment the per-comment overflow dropdown with a Copy Link item.
  // Only the root comment gets it — the permalink targets the whole
  // thread, so showing it on every reply would be redundant.
  const commentDropdownItems = useCallback(
    ({
      comment,
      children,
    }: {
      comment: { id: string };
      children?: React.ReactNode;
    }) => {
      const isRoot = comment.id === rootCommentId;
      if (!isRoot || permalinkUrl === undefined) {
        return <>{children}</>;
      }
      return (
        <>
          {children}
          <Comment.DropdownItem
            aria-label="Copy link to comment"
            icon={<LinkIcon className="h-3.5 w-3.5" />}
            onSelect={onCopyPermalink}
          >
            Copy link
          </Comment.DropdownItem>
        </>
      );
    },
    [rootCommentId, permalinkUrl, onCopyPermalink]
  );

  // Close the composer when the user clicks outside the card. Ignore
  // clicks inside Liveblocks portaled popups (mention suggestions, etc.)
  // because they live outside the card DOM but are part of composer flow.
  useEffect(() => {
    if (!composerOpen) {
      return;
    }
    function onPointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      if (cardRef.current?.contains(target)) {
        return;
      }
      if (target.closest(LIVEBLOCKS_PORTAL_SELECTOR)) {
        return;
      }
      setComposerOpen(false);
    }
    globalThis.document.addEventListener("pointerdown", onPointerDown);
    return () => {
      globalThis.document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [composerOpen]);

  return (
    <CommentThreadCard
      className="group bg-card focus-within:ring-1 focus-within:ring-primary/40"
      data-thread-id={thread.id}
      interactive={false}
      onClick={onCardClick}
      onKeyDown={onKeyDown}
      tabIndex={composerOpen ? -1 : 0}
    >
      <div ref={cardRef}>
        {versionLabel !== undefined && (
          <CommentThreadBanner>
            <span className="rounded border bg-background px-1.5 py-0.5 font-medium text-[10px] text-muted-foreground uppercase tracking-wide">
              {versionLabel}
            </span>
          </CommentThreadBanner>
        )}
        {anchorPreview !== null && (
          <CommentThreadAnchorPreview>
            {anchorPreview}
          </CommentThreadAnchorPreview>
        )}
        <Thread
          commentDropdownItems={commentDropdownItems}
          showComposer={composerOpen}
          thread={thread}
        />
      </div>
    </CommentThreadCard>
  );
}

/**
 * Selector for Liveblocks-rendered floating elements (emoji picker, mention
 * suggestions, format menus, dropdowns, tooltips, etc.) that are portaled
 * outside the card subtree. Clicks inside these must NOT close the composer.
 * `.lb-elevation` is the shared base class for all elevated Liveblocks UI.
 */
const LIVEBLOCKS_PORTAL_SELECTOR = [
  ".lb-elevation",
  ".lb-emoji-picker",
  ".lb-dropdown",
  ".lb-tooltip",
  "[data-radix-popper-content-wrapper]",
].join(", ");
