"use client";

import { BranchArtifactPanel } from "@repo/app/branches/components/prototype-preview/components/branch-artifact-panel"; // Cross-slice: inbox threads open Branches preview artifacts (ISS-12938).
import { branchSlug } from "@repo/app/branches/components/prototype-preview/generic-adapter"; // Cross-slice: inbox threads open Branches preview artifacts (ISS-12938).
import { branchRows } from "@repo/app/branches/components/prototype-preview/mock"; // Cross-slice: inbox threads open Branches preview artifacts (ISS-12938).
import { buildBranchDetail } from "@repo/app/branches/components/prototype-preview/mock-detail"; // Cross-slice: inbox threads open Branches preview artifacts (ISS-12938).
import { ArtifactSessionsTrace } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-sessions-trace";
import { Button } from "@repo/design-system/components/ui/button";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { Link } from "@repo/navigation/link";
import {
  ArchiveIcon,
  ArrowLeftIcon,
  BookmarkIcon,
  ExternalLinkIcon,
  InboxIcon,
  RotateCcwIcon,
} from "lucide-react";
import {
  getSpecializedArtifactFixture,
  getSpecializedArtifactTrace,
  SpecializedArtifactTabContent,
} from "../../../shell/v2/components/web-master-preview/components/specialized-artifact-page"; // Cross-slice: mounted inside the Web Master preview shell (ISS-12938).
import { ArtifactTypeIcons } from "../../../shell/v2/components/web-master-preview/shared/artifact-icons"; // Cross-slice: mounted inside the Web Master preview shell (ISS-12938).
import { resolveThreadPreview } from "./inbox-v2-model";
import {
  ArtifactType,
  InboxView,
  type Thread,
  viewLabels,
} from "./inbox-v2-threads";

export const artifactIcons = {
  [ArtifactType.Issue]: ArtifactTypeIcons.Issue,
  [ArtifactType.Branch]: ArtifactTypeIcons.Branch,
  [ArtifactType.Document]: ArtifactTypeIcons.Document,
  [ArtifactType.Session]: ArtifactTypeIcons.Session,
  [ArtifactType.Prototype]: ArtifactTypeIcons.Prototype,
};

export function RowAction({
  children,
  label,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          onClick={onClick}
          size="icon-sm"
          variant="ghost"
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function AnchoredPreview({
  archived,
  bookmarked,
  onArchive,
  onBack,
  onBookmark,
  onSessionComment,
  thread,
  view,
}: {
  archived: boolean;
  bookmarked: boolean;
  onArchive: () => void;
  onBack: () => void;
  onBookmark: () => void;
  onSessionComment: (body: string) => void;
  thread: Thread;
  view: InboxView;
}) {
  const ArtifactIcon = artifactIcons[thread.artifactType];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <Button
          aria-label="Back to comment threads"
          className="lg:hidden"
          onClick={onBack}
          size="icon-sm"
          variant="ghost"
        >
          <ArrowLeftIcon />
        </Button>
        <ArtifactIcon className="size-4 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm">
          <strong>{thread.artifactId}</strong> · {thread.artifactTitle}
        </span>
        <RowAction
          label={bookmarked ? "Remove bookmark" : "Bookmark notification"}
          onClick={onBookmark}
        >
          <BookmarkIcon className={bookmarked ? "fill-current" : undefined} />
        </RowAction>
        <RowAction
          label={
            archived || view === InboxView.Archive
              ? "Restore notification"
              : "Archive notification"
          }
          onClick={onArchive}
        >
          {archived || view === InboxView.Archive ? (
            <RotateCcwIcon />
          ) : (
            <ArchiveIcon />
          )}
        </RowAction>
        <Button asChild size="sm" variant="outline">
          <Link href={thread.href}>
            Open full artifact <ExternalLinkIcon />
          </Link>
        </Button>
      </header>
      <p className="shrink-0 truncate border-b px-3 py-1.5 text-muted-foreground text-xs">
        Anchored to {thread.anchor} · {thread.anchorDetail}
      </p>
      <div className="min-h-0 flex-1 overflow-auto bg-muted/20 p-4 lg:p-6">
        <div className="mx-auto min-h-full max-w-6xl overflow-hidden rounded-lg border bg-background shadow-xs">
          <ArtifactPreview
            onSessionComment={onSessionComment}
            thread={thread}
          />
        </div>
      </div>
    </div>
  );
}

export function InboxEmpty({ view }: { view: InboxView }) {
  const isAttention = view === InboxView.Attention;
  return (
    <EmptyState
      description={
        isAttention
          ? "You have resolved every comment thread that needs your attention."
          : "No comment threads match this view and the current filters."
      }
      icon={InboxIcon}
      title={
        isAttention ? "Inbox zero" : `No ${viewLabels[view].toLowerCase()}`
      }
      titleAs="h2"
    />
  );
}

function ArtifactPreview({
  onSessionComment,
  thread,
}: {
  onSessionComment: (body: string) => void;
  thread: Thread;
}) {
  const target = resolveThreadPreview(thread);
  if (target.kind === "branch") {
    const row = branchRows.find(
      (candidate) => branchSlug(candidate) === target.branchId
    );
    return row ? <BranchArtifactPanel detail={buildBranchDetail(row)} /> : null;
  }
  if (target.kind === "session") {
    const artifact = getSpecializedArtifactFixture(
      "sessions",
      target.sessionId
    );
    return artifact ? (
      <ArtifactSessionsTrace
        artifact={artifact}
        commentAnchors={[]}
        onSubmitTraceComment={(comment) => onSessionComment(comment.body)}
        trace={getSpecializedArtifactTrace("sessions", artifact)}
        traceJumpRequest={{ nonce: 1, row: target.traceRow }}
      />
    ) : null;
  }
  const artifact = getSpecializedArtifactFixture(
    target.artifactKind,
    target.fixtureKey
  );
  return artifact ? (
    <SpecializedArtifactTabContent
      artifact={artifact}
      kind={target.artifactKind}
    />
  ) : null;
}
