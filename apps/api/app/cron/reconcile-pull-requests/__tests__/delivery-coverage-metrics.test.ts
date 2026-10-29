import {
  SessionArtifactLinkKind,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import { FilterToken } from "@repo/observability/telemetry/filter-tokens";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ISS_12033_LOGGED_ACTIONABLE_TICKS } from "@/__tests__/support/cron/reconcile-pull-requests/delivery-coverage-actionable-ticks.test-fixtures";
import {
  GitHubRepoSyncDeferralReason,
  GitHubRepoSyncTier,
} from "@/lib/github/github-repo-sync-state";
import type { GitHubDeliveryCoverageTickInput } from "../delivery-coverage-metrics";
import { ReconcileRepoStatus } from "../repo-reconcile-status";

const mocks = vi.hoisted(() => ({
  emitTelemetryMetric: vi.fn(),
  logWarn: vi.fn(),
  withDb: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
}));

vi.mock("@repo/observability/log", () => ({
  log: { warn: mocks.logWarn },
}));

vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitTelemetryMetric: mocks.emitTelemetryMetric,
}));

vi.mock("@repo/observability/telemetry/origin", () => ({
  ORIGIN: "api",
}));

const {
  GITHUB_DELIVERY_COVERAGE_LINK_SCAN_LIMIT,
  GITHUB_DELIVERY_COVERAGE_LINK_SCAN_PAGE_SIZE,
} = await import("../delivery-coverage-link-reader");

const {
  GitHubDeliveryCoverageState,
  GitHubDeliveryCoverageUnavailableReason,
  readGitHubDeliveryCoverageCounts,
  reportGitHubDeliveryCoverageTick,
} = await import("../delivery-coverage-metrics");

type PullRequestRow = {
  id: string;
  number: number | null;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
  isCurrent: boolean;
  lastVerifiedAt: Date | null;
  repositoryFullName: string | null;
  repository: { fullName: string } | null;
  branchArtifact: {
    id: string;
    _count: { pullRequestDetails: number };
  };
};

type ArtifactLinkRow = {
  id: string;
  targetId: string;
  metadata: Record<string, unknown>;
  branchRepositoryId: string | null;
  branchRepositoryFullName: string;
};
type ArtifactLinkQuery = {
  where?: Record<string, unknown>;
  cursor?: { id: string };
  skip?: number;
  take?: number;
};

const NOW = new Date("2026-08-26T12:00:00.000Z");
const ORGANIZATION_ID = "org-1";
const REPOSITORY_FULL_NAME = "Acme/Widgets";
const SWEPT = ReconcileRepoStatus.Swept;

let pullRequestRows: PullRequestRow[] = [];
let artifactLinkRows: ArtifactLinkRow[] = [];
const pullRequestFindMany = vi.fn();
const artifactLinkFindMany = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  pullRequestRows = [];
  artifactLinkRows = [];
  pullRequestFindMany.mockImplementation(
    (args: { where: { branchArtifactId: { in: string[] } } }) => {
      const branchIds = new Set(args.where.branchArtifactId.in);
      return Promise.resolve(
        pullRequestRows.filter((row) => branchIds.has(row.branchArtifact.id))
      );
    }
  );
  artifactLinkFindMany.mockImplementation((args: ArtifactLinkQuery) =>
    Promise.resolve(pageArtifactLinks(args))
  );
  mocks.withDb.mockImplementation((fn: (db: unknown) => unknown) =>
    fn({
      artifactLink: { findMany: artifactLinkFindMany },
      pullRequestDetail: { findMany: pullRequestFindMany },
    })
  );
});

