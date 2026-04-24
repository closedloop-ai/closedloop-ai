/**
 * Unit tests for loopsService.resume method and authorizeAdditionalRepos.
 *
 * Tests computeTargetId propagation, s3StateKey exclusion from resumed loops,
 * resumable-status validation, and additional repos authorization behaviors.
 */
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

// Mock modules before importing the service
vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
}));

vi.mock("@repo/github", () => ({
  verifyInstallationBranchExists: vi.fn(),
}));

// Import after mocking
import { withDb } from "@repo/database";
import { verifyInstallationBranchExists } from "@repo/github";
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
  documentId: "artifact-111",
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

describe("loopsService.resume", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes computeTargetId to db.loop.create when provided", async () => {
    const mockFindUnique = vi.fn().mockResolvedValue(makeParentFixture());
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

    await loopsService.resume(
      TEST_PARENT_LOOP_ID,
      TEST_ORG_ID,
      TEST_USER_ID,
      {},
      TEST_COMPUTE_TARGET_ID
    );

    const createCall = mockCreate.mock.calls[0][0];
    expect(createCall.data).toMatchObject({
      computeTargetId: TEST_COMPUTE_TARGET_ID,
    });
  });

  it("does not copy parent s3StateKey to the resumed loop", async () => {
    const parentWithS3 = makeParentFixture({ s3StateKey: "s3://bucket/key" });
    const mockFindUnique = vi.fn().mockResolvedValue(parentWithS3);
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

    await loopsService.resume(
      TEST_PARENT_LOOP_ID,
      TEST_ORG_ID,
      TEST_USER_ID,
      {}
    );

    const createCall = mockCreate.mock.calls[0][0];
    // s3StateKey is no longer copied from parent — the child gets its own
    // during launch (ECS generates one, desktop has none)
    expect(createCall.data.s3StateKey).toBeUndefined();
  });

  it("does not inherit parent computeTargetId when none provided", async () => {
    const parentWithTarget = makeParentFixture({
      computeTargetId: "parent-target-id",
    });
    const mockFindUnique = vi.fn().mockResolvedValue(parentWithTarget);
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

  it("accepts a loop with status Failed as resumable without throwing", async () => {
    const failedParent = makeParentFixture({ status: LoopStatus.Failed });
    const mockFindUnique = vi.fn().mockResolvedValue(failedParent);
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

    await expect(
      loopsService.resume(TEST_PARENT_LOOP_ID, TEST_ORG_ID, TEST_USER_ID, {})
    ).resolves.not.toThrow();

    expect(mockCreate).toHaveBeenCalledTimes(1);
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
