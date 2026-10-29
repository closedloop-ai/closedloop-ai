import type {
  IssueComment,
  IssueCommentCreatedEvent,
  IssueCommentDeletedEvent,
  IssueCommentEditedEvent,
} from "@octokit/webhooks-types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockWithDbTx as setupMockWithDbTx } from "../utils/db-helpers";

const { mockApplyExternal } = vi.hoisted(() => ({
  mockApplyExternal: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  ArtifactType: {
    DOCUMENT: "DOCUMENT",
    BRANCH: "BRANCH",
    DEPLOYMENT: "DEPLOYMENT",
  },
  ExternalCommentProvider: { GITHUB: "GITHUB" },
  GitHubInstallationStatus: {
    ACTIVE: "ACTIVE",
  },
  GitHubCommentThreadKind: { ISSUE_COMMENT: "ISSUE_COMMENT" },
  GitHubLegacyCommentState: {
    PENDING: "PENDING",
    ADDRESSED: "ADDRESSED",
    DISMISSED: "DISMISSED",
  },
  withDb: vi.fn(),
}));

vi.mock("@/app/comments/service", () => ({
  commentsService: { applyExternal: mockApplyExternal },
}));

vi.mock("@/app/webhooks/github/handlers/branch-activity-producer", () => ({
  GitHubBranchActivityEventName: { IssueComment: "issue_comment" },
  persistGitHubBranchActivity: vi.fn().mockResolvedValue({
    status: "persisted",
    persistenceStatus: "inserted",
  }),
}));

import { CommentSyncProvider } from "@repo/api/src/types/comment-thread-dto";
import { GitHubCommentThreadKind } from "@repo/database";
import {
  ApplyExternalOutcome,
  GitHubExternalEventKind,
} from "@/app/comments/service/github/apply-external-events";
import {
  GitHubBranchActivityEventName,
  persistGitHubBranchActivity,
} from "@/app/webhooks/github/handlers/branch-activity-producer";
import { handleIssueComment } from "@/app/webhooks/github/handlers/issue-comment-handler";
import {
  createInstallationLite,
  createReactions,
  createRepository,
  createSender,
} from "../fixtures/github-webhook-fixtures";
import { makePrDetailRow } from "../utils/pr-detail-helpers";

let mockTx: ReturnType<typeof createMockTx>;
const mockPersistGitHubBranchActivity =
  persistGitHubBranchActivity as ReturnType<typeof vi.fn>;

