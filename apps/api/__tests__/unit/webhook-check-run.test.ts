/**
 * Unit tests for GitHub check_run webhook handler.
 *
 * Tests the following functions from check-run-handler.ts:
 * - handleCheckRun: Main entry point for check_run.completed events
 * - mapRollupStateToChecksStatus: Pure mapping function for rollup state to ChecksStatus
 *
 * These are pure unit tests with mocked external dependencies:
 * - @repo/database (Prisma client - withDb + withDb.tx)
 * - @repo/github (queryStatusCheckRollup)
 * - @repo/observability/log (logging)
 */

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
  return { withDb: mockWithDb };
});

vi.mock("@repo/github", () => ({
  queryStatusCheckRollup: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Import after mocking
import { queryStatusCheckRollup } from "@repo/github";
import { getMockWithDb } from "@/__tests__/utils/db-helpers";
import {
  handleCheckRun,
  mapRollupStateToChecksStatus,
} from "@/app/webhooks/github/handlers/check-run-handler";

// Type aliases for mocked functions
const mockWithDb = getMockWithDb();
const mockQueryStatusCheckRollup = queryStatusCheckRollup as unknown as Mock;

// Mock database clients
let mockDb: any;
let mockTx: any;

/**
 * Helper to create a minimal check_run event for testing
 */
function createCheckRunEvent(partial?: {
  action?: string;
  headSha?: string;
  headBranch?: string;
  repositoryId?: number;
  repositoryFullName?: string;
  installationId?: number | null;
  checkRunId?: number;
  checkRunName?: string;
  conclusion?: string;
}) {
  const hasInstallation = partial?.installationId !== null;
  return {
    action: partial?.action ?? "completed",
    check_run: {
      id: partial?.checkRunId ?? 1,
      name: partial?.checkRunName ?? "ci / test",
      head_sha: partial?.headSha ?? "abc123def456abc123def456abc123def456abc1",
      conclusion: partial?.conclusion ?? "success",
      check_suite: {
        head_branch: partial?.headBranch ?? "feature/test-branch",
      },
    },
    repository: {
      id: partial?.repositoryId ?? 12_345,
      full_name: partial?.repositoryFullName ?? "org/repo",
    },
    ...(hasInstallation !== false && {
      installation: {
        id: partial?.installationId ?? 99,
      },
    }),
  } as any;
}

describe("mapRollupStateToChecksStatus", () => {
  it("maps SUCCESS to PASSING", () => {
    expect(mapRollupStateToChecksStatus("SUCCESS")).toBe("PASSING");
  });

  it("maps FAILURE to FAILING", () => {
    expect(mapRollupStateToChecksStatus("FAILURE")).toBe("FAILING");
  });

  it("maps ERROR to FAILING", () => {
    expect(mapRollupStateToChecksStatus("ERROR")).toBe("FAILING");
  });

  it("maps PENDING to PENDING", () => {
    expect(mapRollupStateToChecksStatus("PENDING")).toBe("PENDING");
  });

  it("maps EXPECTED to PENDING", () => {
    expect(mapRollupStateToChecksStatus("EXPECTED")).toBe("PENDING");
  });
});

describe("handleCheckRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockDb = {
      gitHubInstallationRepository: {
        findFirst: vi.fn(),
      },
      gitHubPullRequest: {
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
      },
      workstreamEvent: {
        create: vi.fn(),
      },
    };

    mockTx = {
      gitHubPullRequest: {
        findUnique: vi.fn(),
        update: vi.fn(),
      },
      workstreamEvent: {
        create: vi.fn(),
      },
    };

    mockWithDb.mockImplementation((fn: any) => fn(mockDb));
    mockWithDb.tx.mockImplementation((fn: any) => fn(mockTx));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("action guard", () => {
    it("returns early without calling withDb when action is 'created'", async () => {
      const event = createCheckRunEvent({ action: "created" });

      const response = await handleCheckRun(event);

      expect(mockWithDb).not.toHaveBeenCalled();
      expect(mockQueryStatusCheckRollup).not.toHaveBeenCalled();

      const data = await response.json();
      expect(data.ok).toBe(true);
    });

    it("returns early without calling withDb when action is 'rerequested'", async () => {
      const event = createCheckRunEvent({ action: "rerequested" });

      const response = await handleCheckRun(event);

      expect(mockWithDb).not.toHaveBeenCalled();
      expect(mockQueryStatusCheckRollup).not.toHaveBeenCalled();

      const data = await response.json();
      expect(data.ok).toBe(true);
    });
  });

  describe("installation guard", () => {
    it("returns 400 when installation field is missing", async () => {
      const event = createCheckRunEvent({ installationId: null });
      // Remove installation property entirely (use undefined to satisfy Biome noDelete rule)
      event.installation = undefined;

      const response = await handleCheckRun(event);

      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.ok).toBe(false);
      expect(data.message).toBe("Missing installation");

      expect(mockWithDb).not.toHaveBeenCalled();
      expect(mockQueryStatusCheckRollup).not.toHaveBeenCalled();
    });
  });

  describe("repository lookup", () => {
    it("returns ok:true without calling rollup when repository is not found", async () => {
      const event = createCheckRunEvent({ repositoryId: 99_999 });

      mockDb.gitHubInstallationRepository.findFirst.mockResolvedValue(null);

      const response = await handleCheckRun(event);

      expect(
        mockDb.gitHubInstallationRepository.findFirst
      ).toHaveBeenCalledWith({
        where: { githubRepoId: String(event.repository.id) },
        select: { id: true, owner: true, name: true },
      });
      expect(mockQueryStatusCheckRollup).not.toHaveBeenCalled();
      expect(mockWithDb.tx).not.toHaveBeenCalled();

      const data = await response.json();
      expect(data.ok).toBe(true);
    });
  });

  describe("PR lookup", () => {
    it("returns ok:true without calling rollup when no open PR matches headSha", async () => {
      const headSha = "abc123def456abc123def456abc123def456abc1";
      const event = createCheckRunEvent({ headSha });

      mockDb.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-123",
        owner: "org",
        name: "repo",
      });
      mockDb.gitHubPullRequest.findFirst.mockResolvedValue(null);

      const response = await handleCheckRun(event);

      expect(mockDb.gitHubPullRequest.findFirst).toHaveBeenCalledWith({
        where: {
          state: "OPEN",
          repositoryId: "repo-uuid-123",
          OR: [
            { headSha },
            { headSha: null, headBranch: "feature/test-branch" },
          ],
        },
        select: {
          id: true,
          number: true,
          title: true,
          htmlUrl: true,
          checksStatus: true,
          headSha: true,
          workstreamId: true,
          artifactId: true,
          artifact: { select: { slug: true } },
        },
      });
      expect(mockQueryStatusCheckRollup).not.toHaveBeenCalled();
      expect(mockWithDb.tx).not.toHaveBeenCalled();

      const data = await response.json();
      expect(data.ok).toBe(true);
    });
  });

  describe("GraphQL rollup", () => {
    it("skips DB writes when queryStatusCheckRollup returns null", async () => {
      const headSha = "abc123def456abc123def456abc123def456abc1";
      const installationId = 99;
      const event = createCheckRunEvent({ headSha, installationId });

      mockDb.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-123",
        owner: "org",
        name: "repo",
      });
      mockDb.gitHubPullRequest.findFirst.mockResolvedValue({
        id: "pr-uuid-123",
        number: 42,
        title: "Test PR",
        htmlUrl: "https://github.com/org/repo/pull/42",
        checksStatus: "UNKNOWN",
        headSha,
        workstreamId: "ws-uuid-123",
        artifactId: "artifact-uuid-123",
        artifact: { slug: "test-slug" },
      });

      mockQueryStatusCheckRollup.mockResolvedValue(null);

      const response = await handleCheckRun(event);

      expect(mockQueryStatusCheckRollup).toHaveBeenCalledWith(
        installationId,
        "org",
        "repo",
        headSha
      );
      expect(mockWithDb.tx).not.toHaveBeenCalled();

      const data = await response.json();
      expect(data.ok).toBe(true);
    });
  });

  describe("successful check_run.completed for matching open PR", () => {
    it("calls rollup, updates checksStatus, and creates workstream event when status changes", async () => {
      const headSha = "abc123def456abc123def456abc123def456abc1";
      const installationId = 99;
      const repositoryId = 12_345;
      const event = createCheckRunEvent({
        headSha,
        installationId,
        repositoryId,
      });

      mockDb.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-123",
        owner: "org",
        name: "repo",
      });
      mockDb.gitHubPullRequest.findFirst.mockResolvedValue({
        id: "pr-uuid-123",
        number: 42,
        title: "Test PR",
        htmlUrl: "https://github.com/org/repo/pull/42",
        checksStatus: "UNKNOWN",
        headSha,
        workstreamId: "ws-uuid-123",
        artifactId: "artifact-uuid-123",
        artifact: { slug: "test-slug" },
      });

      mockQueryStatusCheckRollup.mockResolvedValue("SUCCESS");

      // TOCTOU guard: re-read in tx returns same headSha, OPEN state, different checksStatus
      mockTx.gitHubPullRequest.findUnique.mockResolvedValue({
        headSha,
        checksStatus: "UNKNOWN",
        state: "OPEN",
      });
      mockTx.gitHubPullRequest.update.mockResolvedValue({});
      mockTx.workstreamEvent.create.mockResolvedValue({});

      const response = await handleCheckRun(event);

      // Verify GraphQL call
      expect(mockQueryStatusCheckRollup).toHaveBeenCalledWith(
        installationId,
        "org",
        "repo",
        headSha
      );

      // Verify transaction was opened
      expect(mockWithDb.tx).toHaveBeenCalledTimes(1);

      // Verify TOCTOU re-read
      expect(mockTx.gitHubPullRequest.findUnique).toHaveBeenCalledWith({
        where: { id: "pr-uuid-123" },
        select: { headSha: true, checksStatus: true, state: true },
      });

      // Verify checksStatus update
      expect(mockTx.gitHubPullRequest.update).toHaveBeenCalledWith({
        where: { id: "pr-uuid-123" },
        data: { checksStatus: "PASSING" },
      });

      // Verify workstream event creation
      expect(mockTx.workstreamEvent.create).toHaveBeenCalledWith({
        data: {
          workstreamId: "ws-uuid-123",
          type: "GITHUB_CI_STATUS_CHANGED",
          actorType: "system",
          data: {
            prNumber: 42,
            prTitle: "Test PR",
            prUrl: "https://github.com/org/repo/pull/42",
            artifactId: "artifact-uuid-123",
            slug: "test-slug",
            checksStatus: "PASSING",
            previousChecksStatus: "UNKNOWN",
            headSha,
          },
        },
      });

      const data = await response.json();
      expect(data.ok).toBe(true);
    });
  });

  describe("idempotency", () => {
    it("does NOT call update or workstreamEvent.create when checksStatus is already the same", async () => {
      const headSha = "abc123def456abc123def456abc123def456abc1";
      const event = createCheckRunEvent({ headSha });

      mockDb.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-idempotent",
        owner: "org",
        name: "repo",
      });
      mockDb.gitHubPullRequest.findFirst.mockResolvedValue({
        id: "pr-uuid-idempotent",
        number: 43,
        title: "Idempotent PR",
        htmlUrl: "https://github.com/org/repo/pull/43",
        checksStatus: "PASSING",
        headSha,
        workstreamId: "ws-uuid-idempotent",
        artifactId: null,
        artifact: null,
      });

      mockQueryStatusCheckRollup.mockResolvedValue("SUCCESS");

      // TOCTOU re-read returns same status (PASSING == PASSING after mapping SUCCESS)
      mockTx.gitHubPullRequest.findUnique.mockResolvedValue({
        headSha,
        checksStatus: "PASSING",
        state: "OPEN",
      });

      const response = await handleCheckRun(event);

      // Transaction was opened but no writes were made
      expect(mockWithDb.tx).toHaveBeenCalledTimes(1);
      expect(mockTx.gitHubPullRequest.update).not.toHaveBeenCalled();
      expect(mockTx.workstreamEvent.create).not.toHaveBeenCalled();

      const data = await response.json();
      expect(data.ok).toBe(true);
    });
  });

  describe("headSha TOCTOU guard", () => {
    it("skips update when PR headSha changed between non-tx read and tx write", async () => {
      const headSha = "abc123def456abc123def456abc123def456abc1";
      const newHeadSha = "111222333444555666777888999000aaabbbcccd";
      const event = createCheckRunEvent({ headSha });

      mockDb.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-toctou",
        owner: "org",
        name: "repo",
      });
      mockDb.gitHubPullRequest.findFirst.mockResolvedValue({
        id: "pr-uuid-toctou",
        number: 44,
        title: "TOCTOU PR",
        htmlUrl: "https://github.com/org/repo/pull/44",
        checksStatus: "UNKNOWN",
        headSha,
        workstreamId: "ws-uuid-toctou",
        artifactId: null,
        artifact: null,
      });

      mockQueryStatusCheckRollup.mockResolvedValue("SUCCESS");

      // TX re-read returns a different headSha (synchronize event arrived)
      mockTx.gitHubPullRequest.findUnique.mockResolvedValue({
        headSha: newHeadSha,
        checksStatus: "UNKNOWN",
        state: "OPEN",
      });

      const response = await handleCheckRun(event);

      // Transaction opened but no writes
      expect(mockWithDb.tx).toHaveBeenCalledTimes(1);
      expect(mockTx.gitHubPullRequest.update).not.toHaveBeenCalled();
      expect(mockTx.workstreamEvent.create).not.toHaveBeenCalled();

      const data = await response.json();
      expect(data.ok).toBe(true);
    });
  });

  describe("PR state guard in transaction", () => {
    it("skips update when PR state is no longer OPEN (e.g. MERGED) in tx re-read", async () => {
      const headSha = "abc123def456abc123def456abc123def456abc1";
      const event = createCheckRunEvent({ headSha });

      mockDb.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-merged",
        owner: "org",
        name: "repo",
      });
      mockDb.gitHubPullRequest.findFirst.mockResolvedValue({
        id: "pr-uuid-merged",
        number: 45,
        title: "Merged PR",
        htmlUrl: "https://github.com/org/repo/pull/45",
        checksStatus: "UNKNOWN",
        headSha,
        workstreamId: "ws-uuid-merged",
        artifactId: null,
        artifact: null,
      });

      mockQueryStatusCheckRollup.mockResolvedValue("SUCCESS");

      // TX re-read shows PR was merged between initial read and tx
      mockTx.gitHubPullRequest.findUnique.mockResolvedValue({
        headSha,
        checksStatus: "UNKNOWN",
        state: "MERGED",
      });

      const response = await handleCheckRun(event);

      // Transaction opened but no writes
      expect(mockWithDb.tx).toHaveBeenCalledTimes(1);
      expect(mockTx.gitHubPullRequest.update).not.toHaveBeenCalled();
      expect(mockTx.workstreamEvent.create).not.toHaveBeenCalled();

      const data = await response.json();
      expect(data.ok).toBe(true);
    });
  });

  describe("PR no longer exists in transaction", () => {
    it("skips update when PR no longer exists during tx re-read", async () => {
      const headSha = "abc123def456abc123def456abc123def456abc1";
      const event = createCheckRunEvent({ headSha });

      mockDb.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-gone",
        owner: "org",
        name: "repo",
      });
      mockDb.gitHubPullRequest.findFirst.mockResolvedValue({
        id: "pr-uuid-gone",
        number: 46,
        title: "Gone PR",
        htmlUrl: "https://github.com/org/repo/pull/46",
        checksStatus: "UNKNOWN",
        headSha,
        workstreamId: "ws-uuid-gone",
        artifactId: null,
        artifact: null,
      });

      mockQueryStatusCheckRollup.mockResolvedValue("SUCCESS");

      // TX re-read: PR was deleted
      mockTx.gitHubPullRequest.findUnique.mockResolvedValue(null);

      const response = await handleCheckRun(event);

      expect(mockWithDb.tx).toHaveBeenCalledTimes(1);
      expect(mockTx.gitHubPullRequest.update).not.toHaveBeenCalled();
      expect(mockTx.workstreamEvent.create).not.toHaveBeenCalled();

      const data = await response.json();
      expect(data.ok).toBe(true);
    });
  });

  describe("full flow with FAILURE conclusion", () => {
    it("maps FAILURE rollup state to FAILING and updates checksStatus", async () => {
      const headSha = "abc123def456abc123def456abc123def456abc1";
      const event = createCheckRunEvent({ headSha, conclusion: "failure" });

      mockDb.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-fail",
        owner: "org",
        name: "repo",
      });
      mockDb.gitHubPullRequest.findFirst.mockResolvedValue({
        id: "pr-uuid-fail",
        number: 47,
        title: "Failing PR",
        htmlUrl: "https://github.com/org/repo/pull/47",
        checksStatus: "PASSING",
        headSha,
        workstreamId: "ws-uuid-fail",
        artifactId: "artifact-uuid-fail",
        artifact: { slug: "fail-slug" },
      });

      mockQueryStatusCheckRollup.mockResolvedValue("FAILURE");

      mockTx.gitHubPullRequest.findUnique.mockResolvedValue({
        headSha,
        checksStatus: "PASSING",
        state: "OPEN",
      });
      mockTx.gitHubPullRequest.update.mockResolvedValue({});
      mockTx.workstreamEvent.create.mockResolvedValue({});

      const response = await handleCheckRun(event);

      expect(mockTx.gitHubPullRequest.update).toHaveBeenCalledWith({
        where: { id: "pr-uuid-fail" },
        data: { checksStatus: "FAILING" },
      });

      expect(mockTx.workstreamEvent.create).toHaveBeenCalledWith({
        data: {
          workstreamId: "ws-uuid-fail",
          type: "GITHUB_CI_STATUS_CHANGED",
          actorType: "system",
          data: {
            prNumber: 47,
            prTitle: "Failing PR",
            prUrl: "https://github.com/org/repo/pull/47",
            artifactId: "artifact-uuid-fail",
            slug: "fail-slug",
            checksStatus: "FAILING",
            previousChecksStatus: "PASSING",
            headSha,
          },
        },
      });

      const data = await response.json();
      expect(data.ok).toBe(true);
    });
  });

  describe("transaction behavior", () => {
    it("executes the write within a single transaction (withDb.tx called once)", async () => {
      const headSha = "abc123def456abc123def456abc123def456abc1";
      const event = createCheckRunEvent({ headSha });

      mockDb.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-tx",
        owner: "org",
        name: "repo",
      });
      mockDb.gitHubPullRequest.findFirst.mockResolvedValue({
        id: "pr-uuid-tx",
        number: 48,
        title: "TX PR",
        htmlUrl: "https://github.com/org/repo/pull/48",
        checksStatus: "UNKNOWN",
        headSha,
        workstreamId: "ws-uuid-tx",
        artifactId: null,
        artifact: null,
      });

      mockQueryStatusCheckRollup.mockResolvedValue("SUCCESS");

      mockTx.gitHubPullRequest.findUnique.mockResolvedValue({
        headSha,
        checksStatus: "UNKNOWN",
        state: "OPEN",
      });
      mockTx.gitHubPullRequest.update.mockResolvedValue({});
      mockTx.workstreamEvent.create.mockResolvedValue({});

      await handleCheckRun(event);

      // The non-transactional read uses withDb (once)
      expect(mockWithDb).toHaveBeenCalledTimes(1);
      // The transactional write uses withDb.tx (once)
      expect(mockWithDb.tx).toHaveBeenCalledTimes(1);
    });
  });
});
