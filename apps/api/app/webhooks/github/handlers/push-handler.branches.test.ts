import type { Commit, PushEvent } from "@octokit/webhooks-types";
import {
  BranchBaseBranchSource,
  BranchHeadShaSource,
  BranchPushSource,
  LinkType,
} from "@repo/api/src/types/artifact";
import { DocumentType } from "@repo/api/src/types/document";
import { GitHubActorType } from "@repo/api/src/types/github-actor";
import { Status } from "@repo/api/src/types/result";
import { expandSlugAliases, SlugPrefix } from "@repo/api/src/types/slug-prefix";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ISS-12552: the branch write's attribution read, which never reaches PostHog here.
vi.mock("@/lib/attribution-evidence-policy-feature", () => ({
  readAttributionEvidenceForRequest: vi.fn(async () => undefined),
}));
vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "@/__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule();
});

vi.mock("@repo/observability/log", () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("@repo/github/artifact-reference-parser", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@repo/github/artifact-reference-parser")
  >()),
  parseArtifactReferences: vi.fn(),
}));

vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));

vi.mock("@/app/branches/branch-service", () => ({
  branchService: { upsertBranchArtifact: vi.fn() },
}));

vi.mock("@/app/branches/branch-push-contribution-service", () => ({
  invalidateBranchPushCoverageAfterWebhook: vi.fn(),
}));
vi.mock("@/app/branches/branch-push-backfill-service", () => ({
  branchPushBackfillService: {
    captureWebhookPush: vi.fn(async () => undefined),
  },
}));

vi.mock("@/app/branches/branch-write-eligibility", () => ({
  resolveCloudBranchWriteEligibility: vi.fn(),
}));

vi.mock("@/app/branches/file-cache-service", () => ({
  refreshBranchFileChangeCache: vi.fn(),
}));

vi.mock("@/app/commits/commit-service", () => ({
  commitService: { recordWebhookCommits: vi.fn() },
}));

vi.mock("@/app/integrations/github/service/repository-sync", () => ({
  bulkUpsertInstallationRepositories: vi.fn(),
}));

vi.mock("@/lib/github/repository-default-authority", () => ({
  mapGitHubWebhookRepositoryDefaultAuthority: vi.fn(),
}));

vi.mock("@/app/webhooks/github/handlers/dirty-scope-publisher", () => ({
  publishGitHubDirtyScopes: vi.fn(),
}));

vi.mock("@/app/webhooks/github/handlers/push-loc-evidence", () => ({
  capturePushBranchActivity: vi.fn(),
}));

import { ArtifactType } from "@repo/database";
import {
  MatchSource,
  MatchType,
  parseArtifactReferences,
} from "@repo/github/artifact-reference-parser";
import { log } from "@repo/observability/log";
import { waitUntil } from "@vercel/functions";
import { getMockWithDb, mockWithDbAll } from "@/__tests__/utils/db-helpers";
import { branchPushBackfillService } from "@/app/branches/branch-push-backfill-service";
import { invalidateBranchPushCoverageAfterWebhook } from "@/app/branches/branch-push-contribution-service";
import { branchService } from "@/app/branches/branch-service";
import { resolveCloudBranchWriteEligibility } from "@/app/branches/branch-write-eligibility";
import { refreshBranchFileChangeCache } from "@/app/branches/file-cache-service";
import { commitService } from "@/app/commits/commit-service";
import { bulkUpsertInstallationRepositories } from "@/app/integrations/github/service/repository-sync";
import { publishGitHubDirtyScopes } from "@/app/webhooks/github/handlers/dirty-scope-publisher";
import { handlePush } from "@/app/webhooks/github/handlers/push-handler";
import { mapGitHubWebhookRepositoryDefaultAuthority } from "@/lib/github/repository-default-authority";
import { githubAppWebhookFetchProvenance } from "@/lib/github-fetch-provenance";

