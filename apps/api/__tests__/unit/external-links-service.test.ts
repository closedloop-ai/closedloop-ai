import { vi } from "vitest";
import {
  getMockWithDb,
  mockWithDbCall,
  mockWithDbTx,
} from "../utils/db-helpers";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  Prisma: { DbNull: "DbNull" },
}));

import { GitHubPRState } from "@repo/api/src/types/github";
import { externalLinksService } from "@/app/external-links/service";

describe("externalLinksService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("findAll filter precedence", () => {
    let mockDb: { externalLink: { findMany: ReturnType<typeof vi.fn> } };

    beforeEach(() => {
      mockDb = {
        externalLink: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      };
      mockWithDbCall(mockDb);
    });

    it("filters by projectId when workstreamId is absent", async () => {
      await externalLinksService.findAll({
        organizationId: "org-1",
        projectId: "proj-1",
      });

      expect(mockDb.externalLink.findMany).toHaveBeenCalledWith({
        where: { organizationId: "org-1", projectId: "proj-1" },
        orderBy: { createdAt: "desc" },
      });
    });

    it("ignores projectId when workstreamId is present", async () => {
      await externalLinksService.findAll({
        organizationId: "org-1",
        workstreamId: "ws-1",
        projectId: "proj-1",
      });

      expect(mockDb.externalLink.findMany).toHaveBeenCalledWith({
        where: { organizationId: "org-1", workstreamId: "ws-1" },
        orderBy: { createdAt: "desc" },
      });
    });
  });

  describe("create metadata handling", () => {
    it.each([
      {
        label: "null",
        input: {
          type: "FIGMA_DESIGN" as const,
          projectId: "01935b3e-0000-7000-8000-000000000001",
          title: "Design",
          externalUrl: "https://figma.com/file/abc",
          metadata: null,
        },
      },
      {
        label: "undefined",
        input: {
          type: "FIGMA_DESIGN" as const,
          projectId: "01935b3e-0000-7000-8000-000000000001",
          title: "Design",
          externalUrl: "https://figma.com/file/abc",
        },
      },
    ])("uses DbNull when metadata is $label", async ({ input }) => {
      const createdRow = {
        id: "link-1",
        type: "FIGMA_DESIGN",
        metadata: null,
        workstreamId: null,
      };
      const mockTx = {
        externalLink: {
          create: vi.fn().mockResolvedValue(createdRow),
        },
      };
      mockWithDbTx(mockTx);

      await externalLinksService.create("org-1", input);

      expect(mockTx.externalLink.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          metadata: "DbNull",
        }),
      });
    });
  });

  describe("update metadata handling", () => {
    it("sets metadata to DbNull when explicitly null", async () => {
      const mockDb = {
        externalLink: {
          update: vi.fn().mockResolvedValue({ id: "link-1" }),
        },
      };
      mockWithDbCall(mockDb);

      await externalLinksService.update("org-1", "link-1", {
        metadata: null,
      });

      expect(mockDb.externalLink.update).toHaveBeenCalledWith({
        where: { id: "link-1", organizationId: "org-1" },
        data: {
          metadata: "DbNull",
        },
      });
    });

    it("preserves metadata when undefined (not provided)", async () => {
      const mockDb = {
        externalLink: {
          update: vi.fn().mockResolvedValue({ id: "link-1" }),
        },
      };
      mockWithDbCall(mockDb);

      await externalLinksService.update("org-1", "link-1", {
        title: "New Title",
      });

      expect(mockDb.externalLink.update).toHaveBeenCalledWith({
        where: { id: "link-1", organizationId: "org-1" },
        data: {
          title: "New Title",
          metadata: undefined,
        },
      });
    });
  });

  describe("create extended — transaction and github_pull_requests side-effects", () => {
    const ORG_ID = "org-1";

    /** Minimal PULL_REQUEST metadata that satisfies PullRequestMetadata */
    const prMetadata = {
      number: 42,
      githubId: "PR_gh_42",
      headBranch: "feature/foo",
      baseBranch: "main",
      state: GitHubPRState.Open,
    };

    /** A fully-formed created external link returned by tx.externalLink.create */
    function makePrLink(overrides?: Record<string, unknown>) {
      return {
        id: "link-1",
        organizationId: ORG_ID,
        projectId: "proj-1",
        type: "PULL_REQUEST",
        title: "My PR",
        externalUrl: "https://github.com/acme/repo/pull/42",
        workstreamId: "ws-1",
        metadata: prMetadata,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
      };
    }

    it("creates external_links row within transaction", async () => {
      const createdLink = makePrLink({ workstreamId: null, metadata: null });
      const mockTx = {
        document: { findUnique: vi.fn().mockResolvedValue(null) },
        externalLink: { create: vi.fn().mockResolvedValue(createdLink) },
      };
      mockWithDbTx(mockTx);
      // withDb (non-tx) calls must not throw — no PR side-effects for null metadata
      mockWithDbCall({});

      await externalLinksService.create(ORG_ID, {
        projectId: "proj-1",
        type: "PULL_REQUEST",
        title: "My PR",
        externalUrl: "https://github.com/acme/repo/pull/42",
      });

      expect(mockTx.externalLink.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          organizationId: ORG_ID,
          projectId: "proj-1",
          type: "PULL_REQUEST",
        }),
      });
    });

    it("resolves workstreamId from document when documentId provided", async () => {
      const createdLink = makePrLink({
        workstreamId: "ws-from-document",
        metadata: null,
      });
      const mockTx = {
        document: {
          findFirst: vi
            .fn()
            .mockResolvedValue({ workstreamId: "ws-from-document" }),
        },
        externalLink: { create: vi.fn().mockResolvedValue(createdLink) },
      };
      mockWithDbTx(mockTx);
      mockWithDbCall({});

      await externalLinksService.create(ORG_ID, {
        projectId: "proj-1",
        type: "PULL_REQUEST",
        title: "My PR",
        externalUrl: "https://github.com/acme/repo/pull/42",
        documentId: "document-1",
      });

      expect(mockTx.document.findFirst).toHaveBeenCalledWith({
        where: { id: "document-1", organizationId: ORG_ID },
        select: { workstreamId: true },
      });
      expect(mockTx.externalLink.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ workstreamId: "ws-from-document" }),
      });
    });

    it("handles missing document gracefully — external link still created", async () => {
      const createdLink = makePrLink({ workstreamId: null, metadata: null });
      const mockTx = {
        document: { findFirst: vi.fn().mockResolvedValue(null) },
        externalLink: { create: vi.fn().mockResolvedValue(createdLink) },
      };
      mockWithDbTx(mockTx);
      mockWithDbCall({});

      const result = await externalLinksService.create(ORG_ID, {
        projectId: "proj-1",
        type: "PULL_REQUEST",
        title: "My PR",
        externalUrl: "https://github.com/acme/repo/pull/42",
        documentId: "document-missing",
      });

      // External link was returned despite missing document
      expect(result.id).toBe("link-1");
      // workstreamId falls back to undefined/null (no document found)
      expect(mockTx.externalLink.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ organizationId: ORG_ID }),
      });
    });

    it("creates github_pull_requests row when workstream is resolvable", async () => {
      const createdLink = makePrLink();
      const mockTx = {
        document: { findUnique: vi.fn() },
        externalLink: { create: vi.fn().mockResolvedValue(createdLink) },
      };
      mockWithDbTx(mockTx);

      const mockRepo = { id: "repo-1" };
      const mockPrCreate = vi.fn().mockResolvedValue({ githubId: "PR_gh_42" });
      // withDb is called once in the best-effort block for repo lookup, existing PR check, and PR create.
      getMockWithDb().mockImplementationOnce((cb: (db: unknown) => unknown) =>
        cb({
          gitHubInstallationRepository: {
            findFirst: vi.fn().mockResolvedValue(mockRepo),
          },
          gitHubPullRequest: {
            findFirst: vi.fn().mockResolvedValue(null),
            create: mockPrCreate,
          },
        })
      );

      await externalLinksService.create(ORG_ID, {
        projectId: "proj-1",
        type: "PULL_REQUEST",
        title: "My PR",
        externalUrl: "https://github.com/acme/repo/pull/42",
        metadata: prMetadata,
      });

      expect(mockPrCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            workstreamId: "ws-1",
            organizationId: ORG_ID,
            repositoryId: "repo-1",
            number: 42,
            htmlUrl: "https://github.com/acme/repo/pull/42",
          }),
        })
      );
    });

    it("skips github_pull_requests and logs warning when workstreamId is null", async () => {
      const createdLink = makePrLink({ workstreamId: null });
      const mockTx = {
        document: { findUnique: vi.fn() },
        externalLink: { create: vi.fn().mockResolvedValue(createdLink) },
      };
      mockWithDbTx(mockTx);

      // withDb should NOT be called for repo lookup or PR create
      const mockNonTxWithDb = vi.fn();
      getMockWithDb().mockImplementation(mockNonTxWithDb);

      const result = await externalLinksService.create(ORG_ID, {
        projectId: "proj-1",
        type: "PULL_REQUEST",
        title: "My PR",
        externalUrl: "https://github.com/acme/repo/pull/42",
        metadata: prMetadata,
      });

      // External link still returned
      expect(result.id).toBe("link-1");
      // No non-transactional withDb calls (repo lookup / PR create)
      expect(mockNonTxWithDb).not.toHaveBeenCalled();
    });

    it("handles P2002 dedup when github_pull_requests already exists", async () => {
      const createdLink = makePrLink();
      const mockTx = {
        document: { findUnique: vi.fn() },
        externalLink: { create: vi.fn().mockResolvedValue(createdLink) },
      };
      mockWithDbTx(mockTx);

      const p2002Error = Object.assign(new Error("Unique constraint"), {
        code: "P2002",
      });
      getMockWithDb().mockImplementationOnce((cb: (db: unknown) => unknown) =>
        cb({
          gitHubInstallationRepository: {
            findFirst: vi.fn().mockResolvedValue({ id: "repo-1" }),
          },
          gitHubPullRequest: {
            findFirst: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockRejectedValue(p2002Error),
          },
        })
      );

      // Should not throw — P2002 is treated as a no-op dedup
      await expect(
        externalLinksService.create(ORG_ID, {
          projectId: "proj-1",
          type: "PULL_REQUEST",
          title: "My PR",
          externalUrl: "https://github.com/acme/repo/pull/42",
          metadata: prMetadata,
        })
      ).resolves.toBeDefined();
    });

    it("handles repositoryId lookup failure — external link still created, github_pull_requests skipped", async () => {
      const createdLink = makePrLink();
      const mockTx = {
        document: { findUnique: vi.fn() },
        externalLink: { create: vi.fn().mockResolvedValue(createdLink) },
      };
      mockWithDbTx(mockTx);

      const mockPrCreate = vi.fn();
      // Repo lookup returns null (not found) — PR create should never be reached
      getMockWithDb().mockImplementationOnce((cb: (db: unknown) => unknown) =>
        cb({
          gitHubInstallationRepository: {
            findFirst: vi.fn().mockResolvedValue(null),
          },
          gitHubPullRequest: { create: mockPrCreate },
        })
      );

      const result = await externalLinksService.create(ORG_ID, {
        projectId: "proj-1",
        type: "PULL_REQUEST",
        title: "My PR",
        externalUrl: "https://github.com/acme/repo/pull/42",
        metadata: prMetadata,
      });

      // External link returned successfully
      expect(result.id).toBe("link-1");
      // PR create was never called because repo was not found
      expect(mockPrCreate).not.toHaveBeenCalled();
    });
  });

  describe("delete", () => {
    it("cleans up entity links before deleting external link in transaction", async () => {
      const mockTx = {
        entityLink: {
          deleteMany: vi.fn().mockResolvedValue({ count: 2 }),
        },
        externalLink: {
          delete: vi.fn().mockResolvedValue({ id: "link-1" }),
        },
      };
      mockWithDbTx(mockTx);

      await externalLinksService.delete("org-1", "link-1");

      expect(mockTx.entityLink.deleteMany).toHaveBeenCalledWith({
        where: {
          organizationId: "org-1",
          OR: [
            { sourceId: "link-1", sourceType: "EXTERNAL_LINK" },
            { targetId: "link-1", targetType: "EXTERNAL_LINK" },
          ],
        },
      });
      expect(mockTx.externalLink.delete).toHaveBeenCalledWith({
        where: { id: "link-1", organizationId: "org-1" },
      });
    });
  });
});