describe("GitHub delivery coverage metrics", () => {
  it("emits the explicit denominator, numerator, exclusions, and ratio", async () => {
    pullRequestRows.push(
      prRow({ branchId: "branch-loc", number: 1, changedFiles: null }),
      prRow({
        branchId: "branch-visible",
        number: 2,
        additions: null,
        deletions: null,
        changedFiles: null,
        isCurrent: true,
      }),
      prRow({
        branchId: "branch-trusted",
        number: 3,
        additions: null,
        deletions: null,
        changedFiles: null,
        lastVerifiedAt: new Date("2026-08-26T11:00:00.000Z"),
      }),
      prRow({
        branchId: "branch-excluded",
        number: 4,
        isCurrent: true,
        pullRequestCount: 2,
      })
    );
    artifactLinkRows.push(
      linkRow("branch-loc", 1),
      linkRow("branch-visible", 2),
      linkRow("branch-trusted", 3),
      linkRow("branch-excluded", 99)
    );

    await reportGitHubDeliveryCoverageTick(
      tickInput({ writtenCount: 2, tier: GitHubRepoSyncTier.Installed })
    );

    expect(mocks.emitTelemetryMetric).toHaveBeenCalledWith({
      metric: FilterToken.GitHubDeliveryCoverageRepoTick,
      origin: "api",
      syncLane: "reconcile_pull_requests",
      organizationId: ORGANIZATION_ID,
      repositoryId: "repo-1",
      repositoryFullName: "acme/widgets",
      syncTier: GitHubRepoSyncTier.Installed,
      reconcileOutcome: SWEPT,
      coverageState: GitHubDeliveryCoverageState.Measured,
      value: 2 / 4,
      sessionLinkScanLimit: GITHUB_DELIVERY_COVERAGE_LINK_SCAN_LIMIT,
      scannedSessionLinkCount: 4,
      sessionLinkedPrCount: 4,
      locEnrichedPrCount: 1,
      visiblePromotedPrCount: 1,
      trustedVerifiedPrCount: 1,
      enrichedOrVisiblePrCount: 2,
      excludedCandidateCount: 1,
      writtenCount: 2,
      fetchFailureCount: 0,
      targetFetchFailureWriteCount: 0,
      budgetDeferralCount: 0,
      zeroWriteWithSessionLinkedTargets: false,
      actionableZeroWriteWithSessionLinkedTargets: false,
      timestamp: NOW.toISOString(),
    });
  });

  it("emits no-target state without a zero-valued ratio", async () => {
    await reportGitHubDeliveryCoverageTick(tickInput({ writtenCount: 0 }));

    expect(mocks.emitTelemetryMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        coverageState: GitHubDeliveryCoverageState.NoSessionLinkedTargets,
        sessionLinkedPrCount: 0,
        enrichedOrVisiblePrCount: 0,
        zeroWriteWithSessionLinkedTargets: false,
        actionableZeroWriteWithSessionLinkedTargets: false,
      })
    );
    expect(metricPayload()).not.toHaveProperty("value");
    expect(pullRequestFindMany).not.toHaveBeenCalled();
  });

  it("counts known session-linked targets even before a PR detail row exists", async () => {
    artifactLinkRows.push(linkRow("branch-missing", 47));

    await reportGitHubDeliveryCoverageTick(tickInput({ writtenCount: 0 }));

    expect(mocks.emitTelemetryMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        coverageState: GitHubDeliveryCoverageState.Measured,
        value: 0,
        sessionLinkedPrCount: 1,
        enrichedOrVisiblePrCount: 0,
        excludedCandidateCount: 0,
        zeroWriteWithSessionLinkedTargets: true,
        actionableZeroWriteWithSessionLinkedTargets: true,
      })
    );
  });

  it("counts session-linked PRs whose linked head branch belongs to a fork", async () => {
    artifactLinkRows.push(
      linkRow("fork-head-branch", 5, {
        branchRepositoryId: "fork-repo",
        branchRepositoryFullName: "contributor/widgets",
      })
    );
    pullRequestRows.push(
      prRow({ branchId: "fork-head-branch", number: 5, isCurrent: true })
    );

    await reportGitHubDeliveryCoverageTick(tickInput({ writtenCount: 1 }));

    expect(mocks.emitTelemetryMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        coverageState: GitHubDeliveryCoverageState.Measured,
        value: 1,
        sessionLinkedPrCount: 1,
        visiblePromotedPrCount: 1,
        enrichedOrVisiblePrCount: 1,
      })
    );
  });

  it("flags zero writes for a reclassified repo that has session-linked PR targets", async () => {
    pullRequestRows.push(prRow({ branchId: "branch-1", number: 1 }));
    artifactLinkRows.push(linkRow("branch-1", 1));

    await reportGitHubDeliveryCoverageTick(
      tickInput({
        status: ReconcileRepoStatus.Reclassified,
        writtenCount: 0,
      })
    );

    expect(mocks.emitTelemetryMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        coverageState: GitHubDeliveryCoverageState.Measured,
        sessionLinkedPrCount: 1,
        zeroWriteWithSessionLinkedTargets: true,
        actionableZeroWriteWithSessionLinkedTargets: true,
      })
    );
  });

  it("does not flag a healthy swept repo tick that has full coverage and zero writes", async () => {
    pullRequestRows.push(prRow({ branchId: "branch-1", number: 1 }));
    artifactLinkRows.push(linkRow("branch-1", 1));

    await reportGitHubDeliveryCoverageTick(tickInput({ writtenCount: 0 }));

    expect(mocks.emitTelemetryMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        coverageState: GitHubDeliveryCoverageState.Measured,
        value: 1,
        zeroWriteWithSessionLinkedTargets: true,
        actionableZeroWriteWithSessionLinkedTargets: false,
      })
    );
  });

  for (const { tick, overrides, enrichedOrVisible, actionable } of [
    {
      tick: "contention deferral with complete coverage",
      overrides: {
        status: ReconcileRepoStatus.Deferred,
        deferredReason: GitHubRepoSyncDeferralReason.Contention,
      },
      enrichedOrVisible: 2,
      actionable: false,
    },
    {
      tick: "contention deferral with incomplete coverage",
      overrides: {
        status: ReconcileRepoStatus.Deferred,
        deferredReason: GitHubRepoSyncDeferralReason.Contention,
      },
      enrichedOrVisible: 1,
      actionable: false,
    },
    {
      tick: "budget deferral with complete coverage",
      overrides: {
        status: ReconcileRepoStatus.Deferred,
        deferredReason: GitHubRepoSyncDeferralReason.Budget,
        budgetDeferralCount: 1,
      },
      enrichedOrVisible: 2,
      actionable: false,
    },
    {
      tick: "budget deferral with incomplete coverage",
      overrides: {
        status: ReconcileRepoStatus.Deferred,
        deferredReason: GitHubRepoSyncDeferralReason.Budget,
        budgetDeferralCount: 1,
      },
      enrichedOrVisible: 1,
      actionable: true,
    },
    {
      tick: "target fetch failure with complete coverage",
      overrides: { status: ReconcileRepoStatus.Failed, fetchFailureCount: 1 },
      enrichedOrVisible: 2,
      actionable: true,
    },
  ]) {
    it(`ISS-12033 classifies a zero-write ${tick} as actionable=${actionable}`, async () => {
      seedCoverage(2, enrichedOrVisible);

      await reportGitHubDeliveryCoverageTick(tickInput(overrides));

      expect(metricPayload()).toMatchObject({
        sessionLinkedPrCount: 2,
        enrichedOrVisiblePrCount: enrichedOrVisible,
        zeroWriteWithSessionLinkedTargets: true,
        actionableZeroWriteWithSessionLinkedTargets: actionable,
      });
    });
  }

  it("ISS-12033 replay: of the 48h prod actionable ticks, only budget deferrals with incomplete coverage and incomplete sweeps still page", async () => {
    const stillActionable: (typeof ISS_12033_LOGGED_ACTIONABLE_TICKS)[number][] =
      [];
    for (const tick of ISS_12033_LOGGED_ACTIONABLE_TICKS) {
      const [
        ,
        status,
        deferredReason,
        writtenCount,
        fetchFailureCount,
        sessionLinkedPrCount,
        enrichedOrVisiblePrCount,
      ] = tick;
      mocks.emitTelemetryMetric.mockClear();
      seedCoverage(sessionLinkedPrCount, enrichedOrVisiblePrCount);

      await reportGitHubDeliveryCoverageTick(
        tickInput({ status, deferredReason, writtenCount, fetchFailureCount })
      );

      expect(metricPayload()).toMatchObject({
        sessionLinkedPrCount,
        enrichedOrVisiblePrCount,
        zeroWriteWithSessionLinkedTargets: true,
      });
      if (metricPayload().actionableZeroWriteWithSessionLinkedTargets) {
        stillActionable.push(tick);
      }
    }

    expect(
      ISS_12033_LOGGED_ACTIONABLE_TICKS.filter(([org]) => org === "019d7347")
    ).toHaveLength(23);
    expect(stillActionable.filter(([org]) => org === "019d7347")).toEqual([
      ["019d7347", "deferred", "budget", 0, 0, 4, 1],
      ["019d7347", "deferred", "budget", 0, 0, 69, 62],
      ["019d7347", "deferred", "budget", 0, 0, 69, 67],
    ]);
    expect(
      ISS_12033_LOGGED_ACTIONABLE_TICKS.filter(([org]) => org === "other")
    ).toEqual(stillActionable.filter(([org]) => org === "other"));
    expect(stillActionable).toHaveLength(19);
  });

  it("emits unavailable state without counts or a zero-valued ratio when the coverage query fails", async () => {
    artifactLinkFindMany.mockRejectedValueOnce(new Error("db offline"));

    await reportGitHubDeliveryCoverageTick(
      tickInput({
        deferredReason: GitHubRepoSyncDeferralReason.Budget,
        budgetDeferralCount: 1,
        writtenCount: 0,
      })
    );

    expect(mocks.logWarn).toHaveBeenCalledWith(
      "[reconcile-pull-requests] delivery coverage telemetry unavailable",
      expect.objectContaining({
        organizationId: ORGANIZATION_ID,
        repositoryFullName: REPOSITORY_FULL_NAME,
      })
    );
    expect(mocks.emitTelemetryMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        coverageState: GitHubDeliveryCoverageState.Unavailable,
        unavailableReason:
          GitHubDeliveryCoverageUnavailableReason.CoverageQueryFailed,
        deferredReason: GitHubRepoSyncDeferralReason.Budget,
        budgetDeferralCount: 1,
        zeroWriteWithSessionLinkedTargets: false,
        actionableZeroWriteWithSessionLinkedTargets: false,
      })
    );
    const payload = metricPayload();
    expect(payload).not.toHaveProperty("value");
    expect(payload).not.toHaveProperty("sessionLinkedPrCount");
  });

  it("emits explicit unavailable state when the session-link scan exceeds its cap", async () => {
    // Synthesized rather than materialized: the stop is a runaway bound, so the
    // population that trips it is too large to hold in a fixture.
    let issued = 0;
    artifactLinkFindMany.mockImplementation((args: ArtifactLinkQuery) => {
      const page = Array.from({ length: args.take ?? 0 }, (_, index) =>
        linkRow(
          `branch-${String(issued + index).padStart(7, "0")}`,
          issued + index + 1
        )
      );
      issued += page.length;
      return Promise.resolve(page);
    });

    await reportGitHubDeliveryCoverageTick(tickInput({ writtenCount: 0 }));

    expect(mocks.logWarn).toHaveBeenCalledWith(
      "[reconcile-pull-requests] delivery coverage telemetry unavailable",
      expect.objectContaining({
        unavailableReason:
          GitHubDeliveryCoverageUnavailableReason.SessionLinkScanLimitExceeded,
        sessionLinkScanLimit: GITHUB_DELIVERY_COVERAGE_LINK_SCAN_LIMIT,
        scannedSessionLinkCount: GITHUB_DELIVERY_COVERAGE_LINK_SCAN_LIMIT + 1,
      })
    );
    expect(mocks.emitTelemetryMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        coverageState: GitHubDeliveryCoverageState.Unavailable,
        unavailableReason:
          GitHubDeliveryCoverageUnavailableReason.SessionLinkScanLimitExceeded,
        sessionLinkScanLimit: GITHUB_DELIVERY_COVERAGE_LINK_SCAN_LIMIT,
        scannedSessionLinkCount: GITHUB_DELIVERY_COVERAGE_LINK_SCAN_LIMIT + 1,
        zeroWriteWithSessionLinkedTargets: false,
        actionableZeroWriteWithSessionLinkedTargets: false,
      })
    );
    expect(
      artifactLinkFindMany.mock.calls.every(
        (call) =>
          ((call[0] as ArtifactLinkQuery).take ?? 0) <=
          GITHUB_DELIVERY_COVERAGE_LINK_SCAN_PAGE_SIZE
      )
    ).toBe(true);
    expect(metricPayload()).not.toHaveProperty("value");
    expect(metricPayload()).not.toHaveProperty("sessionLinkedPrCount");
    expect(pullRequestFindMany).not.toHaveBeenCalled();
  });

  it("measures a repo whose session-link population is past the retired 5,000 cap", async () => {
    // The population `closedloop-ai/closedloop-ai` measured on every tick from
    // 2026-08-26T23:45Z on (ISS-8263). Under the retired cap this repo emitted
    // `unavailable` forever and published no ratio at all.
    const measuredPrimaryRepoPopulation = 5001;
    artifactLinkRows = Array.from(
      { length: measuredPrimaryRepoPopulation },
      (_, index) =>
        linkRow(`branch-${String(index).padStart(5, "0")}`, index + 1)
    );

    await reportGitHubDeliveryCoverageTick(tickInput({ writtenCount: 0 }));

    expect(mocks.emitTelemetryMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        coverageState: GitHubDeliveryCoverageState.Measured,
        sessionLinkedPrCount: measuredPrimaryRepoPopulation,
        scannedSessionLinkCount: measuredPrimaryRepoPopulation,
        sessionLinkScanLimit: GITHUB_DELIVERY_COVERAGE_LINK_SCAN_LIMIT,
        value: 0,
      })
    );
    expect(metricPayload()).not.toHaveProperty("unavailableReason");
  });

  it("scopes installed repos by repositoryId", async () => {
    artifactLinkRows.push(linkRow("branch-1", 1));

    await readGitHubDeliveryCoverageCounts({
      organizationId: ORGANIZATION_ID,
      repositoryId: "repo-1",
      repositoryFullName: REPOSITORY_FULL_NAME,
    });

    const where = firstPrWhere();
    expect(where.repositoryId).toBe("repo-1");
    expect(where.repositoryFullName).toBeUndefined();
    expect(linkRepoScopeWhere()).toEqual(
      expect.objectContaining({
        OR: expect.arrayContaining([
          {
            metadata: {
              path: ["prRefs"],
              array_contains: [{ repositoryFullName: "acme/widgets" }],
            },
          },
          {
            target: {
              branch: {
                is: {
                  organizationId: ORGANIZATION_ID,
                  repositoryId: "repo-1",
                },
              },
            },
          },
        ]),
      })
    );
  });

  it("scopes repo-less tier-2 repos by normalized repositoryFullName", async () => {
    artifactLinkRows.push(linkRow("branch-1", 1));

    await readGitHubDeliveryCoverageCounts({
      organizationId: ORGANIZATION_ID,
      repositoryId: null,
      repositoryFullName: REPOSITORY_FULL_NAME,
    });

    expect(firstPrWhere()).toEqual(
      expect.objectContaining({
        organizationId: ORGANIZATION_ID,
        repositoryId: null,
        repositoryFullName: "acme/widgets",
      })
    );
    expect(linkRepoScopeWhere()).toEqual(
      expect.objectContaining({
        OR: expect.arrayContaining([
          {
            metadata: {
              path: ["prRefs"],
              array_contains: [{ repositoryFullName: "acme/widgets" }],
            },
          },
          {
            target: {
              branch: {
                is: {
                  organizationId: ORGANIZATION_ID,
                  repositoryFullName: "acme/widgets",
                },
              },
            },
          },
        ]),
      })
    );
    expect(
      extractBranchScope(linkRepoScopeWhere()).some(
        (scope) => scope.repositoryId !== undefined
      )
    ).toBe(false);
  });
});

