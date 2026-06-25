import { HarnessType } from "@repo/api/src/types/compute-target";
import {
  LoopCommand,
  LoopEventType,
  LoopStatus,
} from "@repo/api/src/types/loop";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import { buildPrismaLoop } from "../../../__tests__/fixtures/loop";
import { dbUtilsModuleMock } from "../../../__tests__/fixtures/loops-service-mocks";
import { buildPullRequestInfo } from "../../../__tests__/fixtures/pull-request-info";

// Mock modules before importing the service
const { mockWithDbTx } = vi.hoisted(() => ({
  mockWithDbTx: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: mockWithDbTx }),
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
    getDocumentBranches: vi.fn(),
    getDocumentPullRequests: vi.fn(),
  },
}));

vi.mock("@/lib/loops/uploaded-plan-artifacts", () => ({
  extractUploadedPlanRaw: vi.fn().mockReturnValue(null),
}));

vi.mock("@/lib/db-utils", () => dbUtilsModuleMock());

vi.mock("@/lib/loops/loop-state", () => ({
  generateDownloadUrl: vi.fn((key: string) =>
    Promise.resolve(`https://download.example/${encodeURIComponent(key)}`)
  ),
  validateKeyBelongsToLoop: vi.fn(
    (key: string, organizationId: string, loopId: string) =>
      !(key.includes("..") || key.includes("./")) &&
      key.startsWith(`${organizationId}/loops/${loopId}/`)
  ),
}));

// Blocker resolution defaults to "no blockers" so existing create tests behave
// exactly as before; the gating tests override this per-case.
vi.mock("@/lib/loops/loop-blockers", () => ({
  findNonTerminalBlockers: vi.fn().mockResolvedValue([]),
}));

// Import after mocking
import { withDb } from "@repo/database";
import { verifyInstallationBranchExists } from "@repo/github";
import { documentPullRequestService } from "@/app/documents/document-pull-request-service";
import { findNonTerminalBlockers } from "@/lib/loops/loop-blockers";
import { generateDownloadUrl } from "@/lib/loops/loop-state";
import {
  BranchNotFoundError,
  isInvalidStatusTransitionError,
  isLoopAlreadyActiveError,
  type LoopAlreadyActiveError,
  NestedManualLoopError,
  RepoNotInProjectPoolError,
  UnauthorizedRepoError,
} from "../loop-errors";
import { authorizeAdditionalRepos, loopsService } from "../service";

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
  command: LoopCommand.Plan,
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

/**
 * Wires `withDb.tx` for `reapStalePendingLoops`: it runs `loop.updateMany`,
 * runner-token cleanup, and `loopEvent.create` in one transaction. Tests only
 * care about `updateMany`; the other writes are fire-and-forget no-ops.
 */
function mockWithDbTxForReaper(updateMany: Mock) {
  mockWithDbTx.mockImplementation((callback: (db: unknown) => unknown) =>
    callback({
      loop: { update: vi.fn().mockResolvedValue({}), updateMany },
      loopTokenRefresh: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      loopEvent: {
        create: vi.fn().mockResolvedValue({}),
      },
    })
  );
}

function createMockResumeDb(
  parentOverrides?: Record<string, unknown>,
  extraModels?: Record<string, unknown>
) {
  const mockFindUnique = vi
    .fn()
    .mockResolvedValue(makeParentFixture(parentOverrides));
  const mockFindFirst = vi.fn().mockResolvedValue(null);
  const mockFindMany = vi.fn().mockResolvedValue([]);
  const mockCount = vi.fn().mockResolvedValue(0);
  const mockCreate = vi.fn().mockResolvedValue(NEW_LOOP_FIXTURE);
  const mockUpdateMany = vi.fn().mockResolvedValue({ count: 0 });

  mockWithDb.mockImplementation((callback: (db: unknown) => unknown) => {
    const mockDb = {
      loop: {
        findUnique: mockFindUnique,
        findFirst: mockFindFirst,
        findMany: mockFindMany,
        count: mockCount,
        create: mockCreate,
        updateMany: mockUpdateMany,
      },
      organization: { findUnique: mockOrgFindUnique },
      ...extraModels,
    };
    return callback(mockDb);
  });

  mockWithDbTxForReaper(mockUpdateMany);

  return {
    mockCreate,
    mockCount,
    mockFindUnique,
    mockFindFirst,
    mockFindMany,
    mockUpdateMany,
  };
}

function mockResumeDb(parentOverrides?: Record<string, unknown>) {
  return createMockResumeDb(parentOverrides);
}

/**
 * Like mockResumeDb but also wires gitHubInstallationRepository.findMany
 * so authorizeAdditionalRepos calls resolve correctly.
 */
