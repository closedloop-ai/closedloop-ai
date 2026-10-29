"use client";

import { CommentAnchorKind } from "@repo/api/src/types/comment-anchor-kind";
import { toast } from "@repo/design-system/components/ui/sonner";
import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useEffect,
  useRef,
  useState,
} from "react";
import { CommentsPane } from "../../../comments/comments-pane";
import {
  type CommentsPaneDraft,
  type CommentsPaneDrafts,
  type CommentsPaneLayout,
  NO_ANCHOR_STATE_LABELS,
} from "../../../comments/comments-pane-model";
import type { GenericArtifact } from "../fixtures";
import {
  type GenericCommentRecord,
  PROTOTYPE_VIEWER,
  prototypeCapabilities,
  recordsToThreads,
} from "./artifact-comments-adapter";
import type { DetailTab } from "./generic-artifact-detail-shell";

export type { GenericCommentRecord } from "./artifact-comments-adapter";

export type ArtifactCommentsPresentation = {
  artifactPlaceholder?: string;
  artifactTitle?: string;
  sessionTitle?: string;
};

type CommentSetter = Dispatch<SetStateAction<GenericCommentRecord[]>>;

const REVEALABLE_KINDS = [
  CommentAnchorKind.Text,
  CommentAnchorKind.Prototype,
  CommentAnchorKind.Trace,
  CommentAnchorKind.Code,
] as const;

/**
 * The generic artifact prototype's rail: its fixture arrays adapted onto the
 * canonical {@link CommentsPane} (ISS-11209). Every write lands back in the
 * prototype's own state through the setters, never inside the pane.
 */
