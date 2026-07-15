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
 *
 * `clearOnSubmit={false}`: the parent keeps this composer mounted when the
 * edit save fails, so the draft must survive submit and only reset when the
 * successful mutation unmounts it — otherwise a failed save wipes the user's
 * typed edit with no way to recover it.
 */
export function PrCommentInlineEditComposer({
  initialBody,
  isPending,
  onCancel,
  onSubmit,
}: Readonly<PrCommentInlineEditComposerProps>) {
  return (
    <CommentComposer
      ariaLabel="Edit comment"
      clearOnSubmit={false}
      defaultValue={initialBody}
      isPending={isPending}
      onCancel={onCancel}
      onSubmit={onSubmit}
      submitLabel="Save"
    />
  );
}
