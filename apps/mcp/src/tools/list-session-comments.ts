import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CommentSurface,
  CommentTargetType,
  ThreadStatus,
  TRACE_COMMENT_ID_MAX_LENGTH,
  traceCommentTargetIdSchema,
} from "@repo/api/src/types/comment.js";
import { CommentAnchorKind } from "@repo/api/src/types/comment-anchor-kind.js";
import {
  type CommentThreadDto,
  commentApiPaths,
} from "@repo/api/src/types/comment-thread-dto.js";
import { SlugPrefix } from "@repo/api/src/types/slug-prefix.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import {
  asRecord,
  buildPaginatedPayload,
  buildQuery,
  MAX_PAGE_LIMIT,
  readNumber,
  readString,
  withErrorHandling,
} from "./tool-utils.js";

export const sessionCommentInputSchema = {
  sessionId: traceCommentTargetIdSchema
    .optional()
    .describe(
      "Agent-session identity the API resolves: either the artifact id UUID from list-agent-sessions, or the desktop-local external session id it reports for a session that has no cloud artifact. Artifact display slugs (SES-123) are not accepted."
    ),
  sessionUrl: z
    .string()
    .url()
    .optional()
    .describe(
      "Canonical Closedloop session URL containing /sessions/{uuid}. Provide either sessionId or sessionUrl, not both."
    ),
  computeTargetId: z
    .string()
    .uuid()
    .optional()
    .describe(
      "Optional compute target UUID that scopes an external sessionId to one device you own. Omit it unless you actually have that UUID: supplying a wrong one makes the route stop at that device instead of falling back to a search across your own sessions, turning a resolvable id into a 404."
    ),
  status: z
    .enum([ThreadStatus.Open, ThreadStatus.Resolved])
    .optional()
    .describe('Optional thread-state filter: "OPEN" or "RESOLVED".'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_LIMIT)
    .optional()
    .describe(`Maximum comments to return (1-${MAX_PAGE_LIMIT}).`),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Starting offset for pagination (default 0)."),
} as const;

type ListSessionCommentsInput = {
  sessionId?: string;
  sessionUrl?: string;
  computeTargetId?: string;
  status?: ThreadStatus;
  limit?: number;
  offset?: number;
};

const sessionUrlIdSchema = z.string().uuid();

export function registerListSessionComments(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "list-session-comments",
    {
      description:
        "List read-only trace comments for one agent session. Accepts exactly one sessionId (a cloud artifact id UUID or a desktop-local external session id) or canonical /sessions/{uuid} URL, reads every page of the session's comments with optional OPEN/RESOLVED filtering, then applies offset pagination.",
      inputSchema: sessionCommentInputSchema,
    },
    (input) =>
      withErrorHandling(async () => {
        const sessionId = resolveSessionCommentSessionId(input);
        const threads = await readSessionCommentThreads(
          apiClient,
          sessionId,
          input
        );
        const payload = buildPaginatedPayload(threads, {
          limit: input.limit,
          offset: input.offset,
          mapItem: (thread: CommentThreadDto) =>
            shapeSessionComment(thread, sessionId),
        });
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(payload, null, 2) },
          ],
        };
      })
  );
}

export function resolveSessionCommentSessionId(
  input: ListSessionCommentsInput
): string {
  const hasSessionId = input.sessionId !== undefined;
  const hasSessionUrl = input.sessionUrl !== undefined;
  if (hasSessionId === hasSessionUrl) {
    throw new Error("Provide exactly one of sessionId or sessionUrl.");
  }
  if (input.sessionId !== undefined) {
    return checkedSessionId(input.sessionId);
  }
  return extractSessionIdFromUrl(input.sessionUrl ?? "");
}

/** One page of the unified read, as the legacy session route scoped it: session-detail threads. */
export function buildSessionCommentsQuery(
  input: ListSessionCommentsInput,
  cursor?: string
): Record<string, string> {
  return buildQuery({
    computeTargetId: input.computeTargetId,
    status: input.status,
    surface: CommentSurface.SessionDetail,
    limit: String(MAX_PAGE_LIMIT),
    cursor,
  });
}

/**
 * Every thread on the session, following `nextCursor` to the end so `total`
 * counts all of them. Threads without a trace anchor are left out, as the
 * legacy route left out a thread whose anchor it could not read.
 */
async function readSessionCommentThreads(
  apiClient: ApiClient,
  sessionId: string,
  input: ListSessionCommentsInput
): Promise<CommentThreadDto[]> {
  const path = commentApiPaths.artifactComments(sessionId);
  const threads: CommentThreadDto[] = [];
  let cursor: string | undefined;
  let pages = 0;
  // lc-debt: total walks every page; add a count to the unified read if a session's thread count makes MCP slow.
  do {
    pages += 1;
    if (pages > MAX_SESSION_COMMENT_PAGES) {
      throw new Error(
        `The session's comments did not end within ${MAX_SESSION_COMMENT_PAGES} pages.`
      );
    }
    const page = readThreadsPage(
      await apiClient.get<unknown>(
        path,
        buildSessionCommentsQuery(input, cursor)
      )
    );
    threads.push(
      ...page.threads.filter(
        (thread) => thread.anchor?.kind === CommentAnchorKind.Trace
      )
    );
    const nextCursor = page.nextCursor ?? undefined;
    if (nextCursor !== undefined && nextCursor === cursor) {
      throw new Error("The comments API returned the same page cursor twice.");
    }
    cursor = nextCursor;
  } while (cursor);
  return threads;
}

