/**
 * Unit tests for loopsService methods: resume, create (MANUAL), and authorizeAdditionalRepos.
 *
 * Tests computeTargetId propagation, s3StateKey exclusion from resumed loops,
 * resumable-status validation, additional repos authorization behaviors,
 * MANUAL loop initial status/startedAt, and nested-loop prevention guard.
 */
import { LoopCommand, LoopStatus } from "@repo/api/src/types/loop";
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

// Import after mocking
import { withDb } from "@repo/database";
import { verifyInstallationBranchExists } from "@repo/github";
import {
  authorizeAdditionalRepos,
  BranchNotFoundError,
  loopsService,
  NestedManualLoopError,
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

describe("loopsService.create (MANUAL)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a MANUAL loop in RUNNING status with startedAt set", async () => {
    const mockCreate = vi
      .fn()
      .mockImplementation((args: { data: Record<string, unknown> }) => ({
        id: TEST_NEW_LOOP_ID,
        status: args.data.status,
        startedAt: args.data.startedAt,
      }));
    const mockCount = vi.fn().mockResolvedValue(0);

    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) => {
      const mockDb = {
        loop: {
          count: mockCount,
          create: mockCreate,
        },
        organization: { findUnique: mockOrgFindUnique },
      };
      return callback(mockDb);
    });

    const result = await loopsService.create(TEST_ORG_ID, TEST_USER_ID, {
      command: LoopCommand.Manual,
      documentId: "artifact-111",
    });

    expect(result.status).toBe(LoopStatus.Running);

    const createCall = mockCreate.mock.calls[0][0];
    expect(createCall.data.status).toBe(LoopStatus.Running);
    expect(createCall.data.startedAt).toBeInstanceOf(Date);
  });

  it("creates a non-MANUAL loop in PENDING status without startedAt", async () => {
    const mockCreate = vi
      .fn()
      .mockImplementation((args: { data: Record<string, unknown> }) => ({
        id: TEST_NEW_LOOP_ID,
        status: args.data.status,
      }));
    const mockCount = vi.fn().mockResolvedValue(0);

    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) => {
      const mockDb = {
        loop: {
          count: mockCount,
          create: mockCreate,
        },
        organization: { findUnique: mockOrgFindUnique },
      };
      return callback(mockDb);
    });

    const result = await loopsService.create(TEST_ORG_ID, TEST_USER_ID, {
      command: LoopCommand.Plan,
      documentId: "artifact-111",
    });

    expect(result.status).toBe(LoopStatus.Pending);

    const createCall = mockCreate.mock.calls[0][0];
    expect(createCall.data.status).toBe(LoopStatus.Pending);
    expect(createCall.data.startedAt).toBeUndefined();
  });

  it("throws NestedManualLoopError when a RUNNING non-MANUAL loop exists for the same document", async () => {
    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) => {
      const mockDb = {
        loop: {
          // Active count (concurrency check) returns 0
          count: vi
            .fn()
            .mockImplementation((args: { where: Record<string, unknown> }) => {
              // Nested-loop guard queries with `command: { not: "MANUAL" }`
              if (
                args.where.command &&
                typeof args.where.command === "object" &&
                "not" in args.where.command
              ) {
                return Promise.resolve(1); // A running non-MANUAL loop exists
              }
              return Promise.resolve(0); // Concurrency check passes
            }),
          create: vi.fn(),
        },
        organization: { findUnique: mockOrgFindUnique },
      };
      return callback(mockDb);
    });

    await expect(
      loopsService.create(TEST_ORG_ID, TEST_USER_ID, {
        command: LoopCommand.Manual,
        documentId: "artifact-111",
      })
    ).rejects.toBeInstanceOf(NestedManualLoopError);
  });

  it("allows MANUAL loop creation when no RUNNING non-MANUAL loops exist", async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      id: TEST_NEW_LOOP_ID,
      status: LoopStatus.Running,
    });

    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) => {
      const mockDb = {
        loop: {
          count: vi.fn().mockResolvedValue(0), // Both concurrency + nested-loop
          create: mockCreate,
        },
        organization: { findUnique: mockOrgFindUnique },
      };
      return callback(mockDb);
    });

    await expect(
      loopsService.create(TEST_ORG_ID, TEST_USER_ID, {
        command: LoopCommand.Manual,
        documentId: "artifact-111",
      })
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

const TEST_LOOP_ID = "loop-id-xyz";
const TEST_ORG_ID_OWN = "org-own-999";
const TEST_OTHER_ORG_ID = "org-other-888";

/**
 * Minimal Prisma loop record fixture satisfying the fields toLoop() reads.
 */
const makeLoopRecord = (overrides?: Record<string, unknown>) => ({
  id: TEST_LOOP_ID,
  organizationId: TEST_ORG_ID_OWN,
  userId: TEST_USER_ID,
  command: "MANUAL",
  status: "RUNNING",
  artifactId: "artifact-xyz",
  artifactVersion: null,
  workstreamId: null,
  parentLoopId: null,
  computeTargetId: null,
  containerId: null,
  sessionId: null,
  prompt: null,
  repo: null,
  additionalRepos: null,
  contextRefs: null,
  s3StateKey: null,
  estimatedCost: null,
  tokensInput: 0,
  tokensOutput: 0,
  tokensByModel: null,
  branchName: null,
  prUrl: null,
  prNumber: null,
  error: null,
  metadata: null,
  uploadedArtifacts: null,
  startedAt: new Date(),
  completedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe("loopsService.findById (org-scoped)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when the loop exists but belongs to a different org (cross-org access denied)", async () => {
    // findUnique with { id, organizationId: OTHER_ORG } returns null
    const mockFindUnique = vi.fn().mockResolvedValue(null);

    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) => {
      const mockDb = {
        loop: { findUnique: mockFindUnique },
      };
      return callback(mockDb);
    });

    const result = await loopsService.findById(TEST_LOOP_ID, TEST_OTHER_ORG_ID);

    expect(result).toBeNull();
    expect(mockFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: TEST_LOOP_ID, organizationId: TEST_OTHER_ORG_ID },
      })
    );
  });
});