function tickInput(
  overrides: Partial<GitHubDeliveryCoverageTickInput> = {}
): GitHubDeliveryCoverageTickInput {
  return {
    organizationId: ORGANIZATION_ID,
    repositoryId: "repo-1",
    repositoryFullName: REPOSITORY_FULL_NAME,
    status: SWEPT,
    writtenCount: 0,
    deferredReason: null,
    fetchFailureCount: 0,
    targetFetchFailureWriteCount: 0,
    budgetDeferralCount: 0,
    now: NOW,
    ...overrides,
  };
}

function prRow(input: {
  branchId: string;
  number: number | null;
  additions?: number | null;
  deletions?: number | null;
  changedFiles?: number | null;
  isCurrent?: boolean;
  lastVerifiedAt?: Date | null;
  pullRequestCount?: number;
}): PullRequestRow {
  return {
    id: `pr-${input.branchId}-${String(input.number)}`,
    number: input.number,
    additions: input.additions === undefined ? 10 : input.additions,
    deletions: input.deletions === undefined ? 2 : input.deletions,
    changedFiles: input.changedFiles === undefined ? 1 : input.changedFiles,
    isCurrent: input.isCurrent ?? false,
    lastVerifiedAt: input.lastVerifiedAt ?? null,
    repositoryFullName: "acme/widgets",
    repository: { fullName: "acme/widgets" },
    branchArtifact: {
      id: input.branchId,
      _count: { pullRequestDetails: input.pullRequestCount ?? 1 },
    },
  };
}