function mockResumeDbWithInstallationRepos(
  parentOverrides?: Record<string, unknown>,
  installationRepos?: unknown[]
) {
  const mockFindManyInstallationRepos = vi
    .fn()
    .mockResolvedValue(installationRepos ?? []);

  const base = createMockResumeDb(parentOverrides, {
    gitHubInstallationRepository: {
      findMany: mockFindManyInstallationRepos,
    },
  });

  return {
    ...base,
    mockFindManyInstallationRepos,
  };
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
      parentLoopId: TEST_PARENT_LOOP_ID,
      repo: { fullName: "acme/frontend", branch: "main" },
      contextRefs: [{ type: "document", id: "doc-1" }],
      computeTargetId: TEST_COMPUTE_TARGET_ID,
      status: LoopStatus.Pending,
    });
    expect(createCall.data).not.toHaveProperty("s3StateKey");
  });

  it("preserves the parent harness when resuming a loop", async () => {
    const { mockCreate } = mockResumeDb({
      harness: HarnessType.Codex,
    });

    await loopsService.resume(
      TEST_PARENT_LOOP_ID,
      TEST_ORG_ID,
      TEST_USER_ID,
      {}
    );

    const createCall = mockCreate.mock.calls[0][0];
    expect(createCall.data.harness).toBe(HarnessType.Codex);
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

  it("inherits additionalRepos from parent and authorizes them on resume", async () => {
    const additionalRepos = [{ fullName: "acme/frontend", branch: "main" }];
    const installationRepo = makeInstallationRepo("acme/frontend");

    const { mockCreate, mockFindManyInstallationRepos } =
      mockResumeDbWithInstallationRepos({ additionalRepos }, [
        installationRepo,
      ]);

    mockVerifyBranch.mockResolvedValue(true);

    await loopsService.resume(
      TEST_PARENT_LOOP_ID,
      TEST_ORG_ID,
      TEST_USER_ID,
      {}
    );

    const createCall = mockCreate.mock.calls[0][0];
    expect(createCall.data).toMatchObject({
      additionalRepos,
      status: LoopStatus.Pending,
    });

    expect(mockFindManyInstallationRepos).toHaveBeenCalledTimes(1);
    expect(mockFindManyInstallationRepos).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          fullName: { in: ["acme/frontend"] },
        }),
      })
    );
  });

  it("authorizes all repos and includes both in create payload when parent has multiple additionalRepos", async () => {
    const additionalRepos = [
      { fullName: "acme/a", branch: "main" },
      { fullName: "acme/b", branch: "dev" },
    ];
    const installationRepoA = makeInstallationRepo("acme/a");
    const installationRepoB = makeInstallationRepo("acme/b");

    const { mockCreate, mockFindManyInstallationRepos } =
      mockResumeDbWithInstallationRepos({ additionalRepos }, [
        installationRepoA,
        installationRepoB,
      ]);

    mockVerifyBranch.mockResolvedValue(true);

    await loopsService.resume(
      TEST_PARENT_LOOP_ID,
      TEST_ORG_ID,
      TEST_USER_ID,
      {}
    );

    const createCall = mockCreate.mock.calls[0][0];
    expect(createCall.data).toMatchObject({
      additionalRepos,
      status: LoopStatus.Pending,
    });

    expect(mockFindManyInstallationRepos).toHaveBeenCalledTimes(1);
    expect(mockFindManyInstallationRepos).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          fullName: { in: expect.arrayContaining(["acme/a", "acme/b"]) },
        }),
      })
    );

    expect(mockVerifyBranch).toHaveBeenCalledTimes(2);
    expect(mockVerifyBranch).toHaveBeenCalledWith("12345", "acme", "a", "main");
    expect(mockVerifyBranch).toHaveBeenCalledWith("12345", "acme", "b", "dev");
  });

  it("omits additionalRepos from create payload and skips authorization when parent.additionalRepos is null", async () => {
    const { mockCreate, mockFindManyInstallationRepos } =
      mockResumeDbWithInstallationRepos({ additionalRepos: null });

    await loopsService.resume(
      TEST_PARENT_LOOP_ID,
      TEST_ORG_ID,
      TEST_USER_ID,
      {}
    );

    expect(mockFindManyInstallationRepos).not.toHaveBeenCalled();

    // Prisma treats undefined and a missing key identically (both skip the
    // column write), but null would write NULL to the Json? column.
    const createCall = mockCreate.mock.calls[0][0];
    expect(createCall.data.additionalRepos).toBeUndefined();
  });

  it("throws before authorization or loop creation when parent.additionalRepos is malformed", async () => {
    const { mockCreate, mockFindManyInstallationRepos } =
      mockResumeDbWithInstallationRepos({
        additionalRepos: [{ fullName: "acme/x" }],
      });

    await expect(
      loopsService.resume(TEST_PARENT_LOOP_ID, TEST_ORG_ID, TEST_USER_ID, {})
    ).rejects.toThrow();

    expect(mockFindManyInstallationRepos).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("throws before authorization or loop creation when parent.additionalRepos is a non-array value", async () => {
    const { mockCreate, mockFindManyInstallationRepos } =
      mockResumeDbWithInstallationRepos({
        additionalRepos: "not-an-array",
      });

    await expect(
      loopsService.resume(TEST_PARENT_LOOP_ID, TEST_ORG_ID, TEST_USER_ID, {})
    ).rejects.toThrow(
      `Loop ${TEST_PARENT_LOOP_ID} has malformed additionalRepos data and cannot be resumed. Operator action required.`
    );

    expect(mockFindManyInstallationRepos).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe("loopsService.resume — sibling concurrency gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const parentOverrides = {
    artifactId: "artifact-1",
    command: LoopCommand.Plan,
  };

  it("throws LoopAlreadyActiveError when an active sibling exists for the same (artifactId, command)", async () => {
    const { mockFindFirst, mockCreate } = mockResumeDb(parentOverrides);
    mockFindFirst.mockResolvedValue(
      buildPrismaLoop({
        id: "loop-sibling",
        status: LoopStatus.Running,
        command: LoopCommand.Plan,
      })
    );

    const err = (await loopsService
      .resume(TEST_PARENT_LOOP_ID, TEST_ORG_ID, TEST_USER_ID, {})
      .catch((e) => e)) as LoopAlreadyActiveError;

    expect(isLoopAlreadyActiveError(err)).toBe(true);
    expect(err.existingLoopId).toBe("loop-sibling");
    expect(err.existingCommand).toBe(LoopCommand.Plan);
    expect(err.existingStatus).toBe(LoopStatus.Running);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe("loopsService.create (MANUAL)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockCreateDb({
    count = vi.fn().mockResolvedValue(0),
    create = vi.fn().mockResolvedValue({
      id: TEST_NEW_LOOP_ID,
      status: LoopStatus.Pending,
    }),
    findFirst = vi.fn().mockResolvedValue(null),
    findMany = vi.fn().mockResolvedValue([]),
    updateMany = vi.fn().mockResolvedValue({ count: 0 }),
  }: {
    count?: Mock;
    create?: Mock;
    findFirst?: Mock;
    findMany?: Mock;
    updateMany?: Mock;
  } = {}) {
    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) => {
      const mockDb = {
        loop: {
          count,
          create,
          findFirst,
          findMany,
          updateMany,
        },
        organization: { findUnique: mockOrgFindUnique },
      };
      return callback(mockDb);
    });

    mockWithDbTxForReaper(updateMany);

    return { count, create, findFirst, findMany, updateMany };
  }

  it("creates a MANUAL loop in RUNNING status with startedAt set", async () => {
    const mockCreate = vi
      .fn()
      .mockImplementation((args: { data: Record<string, unknown> }) => ({
        id: TEST_NEW_LOOP_ID,
        status: args.data.status,
        startedAt: args.data.startedAt,
      }));
    mockCreateDb({ create: mockCreate });

    const result = await loopsService.create(TEST_ORG_ID, TEST_USER_ID, {
      command: LoopCommand.Manual,
      documentId: "artifact-111",
    });

    expect(result.status).toBe(LoopStatus.Running);

    const createCall = mockCreate.mock.calls[0][0];
    expect(createCall.data.command).toBe(LoopCommand.Manual);
    expect(createCall.data.status).toBe(LoopStatus.Running);
    expect(createCall.data.startedAt).toBeInstanceOf(Date);
  });

  it("throws NestedManualLoopError when a RUNNING non-MANUAL loop exists for the same document", async () => {
    const mockCreate = vi.fn();
    mockCreateDb({
      count: vi
        .fn()
        .mockImplementation((args: { where: Record<string, unknown> }) => {
          if (
            args.where.command &&
            typeof args.where.command === "object" &&
            "not" in args.where.command
          ) {
            return Promise.resolve(1);
          }
          return Promise.resolve(0);
        }),
      create: mockCreate,
    });

    await expect(
      loopsService.create(TEST_ORG_ID, TEST_USER_ID, {
        command: LoopCommand.Manual,
        documentId: "artifact-111",
      })
    ).rejects.toBeInstanceOf(NestedManualLoopError);

    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("allows MANUAL loop creation when no RUNNING non-MANUAL loops exist", async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      id: TEST_NEW_LOOP_ID,
      status: LoopStatus.Running,
    });

    mockCreateDb({ create: mockCreate });

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
function makeInstallationRepo(
  fullName: string,
  overrides?: Record<string, unknown>
) {
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
}

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
  command: LoopCommand.Manual,
  status: LoopStatus.Running,
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
        loopEvent: { findMany: vi.fn().mockResolvedValue([]) },
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

// ---------------------------------------------------------------------------
// loopsService.findById — _enrichAdditionalReposWithPr
// ---------------------------------------------------------------------------

const mockGetDocumentPullRequests =
  documentPullRequestService.getDocumentPullRequests as unknown as Mock;
const mockGetDocumentBranches =
  documentPullRequestService.getDocumentBranches as unknown as Mock;

/**
 * Minimal Prisma loop row fixture returned by db.loop.findUnique in findById.
 * Includes the `user` and `computeTarget` that are added via `include`.
 */
function makeLoopDbRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "loop-enrich-1",
    organizationId: "org-enrich",
    userId: "user-enrich",
    command: LoopCommand.Plan,
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
    sessionArtifactId: null,
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
    mockGetDocumentBranches.mockResolvedValue([]);
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
        return callback({
          loop: { findUnique: mockFindUnique },
          loopEvent: { findMany: vi.fn().mockResolvedValue([]) },
        });
      }
    );

    const result = await loopsService.findById("loop-enrich-1", "org-enrich");

    expect(result).not.toBeNull();
    expect(result?.additionalRepos).toEqual(expected);
    expect(mockGetDocumentBranches).not.toHaveBeenCalled();
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
        return callback({
          loop: { findUnique: mockFindUnique },
          loopEvent: { findMany: vi.fn().mockResolvedValue([]) },
        });
      }
    );

    const matchingPr = makePrInfo("acme/frontend");
    mockGetDocumentBranches.mockResolvedValue([]);
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
        return callback({
          loop: { findUnique: mockFindUnique },
          loopEvent: { findMany: vi.fn().mockResolvedValue([]) },
        });
      }
    );

    const primaryPr = makePrInfo("acme/primary");
    const frontendPr = makePrInfo("acme/frontend");
    const primaryBranch = {
      id: "branch-primary",
      name: "feature/primary",
      htmlUrl: "https://github.com/acme/primary/tree/feature%2Fprimary",
      branchName: "feature/primary",
      baseBranch: "main",
      headSha: "abc123",
      checksStatus: "PASSING",
      externalLinkId: "branch-primary",
      repoFullName: "acme/primary",
      currentPullRequest: primaryPr,
    };
    const frontendBranch = {
      ...primaryBranch,
      id: "branch-frontend",
      name: "feature/frontend",
      htmlUrl: "https://github.com/acme/frontend/tree/feature%2Ffrontend",
      branchName: "feature/frontend",
      externalLinkId: "branch-frontend",
      repoFullName: "acme/frontend",
      currentPullRequest: frontendPr,
    };
    mockGetDocumentBranches.mockResolvedValue([primaryBranch, frontendBranch]);
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
    expect(result?.primaryBranch).toMatchObject({
      branchName: "feature/primary",
      repoFullName: "acme/primary",
    });

    const repos = result?.additionalRepos ?? [];
    expect(
      repos.find((r) => r.fullName === "acme/frontend")?.branchArtifact
    ).toMatchObject({ branchName: "feature/frontend" });
    expect(
      repos.find((r) => r.fullName === "acme/frontend")?.pullRequest
    ).toMatchObject({ repoFullName: "acme/frontend" });
    expect(
      repos.find((r) => r.fullName === "acme/backend")?.pullRequest
    ).toBeNull();
  });

  it("returns support artifacts from the latest valid support bundle event", async () => {
    const dbRow = makeLoopDbRow({ id: "loop-support-1" });
    const mockFindUnique = vi.fn().mockResolvedValue(dbRow);
    const mockFindMany = vi.fn().mockResolvedValue([
      {
        id: "event-support-1",
        data: {
          keys: [
            "org-enrich/loops/loop-support-1/run-1/support/claude-output.jsonl",
            "org-enrich/loops/loop-support-1/run-1/support/perf.jsonl",
          ],
          files: [
            {
              name: "claude-output.jsonl",
              key: "org-enrich/loops/loop-support-1/run-1/support/claude-output.jsonl",
              sizeBytes: 10,
            },
            {
              name: "perf.jsonl",
              key: "org-enrich/loops/loop-support-1/run-1/support/perf.jsonl",
              sizeBytes: 20,
            },
          ],
        },
      },
    ]);

    (mockWithDb as Mock).mockImplementation(
      (callback: (db: unknown) => unknown) =>
        callback({
          loop: { findUnique: mockFindUnique },
          loopEvent: { findMany: mockFindMany },
        })
    );

    const result = await loopsService.findById("loop-support-1", "org-enrich", {
      includeSupportArtifacts: true,
    });

    expect(result?.supportArtifacts).toEqual([
      {
        name: "claude-output.jsonl",
        key: "org-enrich/loops/loop-support-1/run-1/support/claude-output.jsonl",
        downloadUrl:
          "https://download.example/org-enrich%2Floops%2Floop-support-1%2Frun-1%2Fsupport%2Fclaude-output.jsonl",
        sizeBytes: 10,
      },
      {
        name: "perf.jsonl",
        key: "org-enrich/loops/loop-support-1/run-1/support/perf.jsonl",
        downloadUrl:
          "https://download.example/org-enrich%2Floops%2Floop-support-1%2Frun-1%2Fsupport%2Fperf.jsonl",
        sizeBytes: 20,
      },
    ]);
    expect(mockFindMany).toHaveBeenCalledWith({
      where: {
        loopId: "loop-support-1",
        type: LoopEventType.SupportBundleUploaded,
      },
      orderBy: { createdAt: "desc" },
      take: 1,
    });
  });

  it("omits invalid support artifact keys", async () => {
    const dbRow = makeLoopDbRow({ id: "loop-support-2" });
    const mockFindUnique = vi.fn().mockResolvedValue(dbRow);
    const validKey =
      "org-enrich/loops/loop-support-2/run-1/support/claude-output.jsonl";
    const mockFindMany = vi.fn().mockResolvedValue([
      {
        id: "event-support-2",
        data: {
          keys: [
            validKey,
            "org-enrich/loops/other-loop/run-1/support/perf.jsonl",
          ],
        },
      },
    ]);

    (mockWithDb as Mock).mockImplementation(
      (callback: (db: unknown) => unknown) =>
        callback({
          loop: { findUnique: mockFindUnique },
          loopEvent: { findMany: mockFindMany },
        })
    );

    const result = await loopsService.findById("loop-support-2", "org-enrich", {
      includeSupportArtifacts: true,
    });

    expect(result?.supportArtifacts).toEqual([
      {
        name: "claude-output.jsonl",
        key: validKey,
        downloadUrl:
          "https://download.example/org-enrich%2Floops%2Floop-support-2%2Frun-1%2Fsupport%2Fclaude-output.jsonl",
      },
    ]);
  });

  it("omits support artifact keys whose download URL generation fails", async () => {
    const dbRow = makeLoopDbRow({ id: "loop-support-3" });
    const mockFindUnique = vi.fn().mockResolvedValue(dbRow);
    const validKey =
      "org-enrich/loops/loop-support-3/run-1/support/claude-output.jsonl";
    const failingKey =
      "org-enrich/loops/loop-support-3/run-1/support/perf.jsonl";
    const mockFindMany = vi.fn().mockResolvedValue([
      {
        id: "event-support-3",
        data: { keys: [validKey, failingKey] },
      },
    ]);
    vi.mocked(generateDownloadUrl).mockImplementation((key: string) => {
      if (key === failingKey) {
        return Promise.reject(new Error("presign failed"));
      }
      return Promise.resolve(
        `https://download.example/${encodeURIComponent(key)}`
      );
    });

    (mockWithDb as Mock).mockImplementation(
      (callback: (db: unknown) => unknown) =>
        callback({
          loop: { findUnique: mockFindUnique },
          loopEvent: { findMany: mockFindMany },
        })
    );

    const result = await loopsService.findById("loop-support-3", "org-enrich", {
      includeSupportArtifacts: true,
    });

    expect(result?.supportArtifacts).toEqual([
      {
        name: "claude-output.jsonl",
        key: validKey,
        downloadUrl:
          "https://download.example/org-enrich%2Floops%2Floop-support-3%2Frun-1%2Fsupport%2Fclaude-output.jsonl",
      },
    ]);
  });
});

