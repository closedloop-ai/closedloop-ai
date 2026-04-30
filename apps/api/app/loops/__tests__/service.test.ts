import { LoopStatus } from "@repo/api/src/types/loop";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import { buildPullRequestInfo } from "../../../__tests__/fixtures/pull-request-info";

// Mock modules before importing the service
vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
  GitHubInstallationStatus: {
    PENDING_CLAIM: "PENDING_CLAIM",
    ACTIVE: "ACTIVE",
    SUSPENDED: "SUSPENDED",
    UNINSTALLED: "UNINSTALLED",
  },
}));

vi.mock("@repo/github", () => ({
  verifyInstallationBranchExists: vi.fn(),
}));

vi.mock("@/app/documents/document-pull-request-service", () => ({
  documentPullRequestService: {
    getDocumentPullRequests: vi.fn(),
  },
}));

vi.mock("@/lib/loops/uploaded-plan-artifacts", () => ({
  extractUploadedPlanRaw: vi.fn().mockReturnValue(null),
}));

// Import after mocking
import { withDb } from "@repo/database";
import { verifyInstallationBranchExists } from "@repo/github";
import { documentPullRequestService } from "@/app/documents/document-pull-request-service";
import {
  authorizeAdditionalRepos,
  BranchNotFoundError,
  loopsService,
  UnauthorizedRepoError,
} from "../service";

// Type aliases for mocked functions
const mockWithDb = withDb as unknown as Mock;
const mockVerifyBranch = verifyInstallationBranchExists as unknown as Mock;

const TEST_ORG_ID = "org-123";
const TEST_USER_ID = "user-456";
const TEST_PARENT_LOOP_ID = "loop-parent-789";
const TEST_NEW_LOOP_ID = "loop-new-001";
const TEST_COMPUTE_TARGET_ID = "ct-abc";

/** Minimal parent loop fixture with all fields needed by resume(). */
const makeParentFixture = (overrides?: Record<string, unknown>) => ({
  id: TEST_PARENT_LOOP_ID,
  organizationId: TEST_ORG_ID,
  userId: TEST_USER_ID,
  command: "PLAN",
  status: LoopStatus.Completed,
  artifactId: "artifact-111",
  workstreamId: null,
  prompt: "Original prompt",
  repo: null,
  contextRefs: null,
  s3StateKey: null,
  ...overrides,
});

/** Mock new loop returned by db.loop.create. */
const NEW_LOOP_FIXTURE = {
  id: TEST_NEW_LOOP_ID,
  status: LoopStatus.Pending,
};

/** Mock org lookup — returns null settings so fetchOrgLoopLimit uses defaults. */
const mockOrgFindUnique = vi.fn().mockResolvedValue({ settings: null });

function mockResumeDb(parentOverrides?: Record<string, unknown>) {
  const mockFindUnique = vi
    .fn()
    .mockResolvedValue(makeParentFixture(parentOverrides));
  const mockCount = vi.fn().mockResolvedValue(0);
  const mockCreate = vi.fn().mockResolvedValue(NEW_LOOP_FIXTURE);

  mockWithDb.mockImplementation((callback: (db: unknown) => unknown) => {
    const mockDb = {
      loop: {
        findUnique: mockFindUnique,
        count: mockCount,
        create: mockCreate,
      },
      organization: { findUnique: mockOrgFindUnique },
    };
    return callback(mockDb);
  });

  return { mockCreate, mockCount, mockFindUnique };
}

describe("loopsService.resume", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates the resumed loop with copied context and an explicit compute target", async () => {
    const { mockCreate } = mockResumeDb({
      artifactId: "artifact-222",
      workstreamId: "workstream-333",
      repo: { fullName: "acme/frontend", branch: "main" },
      contextRefs: [{ type: "document", id: "doc-1" }],
      s3StateKey: "s3://bucket/key",
    });

    await loopsService.resume(
      TEST_PARENT_LOOP_ID,
      TEST_ORG_ID,
      TEST_USER_ID,
      {},
      TEST_COMPUTE_TARGET_ID
    );

    const createCall = mockCreate.mock.calls[0][0];
    expect(createCall.data).toMatchObject({
      artifactId: "artifact-222",
      workstreamId: "workstream-333",
      parentLoopId: TEST_PARENT_LOOP_ID,
      repo: { fullName: "acme/frontend", branch: "main" },
      contextRefs: [{ type: "document", id: "doc-1" }],
      computeTargetId: TEST_COMPUTE_TARGET_ID,
      status: LoopStatus.Pending,
    });
    expect(createCall.data).not.toHaveProperty("s3StateKey");
  });

  it("does not inherit parent computeTargetId when none provided", async () => {
    const { mockCreate } = mockResumeDb({
      computeTargetId: "parent-target-id",
    });

    await loopsService.resume(
      TEST_PARENT_LOOP_ID,
      TEST_ORG_ID,
      TEST_USER_ID,
      {}
    );

    const createCall = mockCreate.mock.calls[0][0];
    // computeTargetId is no longer inherited from parent — the route now
    // validates and passes the resolved target explicitly
    expect(createCall.data.computeTargetId).toBeNull();
  });

  it.each([
    LoopStatus.Cancelled,
    LoopStatus.Completed,
    LoopStatus.Failed,
    LoopStatus.TimedOut,
  ])("allows %s parent loops to be resumed", async (status) => {
    const { mockCreate } = mockResumeDb({ status });

    await expect(
      loopsService.resume(TEST_PARENT_LOOP_ID, TEST_ORG_ID, TEST_USER_ID, {})
    ).resolves.not.toThrow();

    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it.each([
    LoopStatus.Pending,
    LoopStatus.Claimed,
    LoopStatus.Running,
  ])("rejects %s parent loops as non-resumable", async (status) => {
    const { mockCreate } = mockResumeDb({ status });

    await expect(
      loopsService.resume(TEST_PARENT_LOOP_ID, TEST_ORG_ID, TEST_USER_ID, {})
    ).rejects.toThrow("Cannot resume loop in");

    expect(mockCreate).not.toHaveBeenCalled();
  });
});

