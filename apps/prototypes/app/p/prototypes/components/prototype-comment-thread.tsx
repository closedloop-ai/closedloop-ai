"use client";

import {
  Avatar,
  AvatarFallback,
} from "@repo/design-system/components/ui/avatar";
import { Button } from "@repo/design-system/components/ui/button";
import { CommentActionMenu } from "@repo/design-system/components/ui/comment-action-menu";
import { CommentComposer } from "@repo/design-system/components/ui/comment-composer";
import {
  CommentThreadAnchorPreview,
  CommentThreadCard,
  CommentThreadHeader,
  CommentThreadMain,
  CommentThreadReplies,
  CommentThreadReplyRow,
} from "@repo/design-system/components/ui/comment-thread";
import { CommentThreadActionFooter } from "@repo/design-system/components/ui/comment-thread-action-footer";
import { MessageSquareIcon, ReplyIcon } from "lucide-react";
import { useState } from "react";
import type { Annotation, Person } from "../mock";

export function PrototypeCommentThread({
  annotation,
  selected,
  onActivate,
  onDelete,
  onEdit,
  onReply,
  onResolve,
}: {
  annotation: Annotation;
  selected: boolean;
  onActivate: () => void;
  onDelete: () => void;
  onEdit: (body: string) => void;
  onReply: (body: string) => void;
  onResolve: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [replying, setReplying] = useState(false);

  return (
    <CommentThreadCard
      className={selected ? "border-primary bg-accent" : undefined}
      data-comment-id={annotation.id}
      data-selected={selected}
      interactive
      selected={selected}
    >
      <CommentThreadAnchorPreview>
        {annotation.target} · {annotation.route}
      </CommentThreadAnchorPreview>
      <CommentThreadMain
        actions={
          <span className="flex items-center gap-1">
            <Button
              aria-label={`Show comment ${annotation.displayNumber} in preview`}
              onClick={onActivate}
              size="icon-sm"
              variant="ghost"
            >
              <MessageSquareIcon />
            </Button>
            <CommentActionMenu
              onDelete={onDelete}
              onEditToggle={() => setEditing((current) => !current)}
              onResolveAction={onResolve}
              resolveLabel={
                annotation.resolved ? "Reopen thread" : "Resolve thread"
              }
            />
          </span>
        }
        avatar={<ThreadAvatar person={annotation.author} />}
        content={
          <>
            <CommentThreadHeader
              author={
                <span className="font-medium text-sm">
                  {annotation.author.name}
                </span>
              }
              metadata={
                <span className="text-muted-foreground text-xs">
                  {annotation.createdAt}
                </span>
              }
            />
            {editing ? (
              <CommentComposer
                cancelLabel="Cancel"
                defaultValue={annotation.body}
                minHeightClassName="min-h-16"
                onCancel={() => setEditing(false)}
                onSubmit={(body) => {
                  onEdit(body);
                  setEditing(false);
                }}
                submitLabel="Save"
              />
            ) : (
              <p className="whitespace-pre-wrap text-sm">{annotation.body}</p>
            )}
            <p className="truncate text-muted-foreground text-xs">
              {annotation.selector}
            </p>
          </>
        }
      />
      {annotation.replies?.length ? (
        <CommentThreadReplies
          className="border-l border-l-border bg-transparent pl-5"
          showDivider={false}
        >
          {annotation.replies.map((reply) => (
            <CommentThreadReplyRow
              avatar={<ThreadAvatar person={reply.author} />}
              body={<p className="whitespace-pre-wrap text-sm">{reply.body}</p>}
              header={
                <CommentThreadHeader
                  author={
                    <span className="font-medium text-sm">
                      {reply.author.name}
                    </span>
                  }
                  metadata={
                    <span className="text-muted-foreground text-xs">
                      {reply.createdAt}
                    </span>
                  }
                />
              }
              key={reply.id}
            />
          ))}
        </CommentThreadReplies>
      ) : null}
      {replying ? (
        <div className="border-t bg-muted/20 p-3">
          <CommentComposer
            cancelLabel="Cancel"
            minHeightClassName="min-h-16"
            onCancel={() => setReplying(false)}
            onSubmit={(body) => {
              onReply(body);
              setReplying(false);
            }}
            placeholder="Reply…"
            submitLabel="Reply"
          />
        </div>
      ) : (
        <CommentThreadActionFooter
          icon={<ReplyIcon />}
          label="Reply"
          onClick={() => setReplying(true)}
        />
      )}
    </CommentThreadCard>
  );
}

function ThreadAvatar({ person }: { person: Person }) {
  return (
    <Avatar className="size-7 shrink-0">
      <AvatarFallback className={person.color}>
        {person.initials}
      </AvatarFallback>
    </Avatar>
  );
}
