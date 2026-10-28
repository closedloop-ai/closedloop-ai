import { randomUUID } from "node:crypto";
import { AgentSessionUsageAttribution } from "@repo/api/src/types/agent-session-usage-attribution";
import {
  AgentSessionComparisonMetric,
  AgentSessionComparisonMode,
} from "@repo/api/src/types/agent-session-usage-comparison";
import { LinkType } from "@repo/api/src/types/artifact";
import {
  BranchParticipationKind,
  BranchStatus,
} from "@repo/api/src/types/branch";
import { DocumentStatus } from "@repo/api/src/types/document";
import { GitHubPRState } from "@repo/api/src/types/github";
import { LocPerDollarCoverageState } from "@repo/api/src/types/loc-per-dollar-coverage";
import { SessionPrPurpose } from "@repo/api/src/types/session-artifact-link";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { ArtifactType, type Prisma, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { buildUsageSummary } from "./usage-summary";

/**
 * ISS-11895 — `/agent-sessions/usage` against real Postgres, over link
 * metadata in the shapes the branch writer persists.
 *
 * 1. The delivery, coverage and attribution figures for a fixed fixture are
 *    pinned as literals. The fix behind this ticket changed how that metadata
 *    is parsed, not what it parses to, so these numbers must not move.
 * 2. The rows the request reads, and the summary it publishes, do not change
 *    with the org's history: sessions and merged PRs outside both the selected
 *    and the prior window add no returned row to any read (the ticket's "no
 *    read that scales with total session count").
 */

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const WINDOW_START = "2026-09-03T00:00:00.000Z";
const WINDOW_END = "2026-10-02T23:59:59.999Z";
const IN_WINDOW = new Date("2026-09-20T09:00:00.000Z");
const MERGED_IN_WINDOW = new Date("2026-09-21T12:00:00.000Z");
const MERGED_IN_PRIOR_WINDOW = new Date("2026-08-20T12:00:00.000Z");
const HISTORY = new Date("2026-03-10T09:00:00.000Z");
const MERGED_IN_HISTORY = new Date("2026-03-11T12:00:00.000Z");
const REPO = "acme/web";
const HISTORY_SESSIONS = 25;

/** A session→PR link as written with branch evidence: relation, participation and lifecycle events. */
function branchWritePrLink(prNumber: number): Prisma.InputJsonObject {
  return {
    linkKind: "session_pr",
    linkKinds: ["session_branch", "session_pr"],
    relationTypes: ["CREATED"],
    prRefs: [
      {
        repositoryFullName: REPO,
        prNumber,
        relationTypes: ["CREATED"],
        method: "gh_pr_create",
      },
    ],
    confidence: 1,
    repositoryFullName: REPO,
    prNumber,
    method: "git_push",
    relation: "output",
    branchParticipation: "wrote",
    branchLifecycleEvents: [
      { kind: "branch_write", observedAt: "2026-09-20T10:05:00.000Z" },
    ],
  };
}

/** A session→branch link naming no PR — admitted only through branch evidence (ISS-7905). */
function branchOnlyLink(branchParticipation: string): Prisma.InputJsonObject {
  return {
    linkKind: "session_branch",
    linkKinds: ["session_branch"],
    method: "git_push",
    relation: "output",
    branchParticipation,
  };
}

/** A session→PR link with no branch evidence: no relation, no participation. */
function referencedPrLink(
  prNumber: number,
  linkKinds: string[] = ["session_pr"]
): Prisma.InputJsonObject {
  return {
    linkKind: "session_pr",
    linkKinds,
    relationTypes: ["REFERENCED"],
    prRefs: [
      {
        repositoryFullName: REPO,
        prNumber,
        relationTypes: ["REFERENCED"],
        method: "pr_url",
      },
    ],
    confidence: 1,
    repositoryFullName: REPO,
    prNumber,
  };
}

describeIfDb("usage summary over persisted link shapes (ISS-11895)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("publishes the pinned delivery, coverage and attribution figures", async () => {
    await autoRollbackTransaction(async () => {
      const fixture = await seedFixture();

      const summary = await buildUsageSummary(usageInput(fixture));

      expect({
        totalSessions: summary.totalSessions,
        totalEstimatedCost: summary.totalEstimatedCost,
        mergedPrCount: summary.mergedPrCount,
        medianPrSize: summary.medianPrSize,
        mergedLocPerDollar: summary.mergedLocPerDollar,
        mergedLocPerDollarCoverage: summary.mergedLocPerDollarCoverage,
        comparison: summary.comparison,
      }).toEqual({
        totalSessions: 5,
        totalEstimatedCost: 27,
        mergedPrCount: 3,
        medianPrSize: 60,
        mergedLocPerDollar: 480 / 27,
        mergedLocPerDollarCoverage: {
          state: LocPerDollarCoverageState.Complete,
          numeratorSessionCount: 4,
          denominatorSessionCount: 5,
          excludedSessionCount: 0,
          costBasisCoveredUsd: 27,
          costBasisExcludedUsd: 0,
        },
        comparison: {
          priorStartDate: "2026-08-04T00:00:00.000Z",
          priorEndDate: "2026-09-02T23:59:59.999Z",
          deltas: { [AgentSessionComparisonMetric.PrsShipped]: 200 },
        },
      });
      expect(
        summary.byPr?.map((pr) => [pr.prNumber, pr.purpose, pr.sessionCount])
      ).toEqual([
        [103, SessionPrPurpose.Authored, 1],
        [101, SessionPrPurpose.Authored, 2],
        [102, SessionPrPurpose.Referenced, 1],
      ]);
    });
  });

  it("reads the same rows and publishes the same summary after out-of-window history is added", async () => {
    await autoRollbackTransaction(async () => {
      const fixture = await seedFixture();
      const before = await countRowsRead(() =>
        buildUsageSummary(usageInput(fixture))
      );

      await seedHistory(fixture);
      const after = await countRowsRead(() =>
        buildUsageSummary(usageInput(fixture))
      );

      expect(before.counts.rows).toBeGreaterThan(0);
      expect(after.counts).toEqual(before.counts);
      expect(after.result).toEqual(before.result);
    });
  });

  it("hands the Pensero reader the byBranch set whether or not the lenses are published (ISS-12284)", async () => {
    await autoRollbackTransaction(async () => {
      const fixture = await seedFixture();
      await seedHistory(fixture);
      await seedLinksTheLensDrops(fixture);
      const included = vi.fn().mockResolvedValue(1.5);
      const omitted = vi.fn().mockResolvedValue(1.5);

      const full = await buildUsageSummary(usageInput(fixture), included);
      const listing = await buildUsageSummary(
        {
          ...usageInput(fixture),
          filters: {
            ...usageInput(fixture).filters,
            attribution: AgentSessionUsageAttribution.Omit,
          },
        },
        omitted
      );

      const lensBranchIds = (full.byBranch ?? [])
        .map((branch) => branch.branchArtifactId)
        .sort();
      expect(lensBranchIds.length).toBeGreaterThan(0);
      expect([...included.mock.calls[0][0]].sort()).toEqual(lensBranchIds);
      expect([...omitted.mock.calls[0][0]].sort()).toEqual(lensBranchIds);
      expect(omitted.mock.calls[0][1]).toBe(included.mock.calls[0][1]);
      const { byBranch: _byBranch, byPr: _byPr, ...withoutLenses } = full;
      expect(JSON.stringify(listing)).toBe(JSON.stringify(withoutLenses));
    });
  });
});

