"use client";

import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { useEffect, useRef } from "react";
import { CommentChat } from "@/components/engineer/CommentChat";
import type { PRComment } from "@/components/engineer/PRCommentCard";
import { useCommentChat } from "@/hooks/engineer/useCommentChat";

type CommentChatDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  comment: PRComment;
  replies?: PRComment[];
  prNumber: number;
  repoPath: string;
  ticketId: string;
  onResolved: () => void;
};

/**
 * CommentChatDialog - A dialog wrapper for CommentChat.
 * Used for mobile layouts and backward compatibility.
 */
export function CommentChatDialog({
  open,
  onOpenChange,
  comment,
  replies = [],
  prNumber,
  repoPath,
  ticketId,
  onResolved,
}: Readonly<CommentChatDialogProps>) {
  const hadChangesRef = useRef(false);

  // Use the hook just to access triggerLearningsExtraction and hasChangedFiles
  // CommentChat internally uses the same hook, but we need access here for dialog close
  const { hasChangedFiles, triggerLearningsExtraction } = useCommentChat({
    commentId: comment.id,
    ticketId,
    repoPath,
    prNumber,
    comment,
    replies,
    enabled: open,
    autoStart: false, // CommentChat will handle auto-start
  });

  // Latch: once we see changes, remember it for the rest of the session
  useEffect(() => {
    if (hasChangedFiles) {
      hadChangesRef.current = true;
    }
  }, [hasChangedFiles]);

  // Reset latch when dialog closes
  useEffect(() => {
    if (!open) {
      hadChangesRef.current = false;
    }
  }, [open]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && hadChangesRef.current) {
      triggerLearningsExtraction();
      hadChangesRef.current = false;
    }
    onOpenChange(nextOpen);
  };

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogContent className="flex h-[80vh] max-h-[800px] w-[95vw] max-w-4xl flex-col gap-0 overflow-hidden border-border bg-background p-0 lg:max-w-5xl xl:max-w-6xl">
        <DialogTitle className="sr-only">Propose Fix</DialogTitle>
        <CommentChat
          className="h-full"
          comment={comment}
          commentId={comment.id}
          onResolved={onResolved}
          prNumber={prNumber}
          replies={replies}
          repoPath={repoPath}
          ticketId={ticketId}
        />
      </DialogContent>
    </Dialog>
  );
}
