"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { useEffect, useState } from "react";

export type CommentComposerProps = {
  value?: string;
  defaultValue?: string;
  placeholder?: string;
  submitLabel?: ReactNode;
  cancelLabel?: ReactNode;
  disabled?: boolean;
  isPending?: boolean;
  minHeightClassName?: string;
  containerClassName?: string;
  footerClassName?: string;
  leadingActions?: ReactNode;
  helperText?: ReactNode;
  onValueChange?: (value: string) => void;
  onSubmit: (body: string) => void;
  onCancel?: () => void;
};

export function CommentComposer({
  value,
  defaultValue = "",
  placeholder = "Add a comment...",
  submitLabel = "Comment",
  cancelLabel = "Cancel",
  disabled = false,
  isPending = false,
  minHeightClassName = "min-h-[96px]",
  containerClassName,
  footerClassName,
  leadingActions,
  helperText,
  onValueChange,
  onSubmit,
  onCancel,
}: Readonly<CommentComposerProps>) {
  const [internalValue, setInternalValue] = useState(defaultValue);
  const draft = value ?? internalValue;

  useEffect(() => {
    if (value === undefined) {
      setInternalValue(defaultValue);
    }
  }, [defaultValue, value]);

  function setDraft(nextValue: string) {
    if (value === undefined) {
      setInternalValue(nextValue);
    }
    onValueChange?.(nextValue);
  }

  function submit() {
    const trimmed = draft.trim();
    if (trimmed.length === 0 || disabled || isPending) {
      return;
    }
    onSubmit(trimmed);
    if (value === undefined) {
      setInternalValue("");
      onValueChange?.("");
    }
  }

  function handleCancelClick(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    if (value === undefined) {
      setInternalValue(defaultValue);
      onValueChange?.(defaultValue);
    }
    onCancel?.();
  }

  function handleSubmitClick(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    submit();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      submit();
    }
  }

  const hasContent = draft.trim().length > 0;

  return (
    <div
      className={containerClassName ?? "flex flex-col gap-2"}
      data-comment-control="true"
    >
      {helperText == null ? null : helperText}
      <Textarea
        className={`${minHeightClassName} resize-y text-sm`}
        data-comment-control="true"
        disabled={disabled || isPending}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        value={draft}
      />
      <div
        className={
          footerClassName ??
          (leadingActions == null
            ? "flex justify-end"
            : "flex items-center justify-between gap-2")
        }
      >
        {leadingActions == null ? null : (
          <div className="flex items-center gap-1">{leadingActions}</div>
        )}
        <div className="flex items-center justify-end gap-2">
          {onCancel ? (
            <Button
              data-comment-control="true"
              disabled={disabled || isPending}
              onClick={handleCancelClick}
              size="sm"
              type="button"
              variant="outline"
            >
              {cancelLabel}
            </Button>
          ) : null}
          <Button
            data-comment-control="true"
            disabled={disabled || isPending || !hasContent}
            onClick={handleSubmitClick}
            size="sm"
            type="button"
          >
            {submitLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