function linkRow(
  targetId: string,
  prNumber: number,
  overrides: Partial<
    Pick<
      ArtifactLinkRow,
      "branchRepositoryId" | "branchRepositoryFullName" | "id"
    >
  > & { metadataRepositoryFullName?: string } = {}
): ArtifactLinkRow {
  const metadataRepositoryFullName =
    overrides.metadataRepositoryFullName ?? "acme/widgets";
  return {
    id: overrides.id ?? `link-${targetId}`,
    targetId,
    branchRepositoryId:
      overrides.branchRepositoryId === undefined
        ? "repo-1"
        : overrides.branchRepositoryId,
    branchRepositoryFullName:
      overrides.branchRepositoryFullName ?? metadataRepositoryFullName,
    metadata: {
      linkKind: SessionArtifactLinkKind.SessionPr,
      prRefs: [
        {
          repositoryFullName: metadataRepositoryFullName,
          prNumber,
          relationTypes: [SessionPrRelationType.Created],
        },
      ],
    },
  };
}

function metricPayload(): Record<string, unknown> {
  return mocks.emitTelemetryMetric.mock.calls[0]?.[0] ?? {};
}

function firstPrWhere(): Record<string, unknown> {
  return pullRequestFindMany.mock.calls[0]?.[0]?.where ?? {};
}

