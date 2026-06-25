import type {
  IssueCommentCreatedEvent,
  IssueCommentEditedEvent,
} from "@octokit/webhooks-types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockWithDbTx as setupMockWithDbTx } from "../utils/db-helpers";

const { MockGitHubProjectionNoWriteError, mockUpsertGitHubIssueCommentThread } =
  vi.hoisted(() => ({
    MockGitHubProjectionNoWriteError: class GitHubProjectionNoWriteError extends Error {
      readonly code: string;
      readonly details: Record<string, string | number | null>;

      constructor(
        code: string,
        details: Record<string, string | number | null>
      ) {
        super(`GitHub comment projection no-write: ${code}`);
        this.name = "GitHubProjectionNoWriteError";
        this.code = code;
        this.details = details;
      }
    },
    mockUpsertGitHubIssueCommentThread: vi.fn(),
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
  GitHubLegacyCommentState: {
    PENDING: "PENDING",
    ADDRESSED: "ADDRESSED",
    DISMISSED: "DISMISSED",
  },
  withDb: vi.fn(),
}));

vi.mock("@/app/comments/github-projection", () => ({
  GitHubProjectionNoWriteError: MockGitHubProjectionNoWriteError,
  softDeleteGitHubCommentByRemoteId: vi.fn(),
  upsertGitHubIssueCommentThread: mockUpsertGitHubIssueCommentThread,
}));

import { GitHubProjectionNoWriteError } from "@/app/comments/github-projection";
import { handleIssueComment } from "@/app/webhooks/github/handlers/issue-comment-handler";
import {
  createRepository,
  createSender,
} from "../fixtures/github-webhook-fixtures";
import { makePrDetailRow } from "../utils/pr-detail-helpers";

let mockTx: any;

describe("handleIssueComment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTx = {
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
    setupMockWithDbTx(mockTx);
    mockExternalAuthorResolution();
    mockUpsertGitHubIssueCommentThread.mockImplementation((_tx, input: any) =>
      Promise.resolve({
        threadId: "thread-1",
        commentIds: ["comment-1"],
        createdGithubCommentIds: [String(input.comment.githubCommentId)],
      })
    );
  });

  it("ignores non-PR issue comments before owner resolution", async () => {
    const response = await handleIssueComment(
      makeIssueCommentEvent({ issue: makeIssue({ pull_request: null }) })
    );

    expect(response.status).toBe(200);
    expect(mockTx.gitHubInstallation.findMany).not.toHaveBeenCalled();
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

  it("creates PR conversation comments with resolved external author identity", async () => {
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
      }),
    });

    await handleIssueComment(event);

    expect(mockUpsertGitHubIssueCommentThread).toHaveBeenCalledWith(
      mockTx,
      expect.objectContaining({
        organizationId: "org-uuid-123",
        branchArtifactId: "branch-artifact-1",
        pullRequestDetailId: "pr-detail-1",
        comment: expect.objectContaining({
          githubCommentId: 123_456,
          bodyMarkdown: "Conversation note",
          author: {
            userId: "shadow-99999",
            externalAuthorId: "external-author-99999",
          },
        }),
      })
    );
    expect(mockTx.workstreamEvent.create).not.toHaveBeenCalled();
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

    expect(mockUpsertGitHubIssueCommentThread).toHaveBeenCalledWith(
      mockTx,
      expect.objectContaining({
        branchArtifactId: "branch-artifact-1",
        pullRequestDetailId: "pr-detail-1",
      })
    );
    expect(mockTx.workstreamEvent.create).not.toHaveBeenCalled();
  });

  it("dedupes duplicate created PR issue comment deliveries via the upsert helper", async () => {
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
    mockUpsertGitHubIssueCommentThread
      .mockResolvedValueOnce({
        threadId: "thread-1",
        commentIds: ["comment-1"],
        createdGithubCommentIds: ["123456"],
      })
      .mockResolvedValueOnce({
        threadId: "thread-1",
        commentIds: ["comment-1"],
        createdGithubCommentIds: [],
      });

    await Promise.all([handleIssueComment(event), handleIssueComment(event)]);

    expect(mockUpsertGitHubIssueCommentThread).toHaveBeenCalledTimes(2);
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
    mockUpsertGitHubIssueCommentThread.mockRejectedValueOnce(
      new GitHubProjectionNoWriteError("ambiguous_thread_projection", {
        branchArtifactId: "branch-artifact-1",
        pullRequestDetailId: "pr-detail-1",
        rootCommentId: 123_456,
        reviewThreadId: null,
      })
    );

    const response = await handleIssueComment(event);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      message: "Event processed successfully",
    });
    expect(mockUpsertGitHubIssueCommentThread).toHaveBeenCalledTimes(1);
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
    const event = {
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
    } as IssueCommentEditedEvent;
    mockUpsertGitHubIssueCommentThread.mockRejectedValueOnce(
      new GitHubProjectionNoWriteError("external_id_conflict", {
        branchArtifactId: "branch-artifact-1",
        githubCommentId: 123_456,
        pullRequestDetailId: "pr-detail-1",
      })
    );

    const response = await handleIssueComment(event);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      message: "Event processed successfully",
    });
    expect(mockUpsertGitHubIssueCommentThread).toHaveBeenCalledTimes(1);
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
    installation: { id: 99 },
    ...overrides,
  } as IssueCommentCreatedEvent;
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    number: 42,
    title: "Test PR",
    html_url: "https://github.com/owner/test-repo/pull/42",
    pull_request: {
      url: "https://api.github.com/repos/owner/test-repo/pulls/42",
    },
    ...overrides,
  } as any;
}

function makeIssueComment(overrides: Record<string, unknown> = {}) {
  return {
    id: 123_456,
    node_id: "IC_123456",
    body: "Conversation note",
    user: createSender({
      login: "reviewer",
      id: 99_999,
      avatar_url: "https://example.com/avatar.png",
    }),
    created_at: "2026-02-10T12:00:00Z",
    updated_at: "2026-02-10T12:00:00Z",
    html_url: "https://github.com/owner/test-repo/pull/42#issuecomment-123456",
    ...overrides,
  } as any;
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