/**
 * Links the lens keeps nothing for: from an in-window session to a target with
 * no branch row, and to a branch artifact in another org reached by a link
 * stamped with this org; from another org's session to this org's branch by a
 * link stamped with this org; and a non-Metric (`PRODUCES`) link to this org's
 * branch. The branch-set read must drop all four, as the lens does (ISS-12284).
 */
async function seedLinksTheLensDrops(fixture: Fixture): Promise<void> {
  const session = await seedSession(fixture, {
    at: IN_WINDOW,
    estimatedCost: 5,
  });
  const document = await withDb((db) =>
    db.artifact.create({
      data: {
        organizationId: fixture.organizationId,
        type: ArtifactType.DOCUMENT,
        status: DocumentStatus.Draft,
        name: `doc-${randomUUID().slice(0, 8)}`,
      },
      select: { id: true },
    })
  );
  await seedLink(
    fixture,
    session,
    document.id,
    branchWritePrLink(106),
    BranchParticipationKind.Wrote
  );
  const foreignOrganizationId = await createTestOrganization();
  const foreignBranch = await seedMergedPrBranch(
    { ...fixture, organizationId: foreignOrganizationId },
    107,
    MERGED_IN_WINDOW,
    70,
    0
  );
  await seedLink(
    fixture,
    session,
    foreignBranch,
    branchWritePrLink(107),
    BranchParticipationKind.Wrote
  );

  const { id: foreignUserId } = await createTestUser(foreignOrganizationId);
  const { id: foreignComputeTargetId } = await withDb((db) =>
    db.computeTarget.create({
      data: {
        organizationId: foreignOrganizationId,
        userId: foreignUserId,
        machineName: "m",
        platform: "darwin",
      },
      select: { id: true },
    })
  );
  const foreignSession = await seedSession(
    {
      organizationId: foreignOrganizationId,
      userId: foreignUserId,
      computeTargetId: foreignComputeTargetId,
    },
    { at: IN_WINDOW, estimatedCost: 5 }
  );
  const reachedFromForeignSession = await seedMergedPrBranch(
    fixture,
    108,
    MERGED_IN_WINDOW,
    80,
    0
  );
  await seedLink(
    fixture,
    foreignSession,
    reachedFromForeignSession,
    branchWritePrLink(108),
    BranchParticipationKind.Wrote
  );

  const reachedByNonMetricLink = await seedMergedPrBranch(
    fixture,
    109,
    MERGED_IN_WINDOW,
    90,
    0
  );
  await seedLink(
    fixture,
    session,
    reachedByNonMetricLink,
    branchWritePrLink(109),
    BranchParticipationKind.Wrote,
    LinkType.Produces
  );
}

