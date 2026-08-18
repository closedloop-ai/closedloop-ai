import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ThreadStatus,
  type TraceComment,
  type TraceCommentReply,
} from "@repo/api/src/types/comment.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import {
  asRecord,
  buildPaginatedPayload,
  buildQuery,
  encodePathSegment,
  extractArrayItems,
  MAX_PAGE_LIMIT,
  readNumber,
  readString,
  withErrorHandling,
} from "./tool-utils.js";

export const sessionCommentInputSchema = {
  sessionId: z
    .string()
    .uuid()
    .optional()
    .describe(
      "Agent-session artifact id UUID from list-agent-sessions. SES-* slugs are not accepted."
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
      "Optional compute target UUID for resolving a desktop-local external session id through the existing API route."
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
        "List read-only trace comments for one agent session. Accepts exactly one UUID sessionId or canonical /sessions/{uuid} URL, reuses the existing authorized session trace-comment API, then applies optional OPEN/RESOLVED filtering and offset pagination over the fresh response.",
      inputSchema: sessionCommentInputSchema,
    },
    (input) =>
      withErrorHandling(async () => {
        const sessionId = resolveSessionCommentSessionId(input);
        const response = await apiClient.get<TraceComment[]>(
          `/agent-sessions/${encodePathSegment(sessionId)}/trace-comments`,
          buildSessionCommentsQuery(input)
        );
        const items = extractArrayItems<TraceComment>(response).filter(
          (item) => input.status === undefined || item.status === input.status
        );
        const payload = buildPaginatedPayload(items, {
          limit: input.limit,
          offset: input.offset,
          mapItem: shapeSessionComment,
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
    const parsed = sessionUrlIdSchema.safeParse(input.sessionId);
    if (!parsed.success) {
      throw new Error(
        "sessionId must be a UUID; SES-* slugs are not accepted."
      );
    }
    return parsed.data;
  }
  return extractSessionIdFromUrl(input.sessionUrl ?? "");
}

export function buildSessionCommentsQuery(
  input: ListSessionCommentsInput
): Record<string, string> {
  return buildQuery({ computeTargetId: input.computeTargetId });
}

export function shapeSessionComment(value: TraceComment) {
  const row = asRecord(value);
  return {
    id: readString(row.id),
    threadId: readString(row.threadId),
    body: readString(row.body),
    status: readString(row.status),
    resolvedAt: readString(row.resolvedAt),
    resolvedById: readString(row.resolvedById),
    resolvedByName: readString(row.resolvedByName),
    resolvedByAvatarUrl: readString(row.resolvedByAvatarUrl),
    target: shapeTarget(row.target),
    artifactId: readString(row.artifactId),
    anchor: shapeAnchor(row.anchor),
    createdAt: readString(row.createdAt),
    updatedAt: readString(row.updatedAt),
    editedAt: readString(row.editedAt),
    authorId: readString(row.authorId),
    authorName: readString(row.authorName),
    authorAvatarUrl: readString(row.authorAvatarUrl),
    replies: Array.isArray(row.replies)
      ? row.replies.map((reply) => shapeSessionCommentReply(reply))
      : [],
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

function shapeTarget(value: unknown) {
  const target = asRecord(value);
  return {
    type: readString(target.type),
    id: readString(target.id),
  };
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

function shapeSessionCommentReply(value: TraceCommentReply) {
  const reply = asRecord(value);
  return {
    id: readString(reply.id),
    threadId: readString(reply.threadId),
    body: readString(reply.body),
    createdAt: readString(reply.createdAt),
    updatedAt: readString(reply.updatedAt),
    editedAt: readString(reply.editedAt),
    authorId: readString(reply.authorId),
    authorName: readString(reply.authorName),
    authorAvatarUrl: readString(reply.authorAvatarUrl),
  };
}
