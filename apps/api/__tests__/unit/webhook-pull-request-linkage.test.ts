/**
 * `handlePullRequest` — the artifact-reference linkage half of the GitHub
 * `pull_request` webhook: parsing PLN/FEA slugs out of a PR title or body,
 * resolving them to a Document, creating the DOCUMENT → produces → PR
 * `ArtifactLink`, and refusing to link on a prefix collision, an unknown slug,
 * an already-linked PR, or a terminal PR. Split out of
 * `webhook-pull-request.test.ts`, which owns the rest of the handler surface
 * (per-action lifecycle writes, repository and installation isolation,
 * transaction behavior). The companion rule that settling a linked PR never
 * writes the document that produced it lives in
 * `webhook-pull-request-upstream-propagation.test.ts`.
 */

import type {
  PullRequestClosedEvent,
  PullRequestReopenedEvent,
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
    ArtifactType: {
      DOCUMENT: "DOCUMENT",
      BRANCH: "BRANCH",

      DEPLOYMENT: "DEPLOYMENT",
    },
    GitHubInstallationStatus: {
      ACTIVE: "ACTIVE",
    },
    ArtifactSubtype: {
      PRD: "PRD",
      IMPLEMENTATION_PLAN: "IMPLEMENTATION_PLAN",
      TEMPLATE: "TEMPLATE",
      FEATURE: "FEATURE",
    },
    ChecksStatus: {
      UNKNOWN: "UNKNOWN",
      PENDING: "PENDING",
      PASSING: "PASSING",
      FAILING: "FAILING",
    },
    withDb: mockWithDb,
  };
});

vi.mock("@repo/github/artifact-reference-parser", () => ({
  parseArtifactReferences: vi.fn().mockReturnValue([]),
}));

vi.mock("@/lib/slug-generator", () => ({
  generateSlug: vi.fn().mockResolvedValue("WORK-99"),
}));

vi.mock("@/lib/artifact-adapters", () => ({
  documentWhere: (where: any) => ({ ...where, type: "DOCUMENT" }),
}));

vi.mock("@/app/branches/branch-service", () => ({
  branchService: {
    upsertBranchArtifact: vi.fn().mockResolvedValue({
      ok: true,
      value: { id: "new-branch-artifact-id" },
    }),
  },
  // PLN-1034: PR-lifecycle actions bump branch_detail.last_activity_at.
  bumpBranchActivity: vi.fn().mockResolvedValue(undefined),
}));

// ISS-4664: the handler calls this AFTER the transaction commits, for the
// linkage actions exercised here. Mocked so linkage assertions are not mixed
// with real label reconciliation.
vi.mock(
  "@/app/webhooks/github/handlers/pull-request-label-reconciliation",
  () => ({
    reconcilePullRequestLabelsForWebhook: vi.fn().mockResolvedValue(undefined),
  })
);

vi.mock("@/app/webhooks/github/handlers/branch-activity-producer", () => ({
  GitHubBranchActivityEventName: { PullRequest: "pull_request" },
  persistGitHubBranchActivity: vi.fn().mockResolvedValue({
    status: "persisted",
    persistenceStatus: "inserted",
  }),
}));

// Import after mocking
import { LinkType } from "@repo/api/src/types/artifact";
import { DocumentType } from "@repo/api/src/types/document";
import { SlugPrefix } from "@repo/api/src/types/slug-prefix";
import { withDb } from "@repo/database";
import { parseArtifactReferences } from "@repo/github/artifact-reference-parser";
import {
  createPullRequestWebhookTx,
  pullRequestWebhookWriteMocks,
} from "@/__tests__/support/webhooks/github/pull-request-handler.test-mocks";
import { branchService } from "@/app/branches/branch-service";
import {
  GitHubBranchActivityEventName,
  persistGitHubBranchActivity,
} from "@/app/webhooks/github/handlers/branch-activity-producer";
import { handlePullRequest } from "@/app/webhooks/github/handlers/pull-request-handler";
import {
  createPullRequest,
  createRepository,
  createSender,
} from "../fixtures/github-webhook-fixtures";
import { makePrDetailRow } from "../utils/pr-detail-helpers";
import { handleAuthoritativePullRequest } from "./webhook-pull-request-authority-fixture";

