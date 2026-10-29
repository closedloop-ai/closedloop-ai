/**
 * `handlePullRequest` — the dirty-scope PUBLICATION decision that closes the
 * `pull_request` webhook transaction, plus the defensive reload throw that can
 * abort it.
 *
 * `processPullRequestTransaction` returns a publication only when all THREE of
 * its `return null` guards clear: the repository resolves, a projection was
 * actually written, and the installation carries an organization. Any one of
 * them withholds the Desktop pull hint while the delivery still answers 200 —
 * so a regression here is silent by construction, and the control case below is
 * what keeps the three withholding cases honest.
 *
 * Lives beside `webhook-pull-request.test.ts` rather than in it: that file is
 * in the shrink-only file-size grandfather list in `biome.jsonc` and owns the
 * per-action lifecycle writes. `webhook-pull-request-linkage.test.ts` owns
 * artifact-reference linkage; `webhook-pull-request-guards.test.ts` owns the
 * pre-transaction early exits.
 */

import type { PullRequestClosedEvent } from "@octokit/webhooks-types";
import {
  GitHubDirtyScopeKind,
  GitHubDirtyTrigger,
} from "@repo/api/src/types/github-dirty-scope";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  persistActivity: vi.fn(),
  publishDirtyScopes: vi.fn(),
  reconcileLabels: vi.fn(),
  repairBranchAssociation: vi.fn(),
  withDbTx: vi.fn(),
}));

vi.mock("@/app/branches/branch-detail-signal", () => ({
  emitBranchDetailChanged: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const withDb = vi.fn();
  Object.assign(withDb, { tx: mocks.withDbTx });
  return { ...actual, withDb };
});

vi.mock("@repo/github/artifact-reference-parser", () => ({
  parseArtifactReferences: vi.fn().mockReturnValue([]),
}));

vi.mock("@/app/branches/branch-service", () => ({
  branchService: { upsertBranchArtifact: vi.fn() },
}));

vi.mock("@/app/branches/pull-request-author-identity", () => ({
  ensurePullRequestAuthorIdentity: vi.fn(),
}));

vi.mock(
  "@/app/webhooks/github/handlers/pull-request-label-reconciliation",
  () => ({
    reconcilePullRequestLabelsForWebhook: mocks.reconcileLabels,
  })
);

vi.mock(
  "@/app/webhooks/github/handlers/branch-activity-producer",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    persistGitHubBranchActivity: mocks.persistActivity,
  })
);

// Whether the publisher is called is this file's whole subject, so it is mocked
// rather than left to run for real and log a failed publish.
vi.mock("@/app/webhooks/github/handlers/dirty-scope-publisher", () => ({
  publishGitHubDirtyScopes: mocks.publishDirtyScopes,
}));

// Controlling the repaired/not-repaired answer directly is the only tractable
// way to reach `reloadRepairedPullRequestDetail`'s throw; the real repair sits
// behind five preconditions that all have their own coverage.
vi.mock(
  "@/app/webhooks/github/handlers/pull-request-branch-association-repair",
  () => ({
    repairPullRequestBranchAssociationInTransaction:
      mocks.repairBranchAssociation,
  })
);

import {
  createInstallationLite,
  createPullRequest,
  createPullRequestClosedEvent,
  createRepository,
} from "@/__tests__/fixtures/github-webhook-fixtures";
import {
  createPullRequestWebhookTx,
  type PullRequestWebhookTx,
} from "@/__tests__/support/webhooks/github/pull-request-handler.test-mocks";
import { makePrDetailRow } from "@/__tests__/utils/pr-detail-helpers";
import { BranchActivityPersistStatus } from "@/app/branches/branch-activity-evidence";
import { GitHubBranchActivityProductionStatus } from "@/app/webhooks/github/handlers/branch-activity-producer";
import { handlePullRequest } from "@/app/webhooks/github/handlers/pull-request-handler";

let mockTx: PullRequestWebhookTx;