function firstLinkWhere(): Record<string, unknown> {
  return artifactLinkFindMany.mock.calls[0]?.[0]?.where ?? {};
}

function pageArtifactLinks(args: ArtifactLinkQuery): ArtifactLinkRow[] {
  const rows = artifactLinkRows
    .filter((row) => artifactLinkMatchesWhere(row, args.where))
    .sort((left, right) => left.id.localeCompare(right.id));
  const cursorIndex =
    args.cursor === undefined
      ? -1
      : rows.findIndex((row) => row.id === args.cursor?.id);
  const start = (cursorIndex < 0 ? 0 : cursorIndex) + (args.skip ?? 0);
  const take = args.take ?? rows.length;
  return rows.slice(Math.max(0, start), Math.max(0, start) + take);
}

function artifactLinkMatchesWhere(
  row: ArtifactLinkRow,
  where: Record<string, unknown> | undefined
): boolean {
  if (!where) {
    return true;
  }
  const andScopes = Array.isArray(where.AND) ? where.AND : [];
  const scopedWhere = [where, ...andScopes]
    .map(asRecord)
    .filter((scope): scope is Record<string, unknown> => scope !== null);
  return scopedWhere.some((scope) => artifactLinkMatchesRepoScope(row, scope));
}

function artifactLinkMatchesRepoScope(
  row: ArtifactLinkRow,
  scope: Record<string, unknown>
): boolean {
  const orScopes = Array.isArray(scope.OR) ? scope.OR : [scope];
  return orScopes
    .map(asRecord)
    .filter(
      (candidate): candidate is Record<string, unknown> => candidate !== null
    )
    .some((candidate) => artifactLinkMatchesRepoCandidate(row, candidate));
}