const TEST_ORG_ID_AUTH = "org-auth-111";

/** A minimal GitHubInstallationRepository fixture. */
const makeInstallationRepo = (
  fullName: string,
  overrides?: Record<string, unknown>
) => {
  const [owner, name] = fullName.split("/");
  return {
    id: `repo-id-${fullName}`,
    fullName,
    name,
    owner,
    private: false,
    githubRepoId: 1,
    installationId: "installation-abc",
    lastPushedAt: null,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    installation: {
      installationId: "12345",
    },
    ...overrides,
  };
};

describe("authorizeAdditionalRepos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns authorized repo records when all repos are in the installation and branches exist", async () => {
    const repo1 = makeInstallationRepo("acme/frontend");
    const repo2 = makeInstallationRepo("acme/backend");

    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) => {
      const mockDb = {
        gitHubInstallationRepository: {
          findMany: vi.fn().mockResolvedValue([repo1, repo2]),
        },
      };
      return callback(mockDb);
    });

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
    expect(mockVerifyBranch).toHaveBeenCalledTimes(2);
    expect(mockVerifyBranch).toHaveBeenCalledWith(
      "12345",
      "acme",
      "frontend",
      "main"
    );
    expect(mockVerifyBranch).toHaveBeenCalledWith(
      "12345",
      "acme",
      "backend",
      "develop"
    );
  });

  it("throws UnauthorizedRepoError when a repo is not found in the installation", async () => {
    // Only acme/frontend is found; acme/missing is not in the installation
    const repo1 = makeInstallationRepo("acme/frontend");

    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) => {
      const mockDb = {
        gitHubInstallationRepository: {
          findMany: vi.fn().mockResolvedValue([repo1]),
        },
      };
      return callback(mockDb);
    });

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
      expect(error).toMatchObject({
        unauthorizedRepos: ["acme/missing"],
      });
      return true;
    });
  });

  it("throws BranchNotFoundError when a branch does not exist in an authorized repo", async () => {
    const repo1 = makeInstallationRepo("acme/frontend");

    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) => {
      const mockDb = {
        gitHubInstallationRepository: {
          findMany: vi.fn().mockResolvedValue([repo1]),
        },
      };
      return callback(mockDb);
    });

    // The branch does not exist
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

// ---------------------------------------------------------------------------
// loopsService.findById — _enrichAdditionalReposWithPr
// ---------------------------------------------------------------------------

const mockGetDocumentPullRequests =
  documentPullRequestService.getDocumentPullRequests as unknown as Mock;

/**
 * Minimal Prisma loop row fixture returned by db.loop.findUnique in findById.
 * Includes the `user` and `computeTarget` that are added via `include`.
 */
function makeLoopDbRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "loop-enrich-1",
    organizationId: "org-enrich",
    userId: "user-enrich",
    command: "PLAN",
    status: LoopStatus.Completed,
    artifactId: "doc-enrich-1",
    workstreamId: null,
    prompt: null,
    repo: null,
    additionalRepos: null,
    contextRefs: null,
    error: null,
    metadata: {},
    uploadedArtifacts: null,
    tokensByModel: null,
    tokensInput: 0,
    tokensOutput: 0,
    estimatedCost: null,
    branchName: null,
    sessionId: null,
    computeTargetId: null,
    containerId: null,
    s3StateKey: null,
    prUrl: null,
    prNumber: null,
    parentLoopId: null,
    artifactVersion: null,
    startedAt: null,
    completedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    user: {
      id: "user-enrich",
      email: "test@example.com",
      firstName: "Test",
      lastName: "User",
      avatarUrl: null,
    },
    computeTarget: null,
    ...overrides,
  };
}

