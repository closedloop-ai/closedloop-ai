import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import {
  dbUtilsModuleMock,
  makeInstallationRepo,
} from "../../../__tests__/fixtures/loops-service-mocks";

const { mockGetInstallationOctokit, mockOctokit } = vi.hoisted(() => ({
  mockGetInstallationOctokit: vi.fn(),
  mockOctokit: { marker: "installation-octokit" },
}));

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  GitHubInstallationStatus: {
    PENDING_CLAIM: "PENDING_CLAIM",
    ACTIVE: "ACTIVE",
    SUSPENDED: "SUSPENDED",
    UNINSTALLED: "UNINSTALLED",
  },
}));

vi.mock("@repo/github", () => ({
  verifyBranchExists: vi.fn(),
}));

vi.mock("@repo/github/installation-auth", () => ({
  // Spy wrapper (not a bare vi.fn implementation) so a restoreAllMocks pass can
  // never strip the marker client the service threads into verifyBranchExists.
  getInstallationOctokit: (installationId: string) => {
    mockGetInstallationOctokit(installationId);
    return Promise.resolve(mockOctokit);
  },
}));

vi.mock("@/app/documents/document-pull-request-service", () => ({
  documentPullRequestService: {
    getDocumentBranches: vi.fn(),
    getDocumentPullRequests: vi.fn(),
  },
}));

vi.mock("@/lib/loops/uploaded-plan-artifacts", () => ({
  extractUploadedPlanRaw: vi.fn().mockReturnValue(null),
}));

vi.mock("@/lib/db-utils", () => dbUtilsModuleMock());

vi.mock("@/lib/loops/loop-state", () => ({
  generateDownloadUrl: vi.fn(),
  validateKeyBelongsToLoop: vi.fn(),
}));

vi.mock("@/lib/loops/loop-blockers", () => ({
  findNonTerminalBlockers: vi.fn().mockResolvedValue([]),
}));

// Import after mocking
import { withDb } from "@repo/database";
import { verifyBranchExists } from "@repo/github";
import { authorizeAdditionalRepos } from "../authorize-additional-repos";
import { BranchNotFoundError, UnauthorizedRepoError } from "../loop-errors";

const mockWithDb = withDb as unknown as Mock;
const mockVerifyBranch = verifyBranchExists as unknown as Mock;

const TEST_ORG_ID_AUTH = "org-auth-111";

/** Wire `withDb` so the installation-repository lookup returns `repos`. */
function mockInstallationRepoLookup(repos: unknown[]) {
  mockWithDb.mockImplementation((callback: (db: unknown) => unknown) =>
    callback({
      gitHubInstallationRepository: {
        findMany: vi.fn().mockResolvedValue(repos),
      },
    })
  );
}

describe("authorizeAdditionalRepos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns authorized repo records when all repos are in the installation and branches exist", async () => {
    mockInstallationRepoLookup([
      makeInstallationRepo("acme/frontend"),
      makeInstallationRepo("acme/backend"),
    ]);
    mockVerifyBranch.mockResolvedValue(true);

    const result = await authorizeAdditionalRepos(
      [
        { fullName: "acme/frontend", branch: "main" },
        { fullName: "acme/backend", branch: "develop" },
      ],
      TEST_ORG_ID_AUTH
    );

    expect(result).toHaveLength(2);
    expect(result.map((r) => r.fullName)).toEqual(
      expect.arrayContaining(["acme/frontend", "acme/backend"])
    );
    expect(mockGetInstallationOctokit).toHaveBeenCalledWith("12345");
    // Both repos share one installation, so the token is acquired once rather
    // than raced for per repo inside the fan-out.
    expect(mockGetInstallationOctokit).toHaveBeenCalledTimes(1);
    expect(mockVerifyBranch).toHaveBeenCalledTimes(2);
    expect(mockVerifyBranch).toHaveBeenCalledWith(
      mockOctokit,
      "acme",
      "frontend",
      "main"
    );
    expect(mockVerifyBranch).toHaveBeenCalledWith(
      mockOctokit,
      "acme",
      "backend",
      "develop"
    );
  });

  it("throws UnauthorizedRepoError when a repo is not found in the installation", async () => {
    // Only acme/frontend is found; acme/missing is not in the installation.
    mockInstallationRepoLookup([makeInstallationRepo("acme/frontend")]);
    mockVerifyBranch.mockResolvedValue(true);

    await expect(
      authorizeAdditionalRepos(
        [
          { fullName: "acme/frontend", branch: "main" },
          { fullName: "acme/missing", branch: "main" },
        ],
        TEST_ORG_ID_AUTH
      )
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(UnauthorizedRepoError);
      expect(error).toMatchObject({ unauthorizedRepos: ["acme/missing"] });
      return true;
    });
  });

  it("throws BranchNotFoundError when a branch does not exist in an authorized repo", async () => {
    mockInstallationRepoLookup([makeInstallationRepo("acme/frontend")]);
    mockVerifyBranch.mockResolvedValue(false);

    await expect(
      authorizeAdditionalRepos(
        [{ fullName: "acme/frontend", branch: "nonexistent-branch" }],
        TEST_ORG_ID_AUTH
      )
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(BranchNotFoundError);
      expect(error).toMatchObject({
        repoFullName: "acme/frontend",
        branch: "nonexistent-branch",
      });
      return true;
    });
  });
});
