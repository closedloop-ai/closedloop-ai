"use client";

import type { TraceCommentMentions } from "@repo/api/src/types/comment";
import { CommentComposer } from "@repo/design-system/components/ui/comment-composer";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import type { CommentsPaneDraft } from "./comments-pane-model";

/** What a composer submits: `mentions` only when the composer collects them. */
export type CommentsPaneComposerSubmission = {
  body: string;
  mentions?: TraceCommentMentions;
};

/**
 * Everything one of the pane's composers needs, handed to a host's
 * `renderComposer` (PLN-2162 decision 4): the host can render its own
 * composer, such as one with an @-mention picker, in the pane's place.
 */
export type CommentsPaneComposerRenderProps = {
  ariaLabel: string;
  disabled?: boolean;
  helperText?: ReactNode;
  /**
   * The mentions the composer starts with: a kept draft's picks, else the
   * edited comment's, so text that keeps their "@Name" tokens sends them.
   */
  initialMentions?: TraceCommentMentions;
  isPending: boolean;
  leadingActions?: ReactNode;
  minHeightClassName: string;
  onCancel?: () => void;
  onSubmit: (submission: {
    body: string;
    mentions: TraceCommentMentions;
  }) => void;
  /** `mentions` is the picked set, from a composer that collects mentions. */
  onValueChange: (body: string, mentions?: TraceCommentMentions) => void;
  placeholder?: string;
  submitLabel?: string;
  value: string;
};

export type CommentsPaneRenderComposer = (
  props: CommentsPaneComposerRenderProps
) => ReactNode;

/** The host's composer when it supplies one, else the plain composer, which collects no mentions. */
export function CommentsPaneComposer({
  renderComposer,
  onSubmit,
  ...props
}: Readonly<
  Omit<CommentsPaneComposerRenderProps, "onSubmit"> & {
    onSubmit: (submission: CommentsPaneComposerSubmission) => void;
    renderComposer?: CommentsPaneRenderComposer;
  }
>) {
  if (renderComposer) {
    return renderComposer({ ...props, onSubmit });
  }
  return (
    <CommentComposer
      ariaLabel={props.ariaLabel}
      disabled={props.disabled}
      helperText={props.helperText}
      isPending={props.isPending}
      leadingActions={props.leadingActions}
      minHeightClassName={props.minHeightClassName}
      onCancel={props.onCancel}
      onSubmit={(body) => onSubmit({ body })}
      onValueChange={props.onValueChange}
      placeholder={props.placeholder}
      submitLabel={props.submitLabel}
      value={props.value}
    />
  );
}

/** A reply or edit composer: Escape is its Cancel, never the rail's dismiss. */
export function CommentsPaneScopedComposer({
  ariaLabel,
  className,
  draft,
  draftKey,
  initialMentions,
  isPending,
  onCancel,
  onDraftChange,
  onSubmit,
  placeholder,
  renderComposer,
  submitLabel,
  value,
}: Readonly<{
  ariaLabel: string;
  className?: string;
  draft: CommentsPaneDraft | undefined;
  draftKey: string;
  initialMentions?: TraceCommentMentions;
  isPending: boolean;
  onCancel: () => void;
  onDraftChange: (key: string, draft: CommentsPaneDraft | null) => void;
  onSubmit: (submission: CommentsPaneComposerSubmission) => void;
  placeholder: string;
  renderComposer?: CommentsPaneRenderComposer;
  submitLabel: string;
  value: string;
}>) {
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape from the composer's own textarea bubbles here; the wrapper takes no input itself.
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: same delegation; the textarea inside is the interactive element.
    <div className={className} data-comment-control onKeyDown={onKeyDown}>
      <CommentsPaneComposer
        ariaLabel={ariaLabel}
        initialMentions={draft?.mentions ?? initialMentions}
        isPending={isPending}
        minHeightClassName="min-h-16 max-h-48"
        onCancel={onCancel}
        onSubmit={onSubmit}
        onValueChange={(body, mentions) =>
          // Keep the rest of the draft (an edit's base revision) as the text changes.
          onDraftChange(draftKey, {
            ...draft,
            body,
            ...(mentions ? { mentions } : {}),
          })
        }
        placeholder={placeholder}
        renderComposer={renderComposer}
        submitLabel={submitLabel}
        value={value}
      />
    </div>
  );
}