function usageInput(fixture: Fixture) {
  return {
    organizationId: fixture.organizationId,
    filters: {
      startDate: WINDOW_START,
      endDate: WINDOW_END,
      comparison: AgentSessionComparisonMode.Prior,
      attribution: AgentSessionUsageAttribution.Include,
    },
  };
}

type Fixture = {
  organizationId: string;
  userId: string;
  computeTargetId: string;
};

/**
 * Five in-window sessions. In the window: #101 (400 lines) and #102 (60) by PR
 * identity, #104 (20) by a writing branch link; #105's only link reviewed its
 * branch, so it is not admitted. #103 merged in the prior window.
 */
async function seedFixture(): Promise<Fixture> {
  const organizationId = await createTestOrganization();
  const { id: userId } = await createTestUser(organizationId);
  const { id: computeTargetId } = await withDb((db) =>
    db.computeTarget.create({
      data: { organizationId, userId, machineName: "m", platform: "darwin" },
      select: { id: true },
    })
  );
  const fixture = { organizationId, userId, computeTargetId };
  const pr101 = await seedMergedPrBranch(
    fixture,
    101,
    MERGED_IN_WINDOW,
    300,
    100
  );
  const pr102 = await seedMergedPrBranch(
    fixture,
    102,
    MERGED_IN_WINDOW,
    50,
    10
  );
  const pr103 = await seedMergedPrBranch(
    fixture,
    103,
    MERGED_IN_PRIOR_WINDOW,
    5,
    5
  );
  const pr104 = await seedMergedPrBranch(fixture, 104, MERGED_IN_WINDOW, 20, 0);
  const pr105 = await seedMergedPrBranch(fixture, 105, MERGED_IN_WINDOW, 30, 0);
  const [s1, s2, s3, s4, s5] = await Promise.all(
    [2, 3, 4, 7, 11].map((cost) =>
      seedSession(fixture, { at: IN_WINDOW, estimatedCost: cost })
    )
  );
  await seedLink(fixture, s1, pr101, branchWritePrLink(101), "wrote");
  await seedLink(fixture, s2, pr101, referencedPrLink(101), null);
  await seedLink(
    fixture,
    s3,
    pr102,
    referencedPrLink(102, ["session_pr", "future_kind"]),
    null
  );
  await seedLink(fixture, s4, pr103, branchWritePrLink(103), "wrote");
  await seedLink(fixture, s5, pr104, branchOnlyLink("wrote"), null);
  await seedLink(fixture, s5, pr105, branchOnlyLink("reviewed"), null);
  return fixture;
}

/**
 * Old sessions on old merged PRs — outside both the selected and the prior
 * window. Each has its own owner, repository, harness and model, so a facet
 * read that lost its date bound would return extra group rows, not just
 * different sums.
 */
