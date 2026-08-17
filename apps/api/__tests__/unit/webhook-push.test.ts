import type { PushEvent } from "@octokit/webhooks-types";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  Prisma: {
    join: vi.fn(),
    sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    })),
  },
  ArtifactType: {
    DOCUMENT: "DOCUMENT",
    BRANCH: "BRANCH",

    DEPLOYMENT: "DEPLOYMENT",
  },
  GitHubInstallationStatus: {
    ACTIVE: "ACTIVE",
  },
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@repo/github/artifact-reference-parser", () => ({
  parseArtifactReferences: vi.fn(),
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn(),
}));

vi.mock("@/app/branches/branch-service", () => ({
  branchService: {
    upsertBranchArtifact: vi.fn(),
  },
}));

vi.mock("@/app/branches/file-cache-service", () => ({
  refreshBranchFileChangeCache: vi.fn(),
}));

vi.mock("@/app/commits/commit-service", () => ({
  commitService: {
    recordWebhookCommits: vi.fn(),
  },
}));

vi.mock("@/app/webhooks/github/handlers/dirty-scope-publisher", () => ({
  publishGitHubDirtyScopes: vi.fn(),
}));

vi.mock("@/app/webhooks/github/handlers/branch-activity-producer", () => ({
  GitHubBranchActivityEventName: { Push: "push" },
  persistGitHubBranchActivity: vi.fn().mockResolvedValue({
    status: "no_write",
    reason: "missing_authoritative_timestamp",
  }),
}));

import { withDb } from "@repo/database";
import { parseArtifactReferences } from "@repo/github/artifact-reference-parser";
import { log } from "@repo/observability/log";
import { waitUntil } from "@vercel/functions";
import { branchService } from "@/app/branches/branch-service";
import { refreshBranchFileChangeCache } from "@/app/branches/file-cache-service";
import { commitService } from "@/app/commits/commit-service";
import {
  GitHubBranchActivityEventName,
  persistGitHubBranchActivity,
} from "@/app/webhooks/github/handlers/branch-activity-producer";
import { publishGitHubDirtyScopes } from "@/app/webhooks/github/handlers/dirty-scope-publisher";
import {
  handlePush,
  PushSourceSkipReason,
} from "@/app/webhooks/github/handlers/push-handler";
import { persistedGitHubRepositoryAuthority } from "../fixtures/repository-default-authority";

const mockWithDb = withDb as unknown as Mock;
const mockWithDbTx = withDb.tx as unknown as Mock;
const mockParseArtifactReferences = parseArtifactReferences as unknown as Mock;
const mockWaitUntil = waitUntil as unknown as Mock;
const mockUpsertBranchArtifact =
  branchService.upsertBranchArtifact as unknown as Mock;
const mockRefreshBranchFileChangeCache =
  refreshBranchFileChangeCache as unknown as Mock;
const mockPublishGitHubDirtyScopes =
  publishGitHubDirtyScopes as unknown as Mock;
const mockRecordWebhookCommits =
  commitService.recordWebhookCommits as unknown as Mock;
const mockLogDebug = log.debug as unknown as Mock;
const mockLogWarn = log.warn as unknown as Mock;
const mockPersistGitHubBranchActivity =
  persistGitHubBranchActivity as unknown as Mock;

const mockDb = {
  $executeRaw: vi.fn(),
  $queryRaw: vi.fn(),
  gitHubInstallationRepository: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
  },
  repositoryDefaultObservationReceipt: {
    createMany: vi.fn(),
  },
  artifact: { findFirst: vi.fn() },
  branchDetail: { findUnique: vi.fn() },
  publicRepository: { findMany: vi.fn() },
};

function createRepository(githubId: number, fullName: string) {
  return {
    id: githubId,
    name: fullName.split("/")[1] || fullName,
    full_name: fullName,
    private: false,
    owner: {
      login: fullName.split("/")[0] || "owner",
    },
    pushed_at: "2024-06-15T10:30:00Z",
    default_branch: "main",
  };
}