function makePrInfo(repoFullName: string) {
  return buildPullRequestInfo({
    id: `pr-${repoFullName}`,
    number: 42,
    title: "Test PR",
    htmlUrl: `https://github.com/${repoFullName}/pull/42`,
    headBranch: "feature/test",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    externalLinkId: null,
    repoFullName,
  });
}

describe("loopsService.findById — _enrichAdditionalReposWithPr", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    {
      name: "additionalRepos is null",
      row: { additionalRepos: null },
      expected: null,
    },
    {
      name: "additionalRepos is empty",
      row: { additionalRepos: [] },
      expected: [],
    },
    {
      name: "documentId is null",
      row: {
        artifactId: null,
        additionalRepos: [{ fullName: "acme/frontend", branch: "main" }],
      },
      expected: [{ fullName: "acme/frontend", branch: "main" }],
    },
  ])("returns additionalRepos unchanged without loading PRs when $name", async ({
    row,
    expected,
  }) => {
    const dbRow = makeLoopDbRow(row);
    const mockFindUnique = vi.fn().mockResolvedValue(dbRow);

    (mockWithDb as Mock).mockImplementation(
      (callback: (db: unknown) => unknown) => {
        return callback({ loop: { findUnique: mockFindUnique } });
      }
    );

    const result = await loopsService.findById("loop-enrich-1", "org-enrich");

    expect(result).not.toBeNull();
    expect(result?.additionalRepos).toEqual(expected);
    expect(mockGetDocumentPullRequests).not.toHaveBeenCalled();
  });

  it("enriches matched repo with pullRequest and sets null for unmatched repo", async () => {
    const dbRow = makeLoopDbRow({
      artifactId: "doc-enrich-1",
      additionalRepos: [
        { fullName: "acme/frontend", branch: "main" },
        { fullName: "acme/backend", branch: "main" },
      ],
    });
    const mockFindUnique = vi.fn().mockResolvedValue(dbRow);

    (mockWithDb as Mock).mockImplementation(
      (callback: (db: unknown) => unknown) => {
        return callback({ loop: { findUnique: mockFindUnique } });
      }
    );

    const matchingPr = makePrInfo("acme/frontend");
    mockGetDocumentPullRequests.mockResolvedValue([matchingPr]);

    const result = await loopsService.findById("loop-enrich-1", "org-enrich");

    expect(result).not.toBeNull();
    expect(mockGetDocumentPullRequests).toHaveBeenCalledTimes(1);
    expect(mockGetDocumentPullRequests).toHaveBeenCalledWith(
      "doc-enrich-1",
      "org-enrich"
    );

    const repos = result?.additionalRepos ?? [];
    expect(repos).toHaveLength(2);

    const frontend = repos.find((r) => r.fullName === "acme/frontend");
    const backend = repos.find((r) => r.fullName === "acme/backend");

    expect(frontend?.pullRequest).toMatchObject({
      repoFullName: "acme/frontend",
    });
    expect(backend?.pullRequest).toBeNull();
  });

  it("loads document PRs once when enriching both primary and additional repos", async () => {
    const dbRow = makeLoopDbRow({
      artifactId: "doc-enrich-1",
      repo: { fullName: "acme/primary", branch: "main" },
      additionalRepos: [
        { fullName: "acme/frontend", branch: "main" },
        { fullName: "acme/backend", branch: "main" },
      ],
    });
    const mockFindUnique = vi.fn().mockResolvedValue(dbRow);

    (mockWithDb as Mock).mockImplementation(
      (callback: (db: unknown) => unknown) => {
        return callback({ loop: { findUnique: mockFindUnique } });
      }
    );

    const primaryPr = makePrInfo("acme/primary");
    const frontendPr = makePrInfo("acme/frontend");
    mockGetDocumentPullRequests.mockResolvedValue([primaryPr, frontendPr]);

    const result = await loopsService.findById("loop-enrich-1", "org-enrich");

    expect(result).not.toBeNull();
    expect(mockGetDocumentPullRequests).toHaveBeenCalledTimes(1);
    expect(mockGetDocumentPullRequests).toHaveBeenCalledWith(
      "doc-enrich-1",
      "org-enrich"
    );
    expect(result?.primaryPullRequest).toMatchObject({
      repoFullName: "acme/primary",
    });

    const repos = result?.additionalRepos ?? [];
    expect(
      repos.find((r) => r.fullName === "acme/frontend")?.pullRequest
    ).toMatchObject({ repoFullName: "acme/frontend" });
    expect(
      repos.find((r) => r.fullName === "acme/backend")?.pullRequest
    ).toBeNull();
  });
});
