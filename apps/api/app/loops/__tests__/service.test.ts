/**
 * Unit tests for loopsService.resume method.
 *
 * Tests computeTargetId propagation, s3StateKey exclusion from resumed loops,
 * and resumable-status validation.
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
}));

const { mockIsFeatureEnabled } = vi.hoisted(() => ({
  mockIsFeatureEnabled: vi.fn().mockResolvedValue(true),
}));

vi.mock("@repo/analytics/server", () => ({
  isFeatureEnabled: mockIsFeatureEnabled,
}));

// Import after mocking
import { withDb } from "@repo/database";
import { loopsService } from "../service";

// Type alias for mocked function
const mockWithDb = withDb as unknown as Mock;

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

describe("loopsService.create — additionalRepos gate", () => {
  const setupMocks = () => {
    const mockCount = vi.fn().mockResolvedValue(0);
    const mockCreate = vi
      .fn()
      .mockResolvedValue({ id: "new-loop", status: LoopStatus.Pending });
    mockWithDb.mockImplementation((callback: (db: unknown) => unknown) => {
      const mockDb = {
        loop: { count: mockCount, create: mockCreate },
        organization: { findUnique: mockOrgFindUnique },
      };
      return callback(mockDb);
    });
    return { mockCreate };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsFeatureEnabled.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("persists additionalRepos for PLAN commands when PostHog flag is enabled", async () => {
    const { mockCreate } = setupMocks();

    const additionalRepos = [
      { fullName: "org/peer-a", branch: "main" },
      { fullName: "org/peer-b", branch: "dev" },
    ];

    await loopsService.create(TEST_ORG_ID, TEST_USER_ID, {
      command: LoopCommand.Plan,
      additionalRepos,
    });

    expect(mockCreate.mock.calls[0][0].data.metadata).toEqual({
      additionalRepos,
    });
  });

  it("drops additionalRepos when PostHog flag is disabled", async () => {
    mockIsFeatureEnabled.mockResolvedValue(false);
    const { mockCreate } = setupMocks();

    await loopsService.create(TEST_ORG_ID, TEST_USER_ID, {
      command: LoopCommand.Plan,
      additionalRepos: [{ fullName: "org/peer-a", branch: "main" }],
    });

    expect(mockCreate.mock.calls[0][0].data.metadata).toBeUndefined();
  });

  it("drops additionalRepos for non-PLAN commands even when PostHog flag is enabled", async () => {
    mockIsFeatureEnabled.mockResolvedValue(true);
    const { mockCreate } = setupMocks();

    await loopsService.create(TEST_ORG_ID, TEST_USER_ID, {
      command: LoopCommand.Chat,
      additionalRepos: [{ fullName: "org/peer-a", branch: "main" }],
    });

    expect(mockCreate.mock.calls[0][0].data.metadata).toBeUndefined();
    expect(mockIsFeatureEnabled).not.toHaveBeenCalled();
  });
});