function createPushEvent(partial: {
  repositoryId: number;
  repositoryFullName: string;
  ref?: string;
  before?: string;
  after?: string;
  commitsCount?: number;
  created?: boolean;
  deleted?: boolean;
}): PushEvent {
  const {
    repositoryId,
    repositoryFullName,
    ref = "refs/heads/fea-1116-branch-artifact",
    before = "abc123",
    after = "def456",
    commitsCount = 1,
    created = false,
    deleted = false,
  } = partial;

  const commits = Array.from({ length: commitsCount }, (_, i) => ({
    id: `commit${i}`,
    tree_id: `tree${i}`,
    distinct: true,
    message: `Commit message ${i}`,
    timestamp: "2021-01-01T00:00:00Z",
    url: "",
    author: {
      name: "Test User",
      email: "test@example.com",
      username: "testuser",
    },
    committer: {
      name: "Test User",
      email: "test@example.com",
      username: "testuser",
    },
    added: [],
    removed: [],
    modified: [],
  }));

  return {
    ref,
    before,
    after,
    repository: createRepository(repositoryId, repositoryFullName),
    pusher: {
      name: "testuser",
      email: "test@example.com",
    },
    sender: {
      login: "testuser",
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
      type: "User",
      site_admin: false,
    },
    created,
    deleted,
    forced: false,
    base_ref: null,
    compare: "",
    commits,
    head_commit: commits[0] || null,
    installation: {
      id: 123_456,
      node_id: "I_123456",
    },
    organization: undefined,
  } as unknown as PushEvent;
}

