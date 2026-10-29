import { describe, expect, it } from "vitest";
import { ThreadSource, ThreadStatus, TraceCommentKind } from "./comment.ts";
import { CommentAnchorKind } from "./comment-anchor-kind.ts";
import {
  type ArtifactCommentsResponse,
  artifactCommentsResponseSchema,
  CommentBodyFormat,
  CommentSyncDirection,
  CommentSyncStatus,
  type CommentThreadDto,
  commentThreadDtoSchema,
} from "./comment-thread-dto.ts";
import { GitHubActorType } from "./github-actor.ts";

const PERMISSIONS = {
  canEdit: true,
  canDelete: true,
  canResolve: false,
  canReopen: false,
  canRetrySync: false,
};

const CAPABILITIES = {
  createThread: true,
  reply: true,
  edit: true,
  delete: true,
  resolve: false,
  reopen: false,
  react: false,
  attach: false,
  mention: true,
  retrySync: true,
  linkOut: false,
  anchorKinds: [CommentAnchorKind.Trace],
  commentKinds: [TraceCommentKind.Comment],
};

function thread(over: Partial<CommentThreadDto> = {}): CommentThreadDto {
  return {
    id: "thread-1",
    artifactId: "artifact-1",
    source: ThreadSource.Native,
    anchor: { kind: CommentAnchorKind.Artifact },
    anchorState: null,
    status: ThreadStatus.Open,
    resolvedAt: null,
    resolvedBy: null,
    revision: 3,
    sync: null,
    permissions: PERMISSIONS,
    provider: {},
    kind: TraceCommentKind.Comment,
    createdAt: "2026-10-01T00:00:00.000Z",
    comments: [
      {
        id: "comment-1",
        threadId: "thread-1",
        author: { id: "user-1", name: "Ada", avatarUrl: null },
        body: "hello",
        bodyFormat: CommentBodyFormat.RichV1,
        mentions: [],
        revision: 1,
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
        editedAt: null,
        permissions: PERMISSIONS,
      },
    ],
    ...over,
  };
}

function page(
  over: Partial<ArtifactCommentsResponse> = {}
): ArtifactCommentsResponse {
  return {
    capabilities: CAPABILITIES,
    threads: [thread()],
    nextCursor: null,
    ...over,
  };
}

