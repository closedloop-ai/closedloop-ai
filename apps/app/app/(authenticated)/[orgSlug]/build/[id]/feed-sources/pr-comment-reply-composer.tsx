"use client";

import { CommentComposer } from "@repo/design-system/components/ui/comment-composer";

type PrCommentReplyComposerProps = {
  isPending: boolean;
  onCancel: () => void;
  onSubmit: (body: string) => void;
};

/**
 * Inline per-thread reply textarea with always-visible Cancel/Reply
 * buttons. Reply is disabled until the trimmed draft has content;
 * Cancel is always available so users can dismiss the composer without
 * typing. Cmd/Ctrl+Enter submits.
 */
export function PrCommentReplyComposer({
  isPending,
  onCancel,
  onSubmit,
}: Readonly<PrCommentReplyComposerProps>) {
  return (
    <div
      className="border-border border-t bg-muted/20 px-3 py-3"
      data-comment-control="true"
    >
      <CommentComposer
        isPending={isPending}
        minHeightClassName="min-h-[64px] max-h-[180px]"
        onCancel={onCancel}
        onSubmit={onSubmit}
        placeholder="Reply…"
        submitLabel="Reply"
      />
    </div>
  );
}
