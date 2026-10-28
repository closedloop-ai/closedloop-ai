import { BranchPushSource } from "@repo/api/src/types/artifact";
import { type BranchKpi, BranchStatus } from "@repo/api/src/types/branch";
import {
  BranchActivityAtomVersion,
  BranchActivityAttributionKind,
  BranchActivityEvidenceCompleteness,
  BranchActivitySource,
} from "@repo/api/src/types/branch-activity";
import {
  type BranchListMetricBundle,
  BranchMetricAvailability,
} from "@repo/api/src/types/branch-metrics";
import { ArtifactType, type TransactionClient, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { log } from "@repo/observability/log";
import { afterEach, describe, expect, it, vi } from "vitest";
import { persistedGitHubRepositoryAuthority } from "@/__tests__/fixtures/repository-default-authority";
import {
  createCommittedTestOrganizationTracker,
  createTestUser,
  linkValidSessionToBranch,
} from "@/__tests__/utils/db-helpers";
import { getPrismaDriverAdapterSqlState } from "@/lib/db-utils";
import { BranchListEnrichmentRead } from "./branch-list-enrichment";
import { branchReadService } from "./branch-read-service";

/**
 * ISS-10804: both analytics reads run on ONE RepeatableRead snapshot. When
 * PostgreSQL aborts it on the push-LOC statement, every sibling read in it is
 * refused (25P02), so the read must be retried on a fresh snapshot without it.
 *
 * The abort is PostgreSQL's own: while armed, every push-LOC statement is
 * replaced on the SAME transaction by one that raises SQLSTATE 57014 (what a
 * `statement_timeout` cancellation raises). Unlike a 1ms deadline it cannot
 * finish in time by luck, and unlike `SET LOCAL` it cannot leak onto a sibling
 * statement. Aborting EVERY push-LOC statement also pins that the recovery
 * skips the read rather than re-issuing it: a retry that read again would
 * abort again.
 */

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;
const committedOrganizations = createCommittedTestOrganizationTracker();

const REPOSITORY = "acme/widgets";
const BRANCH_NAME = "feat/push-loc-abort";
const FIRST_PUSHED_AT = new Date("2026-07-01T00:00:00.000Z");
const SESSION_COST_USD = 2;
const RECOVERED_EVENT =
  "[branches-list] enrichment failure aborted the snapshot; retried without it";

/** Every LOC per $ card divides pushed LOC by AI spend (ISS-12346). */
const PUSH_LOC_RATIOS = [
  "locPerDollar",
  "canonicalLocPerDollar",
  "pushedLocPerDollar",
] as const;

const pushLocAbort = { armed: false, fired: 0 };

afterEach(async () => {
  pushLocAbort.armed = false;
  pushLocAbort.fired = 0;
  vi.restoreAllMocks();
  await committedOrganizations.cleanup();
});

type AnalyticsRead = {
  canonicalMetrics?: BranchListMetricBundle;
  /** Fed by the population read that shares the snapshot with push LOC. */
  totalSpendUsd?: BranchKpi;
};

type AnalyticsEntryPoint = {
  name: string;
  /** The population read's spend, where the entry point publishes it. */
  expectedSpendUsd?: number;
  read: (organizationId: string, branchId: string) => Promise<AnalyticsRead>;
};

const ENTRY_POINTS: AnalyticsEntryPoint[] = [
  {
    name: "getBranchAnalytics",
    expectedSpendUsd: SESSION_COST_USD,
    read: async (organizationId) => {
      const analytics = await branchReadService.getBranchAnalytics(
        organizationId,
        { limit: 50, offset: 0 }
      );
      return {
        canonicalMetrics: analytics.canonicalMetrics,
        totalSpendUsd: analytics.totalSpendUsd,
      };
    },
  },
  {
    name: "getBranchCohortAnalytics",
    read: async (organizationId, branchId) => ({
      canonicalMetrics: (
        await branchReadService.getBranchCohortAnalytics(organizationId, {
          branchIds: [branchId],
        })
      ).canonicalMetrics,
    }),
  },
];

describeIfDb(
  "Branch analytics survive a push-LOC snapshot abort (ISS-10804)",
  () => {
    // Positive control for the harness: its push-LOC abort is PostgreSQL's, so
    // the next read on that snapshot is refused with 25P02, in the envelope the
    // production code reads it through.
    it("aborts the snapshot the push-LOC statement runs on", async () => {
      const nextRead = await withDb.tx(async (tx) => {
        await expect(abortSnapshot(tx)).rejects.toThrow("57014");
        return await tx.branchActivityAtom.findMany({ take: 1 }).then(
          () => null,
          (error: unknown) => error
        );
      });

      expect(getPrismaDriverAdapterSqlState(nextRead)).toBe("25P02");
    });

    it.each(ENTRY_POINTS)(
      "$name degrades push LOC and keeps its sibling metrics",
      async ({ read, expectedSpendUsd }) => {
        const organizationId = await committedOrganizations.create();
        const branchId = await seedPushedBranch(organizationId);
        abortPushLocStatementsWhenArmed();
        const errorLog = vi.spyOn(log, "error");

        const healthy = await read(organizationId, branchId);
        pushLocAbort.armed = true;
        const degraded = await read(organizationId, branchId);

        // Control: the captured push is what the healthy read publishes, over
        // the session's real spend.
        expect(healthy.canonicalMetrics?.totalLocPushed?.current).toEqual({
          state: BranchMetricAvailability.Complete,
          value: 17,
        });
        for (const ratio of PUSH_LOC_RATIOS) {
          expect(healthy.canonicalMetrics?.[ratio]?.current).toEqual({
            state: BranchMetricAvailability.Complete,
            value: 17 / SESSION_COST_USD,
          });
        }
        expect(healthy.totalSpendUsd?.value).toBe(expectedSpendUsd);
        // One abort: the retry skipped the read instead of re-issuing it.
        expect(pushLocAbort.fired).toBe(1);
        const recovered = errorLog.mock.calls.filter(
          ([message]) => message === RECOVERED_EVENT
        );
        expect(recovered).toHaveLength(1);
        expect(recovered[0]?.[1]).toMatchObject({
          organizationId,
          unavailableReads: [BranchListEnrichmentRead.PushLoc],
        });
        // The two push-LOC metrics have no answer and say so through their
        // shipped state, rather than publishing a figure built on nothing.
        expect(degraded.canonicalMetrics?.totalLocPushed?.current).toEqual({
          state: BranchMetricAvailability.Unavailable,
          value: null,
        });
        for (const ratio of PUSH_LOC_RATIOS) {
          expect(degraded.canonicalMetrics?.[ratio]?.current).toEqual({
            state: BranchMetricAvailability.Unavailable,
            value: null,
          });
        }
        // Everything else renders exactly as the healthy read did.
        expect(withoutPushLoc(degraded.canonicalMetrics)).toEqual(
          withoutPushLoc(healthy.canonicalMetrics)
        );
        expect(degraded.totalSpendUsd).toEqual(healthy.totalSpendUsd);
      }
    );
  }
);

/** The bundle minus the push-LOC metrics and the read's own evaluation instant. */
function withoutPushLoc(bundle: BranchListMetricBundle | undefined) {
  if (!bundle) {
    return bundle;
  }
  const {
    totalLocPushed: _totalLocPushed,
    canonicalLocPerDollar: _canonicalLocPerDollar,
    locPerDollar: _locPerDollar,
    pushedLocPerDollar: _pushedLocPerDollar,
    window,
    ...rest
  } = bundle;
  return { ...rest, window: { ...window, endAt: undefined } };
}

/**
 * Hand every read snapshot a client whose armed push-LOC statement PostgreSQL
 * aborts. Every other call reaches the real transaction.
 */
function abortPushLocStatementsWhenArmed(): void {
  const openTransaction = withDb.tx;
  vi.spyOn(withDb, "tx").mockImplementation((fn, options) =>
    openTransaction((tx) => fn(withPushLocAbort(tx)), options)
  );
}

function withPushLocAbort(tx: TransactionClient): TransactionClient {
  return new Proxy(tx, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property !== "branchActivityAtom") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return new Proxy(value, {
        get(delegate, key, delegateReceiver) {
          if (key !== "findMany") {
            return Reflect.get(delegate, key, delegateReceiver);
          }
          return (args: { where?: { source?: string } }) =>
            pushLocAbort.armed &&
            args?.where?.source === BranchActivitySource.PushLoc
              ? abortSnapshot(target)
              : target.branchActivityAtom.findMany(args);
        },
      });
    },
  });
}

