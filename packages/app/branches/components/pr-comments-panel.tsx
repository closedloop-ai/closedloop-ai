"use client";

import {
  BranchCommentsFailureReason,
  BranchCommentsState,
  type BranchPrComment,
  type BranchPrCommentsResponse,
} from "@repo/api/src/types/branch";
import { AlertCircleIcon, MessageSquareIcon } from "lucide-react";
import type { ReactNode } from "react";

export function PrCommentsPanel({
  comments,
  isLoading,
  isError,
}: {
  comments?: BranchPrCommentsResponse;
  isLoading: boolean;
  isError: boolean;
}) {
  if (isLoading && !comments) {
    return (
      <section className="mt-4 rounded-md border border-[var(--border)] p-4">
        <PanelHeading />
        <p className="mt-3 text-[var(--muted-foreground)] text-sm">
          Loading pull request comments...
        </p>
      </section>
    );
  }

  if (isError && !comments) {
    return (
      <section className="mt-4 rounded-md border border-[var(--border)] p-4">
        <PanelHeading />
        <ReadOnlyNotice
          icon={<AlertCircleIcon aria-hidden className="size-4" />}
          title="PR comments unavailable"
          value="Comments could not be loaded. Refresh to retry."
        />
      </section>
    );
  }

  const _state = comments?.state ?? BranchCommentsState.UnsyncedUnknown;
  return (
    <section className="mt-4 rounded-md border border-[var(--border)] p-4">
      <PanelHeading />
      <ReadOnlyNotice
        icon={<MessageSquareIcon aria-hidden className="size-4" />}
        title={stateTitle(comments)}
        value={stateDescription(comments)}
      />
      {comments?.budget.providerTruncated ||
      comments?.budget.responseTruncated ? (
        <p className="mt-2 text-[var(--muted-foreground)] text-xs">
          Showing a bounded subset of comments.{" "}
          {comments.budget.omittedComments} omitted.
        </p>
      ) : null}
      {comments?.comments.length ? (
        <div className="mt-3 flex flex-col gap-3">
          {comments.comments.map((comment) => (
            <CommentCard comment={comment} key={comment.id} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function PanelHeading() {
  return (
    <div className="flex items-center justify-between gap-3">
      <div>
        <h2 className="font-medium text-sm">Pull request comments</h2>
        <p className="mt-0.5 text-[var(--muted-foreground)] text-xs">
          Read-only GitHub conversation and review comments.
        </p>
      </div>
    </div>
  );
}

function ReadOnlyNotice({
  icon,
  title,
  value,
}: {
  icon: ReactNode;
  title: string;
  value: string;
}) {
  return (
    <div className="mt-3 flex gap-2 rounded-md border border-[var(--border)] bg-[var(--muted)]/25 p-3">
      <div className="mt-0.5 text-[var(--muted-foreground)]">{icon}</div>
      <div>
        <p className="font-medium text-sm">{title}</p>
        <p className="mt-0.5 text-[var(--muted-foreground)] text-xs">{value}</p>
      </div>
    </div>
  );
}

function CommentCard({ comment }: { comment: BranchPrComment }) {
  return (
    <article className="rounded-md border border-[var(--border)] bg-[var(--background)] p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium">{comment.author.login}</span>
        <span className="text-[var(--muted-foreground)]">
          {formatTimestamp(comment.createdAt)}
        </span>
        {comment.path ? (
          <span className="rounded border border-[var(--border)] px-1.5 py-0.5 font-mono text-[var(--muted-foreground)]">
            {comment.path}
            {comment.line ? `:${comment.line}` : ""}
          </span>
        ) : null}
        {comment.stale ? (
          <span className="rounded border border-amber-300 px-1.5 py-0.5 text-amber-700">
            stale
          </span>
        ) : null}
      </div>
      <p className="mt-2 whitespace-pre-wrap text-sm">{comment.body}</p>
      {comment.bodyTruncated ? (
        <p className="mt-2 text-[var(--muted-foreground)] text-xs">
          Comment body truncated to the display budget.
        </p>
      ) : null}
    </article>
  );
}

function stateTitle(comments: BranchPrCommentsResponse | undefined): string {
  if (!comments) {
    return "Comments not synced";
  }
  if (comments.state === BranchCommentsState.Populated) {
    return `${comments.comments.length} comment${
      comments.comments.length === 1 ? "" : "s"
    }`;
  }
  if (comments.state === BranchCommentsState.SyncedEmpty) {
    return "No PR comments";
  }
  if (comments.state === BranchCommentsState.ProviderError) {
    return "Comment provider unavailable";
  }
  if (comments.state === BranchCommentsState.StaleMixed) {
    return "Comments may be stale";
  }
  if (comments.state === BranchCommentsState.OverLimitTruncated) {
    return "Comment display is truncated";
  }
  if (comments.state === BranchCommentsState.ForbiddenMismatch) {
    return "Branch and PR do not match";
  }
  return "Comments not synced";
}

function stateDescription(
  comments: BranchPrCommentsResponse | undefined
): string {
  if (!comments) {
    return "No synced comment projection or current provider proof is available yet.";
  }
  if (comments.state === BranchCommentsState.SyncedEmpty) {
    return "GitHub was checked for this request and returned no comments.";
  }
  if (comments.state === BranchCommentsState.ProviderError) {
    return providerErrorDescription(comments.failureReason);
  }
  if (comments.state === BranchCommentsState.StaleMixed) {
    return "Existing projection rows include legacy freshness evidence, so they are shown conservatively.";
  }
  if (comments.state === BranchCommentsState.OverLimitTruncated) {
    return "The response exceeded the display budget and was reduced before rendering.";
  }
  if (comments.state === BranchCommentsState.ForbiddenMismatch) {
    return "The requested pull request identity does not belong to this branch.";
  }
  if (comments.comments.length > 0) {
    return "Comments are read-only on Branches. Use GitHub for comment actions.";
  }
  return "No synced comment projection or current provider proof is available yet.";
}

function providerErrorDescription(
  reason: BranchCommentsFailureReason | undefined
): string {
  if (reason === BranchCommentsFailureReason.RateLimit) {
    return "GitHub rate-limited the comments read. Refresh later to retry.";
  }
  if (reason === BranchCommentsFailureReason.Auth) {
    return "GitHub authentication is required before comments can be loaded.";
  }
  if (reason === BranchCommentsFailureReason.Timeout) {
    return "GitHub did not respond before the comments read timed out.";
  }
  return "GitHub comments could not be loaded. Existing comments remain read-only.";
}

function formatTimestamp(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      });
}