// PLN-529 T-4.1: defense-in-depth check that loops on a project-scoped
// document only target repos curated on the project's team pool. Bypasses
// `authorizeAdditionalRepos` (returns the same in-pool repos) and exercises
// the second-pass check exclusively.
describe("loopsService.create — project-pool membership (PLN-529)", () => {
  const POOL_ORG = "org-pool-1";
  const POOL_USER = "user-pool-1";
  const POOL_DOC = "doc-pool-1";
  const POOL_PROJECT = "project-pool-1";

  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyBranch.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  type MakeDbArgs = {
    teamRepos: Array<{ fullName: string }>;
    artifactProjectId?: string | null;
    installationRepoFullNames: string[];
  };

  function makeDb({
    teamRepos,
    artifactProjectId = POOL_PROJECT,
    installationRepoFullNames,
  }: MakeDbArgs) {
    const mockArtifactFindFirst = vi
      .fn()
      .mockResolvedValue(
        artifactProjectId ? { projectId: artifactProjectId } : null
      );
    const mockTeamRepoFindMany = vi
      .fn()
      .mockResolvedValue(
        teamRepos.map((r) => ({ repository: { fullName: r.fullName } }))
      );
    const mockInstallationRepoFindMany = vi
      .fn()
      .mockResolvedValue(
        installationRepoFullNames.map((n) => makeInstallationRepo(n))
      );
    const mockLoopCount = vi.fn().mockResolvedValue(0);
    const mockLoopFindFirst = vi.fn().mockResolvedValue(null);
    const mockLoopFindMany = vi.fn().mockResolvedValue([]);
    const mockLoopUpdateMany = vi.fn().mockResolvedValue({ count: 0 });
    const mockLoopCreate = vi
      .fn()
      .mockResolvedValue({ id: "loop-pool-1", status: LoopStatus.Pending });

    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({
        loop: {
          count: mockLoopCount,
          create: mockLoopCreate,
          findFirst: mockLoopFindFirst,
          findMany: mockLoopFindMany,
          updateMany: mockLoopUpdateMany,
        },
        organization: { findUnique: mockOrgFindUnique },
        artifact: { findFirst: mockArtifactFindFirst },
        teamRepository: { findMany: mockTeamRepoFindMany },
        gitHubInstallationRepository: {
          findMany: mockInstallationRepoFindMany,
        },
      })
    );

    mockWithDbTxForReaper(mockLoopUpdateMany);

    return {
      mockArtifactFindFirst,
      mockTeamRepoFindMany,
      mockInstallationRepoFindMany,
      mockLoopCreate,
    };
  }

  it("creates the loop when every repo is in the project's team pool", async () => {
    const { mockLoopCreate } = makeDb({
      teamRepos: [{ fullName: "acme/frontend" }, { fullName: "acme/backend" }],
      installationRepoFullNames: ["acme/frontend", "acme/backend"],
    });

    await loopsService.create(POOL_ORG, POOL_USER, {
      command: LoopCommand.Plan,
      documentId: POOL_DOC,
      repo: { fullName: "acme/frontend", branch: "main" },
      additionalRepos: [{ fullName: "acme/backend", branch: "develop" }],
    });

    expect(mockLoopCreate).toHaveBeenCalledTimes(1);
  });

  it("rejects with RepoNotInProjectPoolError when a repo is outside the project's team pool", async () => {
    const { mockLoopCreate } = makeDb({
      teamRepos: [{ fullName: "acme/frontend" }],
      installationRepoFullNames: ["acme/frontend", "acme/payments"],
    });

    await expect(
      loopsService.create(POOL_ORG, POOL_USER, {
        command: LoopCommand.Plan,
        documentId: POOL_DOC,
        repo: { fullName: "acme/frontend", branch: "main" },
        additionalRepos: [{ fullName: "acme/payments", branch: "main" }],
      })
    ).rejects.toBeInstanceOf(RepoNotInProjectPoolError);

    expect(mockLoopCreate).not.toHaveBeenCalled();
  });

  it("falls through (no membership check) when the project has zero team-curated repos", async () => {
    const { mockLoopCreate } = makeDb({
      teamRepos: [],
      installationRepoFullNames: ["acme/frontend"],
    });

    await loopsService.create(POOL_ORG, POOL_USER, {
      command: LoopCommand.Plan,
      documentId: POOL_DOC,
      repo: { fullName: "acme/frontend", branch: "main" },
    });

    expect(mockLoopCreate).toHaveBeenCalledTimes(1);
  });

  it("skips the membership check when there is no documentId on the request", async () => {
    const { mockLoopCreate, mockArtifactFindFirst } = makeDb({
      teamRepos: [],
      installationRepoFullNames: ["acme/frontend"],
    });

    await loopsService.create(POOL_ORG, POOL_USER, {
      command: LoopCommand.Plan,
      repo: { fullName: "acme/frontend", branch: "main" },
    });

    expect(mockLoopCreate).toHaveBeenCalledTimes(1);
    expect(mockArtifactFindFirst).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC-005: toLoop() leakage guard — runner-internal fields must not appear in
// the engineer-facing GET /api/loops/:id response body.
// ---------------------------------------------------------------------------
describe("toLoop() — AC-005 leakage guard (runner-internal fields omitted)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDocumentBranches.mockResolvedValue([]);
    mockGetDocumentPullRequests.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not include tokenExpiresAt, lastRunnerHeartbeatAt, or runnerCapabilities in the findById result", async () => {
    // Build a Prisma row with all three sensitive fields populated to non-null
    // values to ensure they are actively stripped — not merely absent by default.
    const dbRowWithSensitiveFields = {
      ...makeLoopDbRow(),
      tokenExpiresAt: new Date("2026-06-01T00:00:00.000Z"),
      lastRunnerHeartbeatAt: new Date("2026-06-01T00:00:00.000Z"),
      runnerCapabilities: {
        loopRunnerRefreshSupported: true,
        loopRunnerHeartbeatSupported: true,
      },
    };

    (mockWithDb as Mock).mockImplementation(
      (callback: (db: unknown) => unknown) =>
        callback({
          loop: {
            findUnique: vi.fn().mockResolvedValue(dbRowWithSensitiveFields),
          },
          loopEvent: { findMany: vi.fn().mockResolvedValue([]) },
        })
    );

    const result = await loopsService.findById("loop-enrich-1", "org-enrich");

    expect(result).not.toBeNull();
    // These three fields must NOT appear — they are runner-internal and belong
    // only in the admin-only GET /api/loops/:id/runtime response (AC-005).
    expect(result).not.toHaveProperty("tokenExpiresAt");
    expect(result).not.toHaveProperty("lastRunnerHeartbeatAt");
    expect(result).not.toHaveProperty("runnerCapabilities");
  });

  it("does not leak sessionArtifactId (internal Loop→SESSION linkage, FEA-1718) in the findById result", async () => {
    // Populate the field to a non-null value to prove it is actively stripped
    // by toLoop()'s destructure, not merely absent because the row lacked it.
    const dbRowWithSessionArtifact = {
      ...makeLoopDbRow(),
      sessionArtifactId: "11111111-1111-1111-1111-111111111111",
    };

    (mockWithDb as Mock).mockImplementation(
      (callback: (db: unknown) => unknown) =>
        callback({
          loop: {
            findUnique: vi.fn().mockResolvedValue(dbRowWithSessionArtifact),
          },
          loopEvent: { findMany: vi.fn().mockResolvedValue([]) },
        })
    );

    const result = await loopsService.findById("loop-enrich-1", "org-enrich");

    expect(result).not.toBeNull();
    // sessionArtifactId is an internal materialization FK, not part of the
    // public Loop response contract — it must never reach API consumers.
    expect(result).not.toHaveProperty("sessionArtifactId");
  });
});

