/**
 * Branch-arm coverage for `handlePullRequest` (ISS-11280): the lifecycle-skip
 * reason logged for a non-current-branch PR event, and the relink-authority
 * freshness checks that gate the branch-association repair. Split from the
 * former single pull-request-handler.branches.test.ts (713 lines) by concern;
 * see the sibling `.relink-resolution.` and `.branch-fallback-and-linkage.`
 * files for the other arms. Every collaborator that owns its own write is
 * mocked so each case asserts exactly what this module decides and hands on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  parseArtifactReferences: vi.fn(),
  reconcileIdentity: vi.fn(),
  repairAssociation: vi.fn(),
  writeProjection: vi.fn(),
  applyAction: vi.fn(),
  materializeBranch: vi.fn(),
  persistActivity: vi.fn(),
  publishDirtyScopes: vi.fn(),
  reconcileLabels: vi.fn(),
}));

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "@/__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule({
    ChecksStatus: {
      UNKNOWN: "UNKNOWN",
      PENDING: "PENDING",
      PASSING: "PASSING",
      FAILING: "FAILING",
    },
  });
});

vi.mock("@repo/github/artifact-reference-parser", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  parseArtifactReferences: mocks.parseArtifactReferences,
}));

vi.mock("@/app/branches/pull-request-provider-identity", () => ({
  reconcilePullRequestProviderIdentityInTransaction: mocks.reconcileIdentity,
}));

vi.mock("./pull-request-branch-association-repair", () => ({
  repairPullRequestBranchAssociationInTransaction: mocks.repairAssociation,
}));

vi.mock("./pull-request-projection", () => ({
  writeExistingWebhookPullRequestProjection: mocks.writeProjection,
}));

vi.mock("./pull-request-action-application", () => ({
  applyPullRequestAction: mocks.applyAction,
}));

vi.mock("./pull-request-branch-materialization", () => ({
  materializeWebhookPullRequestBranch: mocks.materializeBranch,
}));

vi.mock("./branch-activity-producer", () => ({
  GitHubBranchActivityEventName: { PullRequest: "pull_request" },
  persistGitHubBranchActivity: mocks.persistActivity,
}));

vi.mock("./dirty-scope-publisher", () => ({
  publishGitHubDirtyScopes: mocks.publishDirtyScopes,
}));

vi.mock("./pull-request-label-reconciliation", () => ({
  reconcilePullRequestLabelsForWebhook: mocks.reconcileLabels,
}));

import { GitHubPRState } from "@repo/api/src/types/github";
import { log } from "@repo/observability/log";
import {
  createPullRequestWebhookTx,
  installPullRequestTransactionMock,
  type PullRequestWebhookTx,
} from "@/__tests__/support/webhooks/github/pull-request-handler.test-mocks";
import {
  buildEvent,
  INCOMING_HEAD_REF,
  INCOMING_UPDATED_AT,
  ORG_ID,
  prDetailRow,
  REPO_FULL_NAME,
  stubPrDetailLookups,
  stubRepository,
} from "@/__tests__/support/webhooks/github/pull-request-handler-branches.test-helpers";
import { getMockWithDb } from "@/__tests__/utils/db-helpers";
import { handlePullRequest } from "./pull-request-handler";

const DAY_MS = 86_400_000;

let tx: PullRequestWebhookTx;

describe("handlePullRequest branch arms — lifecycle and relink authority", () => {
  beforeEach(() => {
    tx = createPullRequestWebhookTx();
    installPullRequestTransactionMock(getMockWithDb().tx, tx);
    stubRepository(tx, ORG_ID);
    stubPrDetailLookups(tx, [null]);
    mocks.parseArtifactReferences.mockReturnValue([]);
    mocks.reconcileIdentity.mockResolvedValue(undefined);
    mocks.repairAssociation.mockResolvedValue(false);
    mocks.writeProjection.mockResolvedValue(undefined);
    mocks.applyAction.mockResolvedValue(undefined);
    mocks.materializeBranch.mockResolvedValue(null);
    mocks.persistActivity.mockResolvedValue(undefined);
    mocks.publishDirtyScopes.mockResolvedValue(undefined);
    mocks.reconcileLabels.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports the lifecycle skip reason when a non-current branch PR event is also terminal", async () => {
    const debug = vi.spyOn(log, "debug");
    stubPrDetailLookups(tx, [
      prDetailRow({
        id: "detail-old",
        currentPullRequestDetailId: "detail-newer",
        prState: GitHubPRState.Merged,
      }),
    ]);

    await handlePullRequest(buildEvent("synchronize"));

    expect(mocks.writeProjection).not.toHaveBeenCalled();
    expect(mocks.persistActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        attribution: {
          organizationId: ORG_ID,
          branchArtifactId: "branch-artifact-1",
          pullRequestDetailId: "detail-old",
        },
      })
    );
    // AGENTS.md says avoid asserting debug/info log calls unless the logging
    // behavior itself is the contract. Kept here as a deliberate exception:
    // pull-request-handler.ts's `lifecycleDecision.apply ? "applicable" :
    // lifecycleDecision.reason` ternary feeds only this log call's
    // `lifecycleReason` field — the return value and the persisted-activity
    // call above are identical on both arms, so the log line is this arm's
    // sole observable effect.
    expect(debug).toHaveBeenCalledWith(
      "[handlePullRequest] Skipping non-current branch PR event",
      expect.objectContaining({ lifecycleReason: "merged_terminal" })
    );
  });

  // ISS-12344: a PR filed under the wrong Branch need not be that Branch's
  // current PR, and the ruling moves it either way.
  it("runs the branch-association repair for a PR that is not its Branch's current PR", async () => {
    stubPrDetailLookups(tx, [
      prDetailRow({
        id: "detail-misfiled",
        currentPullRequestDetailId: "detail-sibling",
      }),
    ]);

    await handlePullRequest(buildEvent("synchronize"));

    expect(mocks.repairAssociation).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        pullRequestDetailId: "detail-misfiled",
        currentBranchArtifactId: "branch-artifact-1",
        headBranch: INCOMING_HEAD_REF,
        headRepositoryFullName: REPO_FULL_NAME,
      })
    );
  });

  it.each([
    {
      name: "stored update is newer than the delivery",
      githubUpdatedAt: new Date(INCOMING_UPDATED_AT.getTime() + DAY_MS),
      headRefName: INCOMING_HEAD_REF,
      repairs: false,
    },
    {
      name: "same instant but the stored head ref differs",
      githubUpdatedAt: INCOMING_UPDATED_AT,
      headRefName: "renamed-branch",
      repairs: false,
    },
    {
      name: "same instant and the same head ref",
      githubUpdatedAt: INCOMING_UPDATED_AT,
      headRefName: INCOMING_HEAD_REF,
      repairs: true,
    },
    {
      name: "same instant with no stored head ref",
      githubUpdatedAt: INCOMING_UPDATED_AT,
      headRefName: null,
      repairs: true,
    },
    {
      // The head-ref veto applies only at the same instant: a strictly newer
      // delivery on a renamed head still repairs.
      name: "delivery 1ms newer with a different stored head ref",
      githubUpdatedAt: new Date(INCOMING_UPDATED_AT.getTime() - 1),
      headRefName: "renamed-branch",
      repairs: true,
    },
  ])(
    "gates the branch-association repair on relink authority: $name",
    async ({ githubUpdatedAt, headRefName, repairs }) => {
      stubPrDetailLookups(tx, [prDetailRow({ githubUpdatedAt, headRefName })]);

      await handlePullRequest(buildEvent("synchronize"));

      if (repairs) {
        expect(mocks.repairAssociation).toHaveBeenCalledWith(
          tx,
          expect.objectContaining({
            organizationId: ORG_ID,
            pullRequestDetailId: "detail-current",
            currentBranchArtifactId: "branch-artifact-1",
            incomingUpdatedAt: INCOMING_UPDATED_AT,
          })
        );
      } else {
        expect(mocks.repairAssociation).not.toHaveBeenCalled();
      }
    }
  );
});