describe("artifactCommentsResponseSchema (PLN-2162 decision 2)", () => {
  it("parses a response from a server that predates artifactId and provider.stale", () => {
    const old = page();

    expect(artifactCommentsResponseSchema.parse(old)).toEqual(old);
  });

  it("keeps artifactId and provider.stale when the server sends them", () => {
    const current = page({
      artifactId: "artifact-1",
      threads: [thread({ provider: { stale: true } })],
    });

    expect(artifactCommentsResponseSchema.parse(current)).toEqual(current);
  });

  it("keeps provider.repositoryFullName when the server sends it, and parses a thread without it", () => {
    const named = page({
      threads: [
        thread({
          provider: { pullRequestNumber: 7, repositoryFullName: "acme/web" },
        }),
      ],
    });
    const unnamed = page({
      threads: [thread({ provider: { pullRequestNumber: 7 } })],
    });

    expect(artifactCommentsResponseSchema.parse(named)).toEqual(named);
    expect(
      artifactCommentsResponseSchema.parse(unnamed).threads[0]?.provider
    ).not.toHaveProperty("repositoryFullName");
  });

  it("keeps a comment's reactions and attachments, and parses a comment without them", () => {
    const base = thread();
    const withExtras = page({
      threads: [
        {
          ...base,
          comments: base.comments.map((comment) => ({
            ...comment,
            reactions: [
              { emoji: "+1", userIds: ["user-1"], viewerReacted: true },
            ],
            attachments: [
              {
                id: "attachment-1",
                name: "spec.pdf",
                mimeType: null,
                size: null,
                downloadPath: "/comments/attachments/attachment-1",
              },
            ],
          })),
        },
      ],
    });

    expect(artifactCommentsResponseSchema.parse(withExtras)).toEqual(
      withExtras
    );
    const [parsedComment] =
      artifactCommentsResponseSchema.parse(page()).threads[0]?.comments ?? [];
    expect(parsedComment).not.toHaveProperty("reactions");
    expect(parsedComment).not.toHaveProperty("attachments");
  });

  it("drops keys this build does not know instead of failing", () => {
    const parsed = artifactCommentsResponseSchema.parse({
      ...page(),
      futureField: 1,
      threads: [{ ...thread(), futureThreadField: "x" }],
    });

    expect(parsed).toEqual(page());
  });

  // Kerensa, 2026-10-06: a thread this build cannot fully read is left out.
  it.each(unreadableThreads())(
    "leaves out a thread with $label and loads its sibling",
    ({ unreadable }) => {
      const parsed = artifactCommentsResponseSchema.parse({
        ...page(),
        threads: [unreadable, thread({ id: "thread-2" })],
      });

      expect(parsed.threads).toEqual([thread({ id: "thread-2" })]);
    }
  );

  it.each([
    { label: "threads that are not an array", over: { threads: "none" } },
    { label: "no capabilities", over: { capabilities: undefined } },
    { label: "no nextCursor", over: { nextCursor: undefined } },
  ])(
    "fails a page with $label rather than reading it as no comments",
    ({ over }) => {
      expect(
        artifactCommentsResponseSchema.safeParse({ ...page(), ...over }).success
      ).toBe(false);
    }
  );

  it("does not offer an anchor or comment kind this build does not know", () => {
    const parsed = artifactCommentsResponseSchema.parse({
      ...page(),
      capabilities: {
        ...CAPABILITIES,
        anchorKinds: [CommentAnchorKind.Trace, "hologram"],
        commentKinds: [TraceCommentKind.Comment, "future_kind"],
      },
    });

    expect(parsed.capabilities.anchorKinds).toEqual([CommentAnchorKind.Trace]);
    expect(parsed.capabilities.commentKinds).toEqual([
      TraceCommentKind.Comment,
    ]);
  });
});

describe("commentThreadDtoSchema", () => {
  it("reads a thread kind this build does not know as a plain comment", () => {
    expect(
      commentThreadDtoSchema.parse({ ...thread(), kind: "future_kind" }).kind
    ).toBe(TraceCommentKind.Comment);
  });

  it("reads an unrecognized GitHub actor type as unknown", () => {
    const author = {
      login: "octocat",
      displayName: null,
      avatarUrl: null,
      profileUrl: null,
    };

    expect(
      commentThreadDtoSchema.parse(
        thread({
          source: ThreadSource.Github,
          provider: {
            author: { ...author, actorType: "Robot" as GitHubActorType },
          },
        })
      ).provider.author
    ).toEqual({ ...author, actorType: GitHubActorType.Unknown });
  });
});

function unreadableThreads(): { label: string; unreadable: unknown }[] {
  const { revision: _dropped, ...withoutRevision } = thread();
  const [comment] = thread().comments;
  return [
    { label: "an unknown source", unreadable: { ...thread(), source: "JIRA" } },
    {
      label: "an unknown status",
      unreadable: { ...thread(), status: "ARCHIVED" },
    },
    {
      label: "an unknown comment body format",
      unreadable: {
        ...thread(),
        comments: [{ ...comment, bodyFormat: "HTML_V2" }],
      },
    },
    {
      label: "an unknown anchor kind",
      unreadable: { ...thread(), anchor: { kind: "hologram", depth: 3 } },
    },
    {
      label: "an unknown anchor state",
      unreadable: { ...thread(), anchorState: "DRIFTED" },
    },
    {
      label: "an unknown sync provider",
      unreadable: {
        ...thread(),
        sync: {
          provider: "FUTURE_PROVIDER",
          direction: CommentSyncDirection.Outbound,
          state: CommentSyncStatus.Synced,
        },
      },
    },
    {
      label: "an unknown surface",
      unreadable: { ...thread(), surface: "future_surface" },
    },
    {
      label: "a known anchor kind with a malformed field",
      unreadable: {
        ...thread(),
        anchor: { kind: CommentAnchorKind.Text, documentVersion: -1 },
      },
    },
    { label: "a missing required field", unreadable: withoutRevision },
  ];
}
