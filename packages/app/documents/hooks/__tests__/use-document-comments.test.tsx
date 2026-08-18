import type { CommentThreadWithComments } from "@repo/api/src/types/comment";
import {
  DocumentThreadAnchorStatus,
  ThreadSource,
  ThreadStatus,
} from "@repo/api/src/types/comment";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { CommentThreadItem } from "../../components/comments-section";
import {
  canReopenDocumentThread,
  canResolveDocumentThread,
  documentCommentKeys,
  useCreateDocumentComment,
  useDocumentComments,
  useReplyToDocumentComment,
  useToggleDocumentThreadResolved,
} from "../use-document-comments";

const mockApiClient = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
};

vi.mock("../../../shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

const DOCUMENT_ID = "doc_123";

function buildThread(
  overrides: Partial<CommentThreadWithComments> = {}
): CommentThreadWithComments {
  const now = new Date("2026-05-29T13:45:00.000Z");
  return {
    id: "thread-1",
    organizationId: "org-1",
    source: ThreadSource.Liveblocks,
    externalId: "lb_thread_1",
    roomId: "room-1",
    artifactId: DOCUMENT_ID,
    status: ThreadStatus.Open,
    metadata: null,
    createdAtVersion: 1,
    resolvedAt: null,
    resolvedById: null,
    createdById: "user-1",
    createdAt: now,
    updatedAt: now,
    resolvedBy: null,
    createdBy: null,
    comments: [
      {
        id: "comment-1",
        threadId: "thread-1",
        authorId: "user-1",
        body: {},
        plainText: "First comment body",
        externalId: "lb_comment_1",
        editedAt: null,
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
        author: {
          id: "user-1",
          email: "avery@example.com",
          firstName: "Avery",
          lastName: "Carter",
          avatarUrl: null,
        },
        reactions: [],
        attachments: [],
      },
    ],
    ...overrides,
  };
}

describe("useDocumentComments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("reads threads and maps the root comment to a display item", async () => {
    mockApiClient.get.mockResolvedValueOnce([buildThread()]);

    const { result } = renderHook(() => useDocumentComments(DOCUMENT_ID), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.get).toHaveBeenCalledWith(
      `/documents/${DOCUMENT_ID}/threads`
    );
    expect(result.current.data).toEqual([
      {
        // The action id is the thread's Liveblocks externalId (what the
        // reply/resolve routes resolve), NOT the Prisma row id "thread-1".
        id: "lb_thread_1",
        authorId: "user-1",
        status: ThreadStatus.Open,
        resolvedByName: null,
        participantIds: ["user-1"],
        author: { name: "Avery Carter", avatarUrl: null },
        body: "First comment body",
        createdAt: "2026-05-29T13:45:00.000Z",
        replies: [],
      },
    ]);
  });

  test("uses the thread externalId, not the row id, as the action id", async () => {
    mockApiClient.get.mockResolvedValueOnce([
      buildThread({ id: "row-pk-1", externalId: "lb_thread_distinct" }),
    ]);

    const { result } = renderHook(() => useDocumentComments(DOCUMENT_ID), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // The reply/resolve/reopen routes look the segment up as the Liveblocks
    // externalId (organizationId_externalId), so mapping the row PK here would
    // 404 every mutation from a fetched thread.
    expect(result.current.data?.[0]?.id).toBe("lb_thread_distinct");
  });

  test("falls back to the row id when a thread has no externalId", async () => {
    mockApiClient.get.mockResolvedValueOnce([
      buildThread({ id: "row-pk-2", externalId: null }),
    ]);

    const { result } = renderHook(() => useDocumentComments(DOCUMENT_ID), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.[0]?.id).toBe("row-pk-2");
  });

  test("derives participantIds from the author plus every replier", async () => {
    const now = new Date("2026-05-29T13:45:00.000Z");
    const thread = buildThread({ createdById: "user-1" });
    thread.comments.push({
      id: "comment-2",
      threadId: "thread-1",
      authorId: "user-2",
      body: {},
      plainText: "A reply",
      externalId: "lb_comment_2",
      editedAt: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
      author: {
        id: "user-2",
        email: "marcus@example.com",
        firstName: "Marcus",
        lastName: "Lee",
        avatarUrl: null,
      },
      reactions: [],
      attachments: [],
    });
    mockApiClient.get.mockResolvedValueOnce([thread]);

    const { result } = renderHook(() => useDocumentComments(DOCUMENT_ID), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.[0]?.participantIds).toEqual([
      "user-1",
      "user-2",
    ]);
  });

  test("surfaces the resolver name for a resolved thread", async () => {
    mockApiClient.get.mockResolvedValueOnce([
      buildThread({
        status: ThreadStatus.Resolved,
        resolvedById: "user-2",
        resolvedBy: {
          id: "user-2",
          email: "marcus@example.com",
          firstName: "Marcus",
          lastName: "Lee",
          avatarUrl: null,
        },
      }),
    ]);

    const { result } = renderHook(() => useDocumentComments(DOCUMENT_ID), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.[0]?.status).toBe(ThreadStatus.Resolved);
    expect(result.current.data?.[0]?.resolvedByName).toBe("Marcus Lee");
  });

  test("excludes anchored threads, keeping only artifact-level ones", async () => {
    const anchoredByPreview = buildThread({
      id: "thread-anchored-legacy",
      metadata: { anchorPreview: "a highlighted sentence" },
    });
    const anchoredByStatus = buildThread({
      id: "thread-anchored-explicit",
      metadata: { anchorStatus: DocumentThreadAnchorStatus.Anchored },
    });
    const artifactLevel = buildThread({
      id: "thread-artifact-level",
      externalId: "lb_artifact_level",
      metadata: { anchorStatus: DocumentThreadAnchorStatus.ArtifactLevel },
    });
    const legacyNoMetadata = buildThread({
      id: "thread-legacy-neutral",
      externalId: "lb_legacy_neutral",
      metadata: null,
    });
    mockApiClient.get.mockResolvedValueOnce([
      anchoredByPreview,
      anchoredByStatus,
      artifactLevel,
      legacyNoMetadata,
    ]);

    const { result } = renderHook(() => useDocumentComments(DOCUMENT_ID), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // Mapped item ids are the threads' externalIds (the mutation action id).
    expect(result.current.data?.map((item) => item.id)).toEqual([
      "lb_artifact_level",
      "lb_legacy_neutral",
    ]);
  });

  test("does not fetch when disabled", () => {
    const { result } = renderHook(
      () => useDocumentComments(DOCUMENT_ID, false),
      { wrapper: createWrapper() }
    );

    expect(result.current.fetchStatus).toBe("idle");
    expect(mockApiClient.get).not.toHaveBeenCalled();
  });
});

