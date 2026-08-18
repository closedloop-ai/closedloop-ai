"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Label } from "@repo/design-system/components/ui/label";
import { Separator } from "@repo/design-system/components/ui/separator";
import { MessageSquare } from "lucide-react";
import { useId } from "react";
import type { CommentThread } from "../mock";
import { currentUser, mentionableUsers } from "../mock";
import { MentionComposer } from "./mention-composer";
import { ThreadCard } from "./thread-card";

// Right-hand comment rail, the artifact-level surface. Mirrors the connected
// CommentsSectionView (packages/app/documents/components/comments-section.tsx):
// unresolved threads first, an artifact-level composer, and the no-comments
// empty state. Resolved threads collapse behind a toggle so the rail leads with
// what still needs attention.

type CommentRailProps = {
  threads: readonly CommentThread[];
  showResolved: boolean;
  activeThreadId: string | null;
  onToggleResolved: () => void;
  onResolveToggle: (threadId: string) => void;
  onDelete: (threadId: string) => void;
  onReply: (threadId: string, body: string, mentions: string[]) => void;
  onEdit: (threadId: string, body: string) => void;
  onComment: (body: string, mentions: string[]) => void;
  onRegisterThreadRef: (threadId: string, node: HTMLElement | null) => void;
  /** Hoisted artifact-composer draft so it survives a rail hide/show. */
  composerDraft: string;
  onComposerDraftChange: (next: string) => void;
};

export function CommentRail({
  threads,
  showResolved,
  activeThreadId,
  onToggleResolved,
  onResolveToggle,
  onDelete,
  onReply,
  onEdit,
  onComment,
  onRegisterThreadRef,
  composerDraft,
  onComposerDraftChange,
}: Readonly<CommentRailProps>) {
  const composerLabelId = useId();
  const open = threads.filter((thread) => !thread.resolved);
  const resolved = threads.filter((thread) => thread.resolved);
  const hasThreads = threads.length > 0;

  return (
    <div className="flex flex-col gap-4">
      {hasThreads ? (
        <>
          <div className="flex flex-col gap-3">
            {open.map((thread) => (
              <ThreadCard
                currentUserId={currentUser.id}
                isActive={thread.id === activeThreadId}
                key={thread.id}
                onDelete={onDelete}
                onEdit={onEdit}
                onRegisterRef={onRegisterThreadRef}
                onReply={onReply}
                onResolveToggle={onResolveToggle}
                thread={thread}
              />
            ))}
            {open.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No open threads. Everything here is resolved.
              </p>
            ) : null}
          </div>

          {resolved.length > 0 ? (
            <div className="flex flex-col gap-3">
              <Button
                aria-expanded={showResolved}
                className="h-auto w-fit p-0 font-medium text-muted-foreground text-sm hover:text-foreground hover:no-underline"
                onClick={onToggleResolved}
                variant="link"
              >
                {showResolved ? "Hide" : "Show"} {resolved.length} resolved
              </Button>
              {showResolved
                ? resolved.map((thread) => (
                    <ThreadCard
                      currentUserId={currentUser.id}
                      isActive={thread.id === activeThreadId}
                      key={thread.id}
                      onDelete={onDelete}
                      onEdit={onEdit}
                      onRegisterRef={onRegisterThreadRef}
                      onReply={onReply}
                      onResolveToggle={onResolveToggle}
                      thread={thread}
                    />
                  ))
                : null}
            </div>
          ) : null}
        </>
      ) : (
        <EmptyState
          className="border border-dashed"
          description="Start a discussion, ask for clarification, or @-mention a teammate to bring them in."
          icon={MessageSquare}
          title="No comments yet"
        />
      )}

      <Separator />

      {/* Artifact-level composer: a whole-document comment, not tied to any
          text selection. */}
      <div className="flex flex-col gap-2">
        <Label className="text-sm" id={composerLabelId}>
          Comment on the whole document
        </Label>
        <MentionComposer
          draft={composerDraft}
          labelledBy={composerLabelId}
          onDraftChange={onComposerDraftChange}
          onSubmit={({ body, mentions }) => onComment(body, mentions)}
          placeholder="Add a comment..."
          submitLabel="Comment"
          users={mentionableUsers}
        />
      </div>
    </div>
  );
}