export function ArtifactCommentsRail({
  activeTab,
  artifact,
  availableWidth,
  config,
  draftRequest,
  drafts,
  generalComments,
  layout,
  onDraftChange,
  onOpenChange,
  onSelectArtifactComment,
  onSelectSessionComment,
  open,
  onWidthChange,
  returnFocusRef,
  selectionRequest,
  sessionComments,
  setGeneralComments,
  setSessionComments,
  showsSessionComments,
  width,
}: {
  activeTab: DetailTab;
  artifact: GenericArtifact;
  availableWidth: number;
  config?: ArtifactCommentsPresentation;
  draftRequest?: {
    anchorPreview: string;
    commentId: string;
    nonce: number;
  } | null;
  drafts: CommentsPaneDrafts;
  generalComments: GenericCommentRecord[];
  layout?: CommentsPaneLayout;
  onDraftChange: (key: string, draft: CommentsPaneDraft | null) => void;
  onOpenChange: (open: boolean) => void;
  onSelectArtifactComment?: (comment: GenericCommentRecord) => void;
  onSelectSessionComment: (commentId: string, row: number) => void;
  open: boolean;
  onWidthChange: (width: number) => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  selectionRequest?: { commentId: string; nonce: number } | null;
  sessionComments: GenericCommentRecord[];
  setGeneralComments: CommentSetter;
  setSessionComments: CommentSetter;
  /**
   * Whether this tab's comments are the per-session thread list. Defaults to
   * the `sessions` tab, which is that list for a type whose Sessions tab lists
   * OTHER sessions. A Session's own canvas is its `sessions` tab too
   * (ISS-12167), but the comments on its trace are the artifact's, so that
   * host passes `false`.
   */
  showsSessionComments?: boolean;
  width: number;
}) {
  const showingSessions = showsSessionComments ?? activeTab === "sessions";
  const records = showingSessions ? sessionComments : generalComments;
  const setRecords = showingSessions ? setSessionComments : setGeneralComments;
  const pendingAnchor = usePendingContentAnchor(
    draftRequest,
    open && !showingSessions
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  useEffect(() => {
    if (open && !showingSessions && selectionRequest) {
      setActiveId(selectionRequest.commentId);
    }
  }, [open, selectionRequest, showingSessions]);

  const jumpTo = (threadId: string) => {
    const record = records.find((candidate) => candidate.id === threadId);
    if (showingSessions && record?.traceRow != null) {
      onSelectSessionComment(record.id, record.traceRow);
    } else if (
      record?.anchor &&
      record.anchor.kind !== CommentAnchorKind.Artifact
    ) {
      onSelectArtifactComment?.(record);
    }
  };

  const append = (record: Omit<GenericCommentRecord, "time" | "author">) =>
    setRecords((current) => [
      ...current,
      { ...record, author: PROTOTYPE_VIEWER, time: "now" },
    ]);

  return (
    <CommentsPane
      anchorStateLabels={NO_ANCHOR_STATE_LABELS}
      availableWidth={availableWidth}
      capabilities={prototypeCapabilities(showingSessions)}
      composerPlaceholder={
        showingSessions ? undefined : config?.artifactPlaceholder
      }
      composerTarget={
        showingSessions
          ? null
          : {
              anchor: pendingAnchor
                ? {
                    documentVersion: 1,
                    kind: CommentAnchorKind.Text,
                    quote: {
                      exact: pendingAnchor.anchorPreview,
                      prefix: "",
                      suffix: "",
                    },
                  }
                : { kind: CommentAnchorKind.Artifact },
              label: pendingAnchor
                ? `“${pendingAnchor.anchorPreview}”`
                : undefined,
            }
      }
      drafts={drafts}
      formatTimestamp={(label) => label}
      identity={artifact.id}
      layout={layout}
      loadState={{ status: "ready" }}
      onCreateThread={({ anchor, body }) => {
        const quote =
          anchor.kind === CommentAnchorKind.Text ? anchor.quote.exact : null;
        append({
          anchor: { kind: anchor.kind },
          anchorPreview: quote ?? undefined,
          body,
          context: quote ? `“${quote}”` : "General comment",
          id: pendingAnchor?.commentId ?? `comment-${Date.now()}`,
          source: { provider: "native" },
          status: "open",
        });
        pendingAnchor?.clear();
      }}
      onDelete={({ commentId }) =>
        setRecords((current) =>
          current.filter(
            (record) => record.id !== commentId && record.parentId !== commentId
          )
        )
      }
      onDraftChange={onDraftChange}
      onEdit={(commentId, { body }) =>
        setRecords((current) =>
          current.map((record) =>
            record.id === commentId ? { ...record, body } : record
          )
        )
      }
      onOpenChange={onOpenChange}
      onReopen={(threadId) => {
        setStatus(setRecords, threadId, "open");
        toast.success("Comment reopened");
      }}
      onReply={(threadId, { body }) => {
        const parent = records.find((record) => record.id === threadId);
        append({
          anchor: parent?.anchor,
          anchorPreview: parent?.anchorPreview,
          body,
          context: `Reply to ${parent?.author ?? ""}`,
          id: `comment-reply-${Date.now()}`,
          parentId: threadId,
          source: { provider: "native" },
          status: "open",
          traceRow: parent?.traceRow,
        });
        setActiveId(threadId);
      }}
      onResolve={(threadId) => {
        setStatus(setRecords, threadId, "resolved");
        toast.success("Comment resolved");
      }}
      onRevealAnchor={(thread) => jumpTo(thread.id)}
      onSelectThread={(threadId) => {
        setActiveId(threadId);
        jumpTo(threadId);
      }}
      onWidthChange={onWidthChange}
      open={open}
      returnFocusRef={returnFocusRef}
      revealableAnchorKinds={REVEALABLE_KINDS}
      selectedThreadId={activeId}
      threads={recordsToThreads(records, artifact.id)}
      title={
        showingSessions
          ? (config?.sessionTitle ?? "Session comments")
          : (config?.artifactTitle ?? "Comments")
      }
      width={width}
    />
  );
}

function setStatus(
  setRecords: CommentSetter,
  threadId: string,
  status: "open" | "resolved"
) {
  setRecords((current) =>
    current.map((record) =>
      record.id === threadId ? { ...record, status } : record
    )
  );
}

/** A content quote the canvas asked to comment on, applied once per nonce. */
function usePendingContentAnchor(
  request:
    | { anchorPreview: string; commentId: string; nonce: number }
    | null
    | undefined,
  accepting: boolean
) {
  const [anchor, setAnchor] = useState<{
    anchorPreview: string;
    commentId: string;
  } | null>(null);
  const lastNonce = useRef<number | null>(null);
  useEffect(() => {
    if (!(accepting && request) || lastNonce.current === request.nonce) {
      return;
    }
    lastNonce.current = request.nonce;
    setAnchor({
      anchorPreview: request.anchorPreview,
      commentId: request.commentId,
    });
  }, [accepting, request]);
  return anchor ? { ...anchor, clear: () => setAnchor(null) } : null;
}