const ORG_ID = "org-1";
const REPO_ROW_ID = "repo-db-1";
const REPO_FULL_NAME = "owner/repo";
const BRANCH_ARTIFACT_ID = "branch-artifact-1";
const PUSHED_AT = "2024-06-15T10:30:00.000Z";
const SYSTEM_NOW = new Date("2026-09-01T12:00:00.000Z");
const ISSUE_SLUG = `${SlugPrefix.Issue}-42`;
const BRANCH_NAME = "iss-42-push-branches";

const mockDb = {
  artifact: { findFirst: vi.fn() },
  branchDetail: { findUnique: vi.fn() },
  gitHubInstallationRepository: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
  },
  repositoryDefaultObservationReceipt: { createMany: vi.fn() },
};

function pushCommit(overrides: Partial<Commit> = {}): Commit {
  return {
    id: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
    tree_id: "tree-1",
    distinct: true,
    message: "feat: add thing",
    timestamp: "2026-01-01T00:00:00Z",
    url: "",
    author: { name: "Test User", email: "test@example.com", username: "tu" },
    committer: { name: "Test User", email: "test@example.com" },
    added: ["a.ts"],
    modified: ["b.ts"],
    removed: ["c.ts"],
    ...overrides,
  };
}

function pushEvent(
  overrides: { ref?: string; pushedAt?: string | null; commits?: Commit[] } = {}
): PushEvent {
  const event = {} as PushEvent;
  return Object.assign(event, {
    ref: overrides.ref ?? `refs/heads/${BRANCH_NAME}`,
    before: "before-sha",
    after: "after-sha",
    commits: overrides.commits ?? [pushCommit()],
    created: false,
    deleted: false,
    installation: { id: 123_456 },
    repository: {
      id: 123,
      full_name: REPO_FULL_NAME,
      name: "repo",
      owner: { login: "owner" },
      private: false,
      default_branch: "main",
      pushed_at:
        overrides.pushedAt === undefined ? PUSHED_AT : overrides.pushedAt,
    },
  });
}

function expectedUpsertInput(overrides: Record<string, unknown> = {}) {
  const pushedAt = new Date(PUSHED_AT);
  return {
    organizationId: ORG_ID,
    repositoryId: REPO_ROW_ID,
    repositoryFullName: REPO_FULL_NAME,
    branchName: BRANCH_NAME,
    defaultBranch: "main",
    projectId: "project-1",
    // ISS-10995: lineage is a FILL, so a later push cannot re-file a branch a
    // user filed from the Details Project row. Exact-match, so dropping the
    // flag at the call site fails here.
    projectFillOnly: true,
    sourceArtifactId: "source-artifact-1",
    createdById: "source-user-1",
    baseBranch: "main",
    baseBranchSource: BranchBaseBranchSource.RepositoryDefault,
    headSha: "after-sha",
    headShaSource: BranchHeadShaSource.PushWebhook,
    headShaObservedAt: pushedAt,
    activityAt: null,
    firstPushedAt: pushedAt,
    pushSource: BranchPushSource.Webhook,
    fetchProvenance: githubAppWebhookFetchProvenance(SYSTEM_NOW),
    beforeSha: "before-sha",
    isCreate: false,
    isDelete: false,
    deletedAt: null,
    ...overrides,
  };
}