describe("handleIssueComment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTx = createMockTx();
    setupMockWithDbTx(mockTx);
    mockExternalAuthorResolution();
    mockApplyExternal.mockResolvedValue({
      outcomes: [ApplyExternalOutcome.Applied],
      changedThreadIds: ["thread-1"],
    });
  });

  it("ignores non-PR issue comments before owner resolution", async () => {
    // A plain issue's comment: GitHub sends the issue without `pull_request`.
    const { pull_request: _pullRequest, ...plainIssue } = makeIssue();
    const response = await handleIssueComment(
      makeIssueCommentEvent({ issue: plainIssue })
    );

    expect(response.status).toBe(200);
    expect(mockTx.gitHubInstallation.findMany).not.toHaveBeenCalled();
    expect(mockPersistGitHubBranchActivity).not.toHaveBeenCalled();
  });

  it("returns 400 for missing installation before database reads or writes", async () => {
    const response = await handleIssueComment(
      makeIssueCommentEvent({ installation: undefined })
    );

    expect(response.status).toBe(400);
    expect(mockTx.gitHubInstallation.findMany).not.toHaveBeenCalled();
    expect(mockTx.gitHubInstallationRepository.findMany).not.toHaveBeenCalled();
    expect(mockTx.pullRequestDetail.findMany).not.toHaveBeenCalled();
    expect(mockTx.workstreamEvent.create).not.toHaveBeenCalled();
  });

  it("skips writes when owner resolution cannot map the installation repository", async () => {
    mockTx.gitHubInstallation.findMany.mockResolvedValue([
      {
        id: "installation-uuid-99",
        organizationId: "org-uuid-123",
        status: "ACTIVE",
      },
    ]);
    mockTx.gitHubInstallationRepository.findMany.mockResolvedValue([]);

    await handleIssueComment(makeIssueCommentEvent());

    expect(mockTx.pullRequestDetail.findMany).not.toHaveBeenCalled();
    expect(mockTx.pullRequestDetail.findUnique).not.toHaveBeenCalled();
    expect(mockTx.workstreamEvent.create).not.toHaveBeenCalled();
  });

  it("applies PR conversation comments through applyExternal with the provider author", async () => {
    const prDetail = makePrDetailRow({
      id: "pr-detail-1",
      artifactId: "legacy-pr-artifact",
      branchArtifactId: "branch-artifact-1",
      workstreamId: "branch-workstream",
      branchTargetLinks: [
        { source: { id: "branch-doc", slug: "plan-feature-x" } },
      ],
    });
    mockOwnerResolutionSuccess(prDetail);

    const event = makeIssueCommentEvent({
      issue: makeIssue({
        number: 42,
        title: "Add feature X",
        html_url: "https://github.com/owner/test-repo/pull/42",
      }),
      comment: makeIssueComment({
        id: 123_456,
        body: "Conversation note",
        updated_at: "2026-02-10T12:05:00Z",
      }),
    });

    await handleIssueComment(event, {
      deliveryId: "issue-comment-delivery-1",
      observedAt: new Date("2026-08-12T14:00:00.000Z"),
    });

    expect(mockApplyExternal).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: CommentSyncProvider.Github,
        organizationId: "org-uuid-123",
        branchArtifactId: "branch-artifact-1",
        pullRequestDetailId: "pr-detail-1",
        events: [
          expect.objectContaining({
            kind: GitHubExternalEventKind.IssueCommentUpsert,
            comment: expect.objectContaining({
              githubCommentId: 123_456,
              bodyMarkdown: "Conversation note",
              author: expect.objectContaining({
                id: 99_999,
                login: "reviewer",
              }),
              providerUpdatedAt: new Date("2026-02-10T12:05:00Z"),
            }),
          }),
        ],
      })
    );
    expect(mockPersistGitHubBranchActivity).toHaveBeenCalledWith({
      eventName: GitHubBranchActivityEventName.IssueComment,
      deliveryId: "issue-comment-delivery-1",
      payload: event,
      attribution: {
        organizationId: "org-uuid-123",
        branchArtifactId: "branch-artifact-1",
        pullRequestDetailId: "pr-detail-1",
      },
    });
    expect(mockTx.workstreamEvent.create).not.toHaveBeenCalled();
  });

  it("deletes a PR conversation comment through applyExternal at the payload's updated_at", async () => {
    const prDetail = makePrDetailRow({
      id: "pr-detail-1",
      artifactId: "legacy-pr-artifact",
      branchArtifactId: "branch-artifact-1",
    });
    mockOwnerResolutionSuccess(prDetail);

    const event: IssueCommentDeletedEvent = {
      ...makeIssueCommentEvent({
        comment: makeIssueComment({
          id: 123_456,
          updated_at: "2026-02-10T12:07:00Z",
        }),
      }),
      action: "deleted",
    };
    await handleIssueComment(event);

    expect(mockApplyExternal).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-uuid-123",
        branchArtifactId: "branch-artifact-1",
        pullRequestDetailId: "pr-detail-1",
        events: [
          {
            kind: GitHubExternalEventKind.CommentDelete,
            threadKind: GitHubCommentThreadKind.ISSUE_COMMENT,
            githubCommentId: 123_456,
            providerUpdatedAt: new Date("2026-02-10T12:07:00Z"),
          },
        ],
      })
    );
    expect(mockPersistGitHubBranchActivity).toHaveBeenCalledOnce();
  });

  it("does not treat a null current pull request pointer as stale webhook context", async () => {
    const prDetail = makePrDetailRow({
      id: "pr-detail-1",
      artifactId: "legacy-pr-artifact",
      branchArtifactId: "branch-artifact-1",
      currentPullRequestDetailId: null,
      workstreamId: "branch-workstream",
    });
    mockOwnerResolutionSuccess(prDetail);

    await handleIssueComment(makeIssueCommentEvent());

    expect(mockApplyExternal).toHaveBeenCalledWith(
      expect.objectContaining({
        branchArtifactId: "branch-artifact-1",
        pullRequestDetailId: "pr-detail-1",
      })
    );
    expect(mockTx.workstreamEvent.create).not.toHaveBeenCalled();
  });

  it("records activity but skips projection for a non-current associated PR", async () => {
    const prDetail = makePrDetailRow({
      id: "pr-detail-older",
      artifactId: "legacy-pr-artifact",
      branchArtifactId: "branch-artifact-1",
      currentPullRequestDetailId: "pr-detail-current",
      workstreamId: "branch-workstream",
    });
    mockOwnerResolutionSuccess(prDetail);
    const event = makeIssueCommentEvent();

    await handleIssueComment(event, {
      deliveryId: "issue-comment-older-associated-pr",
      observedAt: new Date("2026-08-12T14:00:00.000Z"),
    });

    expect(mockApplyExternal).not.toHaveBeenCalled();
    expect(mockPersistGitHubBranchActivity).toHaveBeenCalledWith({
      eventName: GitHubBranchActivityEventName.IssueComment,
      deliveryId: "issue-comment-older-associated-pr",
      payload: event,
      attribution: {
        organizationId: "org-uuid-123",
        branchArtifactId: "branch-artifact-1",
        pullRequestDetailId: "pr-detail-older",
      },
    });
  });

  it("hands each duplicate created PR issue comment delivery to applyExternal and emits no workstream event", async () => {
    const prDetail = makePrDetailRow({
      id: "pr-detail-1",
      artifactId: "legacy-pr-artifact",
      branchArtifactId: "branch-artifact-1",
      workstreamId: "branch-workstream",
      branchTargetLinks: [
        { source: { id: "branch-doc", slug: "plan-feature-x" } },
      ],
    });
    mockOwnerResolutionSuccess(prDetail);
    const event = makeIssueCommentEvent({
      issue: makeIssue({
        number: 42,
        title: "Add feature X",
      }),
      comment: makeIssueComment({
        id: 123_456,
        body: "Conversation note",
      }),
    });
    mockApplyExternal
      .mockResolvedValueOnce({
        outcomes: [ApplyExternalOutcome.Applied],
        changedThreadIds: ["thread-1"],
      })
      .mockResolvedValueOnce({
        outcomes: [ApplyExternalOutcome.Unchanged],
        changedThreadIds: [],
      });

    await Promise.all([handleIssueComment(event), handleIssueComment(event)]);

    expect(mockApplyExternal).toHaveBeenCalledTimes(2);
    expect(mockTx.workstreamEvent.create).not.toHaveBeenCalled();
  });

  it("bounds typed projection no-write errors on create without emitting a workstream event", async () => {
    const prDetail = makePrDetailRow({
      id: "pr-detail-1",
      artifactId: "legacy-pr-artifact",
      branchArtifactId: "branch-artifact-1",
      workstreamId: "branch-workstream",
      branchTargetLinks: [
        { source: { id: "branch-doc", slug: "plan-feature-x" } },
      ],
    });
    mockOwnerResolutionSuccess(prDetail);
    const event = makeIssueCommentEvent({
      issue: makeIssue({
        number: 42,
        title: "Add feature X",
      }),
      comment: makeIssueComment({
        id: 123_456,
        body: "Conversation note",
      }),
    });
    mockApplyExternal.mockResolvedValueOnce({
      outcomes: [ApplyExternalOutcome.NoWrite],
      changedThreadIds: [],
    });

    const response = await handleIssueComment(event);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      message: "Event processed successfully",
    });
    expect(mockApplyExternal).toHaveBeenCalledTimes(1);
    expect(mockPersistGitHubBranchActivity).not.toHaveBeenCalled();
    expect(mockTx.workstreamEvent.create).not.toHaveBeenCalled();
  });

  it("bounds typed projection no-write errors on edit without emitting a workstream event", async () => {
    const prDetail = makePrDetailRow({
      id: "pr-detail-1",
      artifactId: "legacy-pr-artifact",
      branchArtifactId: "branch-artifact-1",
      workstreamId: "branch-workstream",
    });
    mockOwnerResolutionSuccess(prDetail);
    const event: IssueCommentEditedEvent = {
      ...makeIssueCommentEvent({
        issue: makeIssue({
          number: 42,
          title: "Add feature X",
        }),
        comment: makeIssueComment({
          id: 123_456,
          body: "Edited conversation note",
        }),
      }),
      action: "edited",
      changes: { body: { from: "Conversation note" } },
    };
    mockApplyExternal.mockResolvedValueOnce({
      outcomes: [ApplyExternalOutcome.NoWrite],
      changedThreadIds: [],
    });

    const response = await handleIssueComment(event);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      message: "Event processed successfully",
    });
    expect(mockApplyExternal).toHaveBeenCalledTimes(1);
    expect(mockPersistGitHubBranchActivity).not.toHaveBeenCalled();
    expect(mockTx.workstreamEvent.create).not.toHaveBeenCalled();
  });
});