describe("handlePush", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockWithDb.mockImplementation((callback) => callback(mockDb));
    mockWithDbTx.mockImplementation((callback) => callback(mockDb));
    const authority = persistedGitHubRepositoryAuthority({
      githubRepoId: "123",
      fullName: "owner/repo",
    });
    mockDb.gitHubInstallationRepository.findFirst.mockResolvedValue({
      id: "repo-db-1",
      installationId: "installation-db-1",
      ...authority,
      installation: { organizationId: "org-1" },
    });
    mockDb.gitHubInstallationRepository.findMany.mockResolvedValue([authority]);
    mockDb.publicRepository.findMany.mockResolvedValue([]);
    mockDb.repositoryDefaultObservationReceipt.createMany.mockResolvedValue({
      count: 1,
    });
    mockDb.$executeRaw.mockResolvedValue(1);
    mockDb.$queryRaw.mockResolvedValue([authority]);
    mockDb.gitHubInstallationRepository.updateMany.mockResolvedValue({
      count: 1,
    });
    mockDb.artifact.findFirst.mockResolvedValue({
      id: "source-artifact-1",
      createdById: "source-user-1",
      projectId: "project-1",
    });
    mockDb.branchDetail.findUnique.mockResolvedValue(null);
    mockParseArtifactReferences.mockReturnValue([
      {
        slug: "FEA-1116",
        docType: "FEATURE",
        prefix: "FEA",
        matchType: "slug",
        source: "branch",
      },
    ]);
    mockUpsertBranchArtifact.mockResolvedValue({
      ok: true,
      value: { id: "branch-artifact-1" },
    });
    mockRefreshBranchFileChangeCache.mockResolvedValue({
      ok: true,
      value: { fileCount: 1, patchBytes: 10 },
    });
    mockPublishGitHubDirtyScopes.mockResolvedValue(undefined);
    mockRecordWebhookCommits.mockResolvedValue({ written: 1 });
    mockWaitUntil.mockImplementation((promise) => promise);
  });

  describe("commit persistence (FEA-2731)", () => {
    it("persists push commits through the commit service with GitHub-mapped fields", async () => {
      const event = createPushEvent({
        repositoryId: 111,
        repositoryFullName: "owner/repo",
        commitsCount: 1,
      });
      event.commits[0].id = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";
      event.commits[0].message = "feat: real subject";
      event.commits[0].added = ["a.ts", "b.ts"];
      event.commits[0].modified = ["c.ts"];
      event.commits[0].removed = [];

      await handlePush(event);

      expect(mockRecordWebhookCommits).toHaveBeenCalledTimes(1);
      const arg = mockRecordWebhookCommits.mock.calls[0][0];
      expect(arg).toMatchObject({
        organizationId: "org-1",
        repositoryFullName: "owner/repo",
        branchArtifactId: "branch-artifact-1",
      });
      expect(arg.commits).toHaveLength(1);
      expect(arg.commits[0]).toMatchObject({
        sha: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
        message: "feat: real subject",
        authorName: "Test User",
        authorEmail: "test@example.com",
        authorLogin: "testuser",
        filesChanged: 3, // added(2) + modified(1) + removed(0)
      });
      expect(arg.commits[0].committedAt).toEqual(
        new Date("2021-01-01T00:00:00Z")
      );
    });

    it("does not persist commits for a branch deletion", async () => {
      const event = createPushEvent({
        repositoryId: 111,
        repositoryFullName: "owner/repo",
        deleted: true,
        commitsCount: 1,
      });
      await handlePush(event);
      expect(mockRecordWebhookCommits).not.toHaveBeenCalled();
    });

    it("does not persist when the push carries zero commits", async () => {
      const event = createPushEvent({
        repositoryId: 111,
        repositoryFullName: "owner/repo",
        commitsCount: 0,
      });
      await handlePush(event);
      expect(mockRecordWebhookCommits).not.toHaveBeenCalled();
    });

    it("acks the webhook even when commit persistence throws (best-effort)", async () => {
      mockRecordWebhookCommits.mockRejectedValue(new Error("db down"));
      const event = createPushEvent({
        repositoryId: 111,
        repositoryFullName: "owner/repo",
        commitsCount: 1,
      });
      const response = await handlePush(event);
      expect(response.status).toBe(200);
      expect(mockPublishGitHubDirtyScopes).toHaveBeenCalled();
    });
  });

  describe("tracked repository", () => {
    it("updates lastPushedAt from payload timestamp when repository exists", async () => {
      const event = createPushEvent({
        repositoryId: 123,
        repositoryFullName: "owner/repo",
        commitsCount: 3,
      });

      mockDb.gitHubInstallationRepository.updateMany.mockResolvedValue({
        count: 1,
      });

      const response = await handlePush(event, {
        deliveryId: "push-delivery-1",
        observedAt: new Date("2026-08-12T14:00:00.000Z"),
      });
      const json = await response.json();

      expect(json).toEqual({
        message: "Push event processed successfully",
        ok: true,
      });

      expect(
        mockDb.gitHubInstallationRepository.updateMany
      ).toHaveBeenCalledWith({
        where: {
          id: "repo-db-1",
          OR: [
            { lastPushedAt: null },
            {
              lastPushedAt: { lt: new Date("2024-06-15T10:30:00Z") },
            },
          ],
        },
        data: { lastPushedAt: new Date("2024-06-15T10:30:00Z") },
      });
      expect(mockUpsertBranchArtifact).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: "org-1",
          repositoryId: "repo-db-1",
          branchName: "fea-1116-branch-artifact",
          sourceArtifactId: "source-artifact-1",
          createdById: "source-user-1",
          beforeSha: "abc123",
          headSha: "def456",
          headShaObservedAt: new Date("2024-06-15T10:30:00Z"),
          isCreate: false,
        })
      );
      expect(mockPersistGitHubBranchActivity).toHaveBeenCalledWith({
        eventName: GitHubBranchActivityEventName.Push,
        deliveryId: "push-delivery-1",
        payload: event,
        attribution: {
          organizationId: "org-1",
          branchArtifactId: "branch-artifact-1",
        },
      });
      expect(mockWaitUntil).toHaveBeenCalled();
    });

    it("does not apply repository authority from an older provider event", async () => {
      const event = createPushEvent({
        repositoryId: 123,
        repositoryFullName: "owner/repo",
        ref: "refs/heads/main",
      });
      (event.repository as any).pushed_at = "2024-06-15T10:00:00Z";
      mockDb.gitHubInstallationRepository.updateMany.mockResolvedValueOnce({
        count: 0,
      });
      mockDb.gitHubInstallationRepository.findUnique.mockResolvedValueOnce({
        lastPushedAt: new Date("2024-06-15T11:00:00Z"),
      });

      const response = await handlePush(event, {
        deliveryId: "stale-delivery",
        observedAt: new Date("2024-06-15T12:00:00.000Z"),
      });

      expect(await response.json()).toEqual({
        message: "Default branch push ignored",
        ok: true,
      });
      expect(mockDb.$executeRaw).not.toHaveBeenCalled();
      expect(
        mockDb.gitHubInstallationRepository.findUnique
      ).toHaveBeenCalledWith({
        where: { id: "repo-db-1" },
        select: { lastPushedAt: true },
      });
    });

    it("passes GitHub created pushes through as branch-create observations", async () => {
      const event = createPushEvent({
        repositoryId: 123,
        repositoryFullName: "owner/repo",
        before: "0000000000000000000000000000000000000000",
        after: "sha-recreated",
        created: true,
      });

      const response = await handlePush(event);
      const json = await response.json();

      expect(json).toEqual({
        message: "Push event processed successfully",
        ok: true,
      });
      expect(mockUpsertBranchArtifact).toHaveBeenCalledWith(
        expect.objectContaining({
          beforeSha: "0000000000000000000000000000000000000000",
          headSha: "sha-recreated",
          headShaObservedAt: new Date("2024-06-15T10:30:00Z"),
          isCreate: true,
          isDelete: false,
          deletedAt: null,
        })
      );
    });

    it("passes GitHub deleted pushes through as tombstone observations", async () => {
      const event = createPushEvent({
        repositoryId: 123,
        repositoryFullName: "owner/repo",
        before: "deleted-head",
        after: "0000000000000000000000000000000000000000",
        deleted: true,
      });

      const response = await handlePush(event);
      const json = await response.json();

      expect(json).toEqual({
        message: "Push event processed successfully",
        ok: true,
      });
      expect(mockUpsertBranchArtifact).toHaveBeenCalledWith(
        expect.objectContaining({
          beforeSha: "deleted-head",
          headSha: null,
          headShaSource: null,
          headShaObservedAt: new Date("2024-06-15T10:30:00Z"),
          isCreate: false,
          isDelete: true,
          deletedAt: new Date("2024-06-15T10:30:00Z"),
        })
      );
      expect(mockWaitUntil).not.toHaveBeenCalled();
    });

    it("matches repository by githubRepoId and installationId from the push payload", async () => {
      const event = createPushEvent({
        repositoryId: 456,
        repositoryFullName: "org/my-repo",
        ref: "refs/heads/feature-branch",
      });

      mockDb.gitHubInstallationRepository.updateMany.mockResolvedValue({
        count: 1,
      });

      await handlePush(event);

      expect(
        mockDb.gitHubInstallationRepository.updateMany
      ).toHaveBeenCalledWith({
        where: {
          id: "repo-db-1",
          OR: [
            { lastPushedAt: null },
            {
              lastPushedAt: { lt: new Date("2024-06-15T10:30:00Z") },
            },
          ],
        },
        data: { lastPushedAt: new Date("2024-06-15T10:30:00Z") },
      });
    });

    it("correctly handles numeric pushed_at (Unix seconds) from GitHub", async () => {
      const event = createPushEvent({
        repositoryId: 123,
        repositoryFullName: "owner/repo",
      });

      (event.repository as any).pushed_at = 1_718_444_200;

      mockDb.gitHubInstallationRepository.updateMany.mockResolvedValue({
        count: 1,
      });

      await handlePush(event);

      const calledWith = mockDb.gitHubInstallationRepository.updateMany.mock
        .calls[0][0].data.lastPushedAt as Date;

      expect(calledWith.getFullYear()).toBe(2024);
      expect(calledWith).toEqual(new Date(1_718_444_200 * 1000));
    });
  });

  describe("unknown repository", () => {
    it("returns success without error when repository not found", async () => {
      const event = createPushEvent({
        repositoryId: 999,
        repositoryFullName: "unknown/repo",
      });

      mockDb.gitHubInstallationRepository.findFirst.mockResolvedValue(null);

      const response = await handlePush(event);
      const json = await response.json();

      expect(json).toEqual({
        message: "Repository not tracked, ignoring push event",
        ok: true,
      });
    });
  });

  describe("multiple pushes", () => {
    it("uses payload timestamp so redeliveries preserve correct ordering", async () => {
      mockDb.gitHubInstallationRepository.updateMany.mockResolvedValue({
        count: 1,
      });

      const event1 = createPushEvent({
        repositoryId: 123,
        repositoryFullName: "owner/repo",
        after: "abc123",
      });
      (event1.repository as any).pushed_at = "2024-06-15T10:00:00Z";
      await handlePush(event1);

      const firstCallTime = (
        mockDb.gitHubInstallationRepository.updateMany.mock.calls[0][0].data
          .lastPushedAt as Date
      ).getTime();

      const event2 = createPushEvent({
        repositoryId: 123,
        repositoryFullName: "owner/repo",
        after: "def456",
      });
      (event2.repository as any).pushed_at = "2024-06-15T11:00:00Z";
      await handlePush(event2);

      const secondCallTime = (
        mockDb.gitHubInstallationRepository.updateMany.mock.calls[1][0].data
          .lastPushedAt as Date
      ).getTime();

      expect(secondCallTime).toBeGreaterThan(firstCallTime);
      expect(
        mockDb.gitHubInstallationRepository.updateMany
      ).toHaveBeenCalledTimes(2);
    });
  });

  describe("installation scoping", () => {
    it("scopes update to specific installation when installation ID is present", async () => {
      const event = createPushEvent({
        repositoryId: 789,
        repositoryFullName: "owner/repo",
      });

      mockDb.gitHubInstallationRepository.updateMany.mockResolvedValue({
        count: 1,
      });

      await handlePush(event);

      expect(
        mockDb.gitHubInstallationRepository.updateMany
      ).toHaveBeenCalledWith({
        where: {
          id: "repo-db-1",
          OR: [
            { lastPushedAt: null },
            {
              lastPushedAt: { lt: new Date("2024-06-15T10:30:00Z") },
            },
          ],
        },
        data: { lastPushedAt: new Date("2024-06-15T10:30:00Z") },
      });
    });

    it("fails closed before database access when installation identity is missing", async () => {
      const event = createPushEvent({
        repositoryId: 789,
        repositoryFullName: "owner/repo",
      });

      (event as any).installation = undefined;

      const response = await handlePush(event);

      expect(await response.json()).toEqual({
        message: "Push event missing installation identity, ignoring",
        ok: true,
      });
      expect(mockWithDb).not.toHaveBeenCalled();
      expect(mockWithDbTx).not.toHaveBeenCalled();
      expect(mockPersistGitHubBranchActivity).not.toHaveBeenCalled();
      expect(
        mockDb.gitHubInstallationRepository.findFirst
      ).not.toHaveBeenCalled();
      expect(
        mockDb.gitHubInstallationRepository.updateMany
      ).not.toHaveBeenCalled();
    });
  });

  describe("edge cases", () => {
    it("limits a duplicate delivery receipt to authority while preserving branch work", async () => {
      const event = createPushEvent({
        repositoryId: 123,
        repositoryFullName: "owner/repo",
        ref: "refs/heads/feature/replayed",
      });
      mockDb.repositoryDefaultObservationReceipt.createMany.mockResolvedValueOnce(
        { count: 0 }
      );

      const response = await handlePush(event, {
        deliveryId: "delivery-replayed",
        observedAt: new Date("2026-08-10T20:00:00.000Z"),
      });

      expect((await response.json()).ok).toBe(true);
      expect(
        mockDb.gitHubInstallationRepository.updateMany
      ).not.toHaveBeenCalled();
      expect(mockDb.$executeRaw).not.toHaveBeenCalled();
      expect(mockUpsertBranchArtifact).toHaveBeenCalledOnce();
      expect(mockRecordWebhookCommits).toHaveBeenCalledOnce();
    });

    it("handles push with zero commits", async () => {
      const event = createPushEvent({
        repositoryId: 123,
        repositoryFullName: "owner/repo",
        commitsCount: 0,
      });

      mockDb.gitHubInstallationRepository.updateMany.mockResolvedValue({
        count: 1,
      });

      const response = await handlePush(event);
      const json = await response.json();

      expect(json.ok).toBe(true);
      expect(mockDb.gitHubInstallationRepository.updateMany).toHaveBeenCalled();
    });

    it("handles push to non-main branch", async () => {
      const event = createPushEvent({
        repositoryId: 123,
        repositoryFullName: "owner/repo",
        ref: "refs/heads/feature/new-feature",
      });

      mockDb.gitHubInstallationRepository.updateMany.mockResolvedValue({
        count: 1,
      });

      const response = await handlePush(event);
      const json = await response.json();

      expect(json.ok).toBe(true);
      expect(mockDb.gitHubInstallationRepository.updateMany).toHaveBeenCalled();
    });

    it("skips default branch pushes without materializing a branch artifact", async () => {
      const event = createPushEvent({
        repositoryId: 123,
        repositoryFullName: "owner/repo",
        ref: "refs/heads/main",
      });

      const response = await handlePush(event);
      const json = await response.json();

      expect(json).toEqual({
        message: "Default branch push ignored",
        ok: true,
      });
      expect(mockUpsertBranchArtifact).not.toHaveBeenCalled();
      expect(mockWaitUntil).not.toHaveBeenCalled();
    });

    it("does not schedule a cache refresh when stale push replay is rejected", async () => {
      const event = createPushEvent({
        repositoryId: 123,
        repositoryFullName: "owner/repo",
      });
      mockUpsertBranchArtifact.mockResolvedValueOnce({
        ok: false,
        error: 409,
      });

      const response = await handlePush(event);
      const json = await response.json();

      expect(json).toEqual({ message: "Stale branch push ignored", ok: true });
      expect(mockWaitUntil).not.toHaveBeenCalled();
    });

    it("logs a warning when the scheduled cache refresh throws (FEA-3327)", async () => {
      const event = createPushEvent({
        repositoryId: 123,
        repositoryFullName: "owner/repo",
      });
      const refreshError = new Error("github compare failed");
      mockRefreshBranchFileChangeCache.mockRejectedValueOnce(refreshError);

      const response = await handlePush(event);
      const json = await response.json();

      expect(json.ok).toBe(true);
      await mockWaitUntil.mock.calls[0][0];

      expect(mockLogWarn).toHaveBeenCalledWith(
        "[handlePush] Branch file-cache refresh failed",
        expect.objectContaining({
          branchArtifactId: "branch-artifact-1",
          error: "github compare failed",
        })
      );
    });

    it("updates an existing branch artifact when the branch name has no document slug", async () => {
      const event = createPushEvent({
        repositoryId: 123,
        repositoryFullName: "owner/repo",
        ref: "refs/heads/manual/no-slug-branch",
        before: "old-head",
        after: "new-head",
      });
      mockParseArtifactReferences.mockReturnValueOnce([]);
      mockDb.branchDetail.findUnique.mockResolvedValueOnce({
        artifact: {
          projectId: "project-existing",
          targetLinks: [],
        },
      });

      const response = await handlePush(event);
      const json = await response.json();

      expect(json).toEqual({
        message: "Push event processed successfully",
        ok: true,
      });
      expect(mockUpsertBranchArtifact).toHaveBeenCalledWith(
        expect.objectContaining({
          branchName: "manual/no-slug-branch",
          projectId: "project-existing",
          sourceArtifactId: null,
          createdById: null,
          beforeSha: "old-head",
          headSha: "new-head",
        })
      );
      expect(mockWaitUntil).toHaveBeenCalled();
    });

    it("carries linked source artifact creator for an existing no-slug branch", async () => {
      const event = createPushEvent({
        repositoryId: 123,
        repositoryFullName: "owner/repo",
        ref: "refs/heads/manual/no-slug-linked-branch",
        before: "old-head",
        after: "new-head",
      });
      mockParseArtifactReferences.mockReturnValueOnce([]);
      mockDb.branchDetail.findUnique.mockResolvedValueOnce({
        artifact: {
          projectId: "project-existing",
          targetLinks: [
            {
              source: {
                id: "linked-source-artifact",
                createdById: "linked-source-user",
              },
            },
          ],
        },
      });

      const response = await handlePush(event);
      const json = await response.json();

      expect(json).toEqual({
        message: "Push event processed successfully",
        ok: true,
      });
      expect(mockUpsertBranchArtifact).toHaveBeenCalledWith(
        expect.objectContaining({
          branchName: "manual/no-slug-linked-branch",
          projectId: "project-existing",
          sourceArtifactId: "linked-source-artifact",
          createdById: "linked-source-user",
          beforeSha: "old-head",
          headSha: "new-head",
        })
      );
      expect(mockWaitUntil).toHaveBeenCalled();
    });

    it("skips a first-observed no-slug branch instead of inferring a project from repository defaults", async () => {
      const event = createPushEvent({
        repositoryId: 123,
        repositoryFullName: "owner/repo",
        ref: "refs/heads/manual/no-slug-default",
        before: "old-head",
        after: "new-head",
      });
      mockParseArtifactReferences.mockReturnValueOnce([]);
      mockDb.branchDetail.findUnique.mockResolvedValueOnce(null);

      const response = await handlePush(event);
      const json = await response.json();

      expect(json).toEqual({
        message: "No resolvable lineage for branch push",
        ok: true,
      });
      expect(mockUpsertBranchArtifact).not.toHaveBeenCalled();
      expect(mockWaitUntil).not.toHaveBeenCalled();
      expect(mockLogDebug).toHaveBeenCalledWith(
        "[handlePush] Branch push skipped, no resolvable lineage",
        expect.objectContaining({
          branchName: "manual/no-slug-default",
          reason: PushSourceSkipReason.UnresolvedBranchLineage,
        })
      );
    });

    it("does not persist commits or publish dirty scopes for a skipped no-slug branch", async () => {
      const event = createPushEvent({
        repositoryId: 123,
        repositoryFullName: "owner/repo",
        ref: "refs/heads/manual/no-slug-commits",
        commitsCount: 1,
      });
      mockParseArtifactReferences.mockReturnValueOnce([]);
      mockDb.branchDetail.findUnique.mockResolvedValueOnce(null);

      await handlePush(event);

      expect(mockRecordWebhookCommits).not.toHaveBeenCalled();
      expect(mockPublishGitHubDirtyScopes).not.toHaveBeenCalled();
    });

    it("resolves a repo-less desktop-first branch row by the D2 identity key", async () => {
      const event = createPushEvent({
        repositoryId: 123,
        repositoryFullName: "owner/repo",
        ref: "refs/heads/manual/desktop-first",
        before: "old-head",
        after: "new-head",
      });
      mockParseArtifactReferences.mockReturnValueOnce([]);
      mockDb.branchDetail.findUnique.mockResolvedValueOnce({
        artifact: {
          projectId: null,
          targetLinks: [],
        },
      });

      const response = await handlePush(event);
      const json = await response.json();

      expect(json).toEqual({
        message: "Push event processed successfully",
        ok: true,
      });
      expect(mockDb.branchDetail.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            organizationId_repositoryFullName_branchName: {
              organizationId: "org-1",
              repositoryFullName: "owner/repo",
              branchName: "manual/desktop-first",
            },
          },
        })
      );
      expect(mockUpsertBranchArtifact).toHaveBeenCalledWith(
        expect.objectContaining({
          branchName: "manual/desktop-first",
          repositoryId: "repo-db-1",
          projectId: null,
        })
      );
    });

    it("handles push with many commits", async () => {
      const event = createPushEvent({
        repositoryId: 123,
        repositoryFullName: "owner/repo",
        commitsCount: 50,
      });

      mockDb.gitHubInstallationRepository.updateMany.mockResolvedValue({
        count: 1,
      });

      const response = await handlePush(event);
      const json = await response.json();

      expect(json.ok).toBe(true);
      expect(mockDb.gitHubInstallationRepository.updateMany).toHaveBeenCalled();
    });
  });
});
