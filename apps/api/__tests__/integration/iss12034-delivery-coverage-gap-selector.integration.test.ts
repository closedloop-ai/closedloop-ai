/**
 * ISS-12034 — the installed tier must be able to reach a session-linked PR the
 * delivery-coverage numerator is missing.
 *
 * Against a real Postgres, for the same reason ISS-8462's suite is: the defect
 * IS a SQL predicate, and a mocked `$queryRaw` returns whatever the test hands
 * it whatever the predicate says. The unit suite pins the rendered text; only
 * this one pins which rows come back.
 *
 * WHAT WAS WRONG. `reconcileRepo` routes only `UserToken` through the targeted
 * session-linked path, so the installed tier had two write paths and neither
 * could reach an uncovered row: the windowed history walk stops at the
 * watermark, and `selectSelfHealTargets` requires `is_current = true` — which
 * `isDeliveryCoverageCovered` already counts as covered. The self-heal
 * population and the uncovered population were disjoint BY CONSTRUCTION, so
 * prod reported `Swept` with `writtenCount 0` and `fetchFailureCount 0` on
 * every tick while the ratio stayed under 1, and monitor 316977438 paged every
 * ~4.5h.
 *
 * THE LOAD-BEARING ASSERTION is the reconciliation one: the row
 * `selectCoverageGapPullRequestTargets` returns is the SAME row
 * `readGitHubDeliveryCoverageCounts` is missing from its numerator. The two
 * read opposite directions off `delivery-coverage-predicate.ts`, and that
 * pairing is what makes the arm provably a heal for the monitored shortfall
 * rather than some other population that merely looks like it.
 *
 * Every negative case below flips exactly ONE operand off the fixture that the
 * positive case proves is selected, so each names the clause it defends.
 */
import {
  BranchParticipationKind,
  normalizeRepoFullName,
} from "@repo/api/src/types/branch";
import {
  ArtifactRefMethod,
  SessionArtifactLinkKind,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import { withDb } from "@repo/database";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RECONCILE_PULL_REQUEST_ATTEMPT_DEBOUNCE_MS } from "@/app/cron/reconcile-pull-requests/constants";
import { readGitHubDeliveryCoverageCounts } from "@/app/cron/reconcile-pull-requests/delivery-coverage-metrics";
import { isDeliveryCoverageCovered } from "@/app/cron/reconcile-pull-requests/delivery-coverage-predicate";
import { selectCoverageGapPullRequestTargets } from "@/app/cron/reconcile-pull-requests/session-linked-targets";
import { createCommittedTestOrganizationTracker } from "../utils/db-helpers";
import {
  baseFixture,
  branchRef,
  findBranch,
  findPrByBranchNumber,
  pullRequestRef,
  seedRepo,
  syncSession,
} from "./agent-session-pr-sync-helpers";

const hasDatabase = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const REPOSITORY = "acme/widgets";
const NORMALIZED = normalizeRepoFullName(REPOSITORY);
const BRANCH_NAME = "feature/iss12034";
const GAP_PR = 41;
const NOW = new Date("2026-07-12T12:00:00.000Z");
const INSIDE_DEBOUNCE = new Date(
  NOW.getTime() - RECONCILE_PULL_REQUEST_ATTEMPT_DEBOUNCE_MS + 60_000
);

type GapScope = {
  organizationId: string;
  repositoryId: string;
  detailId: string;
  linkId: string;
};

/**
 * A session-linked PR row in the UNCOVERED state, built by the real session
 * ingest and then put into that state explicitly.
 *
 * `isCurrent: false` is the shape of the population this heals — a PR whose
 * branch was reused, so the branch's current pointer moved to a later PR and
 * this one's LOC never landed. The ingest leaves a `gh_pr_create` ref's LOC
 * null already; the update below only makes that explicit alongside the flag,
 * so a future ingest change cannot quietly make the fixture covered.
 *
 * THE session→PR LINK IS SEEDED, not produced by the ingest, and that is
 * load-bearing. Measured here: `syncSession` with a `pull_request` ref writes
 * only a `session_branch` link, which the monitored ratio's Metric audience
 * does not admit — so an ingest-only fixture reports `sessionLinkedPrCount: 0`
 * and cannot express this ticket's population at all. The metadata below is the
 * canonical command-derived shape the sibling delivery suites seed
 * (`delivery-cross-surface-reused-branch.integration.test.ts`).
 */