function artifactLinkMatchesRepoCandidate(
  row: ArtifactLinkRow,
  candidate: Record<string, unknown>
): boolean {
  const metadata = asRecord(candidate.metadata);
  if (metadata && metadataRepoCandidateMatches(row, metadata)) {
    return true;
  }
  return extractBranchScope(candidate).some((scope) =>
    branchScopeMatches(row, scope)
  );
}

function metadataRepoCandidateMatches(
  row: ArtifactLinkRow,
  metadata: Record<string, unknown>
): boolean {
  if (metadata.path === undefined) {
    return false;
  }
  const path = Array.isArray(metadata.path) ? metadata.path.join(".") : "";
  if (path === "prRefs") {
    const expectedRepository = firstArrayContainsRepository(metadata);
    const prRefs = Array.isArray(row.metadata.prRefs)
      ? row.metadata.prRefs
      : [];
    return prRefs.some(
      (ref) => asRecord(ref)?.repositoryFullName === expectedRepository
    );
  }
  return (
    path === "repositoryFullName" &&
    row.metadata.repositoryFullName === metadata.equals
  );
}

function firstArrayContainsRepository(
  metadata: Record<string, unknown>
): unknown {
  if (!Array.isArray(metadata.array_contains)) {
    return undefined;
  }
  return asRecord(metadata.array_contains[0])?.repositoryFullName;
}