async function settleDeferredWork(): Promise<void> {
  await Promise.all(
    vi.mocked(waitUntil).mock.calls.map(([promise]) => promise)
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(SYSTEM_NOW);
  mockWithDbAll(mockDb);
  mockDb.gitHubInstallationRepository.findFirst.mockResolvedValue({
    id: REPO_ROW_ID,
    installationId: "installation-db-1",
    fullName: REPO_FULL_NAME,
    installation: { organizationId: ORG_ID },
  });
  mockDb.gitHubInstallationRepository.updateMany.mockResolvedValue({
    count: 1,
  });
  mockDb.repositoryDefaultObservationReceipt.createMany.mockResolvedValue({
    count: 1,
  });
  mockDb.artifact.findFirst.mockResolvedValue({
    id: "source-artifact-1",
    createdById: "source-user-1",
    projectId: "project-1",
  });
  mockDb.branchDetail.findUnique.mockResolvedValue(null);
  vi.mocked(parseArtifactReferences).mockReturnValue([
    {
      slug: ISSUE_SLUG,
      prefix: SlugPrefix.Issue,
      docType: DocumentType.Feature,
      matchType: MatchType.Slug,
      source: MatchSource.Title,
    },
  ]);
  vi.mocked(resolveCloudBranchWriteEligibility).mockResolvedValue({
    kind: "eligible",
  });
  vi.mocked(branchService.upsertBranchArtifact).mockResolvedValue({
    ok: true,
    value: { id: BRANCH_ARTIFACT_ID },
  } as never);
  vi.mocked(refreshBranchFileChangeCache).mockResolvedValue({
    ok: true,
    value: { fileCount: 1, patchBytes: 10 },
  } as never);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("handlePush ref and timestamp handling", () => {
  it("acks a tag push without touching the database", async () => {
    const response = await handlePush(pushEvent({ ref: "refs/tags/v1.0.0" }));

    expect(await response.json()).toEqual({
      message: "Ignoring non-branch push ref",
      ok: true,
    });
    expect(getMockWithDb()).not.toHaveBeenCalled();
    expect(getMockWithDb().tx).not.toHaveBeenCalled();
    expect(branchService.upsertBranchArtifact).not.toHaveBeenCalled();
  });

  it("stamps the push at receipt time when the payload has no pushed_at", async () => {
    await handlePush(pushEvent({ pushedAt: null }));

    expect(mockDb.gitHubInstallationRepository.updateMany).toHaveBeenCalledWith(
      {
        where: {
          id: REPO_ROW_ID,
          OR: [{ lastPushedAt: null }, { lastPushedAt: { lt: SYSTEM_NOW } }],
        },
        data: { lastPushedAt: SYSTEM_NOW },
      }
    );
    expect(branchService.upsertBranchArtifact).toHaveBeenCalledWith(
      expectedUpsertInput({
        headShaObservedAt: SYSTEM_NOW,
        firstPushedAt: SYSTEM_NOW,
      })
    );
  });
});

describe("handlePush branch materialization outcomes", () => {
  it("acks a non-conflict rejection as rejected and skips all follow-up work", async () => {
    vi.mocked(branchService.upsertBranchArtifact).mockResolvedValue({
      ok: false,
      error: Status.NotFound,
    });

    const response = await handlePush(pushEvent());

    expect(await response.json()).toEqual({
      message: "Branch push rejected",
      ok: true,
    });
    expect(log.debug).toHaveBeenCalledWith(
      "[handlePush] Branch materialization skipped",
      {
        branchName: BRANCH_NAME,
        repositoryFullName: REPO_FULL_NAME,
        status: Status.NotFound,
      }
    );
    expect(waitUntil).not.toHaveBeenCalled();
    expect(commitService.recordWebhookCommits).not.toHaveBeenCalled();
    expect(publishGitHubDirtyScopes).not.toHaveBeenCalled();
  });

  it("logs nothing when the deferred file-cache refresh succeeds", async () => {
    await handlePush(pushEvent());
    await settleDeferredWork();

    expect(refreshBranchFileChangeCache).toHaveBeenCalledWith(
      BRANCH_ARTIFACT_ID,
      { organizationId: ORG_ID }
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("warns when the deferred file-cache refresh returns a failed result", async () => {
    vi.mocked(refreshBranchFileChangeCache).mockResolvedValue({
      ok: false,
      error: Status.ServiceUnavailable,
    });

    const response = await handlePush(pushEvent());
    await settleDeferredWork();

    expect((await response.json()).ok).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(
      "[handlePush] Branch file-cache refresh did not complete",
      {
        branchArtifactId: BRANCH_ARTIFACT_ID,
        status: Status.ServiceUnavailable,
      }
    );
    expect(log.warn).not.toHaveBeenCalledWith(
      "[handlePush] Branch file-cache refresh failed",
      expect.anything()
    );
  });

  it("stringifies a non-Error file-cache refresh rejection", async () => {
    vi.mocked(refreshBranchFileChangeCache).mockRejectedValue("socket hang up");

    await handlePush(pushEvent());
    await settleDeferredWork();

    expect(log.warn).toHaveBeenCalledWith(
      "[handlePush] Branch file-cache refresh failed",
      {
        branchArtifactId: BRANCH_ARTIFACT_ID,
        organizationId: ORG_ID,
        error: "socket hang up",
      }
    );
  });

  it("passes an explicit undefined observation when a fresh delivery yields no authority", async () => {
    vi.mocked(mapGitHubWebhookRepositoryDefaultAuthority).mockReturnValue(
      undefined
    );

    await handlePush(pushEvent(), {
      deliveryId: "delivery-1",
      observedAt: new Date("2026-08-12T14:00:00.000Z"),
    });

    expect(bulkUpsertInstallationRepositories).not.toHaveBeenCalled();
    expect(resolveCloudBranchWriteEligibility).toHaveBeenCalledWith(mockDb, {
      organizationId: ORG_ID,
      repositoryId: REPO_ROW_ID,
      repositoryFullName: REPO_FULL_NAME,
      branchName: BRANCH_NAME,
      repositoryDefaultObservation: undefined,
    });
    const [, eligibilityInput] = vi.mocked(resolveCloudBranchWriteEligibility)
      .mock.calls[0];
    expect(
      Object.hasOwn(eligibilityInput, "repositoryDefaultObservation")
    ).toBe(true);
  });

  it("invalidates coverage and supplies the verified delivery account to the exact-transition lookup", async () => {
    const event = Object.assign(pushEvent(), {
      before: "a".repeat(40),
      after: "b".repeat(40),
      sender: { id: 123, login: "alice", type: GitHubActorType.User },
    });
    await handlePush(event, {
      deliveryId: "delivery-pusher-1",
      observedAt: new Date("2026-08-12T14:00:00.000Z"),
    });

    expect(invalidateBranchPushCoverageAfterWebhook).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      branchArtifactId: BRANCH_ARTIFACT_ID,
    });
    expect(branchPushBackfillService.captureWebhookPush).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      branchArtifactId: BRANCH_ARTIFACT_ID,
      beforeSha: "a".repeat(40),
      afterSha: "b".repeat(40),
      observedAt: new Date("2026-08-12T14:00:00.000Z"),
      sender: { id: 123, login: "alice", type: GitHubActorType.User },
      deliveryId: "delivery-pusher-1",
    });
  });

  it("captures pusher evidence even when a commit timestamp cannot feed LOC metrics", async () => {
    const event = Object.assign(
      pushEvent({ commits: [pushCommit({ timestamp: "invalid-timestamp" })] }),
      {
        before: "a".repeat(40),
        after: "b".repeat(40),
        sender: { id: 123, login: "alice", type: GitHubActorType.User },
      }
    );

    const response = await handlePush(event, {
      deliveryId: "delivery-invalid-commit-time",
      observedAt: SYSTEM_NOW,
    });
    await settleDeferredWork();

    expect(response.status).toBe(200);
    expect(
      branchPushBackfillService.captureWebhookPush
    ).toHaveBeenCalledExactlyOnceWith({
      organizationId: ORG_ID,
      branchArtifactId: BRANCH_ARTIFACT_ID,
      beforeSha: "a".repeat(40),
      afterSha: "b".repeat(40),
      observedAt: SYSTEM_NOW,
      sender: event.sender,
      deliveryId: "delivery-invalid-commit-time",
    });
  });

  it("does not attribute a push delivery with no new commit", async () => {
    const event = Object.assign(pushEvent({ commits: [] }), {
      sender: { id: 123, type: GitHubActorType.User },
    });

    await handlePush(event, {
      deliveryId: "delivery-no-commit",
      observedAt: new Date("2026-08-12T14:00:00.000Z"),
    });

    expect(invalidateBranchPushCoverageAfterWebhook).not.toHaveBeenCalled();
    expect(branchPushBackfillService.captureWebhookPush).not.toHaveBeenCalled();
  });

  it("falls back to the branch row lineage when the slug matches no document", async () => {
    mockDb.artifact.findFirst.mockResolvedValue(null);
    mockDb.branchDetail.findUnique.mockResolvedValue({
      artifact: {
        projectId: "project-from-branch",
        targetLinks: [
          { source: { id: "linked-source", createdById: "linked-user" } },
        ],
      },
    });

    const response = await handlePush(pushEvent());

    expect(await response.json()).toEqual({
      message: "Push event processed successfully",
      ok: true,
    });
    expect(mockDb.artifact.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: ORG_ID,
        slug: { in: expandSlugAliases(ISSUE_SLUG) },
        type: ArtifactType.DOCUMENT,
        subtype: DocumentType.Feature,
      },
      select: { id: true, createdById: true, projectId: true },
    });
    expect(mockDb.branchDetail.findUnique).toHaveBeenCalledWith({
      where: {
        organizationId_repositoryFullName_branchName: {
          organizationId: ORG_ID,
          repositoryFullName: REPO_FULL_NAME,
          branchName: BRANCH_NAME,
        },
      },
      select: {
        artifact: {
          select: {
            projectId: true,
            targetLinks: {
              where: {
                linkType: LinkType.Produces,
                source: { type: ArtifactType.DOCUMENT },
              },
              select: { source: { select: { id: true, createdById: true } } },
              orderBy: { createdAt: "asc" },
              take: 1,
            },
          },
        },
      },
    });
    expect(branchService.upsertBranchArtifact).toHaveBeenCalledWith(
      expectedUpsertInput({
        projectId: "project-from-branch",
        sourceArtifactId: "linked-source",
        createdById: "linked-user",
      })
    );
  });
});