async function seedUncoveredSessionLinkedPr(): Promise<GapScope> {
  const fixture = await baseFixture();
  committedOrganizations.track(fixture.organizationId);
  const repo = await seedRepo(fixture.organizationId, REPOSITORY);
  await syncSession({
    organizationId: fixture.organizationId,
    userId: fixture.userId,
    computeTargetId: fixture.computeTargetId,
    sourceArtifactId: fixture.sourceArtifactId,
    artifactRefs: [
      branchRef(REPOSITORY, BRANCH_NAME),
      pullRequestRef({
        repositoryFullName: REPOSITORY,
        prNumber: GAP_PR,
        branchName: BRANCH_NAME,
      }),
    ],
  });
  const branch = await findBranch(
    fixture.organizationId,
    NORMALIZED,
    BRANCH_NAME
  );
  if (!branch) {
    throw new Error("session ingest did not create the branch");
  }
  const detail = await findPrByBranchNumber(branch.artifactId, GAP_PR);
  if (!detail) {
    throw new Error("session ingest did not create the PR row");
  }
  const branchLink = await withDb((db) =>
    db.artifactLink.findFirst({
      where: {
        organizationId: fixture.organizationId,
        targetId: branch.artifactId,
      },
      select: { id: true, metadata: true },
    })
  );
  if (!branchLink) {
    throw new Error("session ingest did not link the session to the branch");
  }
  await withDb((db) =>
    db.pullRequestDetail.update({
      where: { id: detail.id },
      data: {
        repositoryId: repo.repositoryId,
        isCurrent: false,
        additions: null,
        deletions: null,
        lastRefreshAttemptAt: null,
      },
    })
  );
  // MERGED INTO the ingest's link, not added beside it: `ArtifactLink` is
  // unique on (sourceId, targetId, linkType), and production does the same —
  // `pr-links.ts` promotes the session→branch link's `linkKind`/`linkKinds` to
  // the PR tier rather than writing a second RELATES_TO edge.
  await withDb((db) =>
    db.artifactLink.update({
      where: { id: branchLink.id },
      data: {
        branchParticipation: BranchParticipationKind.Wrote,
        metadata: {
          ...(branchLink.metadata as Record<string, unknown>),
          linkKind: SessionArtifactLinkKind.SessionPr,
          linkKinds: [SessionArtifactLinkKind.SessionPr],
          prRefs: [
            {
              repositoryFullName: REPOSITORY,
              prNumber: GAP_PR,
              relationTypes: [SessionPrRelationType.Created],
              method: ArtifactRefMethod.PrCreateOutput,
            },
          ],
        },
      },
    })
  );
  return {
    organizationId: fixture.organizationId,
    repositoryId: repo.repositoryId,
    detailId: detail.id,
    linkId: branchLink.id,
  };
}

function selectGap(scope: GapScope) {
  return selectCoverageGapPullRequestTargets({
    organizationId: scope.organizationId,
    repositoryId: scope.repositoryId,
    repositoryFullName: REPOSITORY,
    now: NOW,
  });
}

function patchDetail(detailId: string, data: Record<string, unknown>) {
  return withDb((db) =>
    db.pullRequestDetail.update({ where: { id: detailId }, data })
  );
}

function readCounts(scope: GapScope) {
  return readGitHubDeliveryCoverageCounts({
    organizationId: scope.organizationId,
    repositoryId: scope.repositoryId,
    repositoryFullName: REPOSITORY,
  });
}

