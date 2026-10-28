import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetRepositoryBranches,
  mockGetRepositoryPullRequests,
  mockGetInstallationOctokit,
} = vi.hoisted(() => ({
  mockGetRepositoryBranches: vi.fn(),
  mockGetRepositoryPullRequests: vi.fn(),
  mockGetInstallationOctokit: vi.fn(() => ({ kind: "installation-octokit" })),
}));

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
    join: (parts: unknown[]) => ({ strings: [], values: parts }),
  },
  ArtifactType: { DOCUMENT: "DOCUMENT", BRANCH: "BRANCH" },
  GitHubInstallationStatus: {
    PENDING_CLAIM: "PENDING_CLAIM",
    ACTIVE: "ACTIVE",
    SUSPENDED: "SUSPENDED",
    UNINSTALLED: "UNINSTALLED",
  },
}));

vi.mock("@repo/github", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/github")>()),
  deleteInstallation: vi.fn(),
  getRepositoryBranches: mockGetRepositoryBranches,
  getRepositoryPullRequestsWithMetadata: mockGetRepositoryPullRequests,
}));

vi.mock("@repo/github/installation-auth", () => ({
  getInstallationOctokit: mockGetInstallationOctokit,
}));

vi.mock("@repo/github/keys", () => ({
  keys: vi.fn(() => ({
    GITHUB_APP_CLIENT_ID: "test-client-id",
    GITHUB_APP_CLIENT_SECRET: "test-client-secret",
  })),
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitTelemetryMetric: vi.fn(),
}));

vi.mock("@repo/observability/error", () => ({
  parseError: vi.fn((err: unknown) => String(err)),
}));

vi.mock("@/app/integrations/github/public-repositories/service", () => ({
  publicRepositoryService: { getBranches: vi.fn() },
}));

import { GitHubInstallationStatus } from "@repo/database";
import { mockWithDbCall } from "@/__tests__/utils/db-helpers";
import { githubService } from "@/app/integrations/github/service";

const ORG_ID = "org-1";
const MALFORMED = ["org/repo/extra", "badformat", "org/", "/repo"];

/** Seed the one row both read methods look up before they parse its name. */
function mockRepositoryRow(fullName: string): void {
  mockWithDbCall({
    gitHubInstallationRepository: {
      findFirst: vi.fn(() =>
        Promise.resolve({
          id: "repo-1",
          fullName,
          removedAt: null,
          installation: {
            organizationId: ORG_ID,
            installationId: "gh-install-100",
            status: GitHubInstallationStatus.ACTIVE,
          },
        })
      ),
    },
  });
}

/**
 * Both read methods must reject a name that is not exactly `owner/repo` BEFORE
 * any provider call — truncating `org/repo/extra` to `org/repo` would return a
 * different repository's branches or pull requests under this repository's id.
 * These assertions live beside the helper rather than in `service.test.ts` so
 * that suite stays byte-identical to its base (ISS-7548).
 */
describe("githubService repository-identity wiring (ISS-7548)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(MALFORMED)(
    "getBranches rejects %s before drawing an installation client",
    async (fullName) => {
      mockRepositoryRow(fullName);

      await expect(githubService.getBranches("repo-1", ORG_ID)).rejects.toThrow(
        "Invalid repository fullName format"
      );
      expect(mockGetRepositoryBranches).not.toHaveBeenCalled();
      expect(mockGetInstallationOctokit).not.toHaveBeenCalled();
    }
  );

  it.each(MALFORMED)(
    "getPullRequests rejects %s before drawing an installation client",
    async (fullName) => {
      mockRepositoryRow(fullName);

      await expect(
        githubService.getPullRequests("repo-1", ORG_ID, null)
      ).rejects.toThrow("Invalid repository fullName format");
      expect(mockGetRepositoryPullRequests).not.toHaveBeenCalled();
      expect(mockGetInstallationOctokit).not.toHaveBeenCalled();
    }
  );
});
