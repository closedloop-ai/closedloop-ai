import { ThreadStatus } from "@repo/api/src/types/comment";
import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  CommentsSection,
  CommentsSectionView,
  type CommentThreadItem,
} from "../comments-section";

/**
 * Compile-time guard (FEA-3910): `CommentsSectionView` MUST NOT be mountable
 * without a submit path. If `onSubmitComment` is ever made optional again, the
 * `@ts-expect-error` below becomes unused and `tsc` fails, catching the
 * regression at typecheck time rather than as a production silent no-op.
 */
function _commentsSectionViewRequiresSubmit() {
  return (
    // @ts-expect-error onSubmitComment is required — omitting it must not typecheck.
    <CommentsSectionView onOpenChange={() => undefined} open />
  );
}

const mockUseDocumentComments = vi.fn();
const mockUseCreateDocumentComment = vi.fn();
const mockReplyMutateAsync = vi.fn().mockResolvedValue({
  commentId: "comment-x",
  threadId: "thread-1",
});
const mockToggleResolvedMutate = vi.fn();

vi.mock("../../hooks/use-document-comments", async () => {
  const actual = await vi.importActual<
    typeof import("../../hooks/use-document-comments")
  >("../../hooks/use-document-comments");
  return {
    ...actual,
    useDocumentComments: (documentId: string, enabled?: boolean) =>
      mockUseDocumentComments(documentId, enabled),
    useCreateDocumentComment: (documentId: string) =>
      mockUseCreateDocumentComment(documentId),
    useReplyToDocumentComment: () => ({
      mutateAsync: mockReplyMutateAsync,
      isPending: false,
    }),
    useToggleDocumentThreadResolved: () => ({
      mutate: mockToggleResolvedMutate,
    }),
  };
});

// The connected section reads the viewer + org member list; the shared
// MentionComposer also reads org members for its typeahead. Stub both so the
// composer and the participant-resolve rule have data.
vi.mock("../../../users/hooks/use-users", () => ({
  useCurrentUser: () => ({ data: { id: "user-you" } }),
  useOrganizationUsers: () => ({
    data: [
      {
        id: "user-you",
        firstName: "You",
        lastName: "Reid",
        email: "you@example.com",
        avatarUrl: null,
        active: true,
      },
    ],
  }),
}));

const DOCUMENT_ID = "doc_123";
const COMMENTS_TOGGLE_NAME = /Comments/;
const SHOW_RESOLVED_NAME = /Show 1 resolved/;

type QueryResult = Pick<
  UseQueryResult<CommentThreadItem[]>,
  "data" | "isPending" | "isError"
>;

function stubQuery(data: CommentThreadItem[]): void {
  mockUseDocumentComments.mockReturnValue({
    data,
    isPending: false,
    isError: false,
  } as QueryResult);
}

type MutationStub = {
  mutateAsync: ReturnType<typeof vi.fn>;
  isPending: boolean;
};

function stubMutation(overrides: Partial<MutationStub> = {}): MutationStub {
  const stub: MutationStub = {
    mutateAsync: vi.fn().mockResolvedValue({
      commentId: "comment-1",
      threadId: "thread-1",
    }),
    isPending: false,
    ...overrides,
  };
  mockUseCreateDocumentComment.mockReturnValue(
    stub as unknown as UseMutationResult<
      { commentId: string; threadId: string },
      Error,
      string
    >
  );
  return stub;
}

/** The artifact composer's textarea, named by its visible label. */
function artifactComposer(): HTMLElement {
  return screen.getByLabelText("Add a comment");
}

function typeIntoComposer(text: string): void {
  fireEvent.change(artifactComposer(), { target: { value: text } });
}

function openThread(overrides: Partial<CommentThreadItem>): CommentThreadItem {
  return {
    id: "thread-1",
    authorId: "user-you",
    status: ThreadStatus.Open,
    resolvedByName: null,
    participantIds: ["user-you"],
    author: { name: "Avery Carter" },
    body: "The rollout needs a fallback plan.",
    createdAt: "2026-05-29T13:45:00.000Z",
    replies: [],
    ...overrides,
  };
}

