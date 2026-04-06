/**
 * Unit tests for GitHub pull_request webhook handler.
 *
 * Tests the handlePullRequest function which processes PR lifecycle events:
 * - opened: Parse plan references from title/body, link PR to plan artifact
 * - edited: Parse plan references from title/body, link PR to plan artifact (if not already linked)
 * - closed (merged=true) → Updates state to MERGED, sets mergedAt and mergeCommitSha
 * - closed (merged=false) → Updates state to CLOSED
 * - reopened → Updates state to OPEN, re-checks plan references
 * - synchronize → Updates headSha
 * - converted_to_draft → Sets isDraft=true
 * - ready_for_review → Sets isDraft=false
 * - Unknown PR/Repository → Returns without error
 * - Unsupported actions → Skips without DB queries
 */

import type {
  PullRequestClosedEvent,
  PullRequestConvertedToDraftEvent,
  PullRequestReadyForReviewEvent,
  PullRequestReopenedEvent,
  PullRequestSynchronizeEvent,
} from "@octokit/webhooks-types";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";

// Mock modules before importing
vi.mock("@repo/database", () => {
  const mockWithDb: any = vi.fn();
  mockWithDb.tx = vi.fn();
  return {
    ChecksStatus: {
      UNKNOWN: "UNKNOWN",
      PENDING: "PENDING",
      PASSING: "PASSING",
      FAILING: "FAILING",
    },
    WorkstreamType: {
      FEATURE: "FEATURE",
      BUG: "BUG",
      TASK: "TASK",
    },
    withDb: mockWithDb,
  };
});

vi.mock("@repo/github/plan-reference-parser", () => ({
  parsePlanReferences: vi.fn().mockReturnValue([]),
}));

vi.mock("@/lib/slug-generator", () => ({
  generateSlug: vi.fn().mockResolvedValue("WORK-99"),
  SlugPrefix: { Workstream: "WORK" },
}));

// Import after mocking
import { ArtifactStatus, ArtifactType } from "@repo/api/src/types/artifact";
import { EntityType, LinkType } from "@repo/api/src/types/entity-link";
import { ExternalLinkType } from "@repo/api/src/types/external-link";
import { GitHubPRState } from "@repo/api/src/types/github";
import { withDb } from "@repo/database";
import { parsePlanReferences } from "@repo/github/plan-reference-parser";
import { handlePullRequest } from "@/app/webhooks/github/handlers/pull-request-handler";

const mockParsePlanReferences = parsePlanReferences as Mock;

// Type aliases for mocked functions
const mockWithDb = withDb as unknown as Mock;
const mockWithDbTx = withDb.tx as unknown as Mock;

// Mock database transaction client
let mockTx: any;

/**
 * Helper to create minimal repository object for webhook events
 */
function createRepository(githubId: number) {
  return {
    id: githubId,
    node_id: `R_${githubId}`,
    name: "test-repo",
    full_name: "owner/test-repo",
    private: false,
    owner: {
      login: "owner",
      id: 12_345,
      node_id: "U_12345",
      avatar_url: "",
      gravatar_id: "",
      url: "",
      html_url: "",
      followers_url: "",
      following_url: "",
      gists_url: "",
      starred_url: "",
      subscriptions_url: "",
      organizations_url: "",
      repos_url: "",
      events_url: "",
      received_events_url: "",
      type: "User" as const,
      site_admin: false,
    },
    html_url: "",
    description: null,
    fork: false,
    url: "",
    // ... other required fields omitted for brevity
  };
}

/**
 * Helper to create minimal pull request object
 */
