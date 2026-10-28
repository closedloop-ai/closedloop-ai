"use client";

import { CommentsPaneToggleButton } from "@repo/app/shared/components/comments/comments-pane-toggle";
import type { RefObject } from "react";
import { BRANCH_COMMENTS_CONTROLS_ID } from "./branch-comments-model";

/** Prototype-faithful header affordance for the flag-off Branch comments rail. */
export function BranchCommentsToggle({
  open,
  onOpenChange,
  toggleRef,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  toggleRef: RefObject<HTMLButtonElement | null>;
}>) {
  return (
    <CommentsPaneToggleButton
      controlsId={BRANCH_COMMENTS_CONTROLS_ID}
      onOpenChange={onOpenChange}
      open={open}
      toggleRef={toggleRef}
    />
  );
}
