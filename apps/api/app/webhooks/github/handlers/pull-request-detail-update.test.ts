import type { PullRequest } from "@octokit/webhooks-types";
import { GitHubPRState } from "@repo/api/src/types/github";
import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
} from "@repo/api/src/types/github-read-model";
import {
  RepositoryDefaultAvailability,
  RepositoryDefaultCompleteness,
  RepositoryDefaultSource,
} from "@repo/api/src/types/repository-default-identity";
import { describe, expect, it, vi } from "vitest";
import { pullRequestToDetailUpdate } from "./pull-request-detail-update";
import {
  persistCreatedWebhookPullRequestAuthority,
  persistWebhookPullRequestAuthorityById,
} from "./pull-request-projection";

function payload(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 42,
    title: "Add feature X",
    html_url: "https://github.com/acme/widgets/pull/42",
    body: "body",
    draft: false,
    state: "closed",
    merged: true,
    additions: 120,
    deletions: 30,
    changed_files: 4,
    created_at: "2026-02-10T00:00:00Z",
    updated_at: "2026-02-11T09:00:00Z",
    closed_at: "2026-02-11T09:00:00Z",
    merged_at: "2026-02-11T09:00:00Z",
    merge_commit_sha: "def456",
    head: {
      sha: "head-abc",
      ref: "feature/x",
      repo: {
        id: 5826,
        full_name: "fork-owner/widgets",
        default_branch: "trunk",
      },
    },
    user: { login: "octocat" },
    ...overrides,
  } as unknown as PullRequest;
}

describe("pullRequestToDetailUpdate (PLN-1535 M0/M1)", () => {
  it("maps the merged-LOC metric fields and reconciler watermark without PR-head authority", () => {
    const result = pullRequestToDetailUpdate(payload());

    expect(result).toMatchObject({
      prState: GitHubPRState.Merged,
      // M0: the metric's exact LOC fields, straight from the payload.
      additions: 120,
      deletions: 30,
      changedFiles: 4,
      // M1: the watermark persists so tier-1 rows stay live.
      githubUpdatedAt: new Date("2026-02-11T09:00:00Z"),
      mergedAt: new Date("2026-02-11T09:00:00Z"),
      closedAt: new Date("2026-02-11T09:00:00Z"),
      mergeCommitSha: "def456",
      // M3: the PR author, for the Postgres-served PR list.
      authorLogin: "octocat",
    });
    expect(result).not.toHaveProperty("headRefName");
    expect(result).not.toHaveProperty("headRefOid");
  });

  it("clears mergedAt/closedAt for an open PR so state cannot lie", () => {
    const result = pullRequestToDetailUpdate(
      payload({
        state: "open",
        merged: false,
        merged_at: null,
        closed_at: null,
      })
    );
    expect(result.prState).toBe(GitHubPRState.Open);
    expect(result.mergedAt).toBeNull();
    expect(result.closedAt).toBeNull();
  });

  it("leaves head-name persistence to the authority CAS boundary", () => {
    const result = pullRequestToDetailUpdate(
      payload({
        updated_at: undefined as unknown as string,
        head: undefined as unknown as PullRequest["head"],
        user: undefined as unknown as PullRequest["user"],
      })
    );
    expect(result.githubUpdatedAt).toBeNull();
    expect(result).not.toHaveProperty("headRefName");
    expect(result).not.toHaveProperty("headRefOid");
    expect(result.authorLogin).toBeNull();
  });
});