describe("CommentsSection (connected)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubQuery([]);
  });

  test("submitting the composer calls the create mutation with the typed body", () => {
    const mutation = stubMutation();

    render(<CommentsSection defaultOpen documentId={DOCUMENT_ID} />);

    typeIntoComposer("Please add a rollback plan");
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));

    expect(mockUseCreateDocumentComment).toHaveBeenCalledWith(DOCUMENT_ID);
    expect(mutation.mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutation.mutateAsync.mock.calls[0][0]).toBe(
      "Please add a rollback plan"
    );
  });

  test("clears the field only after the create resolves", async () => {
    stubMutation();

    render(<CommentsSection defaultOpen documentId={DOCUMENT_ID} />);

    typeIntoComposer("Ship it");
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));

    // The composer clears from the mutation's resolution, not synchronously on
    // click, so a failed post can retain the draft for retry.
    await waitFor(() => expect(artifactComposer()).toHaveValue(""));
  });

  test("retains the draft when the create rejects", async () => {
    stubMutation({
      mutateAsync: vi.fn().mockRejectedValue(new Error("boom")),
    });

    render(<CommentsSection defaultOpen documentId={DOCUMENT_ID} />);

    typeIntoComposer("Ship it");
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));

    // The failed post keeps the typed draft in the composer for retry.
    await waitFor(() => expect(artifactComposer()).toHaveValue("Ship it"));
  });

  test("disables the submit button while the create is pending", () => {
    stubMutation({ isPending: true });

    render(<CommentsSection defaultOpen documentId={DOCUMENT_ID} />);

    typeIntoComposer("Pending submission");

    expect(screen.getByRole("button", { name: "Comment" })).toBeDisabled();
  });

  test("replies to a thread as any viewer via the reply mutation", async () => {
    stubMutation();
    stubQuery([openThread({})]);

    render(<CommentsSection defaultOpen documentId={DOCUMENT_ID} />);

    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    fireEvent.change(screen.getByLabelText("Reply..."), {
      target: { value: "Adding the fallback now" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));

    // The mapped item id is the thread's Liveblocks externalId (what the
    // reply route resolves), not the Prisma row id.
    expect(mockReplyMutateAsync).toHaveBeenCalledWith({
      threadId: "thread-1",
      body: "Adding the fallback now",
    });
    // The reply composer closes only after the reply resolves.
    await waitFor(() =>
      expect(screen.queryByLabelText("Reply...")).not.toBeInTheDocument()
    );
  });

  test("a participant sees Resolve and toggles it via the mutation", () => {
    stubMutation();
    // Viewer (user-you) is a participant of an OPEN thread → can resolve.
    stubQuery([openThread({ participantIds: ["user-avery", "user-you"] })]);

    render(<CommentsSection defaultOpen documentId={DOCUMENT_ID} />);

    fireEvent.click(screen.getByRole("button", { name: "Resolve thread" }));

    expect(mockToggleResolvedMutate).toHaveBeenCalledWith({
      threadId: "thread-1",
      nextResolved: true,
    });
  });

  test("a non-participant sees no resolve control on an open thread", () => {
    stubMutation();
    // Viewer (user-you) is neither author nor a replier → no control at all.
    stubQuery([
      openThread({ authorId: "user-avery", participantIds: ["user-avery"] }),
    ]);

    render(<CommentsSection defaultOpen documentId={DOCUMENT_ID} />);

    expect(
      screen.queryByRole("button", { name: "Resolve thread" })
    ).not.toBeInTheDocument();
  });

  test("reopen is author-only: a non-author participant cannot reopen", () => {
    stubMutation();
    // Resolved thread; viewer replied but is not the author → no reopen control.
    stubQuery([
      openThread({
        status: ThreadStatus.Resolved,
        authorId: "user-avery",
        resolvedByName: "Marcus Lee",
        participantIds: ["user-avery", "user-you"],
      }),
    ]);

    render(<CommentsSection defaultOpen documentId={DOCUMENT_ID} />);

    // Resolved threads are collapsed behind a toggle; reveal them first.
    fireEvent.click(screen.getByRole("button", { name: SHOW_RESOLVED_NAME }));

    expect(
      screen.queryByRole("button", { name: "Reopen thread" })
    ).not.toBeInTheDocument();
  });

  test("the author can reopen a resolved thread via the mutation", () => {
    stubMutation();
    stubQuery([
      openThread({
        status: ThreadStatus.Resolved,
        authorId: "user-you",
        resolvedByName: "Marcus Lee",
        participantIds: ["user-you", "user-marcus"],
      }),
    ]);

    render(<CommentsSection defaultOpen documentId={DOCUMENT_ID} />);

    // Resolved threads are collapsed behind a toggle; reveal them first.
    fireEvent.click(screen.getByRole("button", { name: SHOW_RESOLVED_NAME }));
    fireEvent.click(screen.getByRole("button", { name: "Reopen thread" }));

    expect(mockToggleResolvedMutate).toHaveBeenCalledWith({
      threadId: "thread-1",
      nextResolved: false,
    });
  });

  test("renders the returned comment threads in the list", () => {
    stubMutation();
    stubQuery([openThread({})]);

    render(<CommentsSection defaultOpen documentId={DOCUMENT_ID} />);

    expect(
      screen.getByText("The rollout needs a fallback plan.")
    ).toBeInTheDocument();
  });

  test("defers the read until the section is expanded", () => {
    stubMutation();

    render(<CommentsSection documentId={DOCUMENT_ID} />);

    // Collapsed on mount: the read hook is called with enabled=false.
    expect(mockUseDocumentComments).toHaveBeenCalledWith(DOCUMENT_ID, false);

    fireEvent.click(screen.getByRole("button", { name: COMMENTS_TOGGLE_NAME }));

    expect(mockUseDocumentComments).toHaveBeenLastCalledWith(DOCUMENT_ID, true);
  });
});