function abortSnapshot(tx: TransactionClient): Promise<number> {
  pushLocAbort.fired += 1;
  return tx.$executeRaw`DO $$ BEGIN RAISE EXCEPTION 'canceling statement due to statement timeout' USING ERRCODE = 'query_canceled'; END $$`;
}

/**
 * One Product-visible branch (Wrote session + verified push) carrying one
 * captured push of 13 + 4 lines that post-dates nothing it should disclose.
 */
async function seedPushedBranch(organizationId: string): Promise<string> {
  const user = await createTestUser(organizationId);
  const branchId = await withDb(async (db) => {
    await db.publicRepository.create({
      data: {
        organizationId,
        ...persistedGitHubRepositoryAuthority({
          githubRepoId: `public-${organizationId}`,
          fullName: REPOSITORY,
        }),
        owner: "acme",
        name: "widgets",
        htmlUrl: `https://github.com/${REPOSITORY}`,
      },
      select: { id: true },
    });
    const artifact = await db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.BRANCH,
        name: BRANCH_NAME,
        status: BranchStatus.Open,
      },
      select: { id: true },
    });
    await db.branchDetail.create({
      data: {
        artifactId: artifact.id,
        organizationId,
        repositoryFullName: REPOSITORY,
        branchName: BRANCH_NAME,
        firstPushedAt: FIRST_PUSHED_AT,
        pushSource: BranchPushSource.Session,
        lastActivityAt: FIRST_PUSHED_AT,
      },
      select: { artifactId: true },
    });
    await db.branchActivityAtom.create({
      data: {
        version: BranchActivityAtomVersion.V1,
        organizationId,
        branchArtifactId: artifact.id,
        source: BranchActivitySource.PushLoc,
        sourceEventId: "delivery-1",
        occurredAt: FIRST_PUSHED_AT,
        attributionKind: BranchActivityAttributionKind.Branch,
        completeness: BranchActivityEvidenceCompleteness.Complete,
        beforeSha: "b".repeat(40),
        afterSha: "c".repeat(40),
        linesAdded: 13,
        linesRemoved: 4,
      },
      select: { id: true },
    });
    return artifact.id;
  });
  const sessionId = await linkValidSessionToBranch({
    organizationId,
    userId: user.id,
    branchArtifactId: branchId,
    label: BRANCH_NAME,
    sessionTimestamp: FIRST_PUSHED_AT,
    cost: { estimatedCost: SESSION_COST_USD },
  });
  await withDb((db) =>
    db.agentSessionTokenEvent.create({
      data: {
        agentSessionId: sessionId,
        externalEventId: "spend-1",
        model: "claude",
        estimatedCost: SESSION_COST_USD,
        eventCreatedAt: FIRST_PUSHED_AT,
      },
      select: { id: true },
    })
  );
  return branchId;
}
