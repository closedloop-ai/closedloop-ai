/**
 * Branch-arm coverage for `handlePullRequest` (ISS-11280): the branch-row
 * fallback lookup used when no PR detail matches the incoming number, and
 * the artifact-linkage early exits on a missing-PR opened delivery. Split
 * from the former single pull-request-handler.branches.test.ts (713 lines)
 * by concern; see the sibling `.relink-resolution.` and
 * `.lifecycle-and-relink-authority.` files for the other arms. Every
 * collaborator that owns its own write is mocked so each case asserts
 * exactly what this module decides and hands on.
 */
import { LinkType } from "@repo/api/src/types/artifact";
import { DocumentType } from "@repo/api/src/types/document";
import { GitHubPRState } from "@repo/api/src/types/github";
import { SlugPrefix } from "@repo/api/src/types/slug-prefix";
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
  readAttribution: vi.fn(),
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

vi.mock("./pull-request-attribution-read", () => ({
  readPullRequestAttributionEvidence: mocks.readAttribution,
}));

import { ArtifactType, ChecksStatus } from "@repo/database";
import {
  createPullRequestWebhookTx,
  installPullRequestTransactionMock,
  type PullRequestWebhookTx,
} from "@/__tests__/support/webhooks/github/pull-request-handler.test-mocks";
import {
  buildEvent,
  ORG_ID,
  planReference,
  REPO_FULL_NAME,
  REPO_ID,
  stubBranchRow,
  stubPrDetailLookups,
  stubRepository,
} from "@/__tests__/support/webhooks/github/pull-request-handler-branches.test-helpers";
import { getMockWithDb } from "@/__tests__/utils/db-helpers";
import { handlePullRequest } from "./pull-request-handler";

let tx: PullRequestWebhookTx;

