/**
 * Unit tests for the GitHub `check_run` webhook handler's early-return guards
 * and provider-failure paths: the action/installation guards, the repository
 * and PR lookups, and every branch of the GraphQL rollup (including a failed
 * installation-client acquisition). The persistence flows this handler runs
 * once those guards pass live in `webhook-check-run.test.ts`.
 */

import type * as GitHubModule from "@repo/github";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";

const { mockGetInstallationOctokit, mockOctokit } = vi.hoisted(() => ({
  mockGetInstallationOctokit: vi.fn(),
  mockOctokit: { marker: "installation-octokit" },
}));

vi.mock("@repo/database", () => {
  const mockWithDb: any = vi.fn();
  mockWithDb.tx = vi.fn();
  return {
    ArtifactType: {
      DOCUMENT: "DOCUMENT",
      BRANCH: "BRANCH",
      DEPLOYMENT: "DEPLOYMENT",
    },
    GitHubInstallationStatus: { ACTIVE: "ACTIVE" },
    Prisma: {
      join: (values: unknown[]) => values,
      sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
        strings,
        values,
      }),
    },
    withDb: mockWithDb,
  };
});

vi.mock("@repo/github", async (importOriginal) => {
  const actual = await importOriginal<typeof GitHubModule>();
  return {
    GitHubProviderResultStatus: actual.GitHubProviderResultStatus,
    queryStatusCheckRollupWithProviderResult: vi.fn(),
    // Real classifier (a plain function, immune to restoreAllMocks) so the
    // mint-failure tests pin the production rate-limit-vs-unavailable
    // classification instead of a mock's reimplementation.
  };
});

