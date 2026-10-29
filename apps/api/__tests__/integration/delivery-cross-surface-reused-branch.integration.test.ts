/**
 * ISS-8265 — PER-PULL-REQUEST admission on a REUSED branch, against real
 * Postgres, in BOTH dialects.
 *
 * The org-merged population used to admit a merged+verified PR whenever its
 * BRANCH carried any session→PR link, without checking the link named THAT
 * PR's `repo#number`. So a branch reused for a second PR no session ever
 * touched counted that PR into Insights Delivery, the profile "PRs landed",
 * and the milestone crossings — while the Sessions delivery cards, which have
 * run the ISS-7705 identity pass since that ticket, excluded it.
 *
 * Every scenario here seeds BOTH halves of the discrimination on ONE branch:
 * a PR the link names and a PR it does not. A fixture carrying only the
 * excluded PR would be vacuous — a predicate that matched nothing at all would
 * satisfy it. The two PRs also land on DIFFERENT days, so a windowed count can
 * say WHICH one was admitted rather than only how many.
 *
 * The dialects are read separately on purpose: `getDelivery` exercises the
 * app-side pass over the Prisma row scan, the two SQL counts exercise the
 * correlated predicate, and `collectMergedPrsForScope` is the Sessions cards
 * the two are supposed to agree with.
 */