describe("handlePullRequest dirty-scope publication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.persistActivity.mockResolvedValue({
      status: GitHubBranchActivityProductionStatus.Persisted,
      persistenceStatus: BranchActivityPersistStatus.Inserted,
    });
    mocks.publishDirtyScopes.mockResolvedValue(undefined);
    mocks.reconcileLabels.mockResolvedValue(undefined);
    mocks.repairBranchAssociation.mockResolvedValue(false);

    mockTx = createPullRequestWebhookTx();
    mocks.withDbTx.mockImplementation((callback: (tx: unknown) => unknown) =>
      callback(mockTx)
    );
  });

  it("withholds publication and still answers 200 when the repository does not resolve", async () => {
    mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue(null);

    const response = await handlePullRequest(
      buildClosedPullRequestEvent(),
      OBSERVATION
    );

    expect(mockTx.pullRequestDetail.findUnique).not.toHaveBeenCalled();
    expect(mocks.publishDirtyScopes).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ ok: true })
    );
  });

  it("withholds publication and still answers 200 when a non-current-branch PR event writes no projection", async () => {
    setupRepo(ORG_ID);
    setupPrDetail(
      makePrDetailRow({
        id: "superseded-pr-detail",
        artifactId: BRANCH_ARTIFACT_ID,
        currentPullRequestDetailId: "newer-pr-detail",
        organizationId: ORG_ID,
        linkedDoc: null,
      })
    );

    const response = await handlePullRequest(
      buildClosedPullRequestEvent(),
      OBSERVATION
    );

    // The branch's current PR detail is a different row, so the handler records
    // activity and returns "no projection written" — the first publication guard.
    expect(mocks.persistActivity).toHaveBeenCalledTimes(1);
    expect(mocks.publishDirtyScopes).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ ok: true })
    );
  });

  it("withholds publication and still answers 200 when the projection is written for an installation with no organization", async () => {
    setupRepo(null);
    setupPrDetail(currentPrDetailRow());

    const response = await handlePullRequest(
      buildClosedPullRequestEvent(),
      OBSERVATION
    );

    // With no installation organization nothing reconciles provider identity, so
    // these writes can only come from the projection the second guard discards.
    expect(mockTx.branchDetail.updateMany).toHaveBeenCalled();
    expect(mockTx.artifact.update).toHaveBeenCalledTimes(1);
    expect(mocks.publishDirtyScopes).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ ok: true })
    );
  });

  it("publishes the pull-request dirty scope exactly once when the projection is written and the installation has an organization", async () => {
    setupRepo(ORG_ID);
    setupPrDetail(currentPrDetailRow());

    const response = await handlePullRequest(
      buildClosedPullRequestEvent(),
      OBSERVATION
    );

    expect(mocks.publishDirtyScopes).toHaveBeenCalledTimes(1);
    expect(mocks.publishDirtyScopes).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      repositoryId: REPO_ID,
      repositoryFullName: REPO_FULL_NAME,
      scopes: [
        {
          kind: GitHubDirtyScopeKind.PullRequest,
          repositoryId: REPO_ID,
          repositoryFullName: REPO_FULL_NAME,
          branchName: HEAD_BRANCH,
          pullRequestNumber: PR_NUMBER,
        },
      ],
      triggers: [GitHubDirtyTrigger.PullRequest],
    });
    expect(response.status).toBe(200);
  });

  it("rejects when a repaired PR detail cannot be reloaded", async () => {
    setupRepo(ORG_ID);
    const prDetail = currentPrDetailRow();
    // The relink moved the row out from under the reload — the state the
    // handler refuses to keep projecting against.
    let relinked = false;
    mockTx.pullRequestDetail.findUnique.mockImplementation(() =>
      Promise.resolve(relinked ? null : prDetail)
    );
    mocks.repairBranchAssociation.mockImplementation(() => {
      relinked = true;
      return Promise.resolve(true);
    });

    await expect(
      handlePullRequest(buildClosedPullRequestEvent(), OBSERVATION)
    ).rejects.toThrow(RELOAD_FAILURE_MESSAGE);

    expect(mocks.repairBranchAssociation).toHaveBeenCalledTimes(1);
    expect(mocks.publishDirtyScopes).not.toHaveBeenCalled();
  });
});

function setupRepo(organizationId: string | null): void {
  mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
    id: REPO_ID,
    fullName: REPO_FULL_NAME,
    installation: {
      organizationId,
      installationId: String(INSTALLATION_ID),
    },
  });
}

function setupPrDetail(row: ReturnType<typeof makePrDetailRow>): void {
  mockTx.pullRequestDetail.findUnique.mockResolvedValue(row);
}

/** A PR detail row the branch already points at, so its events apply. */
function currentPrDetailRow() {
  return makePrDetailRow({
    id: "current-pr-detail",
    artifactId: BRANCH_ARTIFACT_ID,
    organizationId: ORG_ID,
    number: PR_NUMBER,
    headSha: "abc123",
    linkedDoc: null,
  });
}

/**
 * One payload shape for every case here, so the only thing separating the two
 * withheld publications from the published control is the arranged DB state.
 */
function buildClosedPullRequestEvent(): PullRequestClosedEvent {
  const pullRequest = createPullRequest({
    id: PR_GITHUB_ID,
    number: PR_NUMBER,
    title: "Close the publication path",
    state: "closed",
    merged: false,
    closed_at: "2026-08-13T11:00:00Z",
    head: {
      sha: "abc123",
      ref: HEAD_BRANCH,
      repo: createRepository(GITHUB_REPO_ID, { default_branch: "main" }),
    },
    base: { repo: createRepository(GITHUB_REPO_ID) },
  });
  return createPullRequestClosedEvent(pullRequest, {
    repository: createRepository(GITHUB_REPO_ID),
    installation: createInstallationLite(INSTALLATION_ID),
  });
}

const ORG_ID = "org-uuid-publication";
const REPO_ID = "repo-uuid-publication";
const REPO_FULL_NAME = "acme/widgets";
const GITHUB_REPO_ID = 789;
const INSTALLATION_ID = 99;
const BRANCH_ARTIFACT_ID = "branch-artifact-publication";
const HEAD_BRANCH = "feature-branch";
const PR_NUMBER = 501;
const PR_GITHUB_ID = 9501;
const OBSERVATION = {
  deliveryId: "iss-7973-publication-delivery",
  observedAt: new Date("2026-08-13T12:00:00.000Z"),
};
// A bare `rejects.toThrow()` also passes on an unrelated `TypeError` raised by a
// tx delegate the stub does not carry, which never reaches the reload guard.
const RELOAD_FAILURE_MESSAGE = /relinked pull request could not be reloaded/;
