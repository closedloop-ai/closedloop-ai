/**
 * Branch-arm coverage for `handlePullRequest` (ISS-11280): PR-detail relink
 * and resolution arms the `webhook-pull-request*.test.ts` siblings never
 * send — a relink whose row vanishes on reload, an orphaned PR detail with no
 * owning artifact, a PR detail with only one of owner relation/artifact id, a
 * PR detail materialized by linkage, a reused PR number carrying a new GitHub
 * id, and a null document slug on the resolved PR detail row. Split from the
 * former single pull-request-handler.branches.test.ts (713 lines) by concern;
 * see the sibling `.lifecycle-and-relink-authority.` and
 * `.branch-fallback-and-linkage.` files for the other arms. Every
 * collaborator that owns its own write is mocked so each case asserts
 * exactly what this module decides and hands on.
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

import {
  createPullRequestWebhookTx,
  installPullRequestTransactionMock,
  type PullRequestWebhookTx,
} from "@/__tests__/support/webhooks/github/pull-request-handler.test-mocks";
import {
  buildEvent,
  INCOMING_GITHUB_ID,
  INCOMING_HEAD_REF,
  INCOMING_UPDATED_AT,
  ORG_ID,
  PR_NUMBER,
  prDetailRow,
  REPO_FULL_NAME,
  REPO_ID,
  stubPrDetailLookups,
  stubRepository,
} from "@/__tests__/support/webhooks/github/pull-request-handler-branches.test-helpers";
import { getMockWithDb } from "@/__tests__/utils/db-helpers";
import { makePrDetailRow } from "@/__tests__/utils/pr-detail-helpers";
import { handlePullRequest } from "./pull-request-handler";

let tx: PullRequestWebhookTx;

describe("handlePullRequest branch arms — relink and resolution", () => {
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

  it("continues with the reloaded PR detail after a repaired relink", async () => {
    // Before the repair nothing matches the number; the repair relinks the PR
    // and the reload finds it under its new branch artifact.
    stubPrDetailLookups(tx, [
      null,
      null,
      {
        ...makePrDetailRow({
          id: "detail-relinked",
          artifactId: "branch-relinked",
          organizationId: ORG_ID,
          headSha: "sha-before",
        }),
        githubId: INCOMING_GITHUB_ID,
        githubUpdatedAt: null,
        headRefName: INCOMING_HEAD_REF,
      },
    ]);
    mocks.repairAssociation.mockResolvedValue(true);

    await handlePullRequest(buildEvent("synchronize"));

    // pins current behavior; looks odd because organizationId is null and
    // pullRequestDetailId is "" here — this repair call fires BEFORE the
    // reload, when no PR detail row had been found yet for this number, so
    // there is no prior artifact to derive an org from and no existing
    // detail id to pass (production derives both from the PRE-repair
    // `prDetail`, which is null in this scenario).
    expect(mocks.repairAssociation).toHaveBeenCalledWith(tx, {
      organizationId: null,
      repositoryId: REPO_ID,
      repositoryFullName: REPO_FULL_NAME,
      headBranch: INCOMING_HEAD_REF,
      headRepositoryFullName: REPO_FULL_NAME,
      pullRequestNumber: PR_NUMBER,
      pullRequestDetailId: "",
      currentBranchArtifactId: null,
      incomingUpdatedAt: INCOMING_UPDATED_AT,
    });
    expect(mocks.writeProjection).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        branchArtifactId: "branch-relinked",
        pullRequestDetailId: "detail-relinked",
        currentHeadSha: "sha-before",
      }),
      expect.anything(),
      "synchronize",
      undefined
    );
    expect(mocks.publishDirtyScopes).toHaveBeenCalledTimes(1);
  });

  it("maps a linked document with a null slug on the PR detail row to an empty slug", async () => {
    const row = prDetailRow({});
    stubPrDetailLookups(tx, [
      {
        ...row,
        branchArtifact: {
          ...row.branchArtifact,
          targetLinks: [{ source: { id: "doc-2", slug: null } }],
        },
      },
    ]);
    const event = buildEvent("synchronize");

    await handlePullRequest(event);

    expect(mocks.applyAction).toHaveBeenCalledWith(
      tx,
      event,
      expect.objectContaining({
        documentId: "doc-2",
        document: { slug: "" },
      })
    );
  });

  it("treats a PR detail with no owning artifact as an authoritative relink and then as a missing PR", async () => {
    stubPrDetailLookups(tx, [
      {
        ...makePrDetailRow({ id: "detail-orphan", artifactId: "unused" }),
        artifactId: null,
        branchArtifactId: null,
        artifact: null,
        branchArtifact: null,
        githubId: INCOMING_GITHUB_ID,
        githubUpdatedAt: null,
        headRefName: null,
      },
    ]);

    await handlePullRequest(buildEvent("opened"));

    expect(mocks.repairAssociation).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        organizationId: null,
        pullRequestDetailId: "detail-orphan",
        currentBranchArtifactId: null,
      })
    );
    // No owner, so no existing PR: the projection writer is never reached and
    // the materialized re-read yields no activity attribution either.
    expect(mocks.writeProjection).not.toHaveBeenCalled();
    expect(mocks.persistActivity).not.toHaveBeenCalled();
    // pins current behavior; looks odd because nothing was written, yet the
    // missing-PR linkage arm reports success and a dirty scope is published.
    expect(mocks.publishDirtyScopes).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "artifact ids set but no owner relation loaded",
      row: {
        artifactId: "legacy-art",
        branchArtifactId: "branch-art",
        artifact: null,
        branchArtifact: null,
      },
    },
    {
      name: "owner relation loaded but no artifact id",
      row: {
        artifactId: null,
        branchArtifactId: null,
        artifact: {
          organizationId: ORG_ID,
          projectId: "project-1",
          targetLinks: [],
        },
        branchArtifact: null,
      },
    },
  ])(
    "treats a PR detail with only one of owner relation and artifact id as a missing PR: $name",
    async ({ row }) => {
      stubPrDetailLookups(tx, [
        {
          ...makePrDetailRow({ id: "detail-half", artifactId: "unused" }),
          ...row,
          githubId: INCOMING_GITHUB_ID,
          githubUpdatedAt: null,
          headRefName: null,
        },
      ]);

      const response = await handlePullRequest(buildEvent("opened"));

      expect(mocks.repairAssociation).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ pullRequestDetailId: "detail-half" })
      );
      expect(mocks.writeProjection).not.toHaveBeenCalled();
      expect(mocks.applyAction).not.toHaveBeenCalled();
      expect(mocks.persistActivity).not.toHaveBeenCalled();
      expect(response.status).toBe(200);
    }
  );

  it("records activity against the PR detail that linkage materialized on a missing-PR delivery", async () => {
    const materialized = makePrDetailRow({
      id: "detail-materialized",
      artifactId: "branch-materialized",
      organizationId: ORG_ID,
    });
    stubPrDetailLookups(tx, [null, null, materialized]);
    const event = buildEvent("opened");

    await handlePullRequest(event, {
      deliveryId: "delivery-materialized",
      observedAt: INCOMING_UPDATED_AT,
    });

    expect(mocks.persistActivity).toHaveBeenCalledWith({
      eventName: "pull_request",
      deliveryId: "delivery-materialized",
      payload: event,
      attribution: {
        organizationId: ORG_ID,
        branchArtifactId: "branch-materialized",
        pullRequestDetailId: "detail-materialized",
      },
    });
  });

  it.each([
    { storedGithubId: "gh-previous", writes: true },
    { storedGithubId: INCOMING_GITHUB_ID, writes: false },
  ])(
    "on a reopened delivery that otherwise duplicates stored state, writes the projection only when the stored GitHub id differs ($storedGithubId)",
    async ({ storedGithubId, writes }) => {
      stubPrDetailLookups(tx, [prDetailRow({ githubId: storedGithubId })]);

      await handlePullRequest(buildEvent("reopened"));

      expect(mocks.writeProjection).toHaveBeenCalledTimes(writes ? 1 : 0);
      expect(mocks.applyAction).toHaveBeenCalledTimes(writes ? 1 : 0);
    }
  );
});
