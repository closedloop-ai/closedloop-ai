import {
  ThreadSource,
  ThreadStatus,
  TraceCommentKind,
} from "@repo/api/src/types/comment";
import {
  CodeCommentSide,
  type CommentAnchor,
  CommentAnchorState,
} from "@repo/api/src/types/comment-anchor";
import { CommentAnchorKind } from "@repo/api/src/types/comment-anchor-kind";
import type {
  CollectionCapabilities,
  ItemPermissions,
} from "@repo/api/src/types/comment-capabilities";
import type {
  CommentDto,
  CommentThreadDto,
} from "@repo/api/src/types/comment-thread-dto";
import { CommentBodyFormat } from "@repo/api/src/types/comment-thread-dto";
import {
  type ArtifactCommentSource,
  type ArtifactCommentStatus,
  type CapturedArtifactCommentAnchor,
  commentAnchorKind,
} from "../../../comments/comment-contract";

/**
 * Fixture adapter: the prototype keeps its `GenericCommentRecord` arrays and
 * hands the canonical pane the unified thread shape it would get from the
 * comments service. Nothing here is a production mapping.
 */
export type GenericCommentRecord = {
  anchorPreview?: string;
  id: string;
  author: string;
  body: string;
  time: string;
  context: string;
  traceRow?: number;
  anchor?: CapturedArtifactCommentAnchor;
  status?: ArtifactCommentStatus;
  source?: ArtifactCommentSource;
  version?: string;
  /** Replies remain in the same canonical thread regardless of anchor type. */
  parentId?: string;
};

/** The prototype's signed-in reviewer, who owns the comments they write. */
export const PROTOTYPE_VIEWER = "Ottilie Eastwick";

const ALL_ANCHOR_KINDS = [
  CommentAnchorKind.Artifact,
  CommentAnchorKind.Text,
  CommentAnchorKind.Prototype,
  CommentAnchorKind.Trace,
  CommentAnchorKind.Code,
] as const;

export function prototypeCapabilities(
  showingSessions: boolean
): CollectionCapabilities {
  return {
    anchorKinds: showingSessions ? [CommentAnchorKind.Trace] : ALL_ANCHOR_KINDS,
    attach: false,
    commentKinds: [TraceCommentKind.Comment],
    createThread: true,
    delete: true,
    edit: true,
    linkOut: true,
    mention: false,
    react: false,
    reopen: true,
    reply: true,
    resolve: true,
    retrySync: false,
  };
}

export function recordsToThreads(
  records: readonly GenericCommentRecord[],
  artifactId: string
): CommentThreadDto[] {
  return records
    .filter((record) => !record.parentId)
    .map((root) => {
      const readOnly =
        root.source?.readOnly === true || root.source?.provider === "github";
      const replies = records.filter((record) => record.parentId === root.id);
      return {
        anchor: fullAnchor(root),
        anchorState: CommentAnchorState.Anchored,
        artifactId,
        comments: [root, ...replies].map((record) =>
          recordToComment(record, root.id, !readOnly)
        ),
        createdAt: root.time,
        id: root.id,
        kind: TraceCommentKind.Comment,
        permissions: permissions(!readOnly),
        provider: { linkOut: root.source?.externalSync?.href },
        resolvedAt: null,
        resolvedBy: null,
        revision: 1,
        source: threadSource(root.source?.provider),
        status:
          root.status === "resolved"
            ? ThreadStatus.Resolved
            : ThreadStatus.Open,
        sync: null,
      };
    });
}

function recordToComment(
  record: GenericCommentRecord,
  threadId: string,
  writable: boolean
): CommentDto {
  const own = writable && record.author === PROTOTYPE_VIEWER;
  return {
    author: { avatarUrl: null, id: record.author, name: record.author },
    body: record.body,
    bodyFormat: CommentBodyFormat.Markdown,
    // The fixtures carry display labels, not instants; the rail prints them as-is.
    createdAt: record.time,
    editedAt: null,
    id: record.id,
    mentions: [],
    permissions: {
      ...permissions(false),
      canDelete: own,
      canEdit: own,
    },
    revision: 1,
    threadId,
    updatedAt: record.time,
  };
}

function permissions(granted: boolean): ItemPermissions {
  return {
    canDelete: granted,
    canEdit: granted,
    canReopen: granted,
    canResolve: granted,
    canRetrySync: false,
  };
}

function threadSource(
  provider: ArtifactCommentSource["provider"] | undefined
): ThreadSource {
  if (provider === "github") {
    return ThreadSource.Github;
  }
  return provider === "liveblocks"
    ? ThreadSource.Liveblocks
    : ThreadSource.Native;
}

/** Fills the captured partial anchor into the shared union for display. */
function fullAnchor(record: GenericCommentRecord): CommentAnchor {
  const preview = record.anchorPreview ?? "";
  switch (commentAnchorKind(record.anchor, record.traceRow)) {
    case CommentAnchorKind.Trace:
      return {
        endOffset: preview.length,
        kind: CommentAnchorKind.Trace,
        row: record.traceRow ?? 0,
        selectedText: preview,
        sourceText: preview,
        startOffset: 0,
        traceId: record.id,
        turnId: record.id,
      };
    case CommentAnchorKind.Text:
      return {
        documentVersion: 1,
        kind: CommentAnchorKind.Text,
        quote: { exact: preview, prefix: "", suffix: "" },
      };
    case CommentAnchorKind.Prototype:
      return {
        anchorId: record.id,
        kind: CommentAnchorKind.Prototype,
        prototypeVersionId: record.version ?? record.id,
        route: "/",
        textContext: preview || undefined,
      };
    case CommentAnchorKind.Code:
      return {
        commitSha: "0".repeat(40),
        endLine: null,
        kind: CommentAnchorKind.Code,
        path: preview,
        repository: record.id,
        side: CodeCommentSide.Right,
      };
    default:
      return { kind: CommentAnchorKind.Artifact };
  }
}