function createPullRequest(partial: {
  number: number;
  title?: string;
  body?: string | null;
  state?: string;
  draft?: boolean;
  merged?: boolean;
  closed_at?: string | null;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  head?: { sha: string; ref?: string };
}) {
  return {
    id: 1,
    node_id: "PR_1",
    number: partial.number,
    title: partial.title ?? "Test PR",
    body: partial.body ?? null,
    user: {
      login: "test-user",
      id: 1,
      node_id: "U_1",
      avatar_url: "",
      gravatar_id: "",
      url: "",
      html_url: "",
      followers_url: "",
      following_url: "",
      gists_url: "",
      starred_url: "",
      subscriptions_url: "",
      organizations_url: "",
      repos_url: "",
      events_url: "",
      received_events_url: "",
      type: "User" as const,
      site_admin: false,
    },
    state: partial.state ?? "open",
    draft: partial.draft ?? false,
    merged: partial.merged ?? false,
    closed_at: partial.closed_at ?? null,
    merged_at: partial.merged_at ?? null,
    merge_commit_sha: partial.merge_commit_sha ?? null,
    head: { sha: "abc123", ref: "feature-branch", ...partial.head },
    base: { ref: "main" },
    // Required fields for webhook type
    url: "",
    html_url: "https://github.com/owner/test-repo/pull/1",
    diff_url: "",
    patch_url: "",
    issue_url: "",
    commits_url: "",
    review_comments_url: "",
    review_comment_url: "",
    comments_url: "",
    statuses_url: "",
    created_at: "2026-02-10T00:00:00Z",
    updated_at: "2026-02-10T00:00:00Z",
  } as any;
}

/**
 * Helper to create minimal sender object
 */
function createSender() {
  return {
    login: "test-user",
    id: 1,
    node_id: "U_1",
    avatar_url: "",
    gravatar_id: "",
    url: "",
    html_url: "",
    followers_url: "",
    following_url: "",
    gists_url: "",
    starred_url: "",
    subscriptions_url: "",
    organizations_url: "",
    repos_url: "",
    events_url: "",
    received_events_url: "",
    type: "User" as const,
    site_admin: false,
  };
}

