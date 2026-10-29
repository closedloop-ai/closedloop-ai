"use client";

import { CommentAnchorState } from "@repo/api/src/types/comment-anchor";
import type { CommentThreadDto } from "@repo/api/src/types/comment-thread-dto";
import { Chip } from "@repo/design-system/components/ui/chip";
import { CommentThreadAnchorPreview } from "@repo/design-system/components/ui/comment-thread";
import { cn } from "@repo/design-system/lib/utils";
import { LocateFixedIcon } from "lucide-react";
import { useId } from "react";
import {
  anchorPreviewText,
  type CommentsPaneAnchorStateLabels,
} from "./comments-pane-model";

/**
 * The non-text cue each non-ANCHORED state carries, so the state reads
 * without wording: MOVED is dashed-underlined (still revealable), OUTDATED
 * is muted, ORPHANED is muted and struck through.
 */
const ANCHOR_STATE_CUE: Record<keyof CommentsPaneAnchorStateLabels, string> = {
  [CommentAnchorState.Moved]:
    "underline decoration-warning decoration-dashed underline-offset-2",
  [CommentAnchorState.Outdated]: "opacity-60",
  [CommentAnchorState.Orphaned]: "line-through opacity-60",
};

export function CommentsPaneThreadAnchor({
  anchorStateLabels,
  onReveal,
  thread,
}: Readonly<{
  anchorStateLabels: CommentsPaneAnchorStateLabels;
  onReveal?: () => void;
  thread: CommentThreadDto;
}>) {
  const labelId = useId();
  const preview = anchorPreviewText(thread.anchor);
  const state =
    thread.anchorState && thread.anchorState !== CommentAnchorState.Anchored
      ? thread.anchorState
      : null;
  const stateLabel = state ? anchorStateLabels[state] : null;
  if (!preview) {
    return null;
  }
  const cueProps = {
    "aria-describedby": stateLabel ? labelId : undefined,
    "data-anchor-cue": state?.toLowerCase(),
  };
  const text = (
    <span className={cn("truncate", state && ANCHOR_STATE_CUE[state])}>
      {preview}
    </span>
  );
  return (
    <CommentThreadAnchorPreview className="flex items-center gap-2">
      {onReveal ? (
        <button
          aria-label={`Jump to ${preview}`}
          className="flex min-w-0 flex-1 items-center justify-between gap-2 text-left hover:text-foreground"
          data-comment-control
          onClick={onReveal}
          type="button"
          {...cueProps}
        >
          {text}
          <LocateFixedIcon aria-hidden className="size-3 shrink-0" />
        </button>
      ) : (
        <span className="flex min-w-0 flex-1" {...cueProps}>
          {text}
        </span>
      )}
      {stateLabel ? (
        <Chip className="not-italic" id={labelId} size="sm" variant="warning">
          {stateLabel}
        </Chip>
      ) : null}
    </CommentThreadAnchorPreview>
  );
}