// ---------------------------------------------------------------------------
// AC-002 (PR #1206 review fix): getLoopRuntime parses Prisma row `status`
// through a Zod validator. An unrecognized status value surfaces as a logged
// warning and a null return (mapped by the route to 404) rather than a silent
// `as LoopStatus` cast that would lie to downstream consumers.
// ---------------------------------------------------------------------------
describe("loopsService.getLoopRuntime — status validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const runtimeRow = (status: string) => ({
    id: TEST_LOOP_ID,
    status,
    tokenExpiresAt: null,
    lastRunnerHeartbeatAt: null,
    activeTokenJti: null,
    runnerCapabilities: {
      loopRunnerRefreshSupported: false,
      loopRunnerHeartbeatSupported: false,
    },
  });

  it("returns the runtime state when the Prisma row has a known LoopStatus value", async () => {
    (mockWithDb as Mock).mockImplementation((cb: (db: unknown) => unknown) =>
      cb({
        loop: {
          findUnique: vi.fn().mockResolvedValue(runtimeRow(LoopStatus.Running)),
        },
      })
    );

    const result = await loopsService.getLoopRuntime(
      TEST_LOOP_ID,
      TEST_ORG_ID_OWN
    );

    expect(result).not.toBeNull();
    expect(result?.status).toBe(LoopStatus.Running);
  });

  it("returns null when the Prisma row carries an unrecognized status value", async () => {
    (mockWithDb as Mock).mockImplementation((cb: (db: unknown) => unknown) =>
      cb({
        loop: {
          findUnique: vi
            .fn()
            .mockResolvedValue(runtimeRow("not-a-real-status-value")),
        },
      })
    );

    const result = await loopsService.getLoopRuntime(
      TEST_LOOP_ID,
      TEST_ORG_ID_OWN
    );

    expect(result).toBeNull();
  });
});

