import { insightsPeriodDays } from "@closedloop-ai/loops-api/insights";
import { stableUtcListWindow } from "@closedloop-ai/loops-api/stable-utc-window";
import { BranchPushSource } from "@repo/api/src/types/artifact";
import { BranchStatus } from "@repo/api/src/types/branch";
import {
  BranchActivityAtomVersion,
  BranchActivityAttributionKind,
  BranchActivityEvidenceCompleteness,
  BranchActivitySource,
} from "@repo/api/src/types/branch-activity";
import {
  BRANCH_LIST_SERVER_PAGE_SIZE,
  BranchListPageMode,
} from "@repo/api/src/types/branch-list-contract";
import { InsightsPeriod, InsightsScope } from "@repo/api/src/types/insights";
import { ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { UNCOMPUTED_SESSION_LAST_ACTIVITY_MS } from "@repo/lib/branches/branch-last-active";
import { afterEach, describe, expect, it } from "vitest";
import { persistedGitHubRepositoryAuthority } from "@/__tests__/fixtures/repository-default-authority";
import {
  createCommittedTestOrganizationTracker,
  createTestUser,
  linkValidSessionToBranch,
} from "@/__tests__/utils/db-helpers";
import { branchReadService } from "@/app/branches/branch-read-service";
import { insightsService } from "@/app/insights/service";

/**
 * ISS-11915 (operator ruling, Marisol Ashgrove 2026-10-08): "the Dashboard for 7
 * days has the same # of branches as the branches listing page for 7 days."
 *
 * One seeded org, read through the production entry points of both surfaces:
 * the Branches list (`branchReadService.listBranches`, legacy and server page
 * modes) over the window the list sends for the range, and the Dashboard
 * (`insightsService.getDelivery`) for the matching period. The corpus holds
 * every case the two used to disagree on: a Last-active tie, a branch with no
 * computed activity, a future Last active, a session-only branch on each side
 * of the window, a branch whose only activity is outside the window, and a
 * branch the list's Product eligibility excludes.
 */

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;
const committedOrganizations = createCommittedTestOrganizationTracker();

afterEach(() => committedOrganizations.cleanup());

const REPOSITORY = "acme/parity";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

type SeedBranch = {
  branchName: string;
  /** Offset from NOW of the branch's one activity atom; omitted = no atom. */
  atomOffsetMs?: number;
  /** Linked Session last activity; `null` = the uncomputed epoch default. */
  sessionLastActivityOffsetMs?: number | null;
  /** No Wrote session link, so the list's Product eligibility excludes it. */
  unlinked?: boolean;
};

const SEED: SeedBranch[] = [
  // A tie on the same atom instant. Each also links a session NEWER than the
  // atom, which the shared definition must ignore while an atom exists.
  { branchName: "tie-a", atomOffsetMs: -DAY, sessionLastActivityOffsetMs: 0 },
  { branchName: "tie-b", atomOffsetMs: -DAY, sessionLastActivityOffsetMs: 0 },
  { branchName: "stale", atomOffsetMs: -20 * DAY },
  { branchName: "future", atomOffsetMs: 2 * HOUR },
  { branchName: "no-activity", sessionLastActivityOffsetMs: null },
  { branchName: "session-only", sessionLastActivityOffsetMs: -2 * DAY },
  { branchName: "session-only-stale", sessionLastActivityOffsetMs: -30 * DAY },
  { branchName: "unlinked", atomOffsetMs: -DAY, unlinked: true },
];

/** The list's 7-day population: in-window, tied, unknown and future rows. */
const WEEK_POPULATION = [
  "future",
  "no-activity",
  "session-only",
  "tie-a",
  "tie-b",
];
/** Every Product-eligible branch: `unlinked` never reaches either surface. */
const ALL_TIME_POPULATION = [
  ...WEEK_POPULATION,
  "session-only-stale",
  "stale",
].sort();

describeIfDb(
  "Dashboard and Branches list branch population (ISS-11915)",
  () => {
    it("selects the same branches for the same period on both surfaces", async () => {
      await committedOrganizations.run(async () => {
        const organizationId = await committedOrganizations.create();
        const now = new Date();
        await seedCorpus(organizationId, now);
        const ctx = {
          organizationId,
          userId: (await createTestUser(organizationId)).id,
          scope: InsightsScope.Org,
        };

        for (const [period, expected] of [
          [InsightsPeriod.Week, WEEK_POPULATION],
          [InsightsPeriod.All, ALL_TIME_POPULATION],
        ] as const) {
          const window = stableUtcListWindow(insightsPeriodDays(period), now);
          const bounds = {
            ...(window.startDate
              ? { startDate: new Date(window.startDate) }
              : {}),
            ...(window.endDate ? { endDate: new Date(window.endDate) } : {}),
          };
          const legacy = await branchReadService.listBranches(organizationId, {
            limit: 50,
            offset: 0,
            ...bounds,
          });
          const server = await branchReadService.listBranches(organizationId, {
            pageMode: BranchListPageMode.Server,
            limit: BRANCH_LIST_SERVER_PAGE_SIZE,
            offset: 0,
            ...bounds,
          });
          const delivery = await insightsService.getDelivery(ctx, period, now);

          expect(legacy.items.map((item) => item.branchName).sort()).toEqual(
            expected
          );
          expect(legacy.total).toBe(expected.length);
          expect(server.total).toBe(expected.length);
          expect(sumValues(delivery.charts.branchesWithoutPr)).toBe(
            expected.length
          );
          expect(sumValues(delivery.charts.checkStatus)).toBe(expected.length);
        }
      });
    });

    it("projects a session-only branch's Last active from its linked session", async () => {
      await committedOrganizations.run(async () => {
        const organizationId = await committedOrganizations.create();
        const now = new Date();
        await seedCorpus(organizationId, now);

        const list = await branchReadService.listBranches(organizationId, {
          limit: 50,
          offset: 0,
        });
        const lastActive = new Map(
          list.items.map((item) => [item.branchName, item.lastActivityAt])
        );

        expect(lastActive.get("session-only")).toBe(
          new Date(now.getTime() - 2 * DAY).toISOString()
        );
        // The atom wins over a newer linked session, and the tie stays a tie.
        expect(lastActive.get("tie-a")).toBe(
          new Date(now.getTime() - DAY).toISOString()
        );
        expect(lastActive.get("tie-b")).toBe(lastActive.get("tie-a"));
        // The uncomputed epoch default is no activity at all.
        expect(lastActive.get("no-activity")).toBe("");
      });
    });
  }
);

function sumValues(
  buckets: readonly { value: number }[] | undefined
): number | undefined {
  return buckets?.reduce((total, bucket) => total + bucket.value, 0);
}

async function seedCorpus(organizationId: string, now: Date): Promise<void> {
  const user = await createTestUser(organizationId);
  await withDb((db) =>
    db.publicRepository.create({
      data: {
        organizationId,
        ...persistedGitHubRepositoryAuthority({
          githubRepoId: `repo-${organizationId}`,
          fullName: REPOSITORY,
        }),
        owner: "acme",
        name: "parity",
        htmlUrl: `https://github.com/${REPOSITORY}`,
      },
      select: { id: true },
    })
  );
  for (const branch of SEED) {
    await seedBranch(organizationId, user.id, branch, now);
  }
}

async function seedBranch(
  organizationId: string,
  userId: string,
  input: SeedBranch,
  now: Date
): Promise<void> {
  const artifactId = await withDb(async (db) => {
    const artifact = await db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.BRANCH,
        name: input.branchName,
        status: BranchStatus.Open,
      },
      select: { id: true },
    });
    // `branch_detail.last_activity_at` stays NULL: the Dashboard used to window
    // on it (falling back to the artifact's creation time), the list never did.
    await db.branchDetail.create({
      data: {
        artifactId: artifact.id,
        organizationId,
        repositoryFullName: REPOSITORY,
        branchName: input.branchName,
        firstPushedAt: new Date(now.getTime() - 40 * DAY),
        pushSource: BranchPushSource.Session,
        headSha: "sha-head",
      },
      select: { artifactId: true },
    });
    if (input.atomOffsetMs !== undefined) {
      await db.branchActivityAtom.create({
        data: {
          organizationId,
          branchArtifactId: artifact.id,
          version: BranchActivityAtomVersion.V1,
          source: BranchActivitySource.GitHead,
          sourceEventId: `event-${artifact.id}`,
          occurredAt: new Date(now.getTime() + input.atomOffsetMs),
          attributionKind: BranchActivityAttributionKind.Branch,
          completeness: BranchActivityEvidenceCompleteness.Complete,
        },
        select: { branchArtifactId: true },
      });
    }
    return artifact.id;
  });
  if (input.unlinked) {
    return;
  }
  const sessionArtifactId = await linkValidSessionToBranch({
    organizationId,
    branchArtifactId: artifactId,
    userId,
    label: input.branchName,
  });
  const offset = input.sessionLastActivityOffsetMs;
  const sessionLastActivityAt =
    offset === null
      ? new Date(UNCOMPUTED_SESSION_LAST_ACTIVITY_MS)
      : new Date(now.getTime() + (offset ?? -60 * DAY));
  await withDb((db) =>
    db.sessionDetail.update({
      where: { artifactId: sessionArtifactId },
      data: { lastActivityAt: sessionLastActivityAt },
      select: { artifactId: true },
    })
  );
}