describe("useCreateDocumentComment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("posts the typed body to the document threads route", async () => {
    mockApiClient.post.mockResolvedValueOnce({
      commentId: "comment-1",
      threadId: "thread-1",
    });

    const { result } = renderHook(() => useCreateDocumentComment(DOCUMENT_ID), {
      wrapper: createWrapper(),
    });

    result.current.mutate("A brand new comment");

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.post).toHaveBeenCalledWith(
      `/documents/${DOCUMENT_ID}/threads`,
      { body: "A brand new comment" }
    );
  });

  test("exposes a stable list query key per document", () => {
    expect(documentCommentKeys.list(DOCUMENT_ID)).toEqual([
      "document-comments",
      DOCUMENT_ID,
    ]);
  });
});

describe("useReplyToDocumentComment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("posts the reply body to the thread replies route", async () => {
    mockApiClient.post.mockResolvedValueOnce({
      commentId: "reply-1",
      threadId: "thread-1",
    });

    const { result } = renderHook(
      () => useReplyToDocumentComment(DOCUMENT_ID),
      { wrapper: createWrapper() }
    );

    result.current.mutate({ threadId: "thread-1", body: "A reply" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.post).toHaveBeenCalledWith(
      `/documents/${DOCUMENT_ID}/threads/thread-1/replies`,
      { body: "A reply" }
    );
  });
});

describe("useToggleDocumentThreadResolved", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("resolving posts to the resolve route", async () => {
    mockApiClient.post.mockResolvedValueOnce({ threadId: "thread-1" });

    const { result } = renderHook(
      () => useToggleDocumentThreadResolved(DOCUMENT_ID),
      { wrapper: createWrapper() }
    );

    result.current.mutate({ threadId: "thread-1", nextResolved: true });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.post).toHaveBeenCalledWith(
      `/documents/${DOCUMENT_ID}/threads/thread-1/resolve`,
      {}
    );
  });

  test("reopening posts to the unresolve route", async () => {
    mockApiClient.post.mockResolvedValueOnce({ threadId: "thread-1" });

    const { result } = renderHook(
      () => useToggleDocumentThreadResolved(DOCUMENT_ID),
      { wrapper: createWrapper() }
    );

    result.current.mutate({ threadId: "thread-1", nextResolved: false });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockApiClient.post).toHaveBeenCalledWith(
      `/documents/${DOCUMENT_ID}/threads/thread-1/unresolve`,
      {}
    );
  });
});

describe("participant-resolve permission helpers", () => {
  function item(overrides: Partial<CommentThreadItem>): CommentThreadItem {
    return {
      id: "thread-1",
      authorId: "user-author",
      status: ThreadStatus.Open,
      resolvedByName: null,
      participantIds: ["user-author", "user-replier"],
      author: { name: "Author" },
      body: "body",
      createdAt: "2026-05-29T13:45:00.000Z",
      replies: [],
      ...overrides,
    };
  }

  test("author or any replier may resolve; a non-participant may not", () => {
    const thread = item({});
    expect(canResolveDocumentThread(thread, "user-author")).toBe(true);
    expect(canResolveDocumentThread(thread, "user-replier")).toBe(true);
    expect(canResolveDocumentThread(thread, "user-stranger")).toBe(false);
    expect(canResolveDocumentThread(thread, null)).toBe(false);
  });

  test("only the author may reopen, even a participant replier may not", () => {
    const thread = item({ status: ThreadStatus.Resolved });
    expect(canReopenDocumentThread(thread, "user-author")).toBe(true);
    expect(canReopenDocumentThread(thread, "user-replier")).toBe(false);
    expect(canReopenDocumentThread(thread, null)).toBe(false);
  });
});