describe("handlePullRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Reset parser mock
    mockParsePlanReferences.mockReturnValue([]);

    // Set up transaction mock
    mockTx = {
      gitHubInstallationRepository: {
        findFirst: vi.fn(),
      },
      gitHubPullRequest: {
        findUnique: vi.fn(),
        update: vi.fn(),
        create: vi.fn(),
      },
      workstreamEvent: {
        create: vi.fn(),
      },
      artifact: {
        findUnique: vi.fn(),
        update: vi.fn(),
      },
      workstream: {
        create: vi.fn(),
      },
      externalLink: {
        findFirst: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
      entityLink: {
        findFirst: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
      },
      feature: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };

    // Mock withDb.tx — all reads and writes happen in a single transaction
    mockWithDbTx.mockImplementation((callback: any) => {
      return callback(mockTx);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("closed action with merged=true", () => {
    it("updates state to MERGED and sets mergedAt, mergeCommitSha, creates GITHUB_PR_MERGED event", async () => {
      const repository = createRepository(789);
      const pullRequest = createPullRequest({
        number: 42,
        title: "Add feature X",
        state: "closed",
        merged: true,
        closed_at: "2026-02-10T12:00:00Z",
        merged_at: "2026-02-10T12:00:00Z",
        merge_commit_sha: "def456",
      });

      const event: PullRequestClosedEvent = {
        action: "closed",
        number: pullRequest.number,
        pull_request: pullRequest,
        repository,
        sender: createSender(),
      } as any;

      // Mock repository lookup
      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-123",
        installation: { organizationId: "org-uuid-123" },
      });

      // Mock PR lookup (includes artifact via relation)
      mockTx.gitHubPullRequest.findUnique.mockResolvedValue({
        id: "pr-uuid-456",
        workstreamId: "ws-uuid-789",
        organizationId: "org-uuid-123",
        artifactId: "artifact-uuid-123",
        checksStatus: "UNKNOWN",
        artifact: { slug: "plan-feature-x" },
      });

      // Mock update
      mockTx.gitHubPullRequest.update.mockResolvedValue({});

      // Mock event creation
      mockTx.workstreamEvent.create.mockResolvedValue({});

      // Mock artifact status update
      mockTx.artifact.update.mockResolvedValue({});

      await handlePullRequest(event);

      // Verify repository lookup
      expect(
        mockTx.gitHubInstallationRepository.findFirst
      ).toHaveBeenCalledWith({
        where: { githubRepoId: "789" },
        select: {
          id: true,
          installation: { select: { organizationId: true } },
        },
      });

      // Verify PR lookup (includes artifact via relation and checksStatus for CI reset)
      expect(mockTx.gitHubPullRequest.findUnique).toHaveBeenCalledWith({
        where: {
          repositoryId_number: {
            repositoryId: "repo-uuid-123",
            number: 42,
          },
        },
        select: {
          id: true,
          workstreamId: true,
          organizationId: true,
          artifactId: true,
          checksStatus: true,
          artifact: { select: { slug: true } },
        },
      });

      // Verify PR update
      expect(mockTx.gitHubPullRequest.update).toHaveBeenCalledWith({
        where: { id: "pr-uuid-456" },
        data: {
          state: GitHubPRState.Merged,
          closedAt: new Date("2026-02-10T12:00:00Z"),
          mergedAt: new Date("2026-02-10T12:00:00Z"),
          mergeCommitSha: "def456",
        },
      });

      // Verify workstream event creation with artifactId and slug
      expect(mockTx.workstreamEvent.create).toHaveBeenCalledWith({
        data: {
          workstreamId: "ws-uuid-789",
          type: "GITHUB_PR_MERGED",
          actorType: "system",
          data: {
            prNumber: 42,
            prTitle: "Add feature X",
            prUrl: "https://github.com/owner/test-repo/pull/1",
            artifactId: "artifact-uuid-123",
            slug: "plan-feature-x",
            mergedAt: "2026-02-10T12:00:00Z",
            mergeCommitSha: "def456",
          },
        },
      });

      // Verify linked artifact marked as EXECUTED
      expect(mockTx.artifact.update).toHaveBeenCalledWith({
        where: { id: "artifact-uuid-123" },
        data: { status: ArtifactStatus.Executed },
      });
    });
  });

  describe("closed action with merged=false", () => {
    it("updates state to CLOSED and creates GITHUB_PR_CLOSED event", async () => {
      const repository = createRepository(789);
      const pullRequest = createPullRequest({
        number: 43,
        title: "Feature rejected",
        state: "closed",
        merged: false,
        closed_at: "2026-02-10T13:00:00Z",
        merged_at: null,
        merge_commit_sha: null,
      });

      const event: PullRequestClosedEvent = {
        action: "closed",
        number: pullRequest.number,
        pull_request: pullRequest,
        repository,
        sender: createSender(),
      } as any;

      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-123",
        installation: { organizationId: "org-uuid-123" },
      });

      mockTx.gitHubPullRequest.findUnique.mockResolvedValue({
        id: "pr-uuid-789",
        workstreamId: "ws-uuid-abc",
        organizationId: "org-uuid-456",
        artifactId: null,
        checksStatus: "UNKNOWN",
        artifact: null,
      });

      mockTx.gitHubPullRequest.update.mockResolvedValue({});
      mockTx.workstreamEvent.create.mockResolvedValue({});

      await handlePullRequest(event);

      expect(mockTx.gitHubPullRequest.update).toHaveBeenCalledWith({
        where: { id: "pr-uuid-789" },
        data: {
          state: GitHubPRState.Closed,
          closedAt: new Date("2026-02-10T13:00:00Z"),
          mergedAt: null,
          mergeCommitSha: null,
        },
      });

      expect(mockTx.workstreamEvent.create).toHaveBeenCalledWith({
        data: {
          workstreamId: "ws-uuid-abc",
          type: "GITHUB_PR_CLOSED",
          actorType: "system",
          data: {
            prNumber: 43,
            prTitle: "Feature rejected",
            prUrl: "https://github.com/owner/test-repo/pull/1",
            artifactId: null,
            slug: undefined,
          },
        },
      });

      // Should NOT mark artifacts as EXECUTED when PR is closed without merge
      expect(mockTx.artifact.update).not.toHaveBeenCalled();
    });
  });

  describe("reopened action", () => {
    it("updates state to OPEN and clears closedAt", async () => {
      const repository = createRepository(123);
      const pullRequest = createPullRequest({
        number: 44,
        title: "Reopened PR",
        state: "open",
      });

      const event: PullRequestReopenedEvent = {
        action: "reopened",
        number: pullRequest.number,
        pull_request: pullRequest,
        repository,
        sender: createSender(),
      } as any;

      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-456",
        installation: { organizationId: "org-uuid-456" },
      });

      mockTx.gitHubPullRequest.findUnique.mockResolvedValue({
        id: "pr-uuid-reopen",
        workstreamId: "ws-uuid-def",
        organizationId: "org-uuid-456",
        artifactId: null,
        checksStatus: "UNKNOWN",
        artifact: null,
      });

      mockTx.gitHubPullRequest.update.mockResolvedValue({});

      await handlePullRequest(event);

      expect(mockTx.gitHubPullRequest.update).toHaveBeenCalledWith({
        where: { id: "pr-uuid-reopen" },
        data: {
          state: GitHubPRState.Open,
          closedAt: null,
        },
      });
    });
  });

  describe("synchronize action", () => {
    it("updates headSha and resets checksStatus to PENDING when PR is synchronized with new commits", async () => {
      const repository = createRepository(456);
      const pullRequest = createPullRequest({
        number: 45,
        title: "Updated PR",
        head: { sha: "new-sha-xyz" },
      });

      const event: PullRequestSynchronizeEvent = {
        action: "synchronize",
        number: pullRequest.number,
        before: "old-sha-abc",
        after: "new-sha-xyz",
        pull_request: pullRequest,
        repository,
        sender: createSender(),
      } as any;

      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-sync",
        installation: { organizationId: "org-uuid-sync" },
      });

      mockTx.gitHubPullRequest.findUnique.mockResolvedValue({
        id: "pr-uuid-sync",
        workstreamId: "ws-uuid-sync",
        checksStatus: "UNKNOWN",
        artifactId: null,
        artifact: null,
      });

      mockTx.gitHubPullRequest.update.mockResolvedValue({});
      mockTx.workstreamEvent.create.mockResolvedValue({});

      await handlePullRequest(event);

      expect(mockTx.gitHubPullRequest.update).toHaveBeenCalledWith({
        where: { id: "pr-uuid-sync" },
        data: {
          headSha: "new-sha-xyz",
          checksStatus: "PENDING",
        },
      });
    });

    it("creates GITHUB_CI_STATUS_CHANGED event with previousChecksStatus when status was PASSING", async () => {
      const repository = createRepository(456);
      const pullRequest = createPullRequest({
        number: 45,
        title: "Updated PR",
        head: { sha: "new-sha-xyz" },
      });

      const event: PullRequestSynchronizeEvent = {
        action: "synchronize",
        number: pullRequest.number,
        before: "old-sha-abc",
        after: "new-sha-xyz",
        pull_request: pullRequest,
        repository,
        sender: createSender(),
      } as any;

      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-sync",
        installation: { organizationId: "org-uuid-sync" },
      });

      // Simulate a PR that currently has PASSING status
      mockTx.gitHubPullRequest.findUnique.mockResolvedValue({
        id: "pr-uuid-sync",
        workstreamId: "ws-uuid-sync",
        checksStatus: "PASSING",
        artifactId: null,
        artifact: null,
      });

      mockTx.gitHubPullRequest.update.mockResolvedValue({});
      mockTx.workstreamEvent.create.mockResolvedValue({});

      await handlePullRequest(event);

      // Verify findUnique select includes checksStatus
      expect(mockTx.gitHubPullRequest.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          select: expect.objectContaining({ checksStatus: true }),
        })
      );

      // Verify update resets checksStatus to PENDING
      expect(mockTx.gitHubPullRequest.update).toHaveBeenCalledWith({
        where: { id: "pr-uuid-sync" },
        data: expect.objectContaining({
          headSha: "new-sha-xyz",
          checksStatus: "PENDING",
        }),
      });

      // Verify GITHUB_CI_STATUS_CHANGED workstream event is created with previousChecksStatus
      expect(mockTx.workstreamEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          workstreamId: "ws-uuid-sync",
          type: "GITHUB_CI_STATUS_CHANGED",
          actorType: "system",
          data: expect.objectContaining({
            checksStatus: "PENDING",
            previousChecksStatus: "PASSING",
            headSha: "new-sha-xyz",
          }),
        }),
      });
    });
  });

  describe("converted_to_draft action", () => {
    it("sets isDraft to true", async () => {
      const repository = createRepository(111);
      const pullRequest = createPullRequest({
        number: 46,
        title: "Draft PR",
        draft: true,
      });

      const event: PullRequestConvertedToDraftEvent = {
        action: "converted_to_draft",
        number: pullRequest.number,
        pull_request: pullRequest,
        repository,
        sender: createSender(),
      } as any;

      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-draft",
        installation: { organizationId: "org-uuid-draft" },
      });

      mockTx.gitHubPullRequest.findUnique.mockResolvedValue({
        id: "pr-uuid-draft",
        workstreamId: "ws-uuid-draft",
      });

      mockTx.gitHubPullRequest.update.mockResolvedValue({});

      await handlePullRequest(event);

      expect(mockTx.gitHubPullRequest.update).toHaveBeenCalledWith({
        where: { id: "pr-uuid-draft" },
        data: {
          isDraft: true,
        },
      });
    });
  });

  describe("ready_for_review action", () => {
    it("sets isDraft to false", async () => {
      const repository = createRepository(222);
      const pullRequest = createPullRequest({
        number: 47,
        title: "Ready for review",
        draft: false,
      });

      const event: PullRequestReadyForReviewEvent = {
        action: "ready_for_review",
        number: pullRequest.number,
        pull_request: pullRequest,
        repository,
        sender: createSender(),
      } as any;

      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-ready",
        installation: { organizationId: "org-uuid-ready" },
      });

      mockTx.gitHubPullRequest.findUnique.mockResolvedValue({
        id: "pr-uuid-ready",
        workstreamId: "ws-uuid-ready",
      });

      mockTx.gitHubPullRequest.update.mockResolvedValue({});

      await handlePullRequest(event);

      expect(mockTx.gitHubPullRequest.update).toHaveBeenCalledWith({
        where: { id: "pr-uuid-ready" },
        data: {
          isDraft: false,
        },
      });
    });
  });

  describe("unknown repository", () => {
    it("returns without error when repository is not found", async () => {
      const repository = createRepository(999);
      const pullRequest = createPullRequest({
        number: 50,
        title: "Unknown repo PR",
      });

      const event: PullRequestClosedEvent = {
        action: "closed",
        number: pullRequest.number,
        pull_request: pullRequest,
        repository,
        sender: createSender(),
      } as any;

      // Mock repository not found
      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue(null);

      await handlePullRequest(event);

      // Should not attempt to find PR or update
      expect(mockTx.gitHubPullRequest.findUnique).not.toHaveBeenCalled();
      expect(mockTx.gitHubPullRequest.update).not.toHaveBeenCalled();
    });
  });

  describe("unknown pull request", () => {
    it("returns without error when PR is not found in database", async () => {
      const repository = createRepository(333);
      const pullRequest = createPullRequest({
        number: 51,
        title: "Unknown PR",
      });

      const event: PullRequestReopenedEvent = {
        action: "reopened",
        number: pullRequest.number,
        pull_request: pullRequest,
        repository,
        sender: createSender(),
      } as any;

      // Repository exists
      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-exists",
        installation: { organizationId: "org-uuid-exists" },
      });

      // PR not found
      mockTx.gitHubPullRequest.findUnique.mockResolvedValue(null);

      await handlePullRequest(event);

      // Should not attempt update
      expect(mockTx.gitHubPullRequest.update).not.toHaveBeenCalled();
    });
  });

  describe("unsupported actions", () => {
    it("skips DB queries for unsupported action types", async () => {
      const repository = createRepository(444);
      const pullRequest = createPullRequest({
        number: 52,
        title: "Labeled PR",
      });

      // Create an event with unsupported action
      const event = {
        action: "labeled",
        number: pullRequest.number,
        pull_request: pullRequest,
        repository,
        sender: createSender(),
      } as any;

      await handlePullRequest(event);

      // Should not query DB at all
      expect(
        mockTx.gitHubInstallationRepository.findFirst
      ).not.toHaveBeenCalled();
      expect(mockTx.gitHubPullRequest.findUnique).not.toHaveBeenCalled();
      expect(mockTx.gitHubPullRequest.update).not.toHaveBeenCalled();
      expect(mockTx.workstreamEvent.create).not.toHaveBeenCalled();
    });
  });

  describe("transaction behavior", () => {
    it("executes all reads and writes within a single transaction", async () => {
      const repository = createRepository(555);
      const pullRequest = createPullRequest({
        number: 53,
        title: "Transaction test",
        state: "closed",
        merged: true,
        closed_at: "2026-02-10T14:00:00Z",
        merged_at: "2026-02-10T14:00:00Z",
        merge_commit_sha: "commit-sha",
      });

      const event: PullRequestClosedEvent = {
        action: "closed",
        number: pullRequest.number,
        pull_request: pullRequest,
        repository,
        sender: createSender(),
      } as any;

      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-tx",
        installation: { organizationId: "org-uuid-tx" },
      });

      mockTx.gitHubPullRequest.findUnique.mockResolvedValue({
        id: "pr-uuid-tx",
        workstreamId: "ws-uuid-tx",
        artifactId: "artifact-uuid-tx",
        artifact: { slug: "plan-tx" },
      });

      mockTx.gitHubPullRequest.update.mockResolvedValue({});
      mockTx.workstreamEvent.create.mockResolvedValue({});
      mockTx.artifact.update.mockResolvedValue({});

      await handlePullRequest(event);

      // Verify all operations in single transaction
      expect(mockWithDbTx).toHaveBeenCalledTimes(1);
      expect(mockWithDb).not.toHaveBeenCalled();

      // Verify lookups and mutations all occurred within the transaction
      expect(mockTx.gitHubInstallationRepository.findFirst).toHaveBeenCalled();
      expect(mockTx.gitHubPullRequest.findUnique).toHaveBeenCalled();
      expect(mockTx.gitHubPullRequest.update).toHaveBeenCalled();
      expect(mockTx.workstreamEvent.create).toHaveBeenCalled();
      expect(mockTx.artifact.update).toHaveBeenCalled();
    });
  });

  describe("plan reference linkage", () => {
    const ORG_ID = "org-uuid-link";
    const REPO_ID = "repo-uuid-link";
    const ARTIFACT_ID = "artifact-uuid-link";
    const WORKSTREAM_ID = "ws-uuid-link";

    function setupRepoMock() {
      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: REPO_ID,
        installation: { organizationId: ORG_ID },
      });
    }

    function setupArtifactMock(
      overrides?: Partial<{
        id: string;
        type: string;
        organizationId: string;
        projectId: string | null;
        workstreamId: string | null;
        slug: string;
      }>
    ) {
      mockTx.artifact.findUnique.mockResolvedValue({
        id: ARTIFACT_ID,
        type: ArtifactType.ImplementationPlan,
        title: "Test Plan",
        organizationId: ORG_ID,
        projectId: "project-uuid-link",
        workstreamId: WORKSTREAM_ID,
        createdById: "user-uuid-link",
        slug: "PLAN-42",
        ...overrides,
      });
    }

    function setupPlanRef(slug = "PLAN-42") {
      mockParsePlanReferences.mockReturnValue([
        { slug, matchType: "slug", source: "title" },
      ]);
    }

    function setupLinkageMocks() {
      mockTx.externalLink.findFirst.mockResolvedValue(null);
      mockTx.externalLink.create.mockResolvedValue({ id: "ext-link-uuid" });
      mockTx.entityLink.findFirst.mockResolvedValue(null);
      mockTx.entityLink.create.mockResolvedValue({});
      mockTx.workstreamEvent.create.mockResolvedValue({});
    }

    it("links PR opened with valid PLAN slug to artifact", async () => {
      setupRepoMock();
      setupPlanRef();
      setupArtifactMock();
      setupLinkageMocks();
      mockTx.gitHubPullRequest.findUnique.mockResolvedValue(null);
      mockTx.gitHubPullRequest.create.mockResolvedValue({});

      const event = {
        action: "opened",
        number: 100,
        pull_request: createPullRequest({
          number: 100,
          title: "PLAN-42: Add feature",
        }),
        repository: createRepository(789),
        sender: createSender(),
      } as any;

      await handlePullRequest(event);

      // Should create a new GitHubPullRequest record with artifactId
      expect(mockTx.gitHubPullRequest.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          artifactId: ARTIFACT_ID,
          workstreamId: WORKSTREAM_ID,
          organizationId: ORG_ID,
          repositoryId: REPO_ID,
          number: 100,
          state: GitHubPRState.Open,
        }),
      });

      // Should create ExternalLink
      expect(mockTx.externalLink.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          organizationId: ORG_ID,
          type: ExternalLinkType.PullRequest,
        }),
      });

      // Should create EntityLink
      expect(mockTx.entityLink.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          sourceId: ARTIFACT_ID,
          sourceType: EntityType.Artifact,
          targetType: EntityType.ExternalLink,
          linkType: LinkType.Produces,
        }),
      });

      // Should create GITHUB_PR_LINKED workstream event
      expect(mockTx.workstreamEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          workstreamId: WORKSTREAM_ID,
          type: "GITHUB_PR_LINKED",
          data: expect.objectContaining({
            artifactId: ARTIFACT_ID,
            slug: "PLAN-42",
          }),
        }),
      });
    });

    it("links PR edited to add plan reference retroactively", async () => {
      setupRepoMock();
      setupPlanRef();
      setupArtifactMock();
      setupLinkageMocks();

      // Existing PR without artifactId
      mockTx.gitHubPullRequest.findUnique.mockResolvedValue({
        id: "pr-uuid-edit",
        workstreamId: WORKSTREAM_ID,
        artifactId: null,
        checksStatus: "UNKNOWN",
        artifact: null,
      });
      mockTx.gitHubPullRequest.update.mockResolvedValue({});

      const event = {
        action: "edited",
        number: 101,
        pull_request: createPullRequest({
          number: 101,
          title: "PLAN-42: Updated",
        }),
        repository: createRepository(789),
        sender: createSender(),
        changes: {},
      } as any;

      await handlePullRequest(event);

      // Should update existing PR with artifactId
      expect(mockTx.gitHubPullRequest.update).toHaveBeenCalledWith({
        where: { id: "pr-uuid-edit" },
        data: { artifactId: ARTIFACT_ID },
      });

      // Should create GITHUB_PR_LINKED event for edited action
      expect(mockTx.workstreamEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          type: "GITHUB_PR_LINKED",
        }),
      });
    });

    it("does not fail for invalid slug (returns 200)", async () => {
      setupRepoMock();
      setupPlanRef("PLAN-999");
      mockTx.artifact.findUnique.mockResolvedValue(null); // Not found
      mockTx.gitHubPullRequest.findUnique.mockResolvedValue(null);

      const event = {
        action: "opened",
        number: 102,
        pull_request: createPullRequest({
          number: 102,
          title: "PLAN-999: Missing",
        }),
        repository: createRepository(789),
        sender: createSender(),
      } as any;

      const response = await handlePullRequest(event);
      const json = await response.json();

      expect(json.ok).toBe(true);
      // Should not create any linkage records
      expect(mockTx.externalLink.create).not.toHaveBeenCalled();
      expect(mockTx.entityLink.create).not.toHaveBeenCalled();
    });

    it("does not link PRD-type artifact", async () => {
      setupRepoMock();
      setupPlanRef("PLAN-42");
      setupArtifactMock({ type: ArtifactType.Prd });
      mockTx.gitHubPullRequest.findUnique.mockResolvedValue(null);

      const event = {
        action: "opened",
        number: 103,
        pull_request: createPullRequest({
          number: 103,
          title: "PLAN-42: PRD ref",
        }),
        repository: createRepository(789),
        sender: createSender(),
      } as any;

      await handlePullRequest(event);

      expect(mockTx.externalLink.create).not.toHaveBeenCalled();
      expect(mockTx.gitHubPullRequest.create).not.toHaveBeenCalled();
    });

    it("does not overwrite existing artifactId (AC-004)", async () => {
      setupRepoMock();
      setupPlanRef("PLAN-42");

      // PR already linked to a different artifact
      mockTx.gitHubPullRequest.findUnique.mockResolvedValue({
        id: "pr-uuid-linked",
        workstreamId: WORKSTREAM_ID,
        artifactId: "existing-artifact-id",
        checksStatus: "UNKNOWN",
        artifact: { slug: "PLAN-1" },
      });

      const event = {
        action: "edited",
        number: 104,
        pull_request: createPullRequest({
          number: 104,
          title: "PLAN-42: Override attempt",
        }),
        repository: createRepository(789),
        sender: createSender(),
        changes: {},
      } as any;

      await handlePullRequest(event);

      // Should NOT look up artifact or create linkage
      expect(mockTx.artifact.findUnique).not.toHaveBeenCalled();
      expect(mockTx.externalLink.create).not.toHaveBeenCalled();
    });

    it("does not create duplicate EntityLink on repeated webhook delivery (AC-008)", async () => {
      setupRepoMock();
      setupPlanRef();
      setupArtifactMock();

      // Existing PR without artifactId
      mockTx.gitHubPullRequest.findUnique.mockResolvedValue({
        id: "pr-uuid-dup",
        workstreamId: WORKSTREAM_ID,
        artifactId: null,
        checksStatus: "UNKNOWN",
        artifact: null,
      });
      mockTx.gitHubPullRequest.update.mockResolvedValue({});

      // ExternalLink already exists
      mockTx.externalLink.findFirst.mockResolvedValue({
        id: "existing-ext-link",
      });

      // EntityLink already exists
      mockTx.entityLink.findFirst.mockResolvedValue({
        id: "existing-entity-link",
      });

      mockTx.workstreamEvent.create.mockResolvedValue({});

      const event = {
        action: "reopened",
        number: 105,
        pull_request: createPullRequest({
          number: 105,
          title: "PLAN-42: Reopened",
        }),
        repository: createRepository(789),
        sender: createSender(),
      } as any;

      await handlePullRequest(event);

      // Should NOT create duplicate ExternalLink or EntityLink
      expect(mockTx.externalLink.create).not.toHaveBeenCalled();
      expect(mockTx.entityLink.create).not.toHaveBeenCalled();

      // Should still create workstream event and update PR
      expect(mockTx.workstreamEvent.create).toHaveBeenCalled();
      expect(mockTx.gitHubPullRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { artifactId: ARTIFACT_ID },
        })
      );
    });

    it("PR merge with linked artifactId sets status to EXECUTED (existing behavior)", async () => {
      setupRepoMock();

      mockTx.gitHubPullRequest.findUnique.mockResolvedValue({
        id: "pr-uuid-merge",
        workstreamId: WORKSTREAM_ID,
        artifactId: ARTIFACT_ID,
        checksStatus: "PASSING",
        artifact: { slug: "PLAN-42" },
      });
      mockTx.gitHubPullRequest.update.mockResolvedValue({});
      mockTx.workstreamEvent.create.mockResolvedValue({});
      mockTx.artifact.update.mockResolvedValue({});

      const event: PullRequestClosedEvent = {
        action: "closed",
        number: 106,
        pull_request: createPullRequest({
          number: 106,
          title: "PLAN-42: Feature",
          state: "closed",
          merged: true,
          closed_at: "2026-03-01T12:00:00Z",
          merged_at: "2026-03-01T12:00:00Z",
          merge_commit_sha: "merge-sha",
        }),
        repository: createRepository(789),
        sender: createSender(),
      } as any;

      await handlePullRequest(event);

      expect(mockTx.artifact.update).toHaveBeenCalledWith({
        where: { id: ARTIFACT_ID },
        data: { status: ArtifactStatus.Executed },
      });
    });
  });
});