describe("loopsService.updateStatus — TIMED_OUT → RUNNING is not a generic transition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects an unguarded TIMED_OUT → RUNNING via updateStatus (revival must go through reviveTimedOutLoop)", async () => {
    // CAS matches no rows (the loop is TIMED_OUT, not a valid RUNNING source),
    // then the re-read reports the current status so the method can explain why.
    const mockUpdateMany = vi.fn().mockResolvedValue({ count: 0 });
    const mockFindUnique = vi
      .fn()
      .mockResolvedValue({ status: LoopStatus.TimedOut });

    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({
        loop: { updateMany: mockUpdateMany, findUnique: mockFindUnique },
      })
    );

    const error = await loopsService
      .updateStatus(TEST_LOOP_ID, TEST_ORG_ID_OWN, LoopStatus.Running)
      .then(
        () => null,
        (e: unknown) => e
      );
    expect(isInvalidStatusTransitionError(error)).toBe(true);

    // The CAS only permits the live RUNNING sources (PENDING, CLAIMED); TIMED_OUT
    // is absent, so a timed-out loop never matches.
    const casWhere = mockUpdateMany.mock.calls[0][0].where;
    expect(casWhere.status.in).not.toContain(LoopStatus.TimedOut);
  });
});

describe("loopsService.create — dependency-aware dispatch gating", () => {
  const ORG = "org-block-1";
  const USER = "user-block-1";
  const DOC = "doc-block-1";

  function makeDb(existingBlocked: { id: string } | null = null): {
    mockLoopCreate: Mock;
  } {
    const mockLoopCreate = vi
      .fn()
      .mockImplementation(({ data }: { data: { status: string } }) =>
        Promise.resolve({ id: "loop-block-1", status: data.status })
      );
    const mockLoopUpdateMany = vi.fn().mockResolvedValue({ count: 0 });

    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({
        loop: {
          count: vi.fn().mockResolvedValue(0),
          create: mockLoopCreate,
          findFirst: vi.fn().mockResolvedValue(existingBlocked),
          findMany: vi.fn().mockResolvedValue([]),
          updateMany: mockLoopUpdateMany,
        },
        organization: { findUnique: mockOrgFindUnique },
        artifact: { findFirst: vi.fn().mockResolvedValue(null) },
      })
    );
    mockWithDbTxForReaper(mockLoopUpdateMany);
    return { mockLoopCreate };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(findNonTerminalBlockers).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defers an autonomous loop as BLOCKED when a linked blocker is non-terminal", async () => {
    const { mockLoopCreate } = makeDb();
    vi.mocked(findNonTerminalBlockers).mockResolvedValue([
      { id: "feat-1", name: "FEA-1", status: "IN_REVIEW" },
    ]);

    const result = await loopsService.create(ORG, USER, {
      command: LoopCommand.Execute,
      documentId: DOC,
    });

    expect(result.status).toBe(LoopStatus.Blocked);
    const createData = mockLoopCreate.mock.calls[0][0].data;
    expect(createData.status).toBe(LoopStatus.Blocked);
    expect(createData.startedAt).toBeUndefined();
    expect(createData.metadata).toEqual({ blockedBy: ["feat-1"] });
  });

  it("reuses an existing BLOCKED loop instead of creating a duplicate", async () => {
    const { mockLoopCreate } = makeDb({ id: "loop-existing-blocked" });
    vi.mocked(findNonTerminalBlockers).mockResolvedValue([
      { id: "feat-1", name: "FEA-1", status: "IN_REVIEW" },
    ]);

    const result = await loopsService.create(ORG, USER, {
      command: LoopCommand.Execute,
      documentId: DOC,
    });

    expect(result).toEqual({
      loopId: "loop-existing-blocked",
      status: LoopStatus.Blocked,
    });
    expect(mockLoopCreate).not.toHaveBeenCalled();
  });

  it("resolves a concurrent deferred-dispatch race idempotently when the blocked index rejects the insert", async () => {
    // Both creators pass the optimistic findFirst (null), one insert wins, the
    // loser's create() throws the blocked partial-unique-index P2002; the
    // recovery re-query returns the winner.
    const blockedIndexError = {
      code: "P2002",
      meta: { target: "loops_blocked_artifact_command_key" },
    };
    const mockLoopCreate = vi.fn().mockRejectedValue(blockedIndexError);
    const mockFindFirst = vi
      .fn()
      .mockResolvedValueOnce(null) // create() optimistic idempotency check
      .mockResolvedValueOnce(null) // active-gate pre-insert lookup
      .mockResolvedValue({ id: "loop-race-winner" }); // recovery re-query

    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({
        loop: {
          count: vi.fn().mockResolvedValue(0),
          create: mockLoopCreate,
          findFirst: mockFindFirst,
          findMany: vi.fn().mockResolvedValue([]),
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        organization: { findUnique: mockOrgFindUnique },
        artifact: { findFirst: vi.fn().mockResolvedValue(null) },
      })
    );
    mockWithDbTxForReaper(vi.fn().mockResolvedValue({ count: 0 }));
    vi.mocked(findNonTerminalBlockers).mockResolvedValue([
      { id: "feat-1", name: "FEA-1", status: "IN_REVIEW" },
    ]);

    const result = await loopsService.create(ORG, USER, {
      command: LoopCommand.Execute,
      documentId: DOC,
    });

    expect(result).toEqual({
      loopId: "loop-race-winner",
      status: LoopStatus.Blocked,
    });
  });

  it("dispatches as PENDING when no blocker is non-terminal", async () => {
    const { mockLoopCreate } = makeDb();
    vi.mocked(findNonTerminalBlockers).mockResolvedValue([]);

    const result = await loopsService.create(ORG, USER, {
      command: LoopCommand.Execute,
      documentId: DOC,
    });

    expect(result.status).toBe(LoopStatus.Pending);
    expect(mockLoopCreate.mock.calls[0][0].data.status).toBe(
      LoopStatus.Pending
    );
  });

  it("never gates a MANUAL loop", async () => {
    const { mockLoopCreate } = makeDb();

    const result = await loopsService.create(ORG, USER, {
      command: LoopCommand.Manual,
      documentId: DOC,
    });

    expect(result.status).toBe(LoopStatus.Running);
    expect(findNonTerminalBlockers).not.toHaveBeenCalled();
    expect(mockLoopCreate.mock.calls[0][0].data.status).toBe(
      LoopStatus.Running
    );
  });
});

