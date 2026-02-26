import { withDb } from "@repo/database";
import { vi } from "vitest";
import { artifactsService } from "@/app/artifacts/service";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
  ArtifactSubtype: {
    PRD: "PRD",
    IMPLEMENTATION_PLAN: "IMPLEMENTATION_PLAN",
  },
}));

vi.mock("@/app/artifacts/artifact-utils", () => ({
  artifactIncludeWithContext: {},
  toArtifact: vi.fn(),
  pullRequestSelect: {
    id: true,
    number: true,
    title: true,
    htmlUrl: true,
    state: true,
    headBranch: true,
    baseBranch: true,
    createdAt: true,
    checksStatus: true,
  },
}));

vi.mock("@/app/artifacts/room-utils", () => ({
  createArtifactRoom: vi.fn(),
}));

describe("Artifacts Service - PR Batch Fetching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("findAll - batch PR fetching", () => {
    it("fetches PRs for artifacts with workstreamIds", async () => {
      const mockArtifacts = [
        {
          id: "artifact-1",
          title: "PRD 1",
          workstreamId: "ws-1",
          organizationId: "org-1",
        },
        {
          id: "artifact-2",
          title: "PRD 2",
          workstreamId: "ws-2",
          organizationId: "org-1",
        },
      ];

      const mockPRs = [
        {
          id: "pr-1",
          workstreamId: "ws-1",
          number: 42,
          title: "PR for WS 1",
          htmlUrl: "https://github.com/org/repo/pull/42",
          state: "OPEN",
          headBranch: "feature-1",
          baseBranch: "main",
          createdAt: new Date("2024-01-15T10:00:00Z"),
        },
        {
          id: "pr-2",
          workstreamId: "ws-2",
          number: 43,
          title: "PR for WS 2",
          htmlUrl: "https://github.com/org/repo/pull/43",
          state: "OPEN",
          headBranch: "feature-2",
          baseBranch: "main",
          createdAt: new Date("2024-01-15T11:00:00Z"),
        },
      ];

      // Mock the two database calls: artifacts query and PRs query
      vi.mocked(withDb).mockImplementation((callback: any) => {
        const mockDb = {
          artifact: {
            findMany: vi.fn().mockResolvedValue(mockArtifacts),
          },
          gitHubPullRequest: {
            findMany: vi.fn().mockResolvedValue(mockPRs),
          },
        };
        return callback(mockDb);
      });

      const result = await artifactsService.findAll({
        organizationId: "org-1",
        subtype: "PRD",
      });

      expect(result).toHaveLength(2);
      expect(result[0].pullRequest).toMatchObject({
        number: 42,
        htmlUrl: "https://github.com/org/repo/pull/42",
      });
      expect(result[1].pullRequest).toMatchObject({
        number: 43,
        htmlUrl: "https://github.com/org/repo/pull/43",
      });
    });

    it("returns null pullRequest when workstreamId is null", async () => {
      const mockArtifacts = [
        {
          id: "artifact-1",
          title: "PRD without workstream",
          workstreamId: null,
          organizationId: "org-1",
        },
      ];

      vi.mocked(withDb).mockImplementation((callback: any) => {
        const mockDb = {
          artifact: {
            findMany: vi.fn().mockResolvedValue(mockArtifacts),
          },
        };
        return callback(mockDb);
      });

      const result = await artifactsService.findAll({
        organizationId: "org-1",
      });

      expect(result).toHaveLength(1);
      expect(result[0].pullRequest).toBeNull();
    });

    it("returns null pullRequest when no PR exists for workstream", async () => {
      const mockArtifacts = [
        {
          id: "artifact-1",
          title: "PRD with workstream but no PR",
          workstreamId: "ws-no-pr",
          organizationId: "org-1",
        },
      ];

      const mockPRs: any[] = []; // No PRs returned

      vi.mocked(withDb).mockImplementation((callback: any) => {
        const mockDb = {
          artifact: {
            findMany: vi.fn().mockResolvedValue(mockArtifacts),
          },
          gitHubPullRequest: {
            findMany: vi.fn().mockResolvedValue(mockPRs),
          },
        };
        return callback(mockDb);
      });

      const result = await artifactsService.findAll({
        organizationId: "org-1",
      });

      expect(result).toHaveLength(1);
      expect(result[0].pullRequest).toBeNull();
    });

    it("deduplicates PRs per workstream, keeping most recent", async () => {
      const mockArtifacts = [
        {
          id: "artifact-1",
          title: "PRD 1",
          workstreamId: "ws-shared",
          organizationId: "org-1",
        },
        {
          id: "artifact-2",
          title: "Plan 1",
          workstreamId: "ws-shared",
          organizationId: "org-1",
        },
      ];

      // Multiple PRs for same workstream, ordered by createdAt desc
      const mockPRs = [
        {
          id: "pr-newer",
          workstreamId: "ws-shared",
          number: 100,
          title: "Newer PR",
          htmlUrl: "https://github.com/org/repo/pull/100",
          state: "OPEN",
          headBranch: "feature-new",
          baseBranch: "main",
          createdAt: new Date("2024-01-16T10:00:00Z"), // More recent
        },
        {
          id: "pr-older",
          workstreamId: "ws-shared",
          number: 99,
          title: "Older PR",
          htmlUrl: "https://github.com/org/repo/pull/99",
          state: "MERGED",
          headBranch: "feature-old",
          baseBranch: "main",
          createdAt: new Date("2024-01-15T10:00:00Z"), // Older
        },
      ];

      vi.mocked(withDb).mockImplementation((callback: any) => {
        const mockDb = {
          artifact: {
            findMany: vi.fn().mockResolvedValue(mockArtifacts),
          },
          gitHubPullRequest: {
            findMany: vi.fn().mockResolvedValue(mockPRs),
          },
        };
        return callback(mockDb);
      });

      const result = await artifactsService.findAll({
        organizationId: "org-1",
      });

      expect(result).toHaveLength(2);
      // Both artifacts should have the newer PR (first in the ordered list)
      expect(result[0].pullRequest?.number).toBe(100);
      expect(result[1].pullRequest?.number).toBe(100);
    });

    it("extracts unique workstreamIds and filters out nulls", async () => {
      const mockArtifacts = [
        {
          id: "artifact-1",
          workstreamId: "ws-1",
          organizationId: "org-1",
        },
        {
          id: "artifact-2",
          workstreamId: "ws-1", // Duplicate
          organizationId: "org-1",
        },
        {
          id: "artifact-3",
          workstreamId: null, // Should be filtered out
          organizationId: "org-1",
        },
        {
          id: "artifact-4",
          workstreamId: "ws-2",
          organizationId: "org-1",
        },
      ];

      const prQuerySpy = vi.fn().mockResolvedValue([]);

      vi.mocked(withDb).mockImplementation((callback: any) => {
        const mockDb = {
          artifact: {
            findMany: vi.fn().mockResolvedValue(mockArtifacts),
          },
          gitHubPullRequest: {
            findMany: prQuerySpy,
          },
        };
        return callback(mockDb);
      });

      await artifactsService.findAll({
        organizationId: "org-1",
      });

      // Should query with only unique, non-null workstreamIds
      expect(prQuerySpy).toHaveBeenCalledWith({
        where: {
          workstreamId: { in: expect.arrayContaining(["ws-1", "ws-2"]) },
        },
        orderBy: { createdAt: "desc" },
        select: expect.any(Object),
      });

      const callArg = prQuerySpy.mock.calls[0][0];
      expect(callArg.where.workstreamId.in).toHaveLength(2);
    });

    it("skips PR query when no artifacts have workstreamIds", async () => {
      const mockArtifacts = [
        {
          id: "artifact-1",
          workstreamId: null,
          organizationId: "org-1",
        },
        {
          id: "artifact-2",
          workstreamId: null,
          organizationId: "org-1",
        },
      ];

      const prQuerySpy = vi.fn();

      vi.mocked(withDb).mockImplementation((callback: any) => {
        const mockDb = {
          artifact: {
            findMany: vi.fn().mockResolvedValue(mockArtifacts),
          },
          gitHubPullRequest: {
            findMany: prQuerySpy,
          },
        };
        return callback(mockDb);
      });

      const result = await artifactsService.findAll({
        organizationId: "org-1",
      });

      // PR query should not be called
      expect(prQuerySpy).not.toHaveBeenCalled();
      expect(result).toHaveLength(2);
      expect(result[0].pullRequest).toBeNull();
      expect(result[1].pullRequest).toBeNull();
    });
  });

  describe("findById - backward compatibility", () => {
    it("returns null pullRequest when prMap not provided", async () => {
      const mockArtifact = {
        id: "artifact-1",
        title: "PRD",
        workstreamId: "ws-1",
        organizationId: "org-1",
        project: null,
        owner: null,
        previewDeployment: null,
      };

      vi.mocked(withDb).mockImplementation((callback: any) => {
        const mockDb = {
          artifact: {
            findUnique: vi.fn().mockResolvedValue(mockArtifact),
          },
        };
        return callback(mockDb);
      });

      const result = await artifactsService.findById("artifact-1", "org-1");

      expect(result).toBeDefined();
      expect(result!.pullRequest).toBeNull();
    });
  });
});