function linkRepoScopeWhere(): Record<string, unknown> {
  const andScopes = firstLinkWhere().AND;
  if (!Array.isArray(andScopes)) {
    return {};
  }
  return asRecord(andScopes[1]) ?? {};
}

function extractBranchScope(
  scope: Record<string, unknown>
): Record<string, unknown>[] {
  const orScopes = Array.isArray(scope.OR) ? scope.OR : [scope];
  return orScopes
    .map(asRecord)
    .map((candidate) => {
      const target = asRecord(candidate?.target);
      const branch = asRecord(target?.branch);
      return asRecord(branch?.is);
    })
    .filter(
      (candidate): candidate is Record<string, unknown> => candidate !== null
    );
}

function branchScopeMatches(
  row: ArtifactLinkRow,
  scope: Record<string, unknown>
): boolean {
  if (scope.repositoryId !== undefined) {
    return row.branchRepositoryId === scope.repositoryId;
  }
  return row.branchRepositoryFullName === scope.repositoryFullName;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function seedCoverage(
  sessionLinkedPrCount: number,
  enrichedOrVisiblePrCount: number
): void {
  artifactLinkRows = [];
  pullRequestRows = [];
  for (let prNumber = 1; prNumber <= sessionLinkedPrCount; prNumber += 1) {
    const branchId = `branch-${String(prNumber).padStart(5, "0")}`;
    artifactLinkRows.push(linkRow(branchId, prNumber));
    if (prNumber <= enrichedOrVisiblePrCount) {
      pullRequestRows.push(prRow({ branchId, number: prNumber }));
    }
  }
}