import { GitHubPRState } from "@repo/api/src/types/github";
import { InsightsPeriod, InsightsScope } from "@repo/api/src/types/insights";
import {
  ArtifactRefMethod,
  SessionArtifactLinkKind,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import type { Prisma } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import {
  REPO_FULL_NAME,
  seedBranch,
  seedRepository,
  WINDOW_END,
  WINDOW_START,
} from "@/__tests__/integration/delivery-cross-surface-seed-helpers";
import {
  createCommittedTestOrganizationTracker,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { readDeliveryPullRequestFacts } from "@/app/insights/delivery-pull-request-facts";
import { countDistinctMergedPrsFrom } from "@/app/insights/merged-pr-queries";
import { insightsService } from "@/app/insights/service";
import { collectMergedPrsForScope } from "@/lib/agent-session-delivery-metrics";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const committedOrganizations = createCommittedTestOrganizationTracker();

afterEach(() => committedOrganizations.cleanup());

/** The PR the link names, and the one it does not. */
const NAMED_PR_NUMBER = 21;
const UNNAMED_PR_NUMBER = 22;
const NAMED_PR_MERGED_AT = new Date("2026-07-20T12:00:00.000Z");
const NAMED_PR_DAY = "2026-07-20";
const UNNAMED_PR_MERGED_AT = new Date("2026-07-05T12:00:00.000Z");
const NAMED_PR_ADDITIONS = 41;
const NAMED_PR_DELETIONS = 17;
const UNNAMED_PR_ADDITIONS = 900;
const UNNAMED_PR_DELETIONS = 900;

/** The identity a link declares for the admitted PR, written independently of
 * the production helper that derives it. */
const NAMED_PR_IDENTITY = `${REPO_FULL_NAME}#${NAMED_PR_NUMBER}`;

type ReusedBranchReadout = {
  deliveryMergedPrKpi: number | null;
  deliveryMergedTrendDays: string[];
  dashboardFoldInWindow: number;
  dashboardFoldFromNamedLanding: number;
  sqlDistinctFromWindowStart: number;
  sqlDistinctFromNamedLanding: number;
  cardAdmittedIdentities: (string | null)[];
  cardMergedLoc: (number | null)[][];
};

/** The one admitted PR, as every surface should report it. */
const ONLY_THE_NAMED_PR: ReusedBranchReadout = {
  deliveryMergedPrKpi: 1,
  deliveryMergedTrendDays: [NAMED_PR_DAY],
  dashboardFoldInWindow: 1,
  dashboardFoldFromNamedLanding: 1,
  sqlDistinctFromWindowStart: 1,
  sqlDistinctFromNamedLanding: 1,
  cardAdmittedIdentities: [NAMED_PR_IDENTITY],
  cardMergedLoc: [[NAMED_PR_ADDITIONS, NAMED_PR_DELETIONS]],
};

/**
 * Neither PR admitted. The Delivery KPI reports a real `0` here rather than the
 * no-data `null` its sibling cards use — the population is empty, not unknown.
 */
const NO_ADMITTED_PR: ReusedBranchReadout = {
  deliveryMergedPrKpi: 0,
  deliveryMergedTrendDays: [],
  dashboardFoldInWindow: 0,
  dashboardFoldFromNamedLanding: 0,
  sqlDistinctFromWindowStart: 0,
  sqlDistinctFromNamedLanding: 0,
  cardAdmittedIdentities: [],
  cardMergedLoc: [],
};

describeIfDb("org-merged admission on a reused branch (ISS-8265)", () => {
  it("admits only the PR a command-derived prRefs link names", async () => {
    await committedOrganizations.run(async () => {
      const seeded = await seedReusedBranch({
        linkMetadata: {
          linkKind: SessionArtifactLinkKind.SessionPr,
          prRefs: [commandDerivedRef({ repositoryFullName: REPO_FULL_NAME })],
        },
      });
      expect(await readReusedBranchSurfaces(seeded)).toEqual(ONLY_THE_NAMED_PR);
    });
  });

  it("normalizes the repository on both sides of the identity comparison", async () => {
    // `sessionPrIdentityKey` lowercases and strips a trailing `.git`, so a link
    // written `Acme/Delivery.git` names `acme/delivery#21`. Without the same
    // normalization in SQL this row is admitted by the Prisma arm and dropped
    // by the counts — the dialect split this ticket exists to close.
    await committedOrganizations.run(async () => {
      const seeded = await seedReusedBranch({
        linkMetadata: {
          linkKind: SessionArtifactLinkKind.SessionPr,
          prRefs: [
            commandDerivedRef({ repositoryFullName: "Acme/Delivery.git" }),
          ],
        },
      });
      expect(await readReusedBranchSurfaces(seeded)).toEqual(ONLY_THE_NAMED_PR);
    });
  });

  it("admits only the PR a LEGACY scalar link names", async () => {
    // The pre-`prRefs` shape: `linkKind` plus top-level `repositoryFullName` /
    // `prNumber`. It declares exactly one identity, so on a two-PR branch it
    // must admit that one and refuse the sibling — the unique-Branch fallback
    // does not apply here, because the link is not identity-less.
    await committedOrganizations.run(async () => {
      const seeded = await seedReusedBranch({
        linkMetadata: {
          linkKind: SessionArtifactLinkKind.SessionPr,
          repositoryFullName: REPO_FULL_NAME,
          prNumber: NAMED_PR_NUMBER,
        },
      });
      expect(await readReusedBranchSurfaces(seeded)).toEqual(ONLY_THE_NAMED_PR);
    });
  });

  it("declares nothing when one prRefs entry is malformed", async () => {
    // Zod fails the WHOLE array on one bad element, so
    // `classifySessionPrMetadata` answers `invalid` and the link declares no
    // identity at all. A SQL mirror that matched the well-formed sibling would
    // admit a PR the row scan and the cards both refuse.
    await committedOrganizations.run(async () => {
      const seeded = await seedReusedBranch({
        linkMetadata: {
          linkKind: SessionArtifactLinkKind.SessionPr,
          prRefs: [
            commandDerivedRef({ repositoryFullName: REPO_FULL_NAME }),
            { repositoryFullName: REPO_FULL_NAME, prNumber: "not-a-number" },
          ],
        },
      });
      expect(await readReusedBranchSurfaces(seeded)).toEqual(NO_ADMITTED_PR);
    });
  });

  it("refuses a PROSE-derived ref, which names a PR on the weakest evidence", async () => {
    // ISS-5823: a model typing "PR #21" in a sentence must not move a count.
    // Both PRs therefore fall out, even though one of them IS named.
    await committedOrganizations.run(async () => {
      const seeded = await seedReusedBranch({
        linkMetadata: {
          linkKind: SessionArtifactLinkKind.SessionPr,
          prRefs: [
            {
              repositoryFullName: REPO_FULL_NAME,
              prNumber: NAMED_PR_NUMBER,
              relationTypes: [SessionPrRelationType.Referenced],
              method: ArtifactRefMethod.PrMentionInProse,
            },
          ],
        },
      });
      expect(await readReusedBranchSurfaces(seeded)).toEqual(NO_ADMITTED_PR);
    });
  });
});

/**
 * ISS-8265 review (whitlockk, codex on PR #6246) — the BRANCH arm reads the same
 * metadata contract the session→PR arm does.
 *
 * `parseSessionPrLinkMetadata` fails closed on a link whose `prRefs` is not an
 * array, so the TypeScript admission drops such a session→branch link and with
 * it the branch's merged rows. The SQL branch arm used to check only `linkKind`
 * and `method`, so it admitted the same link — and the org-wide counts then
 * reported a PR the Delivery rows and the Sessions cards both refused.
 *
 * The well-formed control is what keeps the malformed case from being vacuous:
 * a predicate that admitted NOTHING through this arm would satisfy the second
 * assertion and fail the first.
 */
describeIfDb("branch-arm admission reads the metadata contract", () => {
  it("admits a repo-less row through a well-formed session→branch link", async () => {
    await committedOrganizations.run(async () => {
      const seeded = await seedBranchArmOnlyBranch({
        linkKind: SessionArtifactLinkKind.SessionBranch,
      });
      expect(await readBranchArmSurfaces(seeded)).toEqual({
        deliveryMergedPrKpi: 1,
        dashboardFoldInWindow: 1,
        cardAdmittedBranchCount: 1,
      });
    });
  });

  it("refuses the same link when its prRefs is not an array", async () => {
    await committedOrganizations.run(async () => {
      const seeded = await seedBranchArmOnlyBranch({
        linkKind: SessionArtifactLinkKind.SessionBranch,
        prRefs: "not-an-array",
      });
      expect(await readBranchArmSurfaces(seeded)).toEqual({
        deliveryMergedPrKpi: 0,
        dashboardFoldInWindow: 0,
        cardAdmittedBranchCount: 0,
      });
    });
  });
});

/**
 * One branch carrying exactly ONE repo-less merged PR and one session→branch
 * link whose metadata the caller supplies — the unique-branch, tier-2 shape
 * that is the only one the branch arm admits through.
 */
async function seedBranchArmOnlyBranch(
  linkMetadata: Prisma.InputJsonObject
): Promise<SeededReusedBranch> {
  const organizationId = await committedOrganizations.create();
  const author = await createTestUser(organizationId);
  const repository = await seedRepository(organizationId);
  await seedBranch({
    organizationId,
    userId: author.id,
    ...repository,
    branchName: "branch-arm",
    prNumber: NAMED_PR_NUMBER,
    linkMetadata,
    pr: {
      prState: GitHubPRState.Merged,
      mergedAt: NAMED_PR_MERGED_AT,
      additions: NAMED_PR_ADDITIONS,
      deletions: NAMED_PR_DELETIONS,
      // The branch arm is the installation-free lane: no installation repo on
      // the row, identity carried by the denormalized column alone.
      repoless: true,
      repositoryFullName: REPO_FULL_NAME,
    },
  });
  return { organizationId, userId: author.id };
}

async function readBranchArmSurfaces(seeded: SeededReusedBranch) {
  const orgScope = {
    organizationId: seeded.organizationId,
    userId: seeded.userId,
    scope: InsightsScope.Org,
  };
  const delivery = await insightsService.getDelivery(
    orgScope,
    InsightsPeriod.Month,
    WINDOW_END
  );
  const cards = await collectMergedPrsForScope(seeded.organizationId, {
    artifact: { is: { organizationId: seeded.organizationId } },
  });
  return {
    deliveryMergedPrKpi:
      delivery.kpis.find((kpi) => kpi.key === "merged")?.value ?? null,
    dashboardFoldInWindow: await dashboardMergedPrs(
      orgScope,
      WINDOW_START,
      WINDOW_END
    ),
    cardAdmittedBranchCount: cards.mergedBranches.length,
  };
}

/** A command-derived `prRefs` entry naming {@link NAMED_PR_NUMBER}. */
function commandDerivedRef(input: { repositoryFullName: string }) {
  return {
    repositoryFullName: input.repositoryFullName,
    prNumber: NAMED_PR_NUMBER,
    relationTypes: [SessionPrRelationType.Created],
    method: ArtifactRefMethod.PrCreateOutput,
  };
}

type SeededReusedBranch = { organizationId: string; userId: string };

/**
 * One branch carrying two merged+verified PRs and one session link, whose
 * metadata the caller supplies. The NAMED PR is the branch pointer and lands
 * late; the UNNAMED one is a superseded row that landed earlier and is far
 * larger, so a surface that admitted the wrong PR reports different LOC and a
 * different trend day rather than the same "1".
 */
async function seedReusedBranch(input: {
  linkMetadata: Prisma.InputJsonObject;
}): Promise<SeededReusedBranch> {
  const organizationId = await committedOrganizations.create();
  const author = await createTestUser(organizationId);
  const repository = await seedRepository(organizationId);
  await seedBranch({
    organizationId,
    userId: author.id,
    ...repository,
    branchName: "reused",
    prNumber: NAMED_PR_NUMBER,
    linkMetadata: input.linkMetadata,
    pr: {
      prState: GitHubPRState.Merged,
      mergedAt: NAMED_PR_MERGED_AT,
      additions: NAMED_PR_ADDITIONS,
      deletions: NAMED_PR_DELETIONS,
    },
    historicalPr: {
      prNumber: UNNAMED_PR_NUMBER,
      prState: GitHubPRState.Merged,
      mergedAt: UNNAMED_PR_MERGED_AT,
      additions: UNNAMED_PR_ADDITIONS,
      deletions: UNNAMED_PR_DELETIONS,
    },
  });
  return { organizationId, userId: author.id };
}

/**
 * Both org-wide dialects plus the Sessions cards, over one seeded branch.
 *
 * The SQL counts are read from TWO lower bounds: `fromWindowStart` sees both
 * landings and `fromNamedLanding` only the named one, so admitting the wrong PR
 * shows up as 1/0 and admitting both as 2/1 — a single count of 1 could not
 * tell those apart.
 */
async function readReusedBranchSurfaces(
  seeded: SeededReusedBranch
): Promise<ReusedBranchReadout> {
  const orgScope = {
    organizationId: seeded.organizationId,
    userId: seeded.userId,
    scope: InsightsScope.Org,
  };
  const meScope = { ...orgScope, scope: InsightsScope.Me };
  const delivery = await insightsService.getDelivery(
    orgScope,
    InsightsPeriod.Month,
    WINDOW_END
  );
  const cards = await collectMergedPrsForScope(seeded.organizationId, {
    artifact: { is: { organizationId: seeded.organizationId } },
  });
  return {
    deliveryMergedPrKpi:
      delivery.kpis.find((kpi) => kpi.key === "merged")?.value ?? null,
    deliveryMergedTrendDays: delivery.charts.prTrend.points
      .filter((point) => (point.values.merged ?? 0) > 0)
      .map((point) => point.date),
    dashboardFoldInWindow: await dashboardMergedPrs(
      orgScope,
      WINDOW_START,
      WINDOW_END
    ),
    dashboardFoldFromNamedLanding: await dashboardMergedPrs(
      orgScope,
      NAMED_PR_MERGED_AT,
      WINDOW_END
    ),
    sqlDistinctFromWindowStart: await countDistinctMergedPrsFrom(
      meScope,
      WINDOW_START
    ),
    sqlDistinctFromNamedLanding: await countDistinctMergedPrsFrom(
      meScope,
      NAMED_PR_MERGED_AT
    ),
    cardAdmittedIdentities: cards.mergedBranches.map(
      (branch) => branch.prIdentity
    ),
    cardMergedLoc: cards.prs.map((pr) => [pr.additions, pr.deletions]),
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
