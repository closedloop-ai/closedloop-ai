import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CommentThreadWithComments,
  DocumentThreadAnchorStatus as DocumentThreadAnchorStatusType,
} from "@repo/api/src/types/comment.js";
import {
  DocumentThreadAnchorStatus,
  resolveAnchorStatusKernel,
  ThreadSource,
  ThreadStatus,
} from "@repo/api/src/types/comment.js";
import {
  CommentAnchorState,
  commentAnchorKindSchema,
  commentAnchorStateSchema,
} from "@repo/api/src/types/comment-anchor.js";
import { CommentAnchorKind } from "@repo/api/src/types/comment-anchor-kind.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import {
  buildQuery,
  encodePathSegment,
  requiredIdOrSlug,
  withErrorHandling,
} from "./tool-utils.js";

/**
 * Register the get-document-comments tool on the given MCP server.
 * Calls GET /documents/:documentId/threads to retrieve comment threads for a document.
 */
export function registerGetDocumentComments(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "get-document-comments",
    {
      description:
        "Get comment threads and their comments for a document by UUID or slug (PRD-*, PLN-*, FEA-*). Pass the user's slug verbatim.",
      inputSchema: {
        documentId: requiredIdOrSlug(
          "Document",
          ["PRD-7", "PLN-12", "FEA-42"],
          "Use list-documents to find one."
        ),
        status: z
          .enum(ThreadStatus)
          .optional()
          .describe("Filter threads by status. Omit to return all threads."),
      },
    },
    ({ documentId, status }) =>
      withErrorHandling(async () => {
        const query = buildQuery({ status });

        const threads = await apiClient.get<CommentThreadWithComments[]>(
          `/documents/${encodePathSegment(documentId)}/threads`,
          query
        );

        // PLN-2187 Q-003: NATIVE document threads are real comments and are
        // listed alongside synced ones.
        const mappedThreads = threads.map((thread) => ({
          id: thread.id,
          status: thread.status,
          // `source` identifies the backing system. `anchorStatus` identifies
          // whether a document comment is anchored to text or artifact-level.
          source: thread.source,
          anchorStatus: deriveDocumentCommentAnchorStatus(thread),
          artifactId: thread.artifactId,
          createdAt: thread.createdAt,
          comments: thread.comments.map((c) => ({
            id: c.id,
            plainText: c.plainText,
            createdAt: c.createdAt,
            author: c.authorId,
          })),
        }));

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(mappedThreads, null, 2),
            },
          ],
        };
      })
  );
}

function deriveDocumentCommentAnchorStatus(
  thread: CommentThreadWithComments
): DocumentThreadAnchorStatusType | null {
  return deriveTypedAnchorStatus(thread) ?? deriveMetadataAnchorStatus(thread);
}

function deriveMetadataAnchorStatus(
  thread: CommentThreadWithComments
): DocumentThreadAnchorStatusType | null {
  // Non-Liveblocks threads carry no legacy `anchorPreview` signal, so restrict
  // the `anchorPreview`-based inference to Liveblocks sources by withholding
  // `anchorPreview` from the shared kernel. An explicit, validated
  // `metadata.anchorStatus` still wins for any source. The MCP surface keeps
  // the kernel's neutral (`null`) result as-is (unlike the web feed, which
  // maps neutral to `artifact-level`).
  return resolveAnchorStatusKernel({
    anchorStatus: thread.metadata?.anchorStatus,
    anchorPreview:
      thread.source === ThreadSource.Liveblocks
        ? thread.metadata?.anchorPreview
        : undefined,
  });
}

/**
 * PLN-2187 T-7.3: the status a typed anchor states, or `null` when the thread
 * carries none this build understands (an older API, an unknown kind, or a
 * text anchor's unknown state), which sends the caller to the metadata path.
 * The kind is read apart from the state: an artifact anchor is artifact-level
 * whatever state a newer API pairs it with.
 */
function deriveTypedAnchorStatus(
  thread: CommentThreadWithComments
): DocumentThreadAnchorStatusType | null {
  const anchor = typedAnchorKindSchema.safeParse(thread.anchor);
  if (!anchor.success) {
    return null;
  }
  if (anchor.data?.kind === CommentAnchorKind.Artifact) {
    return DocumentThreadAnchorStatus.ArtifactLevel;
  }
  if (anchor.data?.kind !== CommentAnchorKind.Text) {
    return null;
  }
  const anchorState = commentAnchorStateSchema.safeParse(thread.anchorState);
  if (!anchorState.success) {
    return null;
  }
  switch (anchorState.data) {
    case CommentAnchorState.Anchored:
    case CommentAnchorState.Moved:
      return DocumentThreadAnchorStatus.Anchored;
    case CommentAnchorState.Orphaned:
      return DocumentThreadAnchorStatus.Floating;
    default:
      return null;
  }
}

const typedAnchorKindSchema = z
  .object({ kind: commentAnchorKindSchema })
  .nullish();