describe("webhook PR-head authority production wiring", () => {
  it("persists the created PR's provider head pair through the authority CAS", async () => {
    const db = webhookAuthorityDb();
    db.pullRequestDetail.findFirst
      .mockResolvedValueOnce({ id: "pr-detail-1" })
      .mockResolvedValueOnce(emptyStoredAuthority());

    await persistCreatedWebhookPullRequestAuthority(
      db as never,
      "org-1",
      payload(),
      observationContext("delivery-created")
    );

    expect(db.pullRequestDetail.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          headRefName: "feature/x",
          headRefOid: "head-abc",
        }),
      })
    );
  });

  it("keeps D2 after D1, D2, D1 traverses the existing-PR webhook path", async () => {
    const db = webhookAuthorityDb();
    db.pullRequestDetail.findFirst
      .mockResolvedValueOnce(emptyStoredAuthority())
      .mockResolvedValueOnce(
        storedWebhookAuthority({
          observationKey: "delivery-1",
          observedAt: new Date("2026-02-11T09:00:00Z"),
          eventAt: new Date("2026-02-11T09:00:00Z"),
          headRefName: "feature/one",
          headRefOid: "head-one",
        })
      )
      .mockResolvedValueOnce(
        storedWebhookAuthority({
          observationKey: "delivery-2",
          observedAt: new Date("2026-02-11T09:05:00Z"),
          eventAt: new Date("2026-02-11T09:05:00Z"),
          headRefName: "feature/two",
          headRefOid: "head-two",
        })
      );
    db.repositoryDefaultObservationReceipt.createMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const scope = {
      organizationId: "org-1",
      pullRequestDetailId: "pr-detail-1",
    };
    const d1 = payload({
      updated_at: "2026-02-11T09:00:00Z",
      head: payloadHead("feature/one", "head-one"),
    });
    const d2 = payload({
      updated_at: "2026-02-11T09:05:00Z",
      head: payloadHead("feature/two", "head-two"),
    });

    await persistWebhookPullRequestAuthorityById(
      db as never,
      scope,
      d1,
      observationContext("delivery-1", "2026-02-11T09:00:00Z")
    );
    await persistWebhookPullRequestAuthorityById(
      db as never,
      scope,
      d2,
      observationContext("delivery-2", "2026-02-11T09:05:00Z")
    );
    await persistWebhookPullRequestAuthorityById(
      db as never,
      scope,
      d1,
      observationContext("delivery-1", "2026-02-11T09:10:00Z")
    );

    expect(db.pullRequestDetail.updateMany).toHaveBeenCalledTimes(2);
    expect(db.pullRequestDetail.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          headRefName: "feature/two",
          headRefOid: "head-two",
        }),
      })
    );
  });
});

function webhookAuthorityDb() {
  return {
    pullRequestDetail: {
      findFirst: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    repositoryDefaultObservationReceipt: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
}

function emptyStoredAuthority() {
  return storedWebhookAuthority({
    observationKey: "legacy",
    observedAt: null,
    eventAt: null,
    headRefName: null,
    headRefOid: null,
  });
}

function storedWebhookAuthority(overrides: {
  observationKey: string;
  observedAt: Date | null;
  eventAt: Date | null;
  headRefName: string | null;
  headRefOid: string | null;
}) {
  return {
    headRefName: overrides.headRefName,
    headRefOid: overrides.headRefOid,
    headRepositoryGithubId: "5826",
    headRepositoryFullName: "fork-owner/widgets",
    headRepositoryDefaultBranchName: "trunk",
    headRepositoryDefaultBranchAvailability:
      RepositoryDefaultAvailability.Available,
    headRepositoryDefaultBranchCompleteness:
      RepositoryDefaultCompleteness.Complete,
    headRepositoryDefaultBranchReason: null,
    headRepositoryDefaultBranchSource:
      RepositoryDefaultSource.PullRequestWebhook,
    headRepositoryDefaultBranchMechanism: GitHubFetchMechanism.Webhook,
    headRepositoryDefaultBranchTrigger: GitHubFetchTrigger.Webhook,
    headRepositoryDefaultBranchCredentialType:
      GitHubFetchCredentialType.GitHubApp,
    headRepositoryDefaultBranchCredentialOwnerId: null,
    headRepositoryDefaultBranchObservationKey: overrides.observationKey,
    headRepositoryDefaultBranchObservedAt: overrides.observedAt,
    headRepositoryDefaultBranchEventAt: overrides.eventAt,
  };
}

function observationContext(
  deliveryId: string,
  observedAt = "2026-02-11T09:00:00Z"
) {
  return { deliveryId, observedAt: new Date(observedAt) };
}

function payloadHead(ref: string, sha: string) {
  return {
    ref,
    sha,
    repo: {
      id: 5826,
      full_name: "fork-owner/widgets",
      default_branch: "trunk",
    },
  } as PullRequest["head"];
}
