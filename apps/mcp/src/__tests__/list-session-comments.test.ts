import {
  ThreadStatus,
  TraceCommentTargetType,
} from "@repo/api/src/types/comment";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  buildSessionCommentsQuery,
  registerListSessionComments,
  resolveSessionCommentSessionId,
  sessionCommentInputSchema,
} from "../tools/list-session-comments.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_SESSION_ID = "22222222-2222-4222-8222-222222222222";

const registerTool = vi.fn();
const apiClient = {
  get: vi.fn(),
};

describe("list-session-comments MCP tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerListSessionComments({ registerTool } as never, apiClient as never);
  });

  it("accepts a UUID sessionId and forwards computeTargetId only when supplied", async () => {
    apiClient.get.mockResolvedValue([]);

    const response = await registeredHandler()?.({
      sessionId: SESSION_ID,
      computeTargetId: OTHER_SESSION_ID,
    });
    const payload = JSON.parse(response?.content?.[0]?.text ?? "{}");

    expect(apiClient.get).toHaveBeenCalledWith(
      `/agent-sessions/${SESSION_ID}/trace-comments`,
      { computeTargetId: OTHER_SESSION_ID }
    );
    expect(payload).toMatchObject({ items: [], total: 0, returned: 0 });
    expect(buildSessionCommentsQuery({ sessionId: SESSION_ID })).toEqual({});
  });

  it("extracts the UUID from a canonical session URL", async () => {
    apiClient.get.mockResolvedValue([]);

    await registeredHandler()?.({
      sessionUrl: `https://app.closedloop.ai/closedloop-ai/sessions/${SESSION_ID}`,
    });

    expect(apiClient.get).toHaveBeenCalledWith(
      `/agent-sessions/${SESSION_ID}/trace-comments`,
      {}
    );
  });

  it("rejects invalid identity input before calling the API", () => {
    expect(() =>
      resolveSessionCommentSessionId({ sessionId: "SES-123" })
    ).toThrow("sessionId must be a UUID");
    expect(() => resolveSessionCommentSessionId({})).toThrow(
      "Provide exactly one"
    );
    expect(() =>
      resolveSessionCommentSessionId({
        sessionId: SESSION_ID,
        sessionUrl: `https://app.closedloop.ai/closedloop-ai/sessions/${SESSION_ID}`,
      })
    ).toThrow("Provide exactly one");
    expect(() =>
      resolveSessionCommentSessionId({
        sessionUrl: `https://app.closedloop.ai/closedloop-ai/agent-sessions/${SESSION_ID}`,
      })
    ).toThrow("exactly one /sessions/{uuid}");
    expect(apiClient.get).not.toHaveBeenCalled();
  });

  it("rejects invalid status and pagination at the registered input schema", () => {
    const inputSchema = z.object(sessionCommentInputSchema);

    expect(
      inputSchema.safeParse({ sessionId: SESSION_ID, status: "RESOLVE" })
        .success
    ).toBe(false);
    expect(
      inputSchema.safeParse({ sessionId: SESSION_ID, limit: 0 }).success
    ).toBe(false);
    expect(
      inputSchema.safeParse({ sessionId: SESSION_ID, offset: -1 }).success
    ).toBe(false);
  });

  it("maps root comments, replies, resolver metadata, target, and MCP-only text anchors", async () => {
    apiClient.get.mockResolvedValue([
      sampleComment({
        id: "comment-1",
        status: ThreadStatus.Resolved,
        resolvedAt: "2026-07-20T10:00:00.000Z",
        resolvedById: "resolver-1",
        resolvedByName: "Resolve User",
        resolvedByAvatarUrl: "https://example.com/resolver.png",
      }),
    ]);

    const response = await registeredHandler()?.({ sessionId: SESSION_ID });
    const payload = JSON.parse(response?.content?.[0]?.text ?? "{}");

    expect(payload.items).toEqual([
      {
        id: "comment-1",
        threadId: "thread-comment-1",
        body: "Root note",
        status: ThreadStatus.Resolved,
        resolvedAt: "2026-07-20T10:00:00.000Z",
        resolvedById: "resolver-1",
        resolvedByName: "Resolve User",
        resolvedByAvatarUrl: "https://example.com/resolver.png",
        target: { type: TraceCommentTargetType.Session, id: SESSION_ID },
        artifactId: SESSION_ID,
        anchor: {
          anchorType: "text",
          traceId: "trace-1",
          turnId: "turn-1",
          row: 3,
          selectedText: "selected",
          sourceText: "source selected text",
          startOffset: 7,
          endOffset: 15,
          sessionId: SESSION_ID,
          actor: { name: "codex", human: null },
        },
        createdAt: "2026-07-20T09:00:00.000Z",
        updatedAt: "2026-07-20T09:01:00.000Z",
        editedAt: null,
        authorId: "author-1",
        authorName: "Author User",
        authorAvatarUrl: null,
        replies: [
          {
            id: "reply-1",
            threadId: "thread-comment-1",
            body: "Reply note",
            createdAt: "2026-07-20T09:02:00.000Z",
            updatedAt: "2026-07-20T09:03:00.000Z",
            editedAt: null,
            authorId: "author-2",
            authorName: "Reply User",
            authorAvatarUrl: "https://example.com/reply.png",
          },
        ],
      },
    ]);
  });

  it("filters by status before paginating and preserves null resolver fields", async () => {
    apiClient.get.mockResolvedValue([
      sampleComment({ id: "open-1", status: ThreadStatus.Open }),
      sampleComment({ id: "resolved-1", status: ThreadStatus.Resolved }),
      sampleComment({ id: "resolved-2", status: ThreadStatus.Resolved }),
    ]);

    const response = await registeredHandler()?.({
      sessionId: SESSION_ID,
      status: ThreadStatus.Resolved,
      limit: 1,
      offset: 1,
    });
    const payload = JSON.parse(response?.content?.[0]?.text ?? "{}");

    expect(payload).toMatchObject({
      total: 2,
      offset: 1,
      limit: 1,
      returned: 1,
      hasMore: false,
      nextOffset: null,
    });
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]).toMatchObject({
      id: "resolved-2",
      resolvedAt: null,
      resolvedById: null,
      resolvedByName: null,
      resolvedByAvatarUrl: null,
    });
  });

  it("reads a fresh API response for each page call", async () => {
    apiClient.get
      .mockResolvedValueOnce([sampleComment({ id: "first-call" })])
      .mockResolvedValueOnce([sampleComment({ id: "second-call" })]);

    const first = await registeredHandler()?.({ sessionId: SESSION_ID });
    const second = await registeredHandler()?.({ sessionId: SESSION_ID });

    expect(apiClient.get).toHaveBeenCalledTimes(2);
    expect(JSON.parse(first?.content?.[0]?.text ?? "{}").items[0].id).toBe(
      "first-call"
    );
    expect(JSON.parse(second?.content?.[0]?.text ?? "{}").items[0].id).toBe(
      "second-call"
    );
  });

  it("surfaces API failures through withErrorHandling without comment payload fields", async () => {
    apiClient.get.mockRejectedValue(new Error("not found"));

    const response = await registeredHandler()?.({ sessionId: SESSION_ID });
    const text = response?.content?.[0]?.text ?? "";

    expect(response?.isError).toBe(true);
    expect(text).toContain("not found");
    expect(text).not.toContain("selectedText");
    expect(text).not.toContain("resolvedByName");
  });

  it("returns empty replies array when the comment replies field is not an array", async () => {
    // Covers the false arm of Array.isArray(row.replies) in shapeSessionComment.
    apiClient.get.mockResolvedValue([
      { ...sampleComment({ id: "no-replies" }), replies: null },
    ]);

    const response = await registeredHandler()?.({ sessionId: SESSION_ID });
    const payload = JSON.parse(response?.content?.[0]?.text ?? "{}");

    expect(payload.items[0].replies).toEqual([]);
  });

  it("rejects a sessionUrl where sessions is the terminal path segment with nothing after", () => {
    // Covers the true arm of if (!candidate || sessionIndex + 2 !== segments.length).
    expect(() =>
      resolveSessionCommentSessionId({
        sessionUrl: "https://app.closedloop.ai/closedloop-ai/sessions",
      })
    ).toThrow("sessionUrl must end with /sessions/{uuid}.");
  });

  it("rejects a sessionUrl where the sessions segment is followed by a non-UUID", () => {
    // Covers the true arm of if (!parsed.success) in extractSessionIdFromUrl.
    expect(() =>
      resolveSessionCommentSessionId({
        sessionUrl:
          "https://app.closedloop.ai/closedloop-ai/sessions/not-a-uuid",
      })
    ).toThrow("sessionUrl session id must be a UUID.");
  });

  it("returns null actor when anchor.actor is absent from the comment", async () => {
    // Covers the false arm of actor: anchor.actor ? {...} : null.
    const commentWithNullActor = {
      ...sampleComment({ id: "null-actor" }),
      anchor: {
        traceId: "trace-1",
        turnId: "turn-1",
        row: 1,
        selectedText: "text",
        sourceText: "source text",
        startOffset: 0,
        endOffset: 4,
        sessionId: SESSION_ID,
        actor: null,
      },
    };
    apiClient.get.mockResolvedValue([commentWithNullActor]);

    const response = await registeredHandler()?.({ sessionId: SESSION_ID });
    const payload = JSON.parse(response?.content?.[0]?.text ?? "{}");

    expect(payload.items[0].anchor.actor).toBeNull();
  });
});