describe("handlePush commit persistence", () => {
  it("maps an unparseable commit timestamp and an absent author username to null", async () => {
    const commit = pushCommit({
      timestamp: "not-a-date",
      author: {
        name: "No Login",
        email: "nologin@example.com",
        date: "2026-01-02T03:04:05Z",
      },
    });

    await handlePush(pushEvent({ commits: [commit] }));

    expect(commitService.recordWebhookCommits).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      repositoryFullName: REPO_FULL_NAME,
      branchArtifactId: BRANCH_ARTIFACT_ID,
      commits: [
        {
          sha: commit.id,
          message: commit.message,
          committedAt: null,
          authoredAt: new Date("2026-01-02T03:04:05Z"),
          authorName: "No Login",
          authorEmail: "nologin@example.com",
          authorLogin: null,
          filesChanged: 3,
        },
      ],
    });
  });

  it("stringifies a non-Error persistence failure and still acks and publishes", async () => {
    vi.mocked(commitService.recordWebhookCommits).mockRejectedValue(
      "deadlock detected"
    );

    const response = await handlePush(pushEvent());

    expect(await response.json()).toEqual({
      message: "Push event processed successfully",
      ok: true,
    });
    expect(log.warn).toHaveBeenCalledWith(
      "[handlePush] Commit persistence failed",
      { branchArtifactId: BRANCH_ARTIFACT_ID, error: "deadlock detected" }
    );
    expect(publishGitHubDirtyScopes).toHaveBeenCalledTimes(1);
  });
});