async function addSiblingPr(scope: GapScope, number: number) {
  const { branchArtifactId } = await withDb((db) =>
    db.pullRequestDetail.findUniqueOrThrow({
      where: { id: scope.detailId },
      select: { branchArtifactId: true },
    })
  );
  return await withDb((db) =>
    db.pullRequestDetail.create({
      data: {
        organizationId: scope.organizationId,
        repositoryId: scope.repositoryId,
        repositoryFullName: NORMALIZED,
        branchArtifactId,
        number,
        title: "sibling PR on the same branch",
        isCurrent: false,
        additions: null,
        deletions: null,
      },
      select: { id: true },
    })
  );
}

describeIfDb("ISS-12034 installed-tier delivery-coverage gap selector", () => {
  let scope: GapScope;

  beforeEach(async () => {
    scope = await seedUncoveredSessionLinkedPr();
  });

  afterEach(() => committedOrganizations.cleanup());

  it("returns the exact row the monitored coverage ratio is missing", async () => {
    const counts = await readGitHubDeliveryCoverageCounts({
      organizationId: scope.organizationId,
      repositoryId: scope.repositoryId,
      repositoryFullName: REPOSITORY,
    });
    const targets = await selectGap(scope);

    // The shortfall this ticket exists to close: the row is in the denominator
    // and not the numerator, which is what makes the tick actionable.
    expect(counts.sessionLinkedPrCount).toBe(1);
    expect(counts.enrichedOrVisiblePrCount).toBe(0);
    // ...and it is the row the arm now offers the by-number read.
    expect(targets).toEqual([
      expect.objectContaining({
        pullRequestDetailId: scope.detailId,
        number: GAP_PR,
      }),
    ]);

    // The TypeScript predicate agrees with the SQL on this row, read off the
    // stored columns rather than off the fixture's intent.
    const stored = await withDb((db) =>
      db.pullRequestDetail.findUniqueOrThrow({
        where: { id: scope.detailId },
        select: { additions: true, deletions: true, isCurrent: true },
      })
    );
    expect(isDeliveryCoverageCovered(stored)).toBe(false);
  });

  it("skips a row promoted to its branch's current PR", async () => {
    // `isCurrent` alone puts the row in the numerator, so selecting it would
    // spend a provider read on coverage the ratio already has.
    await patchDetail(scope.detailId, { isCurrent: true });

    const counts = await readGitHubDeliveryCoverageCounts({
      organizationId: scope.organizationId,
      repositoryId: scope.repositoryId,
      repositoryFullName: REPOSITORY,
    });

    expect(counts.enrichedOrVisiblePrCount).toBe(1);
    expect(await selectGap(scope)).toEqual([]);
  });

  it("skips a row whose LOC already landed", async () => {
    await patchDetail(scope.detailId, { additions: 10, deletions: 2 });

    const counts = await readGitHubDeliveryCoverageCounts({
      organizationId: scope.organizationId,
      repositoryId: scope.repositoryId,
      repositoryFullName: REPOSITORY,
    });

    expect(counts.enrichedOrVisiblePrCount).toBe(1);
    expect(await selectGap(scope)).toEqual([]);
  });

  it("still selects a row missing only ONE LOC column", async () => {
    // `hasCompleteDeliveryCoverageLoc` requires EVERY field, so its negation is
    // a disjunction. An `AND` there would strand the half-filled row.
    await patchDetail(scope.detailId, { additions: 10, deletions: null });

    expect(await selectGap(scope)).toEqual([
      expect.objectContaining({ number: GAP_PR }),
    ]);
  });

  it("skips a row attempted inside the debounce window", async () => {
    await patchDetail(scope.detailId, {
      lastRefreshAttemptAt: INSIDE_DEBOUNCE,
    });

    expect(await selectGap(scope)).toEqual([]);
  });

  it("offers the row again once the debounce window has passed", async () => {
    // The paired half of the case above: the bound must be a delay, not a
    // permanent exclusion, or one attempt strands the row forever.
    await patchDetail(scope.detailId, {
      lastRefreshAttemptAt: new Date(
        NOW.getTime() - RECONCILE_PULL_REQUEST_ATTEMPT_DEBOUNCE_MS - 60_000
      ),
    });

    expect(await selectGap(scope)).toEqual([
      expect.objectContaining({ number: GAP_PR }),
    ]);
  });

  it("does not select an uncovered row with no session evidence behind it", async () => {
    // Without this clause the arm stops being a coverage heal and becomes an
    // unbounded repository-history refresh. The row is uncovered and on a
    // session-linked BRANCH; what it lacks is a session→PR identity of its own,
    // which is the population `sessionLinkEvidenceSql` exists to exclude.
    const branchArtifactId = await withDb(async (db) => {
      const row = await db.pullRequestDetail.findUniqueOrThrow({
        where: { id: scope.detailId },
        select: { branchArtifactId: true },
      });
      return row.branchArtifactId;
    });
    const unlinked = await withDb((db) =>
      db.pullRequestDetail.create({
        data: {
          organizationId: scope.organizationId,
          repositoryId: scope.repositoryId,
          repositoryFullName: NORMALIZED,
          branchArtifactId,
          number: 9041,
          title: "unlinked history PR",
          isCurrent: false,
          additions: null,
          deletions: null,
        },
        select: { id: true },
      })
    );

    const targets = await selectGap(scope);

    expect(targets.map((target) => target.number)).toEqual([GAP_PR]);
    expect(targets.map((target) => target.pullRequestDetailId)).not.toContain(
      unlinked.id
    );
  });

  it("selects a PR linked only by a reviewing session", async () => {
    // The coverage reader has no participation filter, so a reviewer-only
    // link is in the denominator; the selector must be able to reach it.
    await withDb((db) =>
      db.artifactLink.update({
        where: { id: scope.linkId },
        data: { branchParticipation: BranchParticipationKind.Reviewed },
      })
    );

    const counts = await readCounts(scope);

    expect(counts.sessionLinkedPrCount).toBe(1);
    expect(counts.enrichedOrVisiblePrCount).toBe(0);
    expect(await selectGap(scope)).toEqual([
      expect.objectContaining({ pullRequestDetailId: scope.detailId }),
    ]);
  });

  it("selects a legacy refless session_pr link's only PR on the branch", async () => {
    // `buildSessionPrAdmissionIndex`'s legacy unique-Branch fallback: a
    // `session_pr` link naming no PR admits the branch's single PR row.
    await withDb((db) =>
      db.artifactLink.update({
        where: { id: scope.linkId },
        data: { metadata: { linkKind: SessionArtifactLinkKind.SessionPr } },
      })
    );

    const counts = await readCounts(scope);

    expect(counts.sessionLinkedPrCount).toBe(1);
    expect(counts.enrichedOrVisiblePrCount).toBe(0);
    expect(await selectGap(scope)).toEqual([
      expect.objectContaining({ pullRequestDetailId: scope.detailId }),
    ]);
  });

  it("does not use the legacy fallback once the branch holds a second PR", async () => {
    await withDb((db) =>
      db.artifactLink.update({
        where: { id: scope.linkId },
        data: { metadata: { linkKind: SessionArtifactLinkKind.SessionPr } },
      })
    );
    await addSiblingPr(scope, 9042);

    const counts = await readCounts(scope);

    expect(counts.sessionLinkedPrCount).toBe(0);
    expect(await selectGap(scope)).toEqual([]);
  });

  it("does not select a repo-less row when the repo has an id", async () => {
    // The write (`readReconcileTargetRows`), the attempt stamp and the
    // numerator all scope on `repositoryId` alone, so this row could never be
    // healed or debounced and would hold a batch slot every tick.
    await patchDetail(scope.detailId, { repositoryId: null });

    expect(await selectGap(scope)).toEqual([]);
  });

  it("does not leak a row across organizations", async () => {
    const other = await baseFixture();
    committedOrganizations.track(other.organizationId);

    const targets = await selectCoverageGapPullRequestTargets({
      organizationId: other.organizationId,
      repositoryId: scope.repositoryId,
      repositoryFullName: REPOSITORY,
      now: NOW,
    });

    expect(targets).toEqual([]);
  });
});

/**
 * These cases commit. Every org they seed is deleted after each case, so no
 * open session-linked PR is left for a later suite's global scan (the
 * PR-comment reconcile batch) to pick up.
 */
const committedOrganizations = createCommittedTestOrganizationTracker();