/**
 * ISS-5286 (review cr thread on comments-section.stories.tsx): the view formats
 * thread timestamps against an injectable clock, so a story can pin its fixtures
 * AND still show a just-posted comment reading as fresh. Both branches are
 * covered: a test that only pinned `now` would pass just as well against a view
 * that accepted the prop and ignored it.
 */
describe("CommentsSectionView thread timestamps", () => {
  const CREATED_AT = "2026-05-29T13:45:00.000Z";
  const FIVE_MINUTES_LATER = new Date("2026-05-29T13:50:00.000Z");
  const MONTHS_LATER = new Date("2026-08-07T09:00:00.000Z");
  const RELATIVE_LABEL = "5 min ago";
  const ABSOLUTE_LABEL = "May 29, 2026";

  afterEach(() => {
    vi.useRealTimers();
  });

  test("formats against the pinned now, not the real clock", () => {
    vi.useFakeTimers();
    // Real clock months past the thread: without the prop this renders absolute.
    vi.setSystemTime(MONTHS_LATER);

    render(
      <CommentsSectionView
        comments={[openThread({ createdAt: CREATED_AT })]}
        now={FIVE_MINUTES_LATER}
        onOpenChange={() => undefined}
        onSubmitComment={() => undefined}
        open
      />
    );

    expect(screen.getByText(RELATIVE_LABEL)).toBeInTheDocument();
    expect(screen.queryByText(ABSOLUTE_LABEL)).toBeNull();
  });

  test("falls back to the real clock when now is omitted", () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIVE_MINUTES_LATER);

    render(
      <CommentsSectionView
        comments={[openThread({ createdAt: CREATED_AT })]}
        onOpenChange={() => undefined}
        onSubmitComment={() => undefined}
        open
      />
    );

    expect(screen.getByText(RELATIVE_LABEL)).toBeInTheDocument();
  });
});
