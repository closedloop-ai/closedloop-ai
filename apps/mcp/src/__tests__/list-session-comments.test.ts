import {
  CommentSurface,
  CommentTargetType,
  ThreadStatus,
  TRACE_COMMENT_ID_MAX_LENGTH,
} from "@repo/api/src/types/comment";
import { CommentAnchorKind } from "@repo/api/src/types/comment-anchor-kind";
import { commentApiPaths } from "@repo/api/src/types/comment-thread-dto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  buildSessionCommentsQuery,
  registerListSessionComments,
  resolveSessionCommentSessionId,
  sessionCommentInputSchema,
} from "../tools/list-session-comments.js";
import { MAX_PAGE_LIMIT } from "../tools/tool-utils.js";
import {
  pagedCommentsApi,
  SESSION_ID,
  sampleThread,
  singlePage,
} from "./fixtures/session-comment-threads.js";
import {
  expectIssue,
  NON_EMPTY_STRING_REJECTION,
  UUID_REJECTION,
  ZodIssueCode,
} from "./fixtures/zod-issues.js";

const OTHER_SESSION_ID = "22222222-2222-4222-8222-222222222222";
const COMPUTE_TARGET_ID = "33333333-3333-4333-8333-333333333333";
/**
 * The ISS-6468 shape: a desktop-local `externalSessionId`. Harness session ids
 * are not UUIDs, and `resolveSessionTraceCommentTarget` in
 * `apps/api/app/comments/service/trace-comment-target-lookup.ts` looks one up by
 * `(computeTargetId, externalSessionId)` and again by `externalSessionId` alone
 * scoped to the caller — so both call shapes below must reach the route.
 */
const EXTERNAL_SESSION_ID = "trace-comments-missing-cloud-session";