function makeIssueCommentEvent(
  overrides: Partial<IssueCommentCreatedEvent> = {}
): IssueCommentCreatedEvent {
  return {
    action: "created",
    issue: makeIssue(),
    comment: makeIssueComment(),
    repository: createRepository(789),
    sender: createSender({ login: "reviewer", id: 99_999 }),
    installation: createInstallationLite(),
    ...overrides,
  };
}

/** A pull request's conversation, which GitHub delivers as an issue. */
function makeIssue(
  overrides: Partial<IssueCommentCreatedEvent["issue"]> = {}
): IssueCommentCreatedEvent["issue"] {
  const number = overrides.number ?? 42;
  const apiUrl = `https://api.github.com/repos/owner/test-repo/issues/${number}`;
  const htmlUrl = `https://github.com/owner/test-repo/pull/${number}`;
  return {
    url: apiUrl,
    repository_url: "https://api.github.com/repos/owner/test-repo",
    labels_url: `${apiUrl}/labels{/name}`,
    comments_url: `${apiUrl}/comments`,
    events_url: `${apiUrl}/events`,
    html_url: htmlUrl,
    id: 42,
    node_id: "PR_42",
    number,
    title: "Test PR",
    user: createSender(),
    labels: [],
    state: "open",
    locked: false,
    assignee: null,
    assignees: [],
    milestone: null,
    comments: 1,
    created_at: "2026-02-10T00:00:00Z",
    updated_at: "2026-02-10T12:00:00Z",
    closed_at: null,
    author_association: "MEMBER",
    active_lock_reason: null,
    draft: false,
    pull_request: {
      url: `https://api.github.com/repos/owner/test-repo/pulls/${number}`,
      html_url: htmlUrl,
      diff_url: `${htmlUrl}.diff`,
      patch_url: `${htmlUrl}.patch`,
      merged_at: null,
    },
    body: null,
    reactions: createReactions(apiUrl),
    timeline_url: `${apiUrl}/timeline`,
    state_reason: null,
    ...overrides,
  };
}