function registeredHandler():
  | ((input: {
      sessionId?: string;
      sessionUrl?: string;
      computeTargetId?: string;
      status?: ThreadStatus;
      limit?: number;
      offset?: number;
    }) => Promise<{
      content?: { text?: string }[];
      isError?: boolean;
    }>)
  | undefined {
  return registerTool.mock.calls[0]?.[2];
}

function sampleComment(overrides: {
  id: string;
  status?: ThreadStatus;
  resolvedAt?: string | null;
  resolvedById?: string | null;
  resolvedByName?: string | null;
  resolvedByAvatarUrl?: string | null;
}) {
  return {
    id: overrides.id,
    threadId: `thread-${overrides.id}`,
    body: "Root note",
    status: overrides.status ?? ThreadStatus.Open,
    resolvedAt: overrides.resolvedAt ?? null,
    resolvedById: overrides.resolvedById ?? null,
    resolvedByName: overrides.resolvedByName ?? null,
    resolvedByAvatarUrl: overrides.resolvedByAvatarUrl ?? null,
    target: { type: TraceCommentTargetType.Session, id: SESSION_ID },
    artifactId: SESSION_ID,
    anchor: {
      traceId: "trace-1",
      turnId: "turn-1",
      row: 3,
      selectedText: "selected",
      sourceText: "source selected text",
      startOffset: 7,
      endOffset: 15,
      sessionId: SESSION_ID,
      actor: { name: "codex", human: null },
    },
    createdAt: "2026-07-20T09:00:00.000Z",
    updatedAt: "2026-07-20T09:01:00.000Z",
    editedAt: null,
    authorId: "author-1",
    authorName: "Author User",
    authorAvatarUrl: null,
    canEdit: false,
    canDelete: false,
    replies: [
      {
        id: "reply-1",
        threadId: `thread-${overrides.id}`,
        body: "Reply note",
        createdAt: "2026-07-20T09:02:00.000Z",
        updatedAt: "2026-07-20T09:03:00.000Z",
        editedAt: null,
        authorId: "author-2",
        authorName: "Reply User",
        authorAvatarUrl: "https://example.com/reply.png",
        canEdit: false,
        canDelete: false,
      },
    ],
  };
}