vi.mock("@repo/github/installation-auth", () => ({
  // Spy wrapper (not a bare vi.fn implementation) so this suite's
  // restoreAllMocks pass can never strip the marker client the handler
  // threads into the rollup query. Mint-failure tests inject a one-shot
  // rejection through the spy; any non-undefined spy result wins over the
  // resolved marker client fallback.
  getInstallationOctokit: (installationId: string) =>
    mockGetInstallationOctokit(installationId) ?? Promise.resolve(mockOctokit),
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { mapRollupStateToChecksStatus } from "@repo/api/src/github-checks-status";
import { BranchViewChecksProviderState } from "@repo/api/src/types/branch-view";
import { StatusCheckRollupFailureReason } from "@repo/api/src/types/github";
import { GitHubInstallationStatus } from "@repo/database";
// Import after mocking
import {
  GitHubProviderResultStatus,
  queryStatusCheckRollupWithProviderResult,
} from "@repo/github";
import { log } from "@repo/observability/log";
import { getMockWithDb } from "@/__tests__/utils/db-helpers";
import { handleCheckRun } from "@/app/webhooks/github/handlers/check-run-handler";
import { CheckRunRetryState } from "@/lib/branch-status-check-retry";
import {
  createCheckRunDbDoubles,
  createCheckRunEvent,
  makeBranchDetailRow,
} from "../utils/check-run-helpers";
import { providerSuccess } from "../utils/status-check-helpers";

const mockWithDb = getMockWithDb();
const mockQueryStatusCheckRollupWithProviderResult =
  queryStatusCheckRollupWithProviderResult as unknown as Mock;

let mockDb: any;
let mockTx: any;

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

describe("handleCheckRun guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ({ mockDb, mockTx } = createCheckRunDbDoubles());
    mockWithDb.mockImplementation((fn: any) => fn(mockDb));
    mockWithDb.tx.mockImplementation((fn: any) => fn(mockTx));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("action guard", () => {
    it("returns early without calling withDb when action is 'created'", async () => {
      const event = createCheckRunEvent({ action: "created" });

      const response = await handleCheckRun(event);

      expect(mockWithDb).not.toHaveBeenCalled();
      expect(
        mockQueryStatusCheckRollupWithProviderResult
      ).not.toHaveBeenCalled();

      const data = await response.json();
      expect(data.ok).toBe(true);
      expect(log.info).toHaveBeenCalledTimes(1);
      expect(log.info).toHaveBeenCalledWith(
        "[handleCheckRun] Completed check_run webhook handling",
        expect.objectContaining({
          action: "created",
          eventType: "check_run",
          outcome: "ignored_action",
          provider: "github",
        })
      );
    });

    it("returns early without calling withDb when action is 'rerequested'", async () => {
      const event = createCheckRunEvent({ action: "rerequested" });

      const response = await handleCheckRun(event);

      expect(mockWithDb).not.toHaveBeenCalled();
      expect(
        mockQueryStatusCheckRollupWithProviderResult
      ).not.toHaveBeenCalled();

      const data = await response.json();
      expect(data.ok).toBe(true);
      expect(log.info).toHaveBeenCalledWith(
        "[handleCheckRun] Completed check_run webhook handling",
        expect.objectContaining({
          action: "rerequested",
          eventType: "check_run",
          outcome: "ignored_action",
          provider: "github",
        })
      );
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
      expect(
        mockQueryStatusCheckRollupWithProviderResult
      ).not.toHaveBeenCalled();
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
        where: {
          githubRepoId: String(event.repository.id),
          fullName: event.repository.full_name,
          removedAt: null,
          installation: {
            installationId: String(event.installation?.id),
            status: GitHubInstallationStatus.ACTIVE,
          },
        },
        select: {
          id: true,
          installation: { select: { organizationId: true } },
          name: true,
          owner: true,
        },
      });
      expect(
        mockQueryStatusCheckRollupWithProviderResult
      ).not.toHaveBeenCalled();
      expect(mockWithDb.tx).not.toHaveBeenCalled();

      const data = await response.json();
      expect(data.ok).toBe(true);
      expect(log.info).toHaveBeenCalledWith(
        "[handleCheckRun] Completed check_run webhook handling",
        expect.objectContaining({
          outcome: "repo_not_registered",
          provider: "github",
        })
      );
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
      mockDb.branchDetail.findFirst.mockResolvedValue(null);
      mockDb.branchDetail.findMany.mockResolvedValue([]);

      const response = await handleCheckRun(event);

      expect(mockDb.branchDetail.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            repositoryId: "repo-uuid-123",
          }),
        })
      );
      expect(
        mockQueryStatusCheckRollupWithProviderResult
      ).not.toHaveBeenCalled();
      expect(mockWithDb.tx).not.toHaveBeenCalled();

      const data = await response.json();
      expect(data.ok).toBe(true);
      expect(log.info).toHaveBeenCalledWith(
        "[handleCheckRun] Completed check_run webhook handling",
        expect.objectContaining({
          outcome: "no_branch_artifact",
          provider: "github",
        })
      );
    });
  });

  describe("GraphQL rollup", () => {
    it("skips DB writes when queryStatusCheckRollupWithProviderResult returns null", async () => {
      const headSha = "abc123def456abc123def456abc123def456abc1";
      const installationId = 99;
      const event = createCheckRunEvent({ headSha, installationId });

      mockDb.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-123",
        owner: "org",
        name: "repo",
      });
      mockDb.branchDetail.findFirst.mockResolvedValue(
        makeBranchDetailRow({
          artifactId: "artifact-pr-123",
          number: 42,
          title: "Test PR",
          externalUrl: "https://github.com/org/repo/pull/42",
          headSha,
          workstreamId: "ws-uuid-123",
          linkedDoc: { id: "artifact-doc-123", slug: "test-slug" },
        })
      );

      mockQueryStatusCheckRollupWithProviderResult.mockResolvedValue(
        providerSuccess({
          ok: false,
          reason: StatusCheckRollupFailureReason.GraphqlError,
        })
      );
      mockTx.branchDetail.findUnique.mockResolvedValue({
        headSha,
        checksStatus: "UNKNOWN",
        deletedAt: null,
      });
      mockTx.branchDetail.updateMany.mockImplementation((args: any) => {
        if (
          args?.data?.checkRunRetryState === CheckRunRetryState.Pending &&
          args?.where?.checkRunRetryResourceId !== undefined
        ) {
          return Promise.resolve({ count: 0 });
        }
        return Promise.resolve({ count: 1 });
      });

      const response = await handleCheckRun(event);

      expect(mockGetInstallationOctokit).toHaveBeenCalledWith(
        String(installationId)
      );
      expect(mockQueryStatusCheckRollupWithProviderResult).toHaveBeenCalledWith(
        mockOctokit,
        "org",
        "repo",
        headSha
      );
      expect(mockWithDb.tx).toHaveBeenCalledTimes(1);
      expect(mockTx.branchDetail.updateMany).toHaveBeenCalledWith({
        data: expect.objectContaining({
          checksDetailProviderState:
            BranchViewChecksProviderState.ProviderUnavailable,
          checksDetailUnavailableReason:
            StatusCheckRollupFailureReason.GraphqlError,
        }),
        where: {
          artifact: { organizationId: "org-1" },
          artifactId: "artifact-pr-123",
          deletedAt: null,
          headSha,
        },
      });

      const data = await response.json();
      expect(data.ok).toBe(true);
    });

    it("schedules rate-limited check_run retries with provider retry metadata", async () => {
      const headSha = "abc123def456abc123def456abc123def456abc1";
      const event = createCheckRunEvent({
        checkRunId: 24_681,
        headSha,
        installationId: 99,
      });
      const now = new Date("2026-07-03T01:00:00Z");
      vi.useFakeTimers();
      vi.setSystemTime(now);

      mockDb.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-123",
        owner: "org",
        name: "repo",
      });
      mockDb.branchDetail.findFirst.mockResolvedValue(
        makeBranchDetailRow({
          artifactId: "artifact-pr-123",
          number: 42,
          title: "Test PR",
          externalUrl: "https://github.com/org/repo/pull/42",
          headSha,
          workstreamId: "ws-uuid-123",
          linkedDoc: { id: "artifact-doc-123", slug: "test-slug" },
        })
      );
      mockQueryStatusCheckRollupWithProviderResult.mockResolvedValue({
        status: GitHubProviderResultStatus.ProviderRateLimit,
        retryAfterSeconds: 37,
      });
      mockTx.branchDetail.findUnique.mockResolvedValue({
        headSha,
        checksStatus: "UNKNOWN",
        deletedAt: null,
      });

      const response = await handleCheckRun(event);

      expect(mockTx.branchDetail.updateMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            checkRunRetryNextAt: new Date("2026-07-03T01:00:37Z"),
            checkRunRetryReason: StatusCheckRollupFailureReason.RateLimited,
            checkRunRetryState: CheckRunRetryState.Pending,
          }),
          where: expect.objectContaining({
            artifact: { organizationId: "org-1" },
            artifactId: "artifact-pr-123",
            deletedAt: null,
            headSha,
            repositoryId: "repo-uuid-123",
          }),
        })
      );
      expect(response.status).toBe(200);
      expect(log.info).toHaveBeenCalledWith(
        "[handleCheckRun] Completed check_run webhook handling",
        expect.objectContaining({
          outcome: "processed",
          providerStatus: GitHubProviderResultStatus.ProviderRateLimit,
          retryAfterSeconds: 37,
        })
      );
    });

    it("schedules a retry when the installation client mint is rate limited", async () => {
      const headSha = "abc123def456abc123def456abc123def456abc1";
      const event = createCheckRunEvent({
        checkRunId: 24_682,
        headSha,
        installationId: 99,
      });
      const now = new Date("2026-07-03T01:00:00Z");
      vi.useFakeTimers();
      vi.setSystemTime(now);

      mockDb.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-123",
        owner: "org",
        name: "repo",
      });
      mockDb.branchDetail.findFirst.mockResolvedValue(
        makeBranchDetailRow({
          artifactId: "artifact-pr-123",
          number: 42,
          title: "Test PR",
          externalUrl: "https://github.com/org/repo/pull/42",
          headSha,
          workstreamId: "ws-uuid-123",
          linkedDoc: { id: "artifact-doc-123", slug: "test-slug" },
        })
      );
      // The token exchange itself is rate limited, so the rollup read never
      // runs — the retry must still be scheduled from the mint failure.
      mockGetInstallationOctokit.mockRejectedValueOnce(
        Object.assign(new Error("installation token request failed"), {
          status: 429,
          headers: { "retry-after": "45" },
        })
      );
      mockTx.branchDetail.findUnique.mockResolvedValue({
        headSha,
        checksStatus: "UNKNOWN",
        deletedAt: null,
      });

      const response = await handleCheckRun(event);

      expect(
        mockQueryStatusCheckRollupWithProviderResult
      ).not.toHaveBeenCalled();
      expect(mockTx.branchDetail.updateMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            checkRunRetryNextAt: new Date("2026-07-03T01:00:45Z"),
            checkRunRetryReason: StatusCheckRollupFailureReason.RateLimited,
            checkRunRetryState: CheckRunRetryState.Pending,
          }),
          where: expect.objectContaining({
            artifactId: "artifact-pr-123",
            headSha,
          }),
        })
      );
      expect(response.status).toBe(200);
    });

    it("persists provider-unavailable checks without scheduling a retry when the installation client mint fails", async () => {
      const headSha = "abc123def456abc123def456abc123def456abc1";
      const event = createCheckRunEvent({
        checkRunId: 24_683,
        headSha,
        installationId: 99,
      });

      mockDb.gitHubInstallationRepository.findFirst.mockResolvedValue({
        id: "repo-uuid-123",
        owner: "org",
        name: "repo",
      });
      mockDb.branchDetail.findFirst.mockResolvedValue(
        makeBranchDetailRow({
          artifactId: "artifact-pr-123",
          number: 42,
          title: "Test PR",
          externalUrl: "https://github.com/org/repo/pull/42",
          headSha,
          workstreamId: "ws-uuid-123",
          linkedDoc: { id: "artifact-doc-123", slug: "test-slug" },
        })
      );
      mockGetInstallationOctokit.mockRejectedValueOnce(
        new Error("token exchange failed")
      );
      mockTx.branchDetail.findUnique.mockResolvedValue({
        headSha,
        checksStatus: "UNKNOWN",
        deletedAt: null,
      });
      mockTx.branchDetail.updateMany.mockResolvedValue({ count: 1 });

      const response = await handleCheckRun(event);

      // A non-rate-limit mint failure classifies as ProviderUnavailable: the
      // unavailable state is persisted, and no retry row is written.
      expect(
        mockQueryStatusCheckRollupWithProviderResult
      ).not.toHaveBeenCalled();
      expect(mockTx.branchDetail.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            checksDetailProviderState:
              BranchViewChecksProviderState.ProviderUnavailable,
            checksDetailUnavailableReason:
              StatusCheckRollupFailureReason.GraphqlError,
          }),
        })
      );
      expect(mockTx.branchDetail.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            checkRunRetryState: CheckRunRetryState.Pending,
          }),
        })
      );

      const data = await response.json();
      expect(data.ok).toBe(true);
    });
  });
});
