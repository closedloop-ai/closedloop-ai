"use client";

import { CommentComposer } from "@repo/design-system/components/ui/comment-composer";

type PrCommentInlineEditComposerProps = {
  initialBody: string;
  isPending: boolean;
  onCancel: () => void;
  onSubmit: (body: string) => void;
};

/**
 * Inline edit composer used by the action-menu Edit affordance. Local
 * draft state is seeded from the comment body; Cmd/Ctrl+Enter submits.
 */
export function PrCommentInlineEditComposer({
  initialBody,
  isPending,
  onCancel,
  onSubmit,
}: Readonly<PrCommentInlineEditComposerProps>) {
  return (
    <CommentComposer
      defaultValue={initialBody}
      isPending={isPending}
      onCancel={onCancel}
      onSubmit={onSubmit}
      submitLabel="Save"
    />
  );
}
