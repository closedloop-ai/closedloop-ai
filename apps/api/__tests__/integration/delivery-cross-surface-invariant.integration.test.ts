/**
 * ISS-8151 (PRD-683 Phase 1, P1-B) — the CROSS-SURFACE DELIVERY READ-PATH
 * INVARIANT, against real Postgres.
 *
 * The autopsy behind PRD-683 found that four shipped surfaces each count a
 * DIFFERENT population of the same delivery record, so Insights could report
 * hundreds of merged PRs while the branch page said those same branches had no
 * PR at all. Nothing pinned the four together, and each surface's own unit tests
 * stayed green through the split because none of them could see another
 * surface's answer.
 *
 * This suite seeds ONE org and asserts all four production readers against the
 * SAME rows in one act:
 *
 *   1. Branch card LOC        `branchReadService.listBranches` → row additions/deletions
 *   2. "Has a PR" breakdown   `fetchBranchesWithoutPrBuckets`  (branch-coverage donut)
 *   3. Profile "PRs landed"   `userProfileService.getUserProfileHeadline`
 *   4. Insights merged PRs    `readDeliveryPullRequestFacts` — the Branches
 *                             card's fold, pull REQUESTS (ISS-12408)
 *   5. Delivery "Merged PRs"  `insightsService.getDelivery` — the shipped KPI,
 *                             which reads the same fold as (4)
 *
 * Every surface is given both an INCLUDED and an EXCLUDED record, so no
 * assertion can pass by counting everything or counting nothing: `landed` must
 * reach all four; `open` has a PR pointer but never merged; `stale-merge`
 * merged BEFORE the window and `after-window` AFTER it, so the reporting
 * interval is pinned at BOTH ends; `bare` has no PR at all. A reader that drops
 * its filter fails on the excluded row, and a reader that drops the record
 * fails on the included one.
 *
 * SCOPE (stated plainly): this is the read-path half of ISS-8151. The
 * end-to-end delivery-lane suite and the push-gated-association spec that issue
 * also names depend on PRD-683 Phase 0 code that is not on `main` — see the PR
 * body for the per-piece account.
 */