async function seedHistory(fixture: Fixture): Promise<void> {
  for (let index = 0; index < HISTORY_SESSIONS; index++) {
    const prNumber = 900 + index;
    const { id: userId } = await createTestUser(fixture.organizationId);
    const branch = await seedMergedPrBranch(
      fixture,
      prNumber,
      MERGED_IN_HISTORY,
      10,
      1
    );
    const session = await seedSession(fixture, {
      at: HISTORY,
      estimatedCost: 1,
      assigneeId: userId,
      repositoryFullName: `acme/history-${index}`,
      harness: `history-harness-${index}`,
      model: `history-model-${index}`,
    });
    await seedLink(
      fixture,
      session,
      branch,
      branchWritePrLink(prNumber),
      "wrote"
    );
  }
}

async function seedSession(
  fixture: Fixture,
  session: {
    at: Date;
    estimatedCost: number;
    assigneeId?: string;
    repositoryFullName?: string;
    harness?: string;
    model?: string;
  }
): Promise<string> {
  const { organizationId, computeTargetId } = fixture;
  const { at, estimatedCost } = session;
  return await withDb(async (db) => {
    const artifact = await db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.SESSION,
        name: `session-${randomUUID().slice(0, 8)}`,
        status: SESSION_STATUS.ACTIVE,
        assigneeId: session.assigneeId ?? null,
      },
      select: { id: true },
    });
    await db.sessionDetail.create({
      data: {
        artifactId: artifact.id,
        computeTargetId,
        externalSessionId: `ext-${artifact.id}`,
        harness: session.harness ?? "claude",
        repositoryFullName: session.repositoryFullName ?? null,
        model: session.model ?? null,
        sessionStartedAt: at,
        sessionUpdatedAt: at,
        lastActivityAt: at,
        estimatedCost,
        billingMode: "api",
        dataRevision: 1,
      },
      select: { artifactId: true },
    });
    return artifact.id;
  });
}

async function seedMergedPrBranch(
  fixture: Fixture,
  prNumber: number,
  mergedAt: Date,
  additions: number,
  deletions: number
): Promise<string> {
  const { organizationId } = fixture;
  const branchName = `feature-${prNumber}`;
  return await withDb(async (db) => {
    const branch = await db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.BRANCH,
        name: branchName,
        status: BranchStatus.Open,
      },
      select: { id: true },
    });
    await db.branchDetail.create({
      data: {
        artifactId: branch.id,
        organizationId,
        repositoryFullName: REPO,
        branchName,
      },
      select: { artifactId: true },
    });
    const pr = await db.pullRequestDetail.create({
      data: {
        organizationId,
        branchArtifactId: branch.id,
        number: prNumber,
        title: `PR ${prNumber}`,
        repositoryFullName: REPO,
        prState: GitHubPRState.Merged,
        mergedAt,
        additions,
        deletions,
        isCurrent: true,
        lastVerifiedAt: mergedAt,
      },
      select: { id: true },
    });
    await db.branchDetail.update({
      where: { artifactId: branch.id },
      data: { currentPullRequestDetailId: pr.id },
      select: { artifactId: true },
    });
    return branch.id;
  });
}

async function seedLink(
  fixture: Fixture,
  sourceId: string,
  targetId: string,
  metadata: Prisma.InputJsonObject,
  branchParticipation: string | null,
  linkType: LinkType = LinkType.RelatesTo
): Promise<void> {
  const { organizationId } = fixture;
  await withDb((db) =>
    db.artifactLink.create({
      data: {
        organizationId,
        sourceId,
        targetId,
        linkType,
        branchParticipation,
        metadata,
      },
    })
  );
}

/**
 * Statements issued and rows returned while `run` executes, read off the pg
 * driver. Counts only promise-form `Client.query`, which is every statement on
 * the `autoRollbackTransaction` client these cases run inside.
 */
async function countRowsRead<T>(
  run: () => Promise<T>
): Promise<{ counts: { statements: number; rows: number }; result: T }> {
  const counts = { statements: 0, rows: 0 };
  const query = pg.Client.prototype.query;
  const spy = vi
    .spyOn(pg.Client.prototype, "query")
    .mockImplementation(function (this: pg.Client, ...args: unknown[]) {
      const result = (query as (...a: unknown[]) => unknown).apply(this, args);
      if (result instanceof Promise) {
        result.then(
          (res: pg.QueryResult) => {
            counts.statements += 1;
            counts.rows += res.rows.length;
          },
          () => undefined
        );
      }
      return result;
    } as typeof query);
  try {
    return { counts, result: await run() };
  } finally {
    spy.mockRestore();
  }
}