/** 10,000 threads at the largest page; past it the cursor is not advancing. */
const MAX_SESSION_COMMENT_PAGES = 100;

function readThreadsPage(payload: unknown): {
  threads: CommentThreadDto[];
  nextCursor: string | null;
} {
  const page = asRecord(payload);
  if (!Array.isArray(page.threads)) {
    throw new Error(
      "Expected a { threads: [] } page from the artifact comments API."
    );
  }
  return {
    threads: page.threads as CommentThreadDto[],
    nextCursor: readString(page.nextCursor),
  };
}

/** A thread in the item shape the tool has always returned: its root comment, with replies under it. */
export function shapeSessionComment(
  value: CommentThreadDto,
  sessionId: string
) {
  const thread = asRecord(value);
  const comments: unknown[] = Array.isArray(thread.comments)
    ? thread.comments
    : [];
  const root = asRecord(comments[0]);
  const author = asRecord(root.author);
  const resolvedBy = asRecord(thread.resolvedBy);
  return {
    id: readString(root.id),
    threadId: readString(thread.id),
    body: readString(root.body),
    status: readString(thread.status),
    resolvedAt: readString(thread.resolvedAt),
    resolvedById: readString(resolvedBy.id),
    resolvedByName: readString(resolvedBy.name),
    resolvedByAvatarUrl: readString(resolvedBy.avatarUrl),
    target: { type: CommentTargetType.Session, id: sessionId },
    artifactId: readString(thread.artifactId),
    anchor: shapeAnchor(thread.anchor),
    createdAt: readString(root.createdAt),
    updatedAt: readString(root.updatedAt),
    editedAt: readString(root.editedAt),
    authorId: readString(author.id),
    authorName: readString(author.name),
    authorAvatarUrl: readString(author.avatarUrl),
    replies: comments.slice(1).map((reply) => shapeSessionCommentReply(reply)),
  };
}

function extractSessionIdFromUrl(sessionUrl: string): string {
  let url: URL;
  try {
    url = new URL(sessionUrl);
  } catch {
    throw new Error("sessionUrl must be a valid URL.");
  }
  const segments = url.pathname.split("/").filter(Boolean);
  const sessionSegmentIndexes = segments
    .map((segment, index) => (segment === "sessions" ? index : -1))
    .filter((index) => index >= 0);
  if (sessionSegmentIndexes.length !== 1) {
    throw new Error(
      "sessionUrl must contain exactly one /sessions/{uuid} path."
    );
  }
  const sessionIndex = sessionSegmentIndexes[0];
  const candidate = segments[sessionIndex + 1];
  if (!candidate || sessionIndex + 2 !== segments.length) {
    throw new Error("sessionUrl must end with /sessions/{uuid}.");
  }
  const parsed = sessionUrlIdSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error("sessionUrl session id must be a UUID.");
  }
  return parsed.data;
}

function shapeAnchor(value: unknown) {
  const anchor = asRecord(value);
  const actor = asRecord(anchor.actor);
  return {
    anchorType: "text" as const,
    traceId: readString(anchor.traceId),
    turnId: readString(anchor.turnId),
    row: readNumber(anchor.row),
    selectedText: readString(anchor.selectedText),
    sourceText: readString(anchor.sourceText),
    startOffset: readNumber(anchor.startOffset),
    endOffset: readNumber(anchor.endOffset),
    sessionId: readString(anchor.sessionId),
    actor: anchor.actor
      ? {
          name: readString(actor.name),
          human: readString(actor.human),
        }
      : null,
  };
}

function shapeSessionCommentReply(value: unknown) {
  const reply = asRecord(value);
  const author = asRecord(reply.author);
  return {
    id: readString(reply.id),
    threadId: readString(reply.threadId),
    body: readString(reply.body),
    createdAt: readString(reply.createdAt),
    updatedAt: readString(reply.updatedAt),
    editedAt: readString(reply.editedAt),
    authorId: readString(author.id),
    authorName: readString(author.name),
    authorAvatarUrl: readString(author.avatarUrl),
  };
}

/**
 * The tool's one narrowing over the shared target-id contract: an artifact
 * DISPLAY SLUG (`SES-123`, `ISS-42`, any letter case) is neither an artifact id
 * nor an external session id, so none of the route's three lookups can resolve
 * one. Reject it here with a message naming what to pass instead of letting it
 * become an opaque 404. Built from the canonical prefix set so a new or renamed
 * prefix is covered without editing this file, and case-insensitive because
 * slugs are written lowercase in branch-derived contexts.
 */
const ARTIFACT_SLUG_PATTERN = new RegExp(
  String.raw`^(${Object.values(SlugPrefix).join("|")})-\d+$`,
  "i"
);

function checkedSessionId(sessionId: string): string {
  const parsed = traceCommentTargetIdSchema.safeParse(sessionId);
  if (!parsed.success) {
    throw new Error(
      `sessionId must be 1-${TRACE_COMMENT_ID_MAX_LENGTH} characters: an agent-session artifact id, or a desktop-local external session id.`
    );
  }
  if (parsed.data !== parsed.data.trim()) {
    throw new Error("sessionId must not have leading or trailing whitespace.");
  }
  if (ARTIFACT_SLUG_PATTERN.test(parsed.data)) {
    throw new Error(
      "sessionId must be an agent-session artifact id or a desktop-local external session id; artifact slugs such as SES-123 are not accepted."
    );
  }
  return parsed.data;
}