describe("handlePullRequest branch arms — branch fallback and linkage", () => {
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
    mocks.readAttribution.mockResolvedValue(undefined);
  });

  describe("attribution read (ISS-12552, PRD-800)", () => {
    it("reads the repository's organization's answer before a linkage action that names an artifact opens its transaction", async () => {
      mocks.parseArtifactReferences.mockReturnValue([planReference()]);
      const event = buildEvent("opened");

      await handlePullRequest(event);

      expect(mocks.readAttribution).toHaveBeenCalledWith(
        event.repository,
        event.installation?.id
      );
      expect(mocks.readAttribution.mock.invocationCallOrder[0]).toBeLessThan(
        getMockWithDb().tx.mock.invocationCallOrder[0] ?? Number.NaN
      );
    });

    it("reads nothing for an action that writes no source link", async () => {
      await handlePullRequest(buildEvent("synchronize"));

      expect(mocks.readAttribution).not.toHaveBeenCalled();
    });

    it("issues no installation repository read outside the transaction for a linkage action that names no artifact", async () => {
      await useRealAttributionRead();

      await handlePullRequest(buildEvent("opened"));

      expect(getMockWithDb()).not.toHaveBeenCalled();
      expect(getMockWithDb().tx).toHaveBeenCalledTimes(1);
    });

    it("issues the installation repository read before the transaction for a linkage action that names an artifact", async () => {
      await useRealAttributionRead();
      mocks.parseArtifactReferences.mockReturnValue([planReference()]);

      await handlePullRequest(buildEvent("opened"));

      expect(getMockWithDb()).toHaveBeenCalledTimes(1);
      expect(getMockWithDb().mock.invocationCallOrder[0]).toBeLessThan(
        getMockWithDb().tx.mock.invocationCallOrder[0] ?? Number.NaN
      );
    });

    it("runs the delivery as with the flag off when the installation repository read fails", async () => {
      await useRealAttributionRead();
      mocks.parseArtifactReferences.mockReturnValue([planReference()]);
      getMockWithDb().mockRejectedValueOnce(new Error("database unavailable"));

      const response = await handlePullRequest(buildEvent("opened"));

      expect(response.status).toBe(200);
      expect(getMockWithDb()).toHaveBeenCalledTimes(1);
      expect(getMockWithDb().tx).toHaveBeenCalledTimes(1);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("branch-row fallback when no PR detail matches the number", () => {
    function branchRow(options: {
      currentDetailBranchArtifactId: string;
      linkedDocSlug: string | null;
    }) {
      return {
        artifactId: "branch-art",
        currentPullRequestDetailId: "detail-cur",
        checksStatus: ChecksStatus.PASSING,
        headSha: "sha-branch",
        artifact: {
          organizationId: ORG_ID,
          projectId: "project-1",
          targetLinks: [
            { source: { id: "doc-1", slug: options.linkedDocSlug } },
          ],
        },
        currentPullRequestDetail: {
          id: "detail-cur",
          branchArtifactId: options.currentDetailBranchArtifactId,
          repositoryId: REPO_ID,
          githubId: "gh-cur",
          prState: GitHubPRState.Open,
          isDraft: false,
          closedAt: null,
          mergedAt: null,
        },
      };
    }

    it("adopts the branch's current PR detail when it belongs to the same repository and branch artifact, mapping a null document slug to an empty string", async () => {
      stubBranchRow(
        tx,
        branchRow({
          currentDetailBranchArtifactId: "branch-art",
          linkedDocSlug: null,
        })
      );
      const event = buildEvent("synchronize");

      await handlePullRequest(event);

      expect(mocks.applyAction).toHaveBeenCalledWith(tx, event, {
        id: "branch-art",
        currentPullRequestDetailId: "detail-cur",
        pullRequestDetailId: "detail-cur",
        projectId: "project-1",
        organizationId: ORG_ID,
        documentId: "doc-1",
        githubId: "gh-cur",
        checksStatus: ChecksStatus.PASSING,
        prState: GitHubPRState.Open,
        isDraft: false,
        closedAt: null,
        mergedAt: null,
        headSha: "sha-branch",
        document: { slug: "" },
        hasBranchArtifact: true,
      });
    });

    it("ignores a current PR detail owned by another branch artifact and keeps the linked document slug", async () => {
      stubBranchRow(
        tx,
        branchRow({
          currentDetailBranchArtifactId: "other-branch-art",
          linkedDocSlug: "PLN-9",
        })
      );
      const event = buildEvent("synchronize");

      await handlePullRequest(event);

      expect(mocks.applyAction).toHaveBeenCalledWith(tx, event, {
        id: "branch-art",
        currentPullRequestDetailId: "detail-cur",
        pullRequestDetailId: null,
        projectId: "project-1",
        organizationId: ORG_ID,
        documentId: "doc-1",
        githubId: null,
        checksStatus: ChecksStatus.PASSING,
        prState: null,
        isDraft: null,
        closedAt: null,
        mergedAt: null,
        headSha: "sha-branch",
        document: { slug: "PLN-9" },
        hasBranchArtifact: true,
      });
    });
  });

  describe("artifact linkage early exits on a missing-PR opened delivery", () => {
    it("skips reference parsing in the linkage when the installation has no organization", async () => {
      stubRepository(tx, null);

      const response = await handlePullRequest(buildEvent("opened"));

      // ISS-12552: the one parse is the pre-transaction attribution read's
      // gate, which runs before the installation's organization is known.
      expect(mocks.parseArtifactReferences).toHaveBeenCalledTimes(1);
      expect(tx.artifact.findFirst).not.toHaveBeenCalled();
      expect(mocks.publishDirtyScopes).not.toHaveBeenCalled();
      expect(response.status).toBe(200);
    });

    it("skips the artifact lookup when no reference is a plan or a feature", async () => {
      mocks.parseArtifactReferences.mockReturnValue([
        {
          ...planReference(),
          slug: "PRD-3",
          prefix: SlugPrefix.Prd,
          docType: DocumentType.Prd,
        },
      ]);

      await handlePullRequest(buildEvent("opened"));

      // ISS-12552: once for the pre-transaction attribution read's gate, once
      // in the linkage.
      expect(mocks.parseArtifactReferences).toHaveBeenCalledTimes(2);
      expect(tx.artifact.findFirst).not.toHaveBeenCalled();
      expect(mocks.materializeBranch).not.toHaveBeenCalled();
    });

    it("materializes the branch with an empty slug when the referenced document has a null slug", async () => {
      mocks.parseArtifactReferences.mockReturnValue([planReference()]);
      mocks.materializeBranch.mockResolvedValue("branch-new");
      const planRow = {
        id: "doc-plan",
        type: ArtifactType.DOCUMENT,
        subtype: DocumentType.ImplementationPlan,
        name: "Plan title",
        organizationId: ORG_ID,
        projectId: "project-1",
        assigneeId: null,
        createdById: "user-1",
        slug: null,
      };
      tx.artifact.findFirst.mockImplementation(
        (args: {
          where: { organizationId?: string; slug?: { in?: string[] } };
        }) =>
          Promise.resolve(
            args.where.organizationId === ORG_ID &&
              args.where.slug?.in?.includes("PLN-5")
              ? planRow
              : null
          )
      );
      tx.artifactLink.findFirst.mockResolvedValue(null);
      const event = buildEvent("opened");

      await handlePullRequest(event);

      expect(mocks.materializeBranch).toHaveBeenCalledWith({
        organizationId: ORG_ID,
        repo: {
          id: REPO_ID,
          fullName: REPO_FULL_NAME,
          installation: { organizationId: ORG_ID, installationId: "99" },
        },
        artifact: {
          id: "doc-plan",
          title: "Plan title",
          organizationId: ORG_ID,
          projectId: "project-1",
          assigneeId: null,
          createdById: "user-1",
          slug: "",
        },
        pullRequest: (event as { pull_request: unknown }).pull_request,
        observationContext: undefined,
      });
      expect(tx.artifact.findFirst).toHaveBeenCalledWith({
        where: { organizationId: ORG_ID, slug: { in: ["PLN-5"] } },
        select: {
          id: true,
          type: true,
          subtype: true,
          name: true,
          organizationId: true,
          projectId: true,
          assigneeId: true,
          createdById: true,
          slug: true,
        },
      });
      expect(tx.artifactLink.findFirst).toHaveBeenCalledWith({
        where: {
          organizationId: ORG_ID,
          sourceId: "doc-plan",
          targetId: "branch-new",
          linkType: LinkType.Produces,
        },
        select: { id: true },
      });
      expect(tx.artifactLink.create).toHaveBeenCalledWith({
        data: {
          organizationId: ORG_ID,
          sourceId: "doc-plan",
          targetId: "branch-new",
          linkType: LinkType.Produces,
          sortOrder: 0,
        },
        select: { id: true },
      });
    });
  });
});

/** Run the real pre-transaction read, so its database calls reach the mock. */
async function useRealAttributionRead(): Promise<void> {
  const actual = await vi.importActual<
    typeof import("./pull-request-attribution-read")
  >("./pull-request-attribution-read");
  mocks.readAttribution.mockImplementation(
    actual.readPullRequestAttributionEvidence
  );
}