import { randomUUID } from "node:crypto";
import { LinkType } from "@repo/api/src/types/artifact";
import { GitHubPRState } from "@repo/api/src/types/github";
import { InsightsPeriod, InsightsScope } from "@repo/api/src/types/insights";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import { MilestoneKind } from "@repo/api/src/types/user";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import {
  AFTER_WINDOW_MERGED_AT,
  BEFORE_WINDOW_MERGED_AT,
  IN_WINDOW_MERGED_AT,
  REPO_FULL_NAME,
  seedBranch,
  seedRepository,
  WINDOW_END,
  WINDOW_START,
} from "@/__tests__/integration/delivery-cross-surface-seed-helpers";
import {
  createCommittedTestOrganizationTracker,
  createTestSessionDetail,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { branchReadService } from "@/app/branches/branch-read-service";
import { readDeliveryPullRequestFacts } from "@/app/insights/delivery-pull-request-facts";
import {
  fetchBranchesWithoutPrBuckets,
  readBranchListPopulationIds,
} from "@/app/insights/insights-branch-population";
import { countDistinctMergedPrsFrom } from "@/app/insights/merged-pr-queries";
import { insightsService } from "@/app/insights/service";
import {
  PR_LANDED_THRESHOLDS,
  userProfileService,
} from "@/app/users/user-profile-service";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const committedOrganizations = createCommittedTestOrganizationTracker();

afterEach(() => committedOrganizations.cleanup());

/**
 * The upper bound that makes an Insights count mean what the PROFILE headline
 * means.
 *
 * `getUserProfileHeadline` takes a `startDate` and nothing else — its "PRs
 * landed" filter is `mergedAt: { gte: startDate }`, with NO upper bound. So the
 * profile count and a closed-interval Insights count describe different
 * windows, and asserting them equal is only true while the fixture happens to
 * contain nothing merged after the interval ends. Rather than hide that, the
 * suite reads Insights TWICE: once over the closed reporting interval (the
 * window-bound control) and once from `WINDOW_START` to this effectively-open
 * end, which is the comparison the profile can actually be held to.
 */
const OPEN_ENDED_WINDOW_END = new Date("2099-12-31T23:59:59.999Z");

const LANDED_ADDITIONS = 613;
const LANDED_DELETIONS = 407;

describeIfDb("delivery cross-surface read-path invariant (ISS-8151)", () => {
  it("counts one session-linked merged PR on all four delivery surfaces", async () => {
    await committedOrganizations.run(async () => {
      const organizationId = await committedOrganizations.create();
      const author = await createTestUser(organizationId);
      const repository = await seedRepository(organizationId);

      // The record under test: merged inside the window, session-linked, with
      // provider diff stats and no file cache, so the branch card's LOC can
      // only come from the PR backfill.
      await seedBranch({
        organizationId,
        userId: author.id,
        ...repository,
        branchName: "landed",
        prNumber: 1,
        pr: {
          prState: GitHubPRState.Merged,
          mergedAt: IN_WINDOW_MERGED_AT,
          additions: LANDED_ADDITIONS,
          deletions: LANDED_DELETIONS,
        },
      });
      // Controls. Each is excluded by exactly one surface's filter, so a reader
      // that stops filtering is caught here rather than by a green suite.
      await seedBranch({
        organizationId,
        userId: author.id,
        ...repository,
        branchName: "open",
        prNumber: 2,
        pr: {
          prState: GitHubPRState.Open,
          mergedAt: null,
          additions: 10,
          deletions: 10,
        },
      });
      await seedBranch({
        organizationId,
        userId: author.id,
        ...repository,
        branchName: "stale-merge",
        prNumber: 3,
        pr: {
          prState: GitHubPRState.Merged,
          mergedAt: BEFORE_WINDOW_MERGED_AT,
          additions: 20,
          deletions: 20,
        },
      });
      // The window's UPPER bound, which `BEFORE_WINDOW_MERGED_AT` alone cannot
      // hold: a PR merged after the interval ends. Insights bounds `mergedAt`
      // at BOTH ends (`mergedPrWhere`: `gte: start, lte: end`), so this row
      // must stay out of the in-window count — drop the `lte` and the count
      // rises. The profile headline has no upper bound at all, so it DOES
      // include this row; that divergence is asserted rather than hidden.
      await seedBranch({
        organizationId,
        userId: author.id,
        ...repository,
        branchName: "after-window",
        prNumber: 5,
        pr: {
          prState: GitHubPRState.Merged,
          mergedAt: AFTER_WINDOW_MERGED_AT,
          additions: 30,
          deletions: 30,
        },
      });
      await seedBranch({
        organizationId,
        userId: author.id,
        ...repository,
        branchName: "bare",
        prNumber: 4,
      });
      // The pointer-vs-row population split, made reachable: a HISTORICAL
      // merged PR row that is not current, under a CURRENT open PR. Insights
      // counts `PullRequestDetail` rows and applies no `isCurrent` filter, so
      // it sees the merged row; the profile headline and the coverage buckets
      // follow the current pointer, so they see only the open one. Without this
      // branch every seeded PR is current and that divergence is unreachable.
      await seedBranch({
        organizationId,
        userId: author.id,
        ...repository,
        branchName: "superseded",
        prNumber: 8,
        pr: {
          prState: GitHubPRState.Open,
          mergedAt: null,
          additions: 50,
          deletions: 50,
        },
        historicalPr: {
          prNumber: 7,
          prState: GitHubPRState.Merged,
          mergedAt: IN_WINDOW_MERGED_AT,
          additions: 60,
          deletions: 60,
        },
      });
      // Same branch, two PR rows, but only the current open PR is named.
      await seedBranch({
        organizationId,
        userId: author.id,
        ...repository,
        branchName: "reused-unadmitted",
        prNumber: 13,
        pr: {
          prState: GitHubPRState.Open,
          mergedAt: null,
          additions: 110,
          deletions: 110,
        },
        historicalPr: {
          prNumber: 14,
          prState: GitHubPRState.Merged,
          mergedAt: IN_WINDOW_MERGED_AT,
          additions: 120,
          deletions: 120,
        },
        linkedPrNumbers: [13],
      });
      // ONE pull request projected TWICE, on two different branches — the
      // adopted/repo-less twin `projectedPrIdentity` documents and no unique
      // constraint can forbid. Both rows carry the same `repositoryFullName`
      // and number, so they share one identity: the raw row count sees two, the
      // shipped Delivery KPI (the shared fold) sees one. Without this
      // pair the two figures are equal and the dedupe is unasserted.
      await seedBranch({
        organizationId,
        userId: author.id,
        ...repository,
        branchName: "twin-adopted",
        prNumber: 9,
        pr: {
          prState: GitHubPRState.Merged,
          mergedAt: IN_WINDOW_MERGED_AT,
          additions: 70,
          deletions: 70,
          repositoryFullName: REPO_FULL_NAME,
          githubId: `gh-twin-${randomUUID().slice(0, 8)}`,
        },
      });
      await seedBranch({
        organizationId,
        userId: author.id,
        ...repository,
        branchName: "twin-repoless",
        prNumber: 9,
        pr: {
          prState: GitHubPRState.Merged,
          mergedAt: IN_WINDOW_MERGED_AT,
          additions: 70,
          deletions: 70,
          repositoryFullName: REPO_FULL_NAME,
          repoless: true,
        },
      });
      // A SECOND author's merged PR, so the scope predicates are load-bearing.
      // The profile headline filters `createdById: userId`; Insights at
      // `InsightsScope.Org` deliberately does not. With one author every scope
      // agrees by accident and deleting either predicate changes nothing — this
      // row is what separates them.
      const otherAuthor = await createTestUser(organizationId);
      await seedBranch({
        organizationId,
        userId: otherAuthor.id,
        ...repository,
        branchName: "other-author",
        prNumber: 6,
        pr: {
          prState: GitHubPRState.Merged,
          mergedAt: IN_WINDOW_MERGED_AT,
          additions: 40,
          deletions: 40,
        },
      });
      // ISS-8153 exclusion control: the retired-genesis shape — a merged row
      // NO session touched and NO producer verified. The org-merged population
      // (provider-authoritative OR session-linked+verified) must drop it from
      // every Insights figure, while the branch artifact itself still exists
      // (D6 deletes these rows; until then the READ side must not count them).
      await seedBranch({
        organizationId,
        userId: author.id,
        ...repository,
        branchName: "genesis",
        prNumber: 10,
        unlinked: true,
        pr: {
          prState: GitHubPRState.Merged,
          mergedAt: IN_WINDOW_MERGED_AT,
          additions: 80,
          deletions: 80,
          unverified: true,
        },
      });
      // D1 ruling control (Kerensa, 2026-08-27): a webhook/App-shaped merged row
      // — GitHub node id, App fetch mechanism, verified — that NO session
      // touched. Provenance cannot admit it: "no session reference, not
      // included." Before the ruling this row rode the provider-authoritative
      // arm into every Insights figure.
      const webhookUnlinkedBranchId = await seedBranch({
        organizationId,
        userId: author.id,
        ...repository,
        branchName: "webhook-unlinked",
        prNumber: 12,
        unlinked: true,
        pr: {
          prState: GitHubPRState.Merged,
          mergedAt: IN_WINDOW_MERGED_AT,
          additions: 100,
          deletions: 100,
          githubId: `gh-hook-${randomUUID().slice(0, 8)}`,
        },
      });
      // Cross-tenant contaminant (cr on PR #6112): a FOREIGN-org session
      // wired onto this org's branch through an org-A link row — the shape
      // the schema does not forbid. The membership's source-org check must
      // keep `webhook-unlinked` excluded; without it this link would admit
      // the branch and every figure below would move.
      const foreignOrganizationId = await committedOrganizations.create();
      const foreignUser = await createTestUser(foreignOrganizationId);
      const foreignSessionArtifactId = await createTestSessionDetail({
        organizationId: foreignOrganizationId,
        userId: foreignUser.id,
        label: "foreign-org-session",
      });
      await withDb((db) =>
        db.artifactLink.create({
          data: {
            organizationId,
            sourceId: foreignSessionArtifactId,
            targetId: webhookUnlinkedBranchId,
            linkType: LinkType.RelatesTo,
            metadata: { linkKind: SessionArtifactLinkKind.SessionPr },
          },
        })
      );
      // ISS-8153 inclusion control: the tier-2 HEAL-WINDOW shape — a verified,
      // session-linked merged row whose branch has NO current pointer yet
      // (promotion has not run). The canonical fallback must carry it onto the
      // coverage donut and the profile, and the org-merged population counts
      // it — this is the branch the pointer-only reads dropped to zero.
      await seedBranch({
        organizationId,
        userId: author.id,
        ...repository,
        branchName: "healing",
        prNumber: 11,
        withoutPointer: true,
        pr: {
          prState: GitHubPRState.Merged,
          mergedAt: IN_WINDOW_MERGED_AT,
          additions: 90,
          deletions: 90,
        },
      });

      const surfaces = await readAllFourSurfaces(organizationId, author.id);

      // One assertion over all four readers: a divergence names the surface
      // that moved instead of failing four unrelated expectations.
      expect(surfaces).toEqual({
        branchCardLoc: {
          landed: { additions: LANDED_ADDITIONS, deletions: LANDED_DELETIONS },
          open: { additions: 10, deletions: 10 },
          "stale-merge": { additions: 20, deletions: 20 },
          "after-window": { additions: 30, deletions: 30 },
          // The CURRENT (open) PR's stats, not the superseded merged row's
          // 60/60 — the branch card follows the pointer.
          superseded: { additions: 50, deletions: 50 },
          "reused-unadmitted": { additions: 110, deletions: 110 },
          "twin-adopted": { additions: 70, deletions: 70 },
          "twin-repoless": { additions: 70, deletions: 70 },
          "other-author": { additions: 40, deletions: 40 },
          // ISS-8153: no pointer, but the owned merged row still carries the
          // card's LOC — the heal-window branch is not blank.
          healing: { additions: 90, deletions: 90 },
          // `genesis` and `webhook-unlinked` are deliberately NOT here: the
          // Branches list requires a linked session, so unlinked branches
          // never surface on it — nor, since ISS-11915, in the donut.
          bare: { additions: null, deletions: null },
        },
        // ISS-8153: "has a PR" keys on owned rows; `bare` is the only no-PR row.
        // ISS-11915: the donut counts the Branches list population, so the two
        // unlinked branches (`genesis`, `webhook-unlinked`) no longer count.
        hasPrBreakdown: { hasPr: 10, noPr: 1 },
        // Distinct merged PRs: landed, exact-linked superseded, after-window,
        // healing, and the collapsed twin pair.
        profilePrsLanded: 5,
        insightsDistinctMergedPrsFromWindowStartMe: 5,
        // ISS-12408: the dashboard counts pull requests, not rows, so the twin
        // pair is ONE here and the figure equals the profile's. Exact
        // session-linked and verified rows only: landed, superseded, the
        // collapsed twin pair, and healing. `reused-unadmitted` names only its
        // open sibling.
        dashboardMergedPrsFromWindowStartMe: 5,
        // Org scope is strictly wider by exactly the other author's PR. Equal
        // to the Me figure would mean the creator predicate stopped applying.
        dashboardMergedPrsFromWindowStartOrg: 6,
        // The closed reporting interval excludes both out-of-window merges plus
        // genesis and reused-unadmitted.
        dashboardMergedPrsInWindowOrg: 5,
        // The shipped Delivery KPI reads the same fold, so it is the same FIVE
        // pull requests as the window control above. A dedupe regression moves
        // both together; a divergence between them is the surfaces disagreeing.
        deliveryMergedPrKpi: 5,
      });
    });
  });

  it("computes the PR-landed milestone crossing in landing order, one landing per pull request", async () => {
    // cr-96292 (Kerensa: SQL-side, not a capped app-side scan) + cr on PR #6112
    // (one basis everywhere): the milestone crossing query ranks DISTINCT
    // merged pull requests — the projected identity the Delivery KPI dedupes
    // on — by their landing instant, never by branch creation order and never
    // per projection row.
    await committedOrganizations.run(async () => {
      const organizationId = await committedOrganizations.create();
      const author = await createTestUser(organizationId);
      const repository = await seedRepository(organizationId);

      const lastLanding = new Date("2026-10-15T12:00:00.000Z");
      // Created FIRST, lands LAST: if the query ordered by creation instead
      // of landing, the crossing instant below moves.
      await seedBranch({
        organizationId,
        userId: author.id,
        ...repository,
        branchName: "created-first-lands-last",
        prNumber: 30,
        pr: {
          prState: GitHubPRState.Merged,
          mergedAt: lastLanding,
          additions: 1,
          deletions: 1,
        },
      });
      // ONE pull request projected TWICE (the adopted/repo-less twin shape):
      // both rows share `repositoryFullName` + number, so they are ONE
      // landing. A row-counting or branch-counting walk sees two and crosses
      // the threshold a landing early — at the twin's instant, not
      // `lastLanding`.
      const twinLanding = new Date("2026-02-20T12:00:00.000Z");
      await seedBranch({
        organizationId,
        userId: author.id,
        ...repository,
        branchName: "twin-adopted-milestone",
        prNumber: 48,
        pr: {
          prState: GitHubPRState.Merged,
          mergedAt: twinLanding,
          additions: 1,
          deletions: 1,
          repositoryFullName: REPO_FULL_NAME,
          githubId: `gh-twin-m-${randomUUID().slice(0, 8)}`,
        },
      });
      await seedBranch({
        organizationId,
        userId: author.id,
        ...repository,
        branchName: "twin-repoless-milestone",
        prNumber: 48,
        pr: {
          prState: GitHubPRState.Merged,
          mergedAt: twinLanding,
          additions: 1,
          deletions: 1,
          repositoryFullName: REPO_FULL_NAME,
          repoless: true,
        },
      });
      // Enough further single-PR landings at distinct earlier instants to
      // bring the author to exactly the first threshold: the twin pair is one
      // of the ten identities.
      for (let i = 0; i < PR_LANDED_THRESHOLDS[0] - 2; i++) {
        await seedBranch({
          organizationId,
          userId: author.id,
          ...repository,
          branchName: `landing-${i}`,
          prNumber: 40 + i,
          pr: {
            prState: GitHubPRState.Merged,
            mergedAt: new Date(Date.UTC(2026, 1, i + 1, 12)),
            additions: 1,
            deletions: 1,
          },
        });
      }

      const { milestones } = await userProfileService.getUserProfileMilestones(
        author.id,
        organizationId
      );
      const prMilestones = milestones.filter(
        (milestone) => milestone.kind === MilestoneKind.PrsLanded
      );
      // The twin pair lands ONCE, so exactly the first threshold is crossed
      // — at the final landing instant in LANDING order, which is the
      // created-first branch's merge.
      expect(prMilestones).toEqual([
        {
          kind: MilestoneKind.PrsLanded,
          threshold: PR_LANDED_THRESHOLDS[0],
          earnedAt: lastLanding,
        },
      ]);
    });
  });

  it("drops the record from every merged-PR surface when its PR is not merged", async () => {
    await committedOrganizations.run(async () => {
      const organizationId = await committedOrganizations.create();
      const author = await createTestUser(organizationId);
      const repository = await seedRepository(organizationId);

      // The SAME shape as the landed case except the PR never merged. Both
      // merged-PR surfaces must read zero while the branch itself still
      // surfaces with a PR — this is what makes the counts above load-bearing
      // rather than a restatement of the seed size.
      await seedBranch({
        organizationId,
        userId: author.id,
        ...repository,
        branchName: "landed",
        prNumber: 1,
        pr: {
          prState: GitHubPRState.Open,
          mergedAt: null,
          additions: LANDED_ADDITIONS,
          deletions: LANDED_DELETIONS,
        },
      });

      const surfaces = await readAllFourSurfaces(organizationId, author.id);

      expect(surfaces).toEqual({
        // The branch still surfaces and still shows its PR's LOC — only the
        // two merged-PR populations move.
        branchCardLoc: {
          landed: { additions: LANDED_ADDITIONS, deletions: LANDED_DELETIONS },
        },
        hasPrBreakdown: { hasPr: 1, noPr: 0 },
        profilePrsLanded: 0,
        insightsDistinctMergedPrsFromWindowStartMe: 0,
        dashboardMergedPrsFromWindowStartMe: 0,
        dashboardMergedPrsFromWindowStartOrg: 0,
        dashboardMergedPrsInWindowOrg: 0,
        deliveryMergedPrKpi: 0,
      });
    });
  });
});

/** What each of the four production readers says about the seeded org. */
type DeliverySurfaceReadout = {
  branchCardLoc: Record<
    string,
    { additions: number | null; deletions: number | null }
  >;
  hasPrBreakdown: { hasPr: number; noPr: number };
  profilePrsLanded: number;
  /**
   * The dashboard's Merged PRs figure over the CLOSED reporting interval — the
   * window-bound control. Distinct pull requests, as the Branches card counts.
   */
  dashboardMergedPrsInWindowOrg: number;
  /**
   * Insights over the profile's own window AND the profile's own scope, so the
   * profile headline is compared against a count that means what it means.
   * The dashboard fold and the profile's DISTINCT-identity count are both read,
   * and must agree (cr on PR #6112 — a twin projection lands once).
   */
  dashboardMergedPrsFromWindowStartMe: number;
  insightsDistinctMergedPrsFromWindowStartMe: number;
  /** The same window at org scope — wider by the other author's PR. */
  dashboardMergedPrsFromWindowStartOrg: number;
  /**
   * The "Merged PRs" KPI the Delivery ROUTE actually returns — deduped by
   * projected PR identity, so it counts pull requests, not rows.
   */
  deliveryMergedPrKpi: number;
};

/**
 * Calls all four production readers for one org and projects their answers into
 * a single comparable shape. Each call is the real entry point the route uses —
 * nothing here reimplements a query.
 */
async function readAllFourSurfaces(
  organizationId: string,
  userId: string
): Promise<DeliverySurfaceReadout> {
  const list = await branchReadService.listBranches(organizationId, {
    limit: 50,
    offset: 0,
  });
  const branchCardLoc: DeliverySurfaceReadout["branchCardLoc"] = {};
  for (const item of list.items) {
    branchCardLoc[item.branchName] = {
      additions: item.additions,
      deletions: item.deletions,
    };
  }

  // ISS-11915: the donut counts the Branches list's own population for the
  // reporting window, read once through the list's candidate SQL.
  const populationIds = await readBranchListPopulationIds(organizationId, {
    startDate: WINDOW_START,
    endDate: WINDOW_END,
    evaluationNow: WINDOW_END,
  });
  const buckets = await fetchBranchesWithoutPrBuckets(populationIds, {
    organizationId,
  });
  const bucketValue = (key: string) =>
    buckets.find((bucket) => bucket.key === key)?.value ?? -1;

  const headline = await userProfileService.getUserProfileHeadline(
    userId,
    organizationId,
    WINDOW_START
  );

  const orgScope = { organizationId, userId, scope: InsightsScope.Org };
  // The profile headline counts branches the user AUTHORED, so `InsightsScope.Me`
  // — not `Org` — is the scope its figure is comparable to.
  const meScope = { organizationId, userId, scope: InsightsScope.Me };
  const dashboardMergedPrsInWindowOrg = await dashboardMergedPrs(
    orgScope,
    WINDOW_START,
    WINDOW_END
  );
  const dashboardMergedPrsFromWindowStartMe = await dashboardMergedPrs(
    meScope,
    WINDOW_START,
    OPEN_ENDED_WINDOW_END
  );
  const insightsDistinctMergedPrsFromWindowStartMe =
    await countDistinctMergedPrsFrom(meScope, WINDOW_START);
  const dashboardMergedPrsFromWindowStartOrg = await dashboardMergedPrs(
    orgScope,
    WINDOW_START,
    OPEN_ENDED_WINDOW_END
  );

  // The SHIPPED Delivery response, not a query standing in for it. Its "Merged
  // PRs" KPI reads the shared fold (ISS-12408), the same one `dashboardMergedPrs`
  // above calls for the window controls. `getDelivery`
  // resolves its own range from (period, now): anchoring `now` at WINDOW_END
  // over the 30-day period yields a subinterval of [WINDOW_START, WINDOW_END]
  // that holds every in-window control and excludes both out-of-window merges.
  const delivery = await insightsService.getDelivery(
    orgScope,
    InsightsPeriod.Month,
    WINDOW_END
  );
  const deliveryMergedPrKpi =
    delivery.kpis.find((stat) => stat.key === "merged")?.value ?? -1;

  return {
    branchCardLoc,
    hasPrBreakdown: {
      hasPr: bucketValue("has-pr"),
      noPr: bucketValue("no-pr"),
    },
    profilePrsLanded: headline.totalPRsLanded,
    insightsDistinctMergedPrsFromWindowStartMe,
    dashboardMergedPrsInWindowOrg,
    dashboardMergedPrsFromWindowStartMe,
    dashboardMergedPrsFromWindowStartOrg,
    deliveryMergedPrKpi,
  };
}

/** The dashboard's Merged PRs figure for a scope and window, from the shared fold. */
async function dashboardMergedPrs(
  scope: Parameters<typeof readDeliveryPullRequestFacts>[0],
  start: Date,
  end: Date
): Promise<number> {
  return (
    await readDeliveryPullRequestFacts(scope, {
      start,
      end,
      priorStart: null,
      priorEnd: start,
    })
  ).merged;
}