describe("loopsService.updateManualLoopFields", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when the loop belongs to a different org (cross-org access denied)", async () => {
    // findUnique with wrong org returns null
    const mockFindUnique = vi.fn().mockResolvedValue(null);

    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) => {
      const mockDb = {
        loop: {
          findUnique: mockFindUnique,
          updateMany: vi.fn(),
        },
      };
      return callback(mockDb);
    });

    const result = await loopsService.updateManualLoopFields(
      TEST_LOOP_ID,
      TEST_OTHER_ORG_ID,
      { prUrl: "https://github.com/acme/repo/pull/1" }
    );

    expect(result).toBeNull();
  });

  it("merges summary into existing metadata without overwriting other keys", async () => {
    const existingMetadata = { existingKey: "existingValue", otherKey: 42 };
    const currentRecord = makeLoopRecord({ metadata: existingMetadata });
    const updatedRecord = makeLoopRecord({
      metadata: { existingKey: "existingValue", otherKey: 42, summary: "done" },
    });

    const mockFindUnique = vi
      .fn()
      .mockResolvedValueOnce(currentRecord) // initial fetch
      .mockResolvedValueOnce(updatedRecord); // re-fetch after update
    const mockUpdateMany = vi.fn().mockResolvedValue({ count: 1 });

    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) => {
      const mockDb = {
        loop: {
          findUnique: mockFindUnique,
          updateMany: mockUpdateMany,
        },
      };
      return callback(mockDb);
    });

    const result = await loopsService.updateManualLoopFields(
      TEST_LOOP_ID,
      TEST_ORG_ID_OWN,
      { summary: "done" }
    );

    const updateCall = mockUpdateMany.mock.calls[0][0];
    expect(updateCall.data.metadata).toEqual({
      existingKey: "existingValue",
      otherKey: 42,
      summary: "done",
    });
    expect(result).not.toBeNull();
  });

  it("updates prUrl and branchName directly on the record without touching metadata", async () => {
    const currentRecord = makeLoopRecord({ metadata: { summary: "old" } });
    const updatedRecord = makeLoopRecord({
      prUrl: "https://github.com/acme/repo/pull/99",
      branchName: "feat/my-branch",
      metadata: { summary: "old" },
    });

    const mockFindUnique = vi
      .fn()
      .mockResolvedValueOnce(currentRecord)
      .mockResolvedValueOnce(updatedRecord);
    const mockUpdateMany = vi.fn().mockResolvedValue({ count: 1 });

    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) => {
      const mockDb = {
        loop: {
          findUnique: mockFindUnique,
          updateMany: mockUpdateMany,
        },
      };
      return callback(mockDb);
    });

    const result = await loopsService.updateManualLoopFields(
      TEST_LOOP_ID,
      TEST_ORG_ID_OWN,
      {
        prUrl: "https://github.com/acme/repo/pull/99",
        branchName: "feat/my-branch",
      }
    );

    const updateCall = mockUpdateMany.mock.calls[0][0];
    expect(updateCall.data.prUrl).toBe("https://github.com/acme/repo/pull/99");
    expect(updateCall.data.branchName).toBe("feat/my-branch");
    // metadata should not be modified when summary is not provided
    expect(updateCall.data.metadata).toBeUndefined();
    expect(result).not.toBeNull();
  });
});