const mockParseArtifactReferences = parseArtifactReferences as Mock;
const mockUpsertBranchArtifact = branchService.upsertBranchArtifact as Mock;
const mockPersistGitHubBranchActivity = persistGitHubBranchActivity as Mock;

// Type aliases for mocked functions
const mockWithDbTx = withDb.tx as unknown as Mock;

// Mock database transaction client
let mockTx: any;

function webhookWriteMocks() {
  return pullRequestWebhookWriteMocks(mockTx, mockUpsertBranchArtifact);
}

describe("handlePullRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockParseArtifactReferences.mockReturnValue([]);
    mockUpsertBranchArtifact.mockResolvedValue({
      ok: true,
      value: { id: "new-branch-artifact-id" },
    });

    mockTx = createPullRequestWebhookTx();

    mockWithDbTx.mockImplementation((callback: any) => callback(mockTx));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("plan reference linkage", () => {
    const ORG_ID = "org-uuid-link";
    const REPO_ID = "repo-uuid-link";
    const ARTIFACT_ID = "artifact-uuid-link";

    function setupRepoMock() {
      mockTx.gitHubInstallationRepository.findFirst.mockResolvedValue({
        fullName: "acme/widgets",
        id: REPO_ID,
        installation: { organizationId: ORG_ID },
      });
    }

    // FEA-4137: the handler resolves the artifact-ref slug via
    // `tx.artifact.findFirst({ where: { slug: { in: expandSlugAliases(...) } } })`
    // (alias-aware) instead of the old `findUnique(organizationId_slug)`. This
    // installs a shape-aware implementation: the `slug`-keyed artifact-ref lookup
    // returns the Document, and any other shape returns null.
    function setupArtifactMock(
      overrides?: Partial<{
        id: string;
        type: string;
        subtype: string;
        organizationId: string;
        projectId: string | null;
        slug: string;
      }>
    ) {
      const documentRow = {
        id: ARTIFACT_ID,
        type: "DOCUMENT",
        subtype: "IMPLEMENTATION_PLAN",
        name: "Test Plan",
        organizationId: ORG_ID,
        projectId: "project-uuid-link",
        assigneeId: null,
        createdById: "user-uuid-link",
        slug: "PLAN-42",
        ...overrides,
      };
      mockTx.artifact.findFirst.mockImplementation((args: unknown) => {
        const where = (args as { where?: { slug?: unknown } } | undefined)
          ?.where;
        // The alias-aware artifact-ref lookup keys on `slug` (an `{ in: [...] }`).
        if (where && "slug" in where) {
          return Promise.resolve(documentRow);
        }
        return Promise.resolve(null);
      });
    }

    function setupPlanRef(slug = "PLN-42") {
      mockParseArtifactReferences.mockReturnValue([
        {
          slug,
          prefix: SlugPrefix.Plan,
          docType: DocumentType.ImplementationPlan,
          matchType: "slug",
          source: "title",
        },
      ]);
    }

    function setupFeatureRef(slug = "FEA-42") {
      mockParseArtifactReferences.mockReturnValue([
        {
          slug,
          prefix: SlugPrefix.Feature,
          docType: DocumentType.Feature,
          matchType: "slug",
          source: "title",
        },
      ]);
    }

    function setupLinkageMocks() {
      // No existing artifact link; link create is a no-op. The `artifact.findFirst`
      // delegate is owned by `setupArtifactMock`'s shape-aware implementation (it
      // must keep returning the Document for the slug-keyed ref lookup), so we do
      // NOT reset it to null here.
      mockTx.artifactLink.findFirst.mockResolvedValue(null);
      mockTx.artifactLink.create.mockResolvedValue({});
    }

    it("links PR opened with valid PLAN slug to artifact", async () => {
      setupRepoMock();
      setupPlanRef();
      setupArtifactMock();
      setupLinkageMocks();
      // First findUnique call (repositoryId_number lookup) returns null (no PR yet).
      // Second findUnique call (githubId dedup) returns null.
      mockTx.pullRequestDetail.findUnique.mockResolvedValue(null);
      // Simulate create returning a new PR artifact
      mockTx.artifact.create.mockResolvedValue({
        id: "new-pr-artifact-id",
      });
      // NOTE: `artifact.findFirst` is owned by setupArtifactMock's shape-aware
      // implementation (slug-keyed → Document, any other shape → null). Do not
      // override it with a flat resolved value here or the alias-aware slug lookup
      // (the artifact-ref resolution) would return a shapeless row and skip linkage.

      const event = {
        action: "opened",
        number: 100,
        pull_request: createPullRequest({
          id: 9001,
          number: 100,
          title: "PLAN-42: Add feature",
        }),
        repository: createRepository(789),
        sender: createSender(),
        installation: { id: 99 },
      } as any;
      await handleAuthoritativePullRequest(event);

      // Should materialize a branch artifact with current PR detail.
      expect(mockUpsertBranchArtifact).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: ORG_ID,
          repositoryId: null,
          pullRequestRepositoryId: REPO_ID,
          branchName: "feature-branch",
          sourceArtifactId: ARTIFACT_ID,
          createdById: "user-uuid-link",
          pullRequest: expect.objectContaining({
            githubId: "9001",
            number: 100,
          }),
        })
      );

      // Should create an ArtifactLink (DOCUMENT → BRANCH via Produces)
      expect(mockTx.artifactLink.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            organizationId: ORG_ID,
            sourceId: ARTIFACT_ID,
            linkType: LinkType.Produces,
          }),
        })
      );
    });

    it("links PR edited to add plan reference retroactively", async () => {
      setupRepoMock();
      setupPlanRef();
      setupArtifactMock();
      setupLinkageMocks();

      // First findUnique (repositoryId_number) → existing PR without linkedDoc
      mockTx.pullRequestDetail.findUnique.mockResolvedValueOnce(
        makePrDetailRow({
          artifactId: "artifact-pr-edit",
          organizationId: ORG_ID,
          linkedDoc: null,
        })
      );
      // Second findUnique re-reads the projected PR for activity attribution.
      mockTx.pullRequestDetail.findUnique.mockResolvedValueOnce({
        id: "artifact-pr-edit",
      });
      // Third findUnique (by githubId in createLinkageRecords) → returns artifactId
      mockTx.pullRequestDetail.findUnique.mockResolvedValueOnce({
        artifactId: "artifact-pr-edit",
      });
      mockTx.artifact.update.mockResolvedValue({});

      const event = {
        action: "edited",
        number: 101,
        pull_request: createPullRequest({
          id: 9002,
          number: 101,
          title: "PLAN-42: Updated",
        }),
        repository: createRepository(789),
        sender: createSender(),
        installation: { id: 99 },
        changes: {},
      } as any;

      await handlePullRequest(event);

      // Should update PR artifact (via createLinkageRecords) and create linkage
      expect(mockTx.artifactLink.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            sourceId: ARTIFACT_ID,
            targetId: "artifact-pr-edit",
            linkType: LinkType.Produces,
          }),
        })
      );

      expect(mockTx.artifact.update).toHaveBeenCalledTimes(1);
      expect(mockTx.pullRequestDetail.update).toHaveBeenCalledTimes(2);
      expect(mockTx.pullRequestDetail.update).toHaveBeenCalledWith({
        where: { githubId: String(event.pull_request.id) },
        data: expect.objectContaining({ prState: "OPEN" }),
        select: { id: true },
      });
      expect(mockTx.pullRequestDetail.updateMany).toHaveBeenCalledTimes(1);
    });

    it("links and applies reopened action when a migration-window PR detail points at a legacy non-branch artifact", async () => {
      setupRepoMock();
      setupPlanRef();
      setupArtifactMock();
      setupLinkageMocks();
      mockTx.pullRequestDetail.findUnique
        .mockResolvedValueOnce({
          artifactId: "legacy-pr-artifact",
          branchArtifactId: null,
          artifact: {
            organizationId: ORG_ID,
            projectId: "project-uuid-link",
            branch: null,
            targetLinks: [],
          },
          branchArtifact: null,
        })
        .mockResolvedValueOnce({
          id: "legacy-pr-detail",
        })
        .mockResolvedValueOnce({
          artifactId: "legacy-pr-artifact",
          branchArtifactId: null,
        });
      mockTx.branchDetail.findFirst.mockResolvedValueOnce(null);

      const pullRequest = createPullRequest({
        id: 9006,
        number: 106,
        title: "PLAN-42: Reopened legacy PR",
        state: "open",
      });
      const event: PullRequestReopenedEvent = {
        action: "reopened",
        number: 106,
        pull_request: pullRequest,
        repository: createRepository(789),
        sender: createSender(),
        installation: { id: 99 },
      } as any;

      await handlePullRequest(event);

      expect(mockTx.branchDetail.update).not.toHaveBeenCalled();
      expect(mockTx.artifactLink.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            sourceId: ARTIFACT_ID,
            targetId: "legacy-pr-artifact",
            linkType: LinkType.Produces,
          }),
        })
      );
      expect(mockTx.pullRequestDetail.update).toHaveBeenCalledWith({
        where: { githubId: String(pullRequest.id) },
        data: expect.objectContaining({
          prState: "OPEN",
          closedAt: null,
        }),
        select: { id: true },
      });
    });

    it("does not fail for invalid slug (returns 200)", async () => {
      setupRepoMock();
      setupPlanRef("PLAN-999");
      // FEA-4137: the artifact-ref lookup is the alias-aware `findFirst`; an
      // unknown slug resolves to no artifact.
      mockTx.artifact.findFirst.mockResolvedValue(null);
      mockTx.pullRequestDetail.findUnique.mockResolvedValue(null);

      const event = {
        action: "opened",
        number: 102,
        pull_request: createPullRequest({
          id: 9003,
          number: 102,
          title: "PLAN-999: Missing",
        }),
        repository: createRepository(789),
        sender: createSender(),
        installation: { id: 99 },
      } as any;

      const response = await handlePullRequest(event);
      const json = await response.json();

      expect(json.ok).toBe(true);
      expect(mockTx.artifactLink.create).not.toHaveBeenCalled();
      expect(mockTx.artifact.create).not.toHaveBeenCalled();
    });

    it("does not link when docType mismatches ref prefix (prefix collision)", async () => {
      setupRepoMock();
      setupPlanRef("PLN-42");
      // Artifact is a PRD (not ImplementationPlan, which is what the ref claims)
      setupArtifactMock({ subtype: "PRD" });
      mockTx.pullRequestDetail.findUnique.mockResolvedValue(null);

      const event = {
        action: "opened",
        number: 103,
        pull_request: createPullRequest({
          id: 9004,
          number: 103,
          title: "PLN-42: PRD ref",
        }),
        repository: createRepository(789),
        sender: createSender(),
        installation: { id: 99 },
      } as any;

      await handlePullRequest(event);

      expect(mockTx.artifactLink.create).not.toHaveBeenCalled();
      expect(mockTx.artifact.create).not.toHaveBeenCalled();
    });

    it("does not overwrite existing link (AC-004)", async () => {
      setupRepoMock();
      setupPlanRef("PLAN-42");

      // PR already linked to a different document
      mockTx.pullRequestDetail.findUnique.mockResolvedValue(
        makePrDetailRow({
          artifactId: "artifact-pr-linked",
          organizationId: ORG_ID,
          linkedDoc: { id: "existing-doc-id", slug: "PLAN-1" },
        })
      );

      const event = {
        action: "edited",
        number: 104,
        pull_request: createPullRequest({
          id: 9005,
          number: 104,
          title: "PLAN-42: Override attempt",
        }),
        repository: createRepository(789),
        sender: createSender(),
        installation: { id: 99 },
        changes: {},
      } as any;

      await handlePullRequest(event);

      // Should NOT look up artifact or create linkage
      expect(mockTx.artifact.findUnique).not.toHaveBeenCalled();
      expect(mockTx.artifactLink.create).not.toHaveBeenCalled();
    });

    it("does not create duplicate ArtifactLink on repeated webhook delivery (AC-008)", async () => {
      setupRepoMock();
      setupPlanRef();
      setupArtifactMock();

      // First findUnique (repositoryId_number) → existing PR without linkedDoc
      mockTx.pullRequestDetail.findUnique.mockResolvedValueOnce(
        makePrDetailRow({
          artifactId: "artifact-pr-dup",
          organizationId: ORG_ID,
          linkedDoc: null,
        })
      );
      // Second findUnique (by githubId in createLinkageRecords) → returns artifactId
      mockTx.pullRequestDetail.findUnique.mockResolvedValueOnce({
        artifactId: "artifact-pr-dup",
      });
      mockTx.artifact.update.mockResolvedValue({});

      // ArtifactLink already exists
      mockTx.artifactLink.findFirst.mockResolvedValue({
        id: "existing-artifact-link",
      });

      const event = {
        action: "reopened",
        number: 105,
        pull_request: createPullRequest({
          id: 9006,
          number: 105,
          title: "PLAN-42: Reopened",
        }),
        repository: createRepository(789),
        sender: createSender(),
        installation: { id: 99 },
      } as any;

      await handlePullRequest(event);

      // Should NOT create duplicate ArtifactLink
      expect(mockTx.artifactLink.create).not.toHaveBeenCalled();

      expect(mockTx.artifact.update).toHaveBeenCalledTimes(1);
      expect(mockTx.pullRequestDetail.update).toHaveBeenCalledTimes(2);
      expect(mockTx.pullRequestDetail.update).toHaveBeenCalledWith({
        where: { githubId: String(event.pull_request.id) },
        data: expect.objectContaining({ prState: "OPEN" }),
        select: { id: true },
      });
    });

    it("records supported activity without re-pointing the branch for a non-current associated PR", async () => {
      setupRepoMock();
      setupPlanRef();
      const pullRequest = createPullRequest({
        id: 9017,
        number: 209,
        title: "PLN-42: stale old PR",
        state: "closed",
        merged: true,
        closed_at: "2026-08-12T18:00:00Z",
        merged_at: "2026-08-12T18:00:00Z",
        head: { sha: "old-pr-head" },
      });
      mockTx.pullRequestDetail.findUnique.mockResolvedValue(
        makePrDetailRow({
          id: "old-pr-detail-id",
          artifactId: "branch-artifact-current",
          currentPullRequestDetailId: "new-pr-detail-id",
          headSha: "new-pr-head",
          organizationId: ORG_ID,
          linkedDoc: null,
        })
      );

      const event = {
        action: "closed",
        number: pullRequest.number,
        pull_request: pullRequest,
        repository: createRepository(789),
        sender: createSender(),
        installation: { id: 99 },
      } as PullRequestClosedEvent;

      await handlePullRequest(event, {
        deliveryId: "non-current-pr-close-delivery",
        observedAt: new Date("2026-08-12T19:00:00Z"),
      });

      expect(mockParseArtifactReferences).not.toHaveBeenCalled();
      for (const write of webhookWriteMocks()) {
        expect(write).not.toHaveBeenCalled();
      }
      expect(mockPersistGitHubBranchActivity).toHaveBeenCalledWith({
        eventName: GitHubBranchActivityEventName.PullRequest,
        deliveryId: "non-current-pr-close-delivery",
        payload: event,
        attribution: {
          organizationId: ORG_ID,
          branchArtifactId: "branch-artifact-current",
          pullRequestDetailId: "old-pr-detail-id",
        },
      });
    });

    it("does not mutate linkage for stale edited events against an existing closed PR", async () => {
      setupRepoMock();
      setupPlanRef();
      mockTx.pullRequestDetail.findUnique.mockResolvedValue(
        makePrDetailRow({
          artifactId: "artifact-pr-stale-edit",
          headSha: "abc123",
          prState: "CLOSED",
          closedAt: new Date("2026-03-01T12:00:00Z"),
          organizationId: ORG_ID,
          linkedDoc: null,
        })
      );

      await handlePullRequest({
        action: "edited",
        number: 206,
        pull_request: createPullRequest({
          id: 9014,
          number: 206,
          title: "PLN-42: stale edit",
        }),
        repository: createRepository(789),
        sender: createSender(),
        installation: { id: 99 },
        changes: {},
      } as any);

      expect(mockParseArtifactReferences).not.toHaveBeenCalled();
      for (const write of webhookWriteMocks()) {
        expect(write).not.toHaveBeenCalled();
      }
    });

    it("does not mutate linkage for stale reopened events against an existing closed PR", async () => {
      setupRepoMock();
      setupPlanRef();
      mockTx.pullRequestDetail.findUnique.mockResolvedValue(
        makePrDetailRow({
          artifactId: "artifact-pr-stale-reopen",
          headSha: "abc123",
          prState: "CLOSED",
          closedAt: new Date("2026-03-01T12:00:00Z"),
          organizationId: ORG_ID,
          linkedDoc: null,
        })
      );

      await handlePullRequest({
        action: "reopened",
        number: 207,
        pull_request: createPullRequest({
          id: 9015,
          number: 207,
          title: "PLN-42: stale reopen",
        }),
        repository: createRepository(789),
        sender: createSender(),
        installation: { id: 99 },
      } as any);

      expect(mockParseArtifactReferences).not.toHaveBeenCalled();
      for (const write of webhookWriteMocks()) {
        expect(write).not.toHaveBeenCalled();
      }
    });

    it("does not mutate linkage for edited events against an existing merged PR", async () => {
      setupRepoMock();
      setupPlanRef();
      mockTx.pullRequestDetail.findUnique.mockResolvedValue(
        makePrDetailRow({
          artifactId: "artifact-pr-merged-terminal",
          headSha: "abc123",
          prState: "MERGED",
          mergedAt: new Date("2026-03-01T12:00:00Z"),
          organizationId: ORG_ID,
          linkedDoc: null,
        })
      );

      await handlePullRequest({
        action: "edited",
        number: 208,
        pull_request: createPullRequest({
          id: 9016,
          number: 208,
          title: "PLN-42: terminal edit",
        }),
        repository: createRepository(789),
        sender: createSender(),
        installation: { id: 99 },
        changes: {},
      } as any);

      expect(mockParseArtifactReferences).not.toHaveBeenCalled();
      for (const write of webhookWriteMocks()) {
        expect(write).not.toHaveBeenCalled();
      }
    });

    it("PR opened with FEA slug links to feature document", async () => {
      setupRepoMock();
      setupFeatureRef("FEA-42");
      setupArtifactMock({
        subtype: "FEATURE",
        slug: "FEA-42",
      });
      setupLinkageMocks();
      mockTx.pullRequestDetail.findUnique.mockResolvedValue(null);
      mockTx.artifact.create.mockResolvedValue({ id: "new-pr-id-feature" });
      // artifact.findFirst is owned by setupArtifactMock's shape-aware impl.

      const event = {
        action: "opened",
        number: 200,
        pull_request: createPullRequest({
          id: 9008,
          number: 200,
          title: "FEA-42: fix login timeout",
        }),
        repository: createRepository(789),
        sender: createSender(),
        installation: { id: 99 },
      } as any;
      await handleAuthoritativePullRequest(event);

      // Branch artifact created with nested current PR detail through service.
      expect(mockUpsertBranchArtifact).toHaveBeenCalledWith(
        expect.objectContaining({
          branchName: "feature-branch",
          sourceArtifactId: ARTIFACT_ID,
          createdById: "user-uuid-link",
        })
      );
      // ArtifactLink created with FEATURE document as source
      expect(mockTx.artifactLink.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            sourceId: ARTIFACT_ID,
            linkType: LinkType.Produces,
          }),
        })
      );
    });

    it("skips linkage when FEA slug resolves to non-Feature document (prefix collision)", async () => {
      setupRepoMock();
      setupFeatureRef("FEA-42");
      // Document exists but is an ImplementationPlan (simulated collision)
      setupArtifactMock({
        subtype: "IMPLEMENTATION_PLAN",
        slug: "FEA-42",
      });
      mockTx.pullRequestDetail.findUnique.mockResolvedValue(null);

      const event = {
        action: "opened",
        number: 201,
        pull_request: createPullRequest({
          id: 9009,
          number: 201,
          title: "FEA-42: collision",
        }),
        repository: createRepository(789),
        sender: createSender(),
        installation: { id: 99 },
      } as any;

      await handlePullRequest(event);

      expect(mockTx.artifactLink.create).not.toHaveBeenCalled();
      expect(mockTx.artifact.create).not.toHaveBeenCalled();
    });

    it("when PR references both PLN and FEA, plan wins and only one link is created", async () => {
      setupRepoMock();
      // Parser returns both refs — plan first (matches real behaviour for same-source refs)
      mockParseArtifactReferences.mockReturnValue([
        {
          slug: "PLN-17",
          prefix: SlugPrefix.Plan,
          docType: DocumentType.ImplementationPlan,
          matchType: "slug",
          source: "title",
        },
        {
          slug: "FEA-42",
          prefix: SlugPrefix.Feature,
          docType: DocumentType.Feature,
          matchType: "slug",
          source: "title",
        },
      ]);
      setupArtifactMock({ slug: "PLN-17" });
      setupLinkageMocks();
      mockTx.pullRequestDetail.findUnique.mockResolvedValue(null);
      mockTx.artifact.create.mockResolvedValue({ id: "new-pr-id-both" });
      // artifact.findFirst is owned by setupArtifactMock's shape-aware impl.

      const event = {
        action: "opened",
        number: 202,
        pull_request: createPullRequest({
          id: 9010,
          number: 202,
          title: "FEA-42: implement PLN-17",
        }),
        repository: createRepository(789),
        sender: createSender(),
        installation: { id: 99 },
      } as any;
      await handleAuthoritativePullRequest(event);

      // Only the plan was looked up by slug. FEA-4137: the artifact-ref lookup is
      // now the alias-aware `findFirst({ slug: { in: expandSlugAliases(slug) } })`
      // (a PLN slug has no cross-prefix alias, so the candidate set is ["PLN-17"]).
      const slugLookups = mockTx.artifact.findFirst.mock.calls.filter(
        (call: unknown[]) =>
          Boolean((call[0] as { where?: { slug?: unknown } })?.where?.slug)
      );
      expect(slugLookups).toHaveLength(1);
      expect(slugLookups[0][0]).toEqual(
        expect.objectContaining({
          where: expect.objectContaining({
            organizationId: ORG_ID,
            slug: { in: ["PLN-17"] },
          }),
        })
      );
      expect(mockTx.artifactLink.create).toHaveBeenCalledTimes(1);
    });
  });
});