describe("loopsService.reconcileBlockedLoops", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(findNonTerminalBlockers).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("releases a blocked loop (BLOCKED → PENDING) once its blockers clear, clearing stale blockedBy metadata", async () => {
    const mockUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const mockFindMany = vi.fn().mockResolvedValue([
      {
        id: "loop-b1",
        organizationId: "org-1",
        artifactId: "doc-1",
        metadata: { blockedBy: ["feat-1"], origin: "nightly" },
      },
    ]);
    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({ loop: { findMany: mockFindMany, updateMany: mockUpdateMany } })
    );
    vi.mocked(findNonTerminalBlockers).mockResolvedValue([]);

    const released = await loopsService.reconcileBlockedLoops();

    expect(released).toBe(1);
    // blockedBy is dropped; every other metadata key is preserved.
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "loop-b1",
        organizationId: "org-1",
        status: LoopStatus.Blocked,
      },
      data: {
        status: LoopStatus.Pending,
        metadata: { origin: "nightly" },
      },
    });
  });

  it("leaves a loop BLOCKED while a blocker is still non-terminal", async () => {
    const mockUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const mockFindMany = vi.fn().mockResolvedValue([
      {
        id: "loop-b2",
        organizationId: "org-1",
        artifactId: "doc-2",
        metadata: { blockedBy: ["feat-x"] },
      },
    ]);
    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({ loop: { findMany: mockFindMany, updateMany: mockUpdateMany } })
    );
    vi.mocked(findNonTerminalBlockers).mockResolvedValue([
      { id: "feat-x", name: "FEA-X", status: "APPROVED" },
    ]);

    const released = await loopsService.reconcileBlockedLoops();

    expect(released).toBe(0);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });
});