/** Every page request names the legacy session route's surface and the largest page. */
const PAGE_QUERY = {
  surface: CommentSurface.SessionDetail,
  limit: String(MAX_PAGE_LIMIT),
};

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
    apiClient.get.mockResolvedValue(singlePage([]));

    const response = await registeredHandler()?.({
      sessionId: SESSION_ID,
      computeTargetId: OTHER_SESSION_ID,
    });
    const payload = JSON.parse(response?.content?.[0]?.text ?? "{}");

    expect(apiClient.get).toHaveBeenCalledWith(
      commentApiPaths.artifactComments(SESSION_ID),
      { ...PAGE_QUERY, computeTargetId: OTHER_SESSION_ID }
    );
    expect(payload).toMatchObject({ items: [], total: 0, returned: 0 });
    expect(buildSessionCommentsQuery({ sessionId: SESSION_ID })).toEqual(
      PAGE_QUERY
    );
  });

  it("extracts the UUID from a canonical session URL", async () => {
    apiClient.get.mockResolvedValue(singlePage([]));

    await registeredHandler()?.({
      sessionUrl: `https://app.closedloop.ai/closedloop-ai/sessions/${SESSION_ID}`,
    });

    expect(apiClient.get).toHaveBeenCalledWith(
      commentApiPaths.artifactComments(SESSION_ID),
      PAGE_QUERY
    );
  });

  it("is exercised with a fixture that is genuinely not a UUID", () => {
    // Positive control for the two tests below: if this fixture ever parsed as
    // a UUID they would stay green against the over-narrow schema too.
    expectIssue(
      z.string().uuid().safeParse(EXTERNAL_SESSION_ID),
      [],
      UUID_REJECTION
    );
  });

  it("reaches the API with a non-UUID external session id plus computeTargetId", async () => {
    apiClient.get.mockResolvedValue(
      singlePage([sampleThread({ id: "external-1" })])
    );

    const payload = await callTool({
      sessionId: EXTERNAL_SESSION_ID,
      computeTargetId: COMPUTE_TARGET_ID,
    });

    // Assert the downstream call SHAPE: the external id has to be the path
    // segment. A mock that answers any id would satisfy a payload-only check.
    expect(apiClient.get).toHaveBeenCalledTimes(1);
    expect(apiClient.get).toHaveBeenCalledWith(
      commentApiPaths.artifactComments(EXTERNAL_SESSION_ID),
      { ...PAGE_QUERY, computeTargetId: COMPUTE_TARGET_ID }
    );
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0].id).toBe("external-1");
  });

  it("reaches the API with a bare external session id and no computeTargetId", async () => {
    // The route's third lookup resolves `externalSessionId` scoped to the
    // caller's own sessions with no compute target, so gating the external form
    // on computeTargetId would leave the tool narrower than the route again.
    apiClient.get.mockResolvedValue(singlePage([]));

    await callTool({ sessionId: EXTERNAL_SESSION_ID });

    expect(apiClient.get).toHaveBeenCalledWith(
      commentApiPaths.artifactComments(EXTERNAL_SESSION_ID),
      PAGE_QUERY
    );
  });

  it("rejects a dot path segment before issuing the request", async () => {
    // The schema accepts ".." (it is a non-empty string), so the guard in
    // encodePathSegment is the reachable one — assert BOTH halves, or this
    // cannot tell "the guard fires" from "the schema made it dead code".
    expect(
      z.object(sessionCommentInputSchema).safeParse({ sessionId: ".." }).success
    ).toBe(true);

    const response = await callToolExpectingError({ sessionId: ".." });

    expect(response).toContain("not a valid path segment");
    expect(apiClient.get).not.toHaveBeenCalled();
  });

  it("rejects artifact display slugs in any letter case", () => {
    // Session slugs are the ticket's case, but every typed prefix is equally
    // unresolvable by the route, and branch-derived slugs are lowercased.
    for (const slug of ["SES-123", "ses-123", "ISS-6468", "PRD-7", "Fea-42"]) {
      expect(() => resolveSessionCommentSessionId({ sessionId: slug })).toThrow(
        "artifact slugs such as SES-123 are not accepted"
      );
    }
  });

  it("rejects an id that is padded with whitespace", () => {
    expect(() =>
      resolveSessionCommentSessionId({
        sessionId: `${EXTERNAL_SESSION_ID}\n`,
      })
    ).toThrow("leading or trailing whitespace");
  });

  it("rejects invalid identity input before calling the API", () => {
    expect(() => resolveSessionCommentSessionId({ sessionId: "" })).toThrow(
      `sessionId must be 1-${TRACE_COMMENT_ID_MAX_LENGTH} characters`
    );
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

    expectIssue(
      inputSchema.safeParse({ sessionId: SESSION_ID, status: "RESOLVE" }),
      ["status"],
      {
        code: ZodIssueCode.InvalidValue,
        values: Object.values(ThreadStatus),
      }
    );
    expectIssue(
      inputSchema.safeParse({ sessionId: SESSION_ID, limit: 0 }),
      ["limit"],
      { code: ZodIssueCode.TooSmall, origin: "number", minimum: 1 }
    );
    expectIssue(
      inputSchema.safeParse({ sessionId: SESSION_ID, offset: -1 }),
      ["offset"],
      { code: ZodIssueCode.TooSmall, origin: "number", minimum: 0 }
    );
    expectIssue(
      inputSchema.safeParse({ sessionId: "" }),
      ["sessionId"],
      NON_EMPTY_STRING_REJECTION
    );
    // Both bounds of the shared target-id contract this tool now depends on.
    expectIssue(
      inputSchema.safeParse({
        sessionId: "x".repeat(TRACE_COMMENT_ID_MAX_LENGTH + 1),
      }),
      ["sessionId"],
      {
        code: ZodIssueCode.TooBig,
        origin: "string",
        maximum: TRACE_COMMENT_ID_MAX_LENGTH,
      }
    );
    expect(
      inputSchema.safeParse({
        sessionId: "x".repeat(TRACE_COMMENT_ID_MAX_LENGTH),
      }).success
    ).toBe(true);
    expect(
      inputSchema.safeParse({ sessionId: EXTERNAL_SESSION_ID }).success
    ).toBe(true);
  });

  it("maps root comments, replies, resolver metadata, target, and MCP-only text anchors", async () => {
    apiClient.get.mockResolvedValue(
      singlePage([
        sampleThread({
          id: "comment-1",
          status: ThreadStatus.Resolved,
          resolvedAt: "2026-07-20T10:00:00.000Z",
          resolvedBy: {
            id: "resolver-1",
            name: "Resolve User",
            avatarUrl: "https://example.com/resolver.png",
          },
        }),
      ])
    );

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
        target: { type: CommentTargetType.Session, id: SESSION_ID },
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
    apiClient.get.mockImplementation(
      pagedCommentsApi(commentApiPaths.artifactComments(SESSION_ID), [
        sampleThread({ id: "open-1", status: ThreadStatus.Open }),
        sampleThread({ id: "resolved-1", status: ThreadStatus.Resolved }),
        sampleThread({ id: "resolved-2", status: ThreadStatus.Resolved }),
      ])
    );

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
      .mockResolvedValueOnce(singlePage([sampleThread({ id: "first-call" })]))
      .mockResolvedValueOnce(singlePage([sampleThread({ id: "second-call" })]));

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

  it("returns empty replies array when the thread's comments field is not an array", async () => {
    // Covers the false arm of Array.isArray(thread.comments) in shapeSessionComment.
    apiClient.get.mockResolvedValue(
      singlePage([{ ...sampleThread({ id: "no-replies" }), comments: null }])
    );

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
    const commentWithNullActor = sampleThread({
      id: "null-actor",
      anchor: {
        kind: CommentAnchorKind.Trace,
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
    });
    apiClient.get.mockResolvedValue(singlePage([commentWithNullActor]));

    const response = await registeredHandler()?.({ sessionId: SESSION_ID });
    const payload = JSON.parse(response?.content?.[0]?.text ?? "{}");

    expect(payload.items[0].anchor.actor).toBeNull();
  });
});

/**
 * Drive the tool the way the MCP SDK does: validate against the registered
 * `inputSchema` FIRST, then invoke the handler. `registeredHandler()` alone
 * bypasses the schema, so a test that only calls it would stay green with the
 * over-narrow `z.string().uuid()` still on `sessionId`.
 */
async function callTool(input: Record<string, unknown>) {
  const parsed = z.object(sessionCommentInputSchema).safeParse(input);
  if (!parsed.success) {
    throw new Error(`input rejected by tool schema: ${parsed.error.message}`);
  }
  const response = await registeredHandler()?.(parsed.data);
  if (response?.isError) {
    throw new Error(`tool returned an error: ${response.content?.[0]?.text}`);
  }
  return JSON.parse(response?.content?.[0]?.text ?? "{}");
}

/** Same production path as {@link callTool}, for input the handler refuses. */
async function callToolExpectingError(
  input: Record<string, unknown>
): Promise<string> {
  const parsed = z.object(sessionCommentInputSchema).safeParse(input);
  if (!parsed.success) {
    throw new Error(`input rejected by tool schema: ${parsed.error.message}`);
  }
  const response = await registeredHandler()?.(parsed.data);
  if (!response?.isError) {
    throw new Error("expected the tool to report an error");
  }
  return response.content?.[0]?.text ?? "";
}

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