function makeIssueComment(overrides: Partial<IssueComment> = {}): IssueComment {
  const id = overrides.id ?? 123_456;
  const apiUrl = `https://api.github.com/repos/owner/test-repo/issues/comments/${id}`;
  return {
    url: apiUrl,
    html_url: `https://github.com/owner/test-repo/pull/42#issuecomment-${id}`,
    issue_url: "https://api.github.com/repos/owner/test-repo/issues/42",
    id,
    node_id: `IC_${id}`,
    user: createSender({
      login: "reviewer",
      id: 99_999,
      avatar_url: "https://example.com/avatar.png",
    }),
    created_at: "2026-02-10T12:00:00Z",
    updated_at: "2026-02-10T12:00:00Z",
    author_association: "CONTRIBUTOR",
    body: "Conversation note",
    reactions: createReactions(apiUrl),
    performed_via_github_app: null,
    ...overrides,
  };
}

function mockOwnerResolutionSuccess(
  prDetail: ReturnType<typeof makePrDetailRow>
) {
  mockTx.gitHubInstallation.findMany.mockResolvedValue([
    {
      id: "installation-uuid-99",
      organizationId: "org-uuid-123",
      status: "ACTIVE",
    },
  ]);
  mockTx.gitHubInstallationRepository.findMany.mockResolvedValue([
    { id: "repo-uuid-123" },
  ]);
  mockTx.pullRequestDetail.findMany.mockResolvedValue([
    {
      id: prDetail.id,
      branchArtifactId: prDetail.branchArtifactId,
      branchArtifact: { organizationId: "org-uuid-123" },
    },
  ]);
  mockTx.pullRequestDetail.findUnique.mockResolvedValue(prDetail);
}

function mockExternalAuthorResolution() {
  mockTx.user.upsert.mockResolvedValue({
    id: "shadow-99999",
    clerkId: "github-shadow:org-uuid-123:99999",
    organizationId: "org-uuid-123",
    active: false,
    email: "github-shadow+org-uuid-123+99999@invalid.closedloop.local",
    firstName: "reviewer",
    lastName: "GitHub",
    avatarUrl: "https://example.com/avatar.png",
    githubUsername: "reviewer",
  });
  mockTx.externalCommentAuthor.upsert.mockResolvedValue({
    id: "external-author-99999",
    organizationId: "org-uuid-123",
    provider: "GITHUB",
    providerUserId: "99999",
    providerNodeId: "U_99999",
    providerLogin: "reviewer",
    normalizedProviderLogin: "reviewer",
    displayName: "reviewer",
    avatarUrl: "https://example.com/avatar.png",
    profileUrl: "",
    userId: "shadow-99999",
    user: null,
  });
}

function createMockTx() {
  return {
    gitHubInstallation: {
      findMany: vi.fn(),
    },
    gitHubInstallationRepository: {
      findMany: vi.fn(),
    },
    pullRequestDetail: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
    gitHubCommentProjection: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    gitHubUserConnection: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    externalCommentAuthor: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn(),
    },
    user: {
      upsert: vi.fn(),
    },
    workstreamEvent: {
      create: vi.fn(),
    },
  };
}