describe("loopsService.reapStaleBlockedLoops", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("force-cancels a BLOCKED loop past the staleness threshold and records a cancelled event", async () => {
    const mockUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const mockFindMany = vi
      .fn()
      .mockResolvedValue([{ id: "loop-stale", organizationId: "org-1" }]);
    // findUnique backs addEvent's terminal-state check; create backs its insert.
    const mockFindUnique = vi
      .fn()
      .mockResolvedValue({ status: LoopStatus.Cancelled });
    const mockEventCreate = vi.fn().mockResolvedValue({ id: "evt-1" });
    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({
        loop: {
          findMany: mockFindMany,
          updateMany: mockUpdateMany,
          findUnique: mockFindUnique,
        },
        loopEvent: { create: mockEventCreate },
      })
    );

    const cancelled = await loopsService.reapStaleBlockedLoops();

    expect(cancelled).toBe(1);
    const updateArg = mockUpdateMany.mock.calls[0][0];
    expect(updateArg.where).toEqual({
      id: "loop-stale",
      organizationId: "org-1",
      status: LoopStatus.Blocked,
    });
    expect(updateArg.data.status).toBe(LoopStatus.Cancelled);
    expect(updateArg.data.error.code).toBe("BLOCKED_TIMEOUT");
    expect(mockEventCreate).toHaveBeenCalled();
  });

  it("does nothing when no BLOCKED loop is stale", async () => {
    const mockUpdateMany = vi.fn();
    const mockFindMany = vi.fn().mockResolvedValue([]);
    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) =>
      callback({ loop: { findMany: mockFindMany, updateMany: mockUpdateMany } })
    );

    const cancelled = await loopsService.reapStaleBlockedLoops();

    expect(cancelled).toBe(0);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });
});
