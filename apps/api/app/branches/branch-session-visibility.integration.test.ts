import { BranchPushSource, LinkType } from "@repo/api/src/types/artifact";
import {
  BranchDataState,
  BranchParticipationKind,
} from "@repo/api/src/types/branch";
import { BranchMetricAvailability } from "@repo/api/src/types/branch-metrics";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { UNCOMPUTED_SESSION_LAST_ACTIVITY_MS } from "@repo/lib/branches/branch-last-active";
import { afterEach, describe, expect, it, vi } from "vitest";
import { persistedGitHubRepositoryAuthority } from "@/__tests__/fixtures/repository-default-authority";
import {
  ACTIVITY_AT,
  createBranchArtifact,
  createCountedPullRequest,
  linkValidSession,
  type TestDb,
} from "@/__tests__/support/branches/visible-branch.test-fixtures";
import {
  createCommittedTestOrganizationTracker,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { branchReadService } from "@/app/branches/branch-read-service";
import type * as CostWindowMetrics from "./branch-cost-window-metrics";
import { readCostMetricFacts } from "./branch-cost-window-metrics";
import type * as PullRequestWindowMetrics from "./branch-pull-request-window-metrics";
import { readPullRequestMetricFacts } from "./branch-pull-request-window-metrics";

/**
 * ISS-6541 — Product Branches require two independent evidence classes for the
 * same canonical Branch: an active SessionDetail-backed explicit Wrote link and
 * verified publication. Session-only and publication-only rows remain auditable
 * internally but are absent from Product list/detail/analytics reads.
 *
 * End-to-end against real Postgres with committed, organization-isolated
 * fixtures so the production repeatable-read boundary remains outermost.
 */

vi.mock("./branch-pull-request-window-metrics", async (importOriginal) => {
  const actual = await importOriginal<typeof PullRequestWindowMetrics>();
  return {
    ...actual,
    readPullRequestMetricFacts: vi.fn(actual.readPullRequestMetricFacts),
  };
});

vi.mock("./branch-cost-window-metrics", async (importOriginal) => {
  const actual = await importOriginal<typeof CostWindowMetrics>();
  return {
    ...actual,
    readCostMetricFacts: vi.fn(actual.readCostMetricFacts),
  };
});

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const committedOrganizations = createCommittedTestOrganizationTracker();

afterEach(() => committedOrganizations.cleanup());

async function attachVerifiedPullRequestPublication(
  db: TestDb,
  organizationId: string,
  branchArtifactId: string,
  branchName: string,
  repositoryFullName: string,
  overrides: {
    baseRepository?: string;
    headBranch?: string;
    headRepository?: string;
  } = {}
): Promise<void> {
  const authority = persistedGitHubRepositoryAuthority({
    githubRepoId: `repo-${branchArtifactId}`,
    fullName: overrides.headRepository ?? repositoryFullName,
  });
  await db.pullRequestDetail.create({
    data: {
      organizationId,
      branchArtifactId,
      repositoryFullName: overrides.baseRepository ?? repositoryFullName,
      number: 1,
      headRefOid: "a".repeat(40),
      headRefName: overrides.headBranch ?? branchName,
      headRepositoryGithubId: authority.githubRepoId,
      headRepositoryFullName: authority.fullName,
      headRepositoryDefaultBranchName: authority.defaultBranchName,
      headRepositoryDefaultBranchAvailability:
        authority.defaultBranchAvailability,
      headRepositoryDefaultBranchCompleteness:
        authority.defaultBranchCompleteness,
      headRepositoryDefaultBranchReason: authority.defaultBranchReason,
      headRepositoryDefaultBranchSource: authority.defaultBranchSource,
      headRepositoryDefaultBranchMechanism: authority.defaultBranchMechanism,
      headRepositoryDefaultBranchTrigger: authority.defaultBranchTrigger,
      headRepositoryDefaultBranchCredentialType:
        authority.defaultBranchCredentialType,
      headRepositoryDefaultBranchObservationKey:
        authority.defaultBranchObservationKey,
      headRepositoryDefaultBranchObservedAt: authority.defaultBranchObservedAt,
    },
    select: { id: true },
  });
}

describeIfDb("Product Branch dual-evidence visibility (ISS-6541)", () => {
  it("excludes a session-only Branch and admits it after verified publication arrives", async () => {
    await committedOrganizations.run(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const { branchId, sessionId } = await withDb(async (db) => {
        const id = await createBranchArtifact(
          db,
          organizationId,
          "session-only",
          { firstPushedAt: null }
        );
        const sid = await linkValidSession(
          db,
          organizationId,
          id,
          "session-only",
          user.id
        );
        return { branchId: id, sessionId: sid };
      });

      expect(
        await branchReadService.getBranchDetail(organizationId, branchId)
      ).toBeNull();
      expect(
        (
          await branchReadService.listBranches(organizationId, {
            limit: 50,
            offset: 0,
          })
        ).items.some((item) => item.id === branchId)
      ).toBe(false);

      await withDb((db) =>
        db.branchDetail.update({
          where: { artifactId: branchId },
          data: {
            firstPushedAt: ACTIVITY_AT,
            pushSource: BranchPushSource.Session,
          },
        })
      );

      const detail = await branchReadService.getBranchDetail(
        organizationId,
        branchId
      );
      expect(detail).not.toBeNull();
      expect(detail?.dataState).toBe(BranchDataState.Ready);
      expect(detail?.sessionIds).toEqual([sessionId]);

      const list = await branchReadService.listBranches(organizationId, {
        limit: 50,
        offset: 0,
      });
      expect(list.items.some((item) => item.id === branchId)).toBe(true);

      const analytics = await branchReadService.getBranchAnalytics(
        organizationId,
        { limit: 50, offset: 0 }
      );
      expect(analytics.activeBranchCount.value).toBe(1);
    });
  });

  it("excludes a branch with NEITHER a linked session NOR remote evidence", async () => {
    await committedOrganizations.run(async () => {
      const organizationId = await createTestOrganization();
      const branchId = await withDb((db) =>
        createBranchArtifact(db, organizationId, "no-evidence", {
          firstPushedAt: null,
        })
      );

      const detail = await branchReadService.getBranchDetail(
        organizationId,
        branchId
      );
      expect(detail).toBeNull();

      const list = await branchReadService.listBranches(organizationId, {
        limit: 50,
        offset: 0,
      });
      expect(list.items.some((item) => item.id === branchId)).toBe(false);
    });
  });

  it("converges when verified PR publication arrives before Wrote evidence", async () => {
    await committedOrganizations.run(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const branchId = await withDb(async (db) => {
        const id = await createBranchArtifact(db, organizationId, "pr-first", {
          firstPushedAt: null,
          repositoryFullName: "contributor/fork",
        });
        await attachVerifiedPullRequestPublication(
          db,
          organizationId,
          id,
          "pr-first",
          "contributor/fork",
          {
            baseRepository: "acme/base",
            headRepository: "/Contributor/Fork.git/",
          }
        );
        return id;
      });

      expect(
        await branchReadService.getBranchDetail(organizationId, branchId)
      ).toBeNull();

      await withDb((db) =>
        linkValidSession(db, organizationId, branchId, "pr-first", user.id)
      );

      expect(
        await branchReadService.getBranchDetail(organizationId, branchId)
      ).not.toBeNull();
    });
  });

  it("fails closed for reviewed, legacy, unknown-push, default, and mismatched PR evidence", async () => {
    await committedOrganizations.run(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const branchIds = await withDb(async (db) => {
        const reviewed = await createBranchArtifact(
          db,
          organizationId,
          "reviewed-only",
          { firstPushedAt: ACTIVITY_AT }
        );
        await linkValidSession(
          db,
          organizationId,
          reviewed,
          "reviewed-only",
          user.id,
          BranchParticipationKind.Reviewed
        );

        const legacy = await createBranchArtifact(
          db,
          organizationId,
          "legacy-link",
          { firstPushedAt: ACTIVITY_AT }
        );
        await linkValidSession(
          db,
          organizationId,
          legacy,
          "legacy-link",
          user.id,
          null
        );

        const unknownPush = await createBranchArtifact(
          db,
          organizationId,
          "unknown-push",
          { firstPushedAt: ACTIVITY_AT }
        );
        await linkValidSession(
          db,
          organizationId,
          unknownPush,
          "unknown-push",
          user.id
        );
        await db.branchDetail.update({
          where: { artifactId: unknownPush },
          data: { pushSource: "unknown" },
          select: { artifactId: true },
        });

        const defaultBranch = await createBranchArtifact(
          db,
          organizationId,
          "main",
          { firstPushedAt: ACTIVITY_AT }
        );
        await linkValidSession(
          db,
          organizationId,
          defaultBranch,
          "main",
          user.id
        );

        const mismatchedPr = await createBranchArtifact(
          db,
          organizationId,
          "mismatched-pr",
          { firstPushedAt: null }
        );
        await linkValidSession(
          db,
          organizationId,
          mismatchedPr,
          "mismatched-pr",
          user.id
        );
        await attachVerifiedPullRequestPublication(
          db,
          organizationId,
          mismatchedPr,
          "mismatched-pr",
          "acme/mismatched-pr",
          { headBranch: "other-branch" }
        );

        return [reviewed, legacy, unknownPush, defaultBranch, mismatchedPr];
      });

      const list = await branchReadService.listBranches(organizationId, {
        limit: 50,
        offset: 0,
      });
      expect(list.items.map((item) => item.id)).not.toEqual(
        expect.arrayContaining(branchIds)
      );
      for (const branchId of branchIds) {
        expect(
          await branchReadService.getBranchDetail(organizationId, branchId)
        ).toBeNull();
      }
    });
  });

  // ISS-8148 (PRD-683 Ruling 2 + D7) deliberately flipped this contract: the
  // divisor originally KEPT unpublished Wrote Branches ("session cost remains
  // eligible before a push/PR"). Ruling 2 retired the pre-publication state —
  // an un-pushed branch no longer materializes at all — so the denominator now
  // requires verified publication too, and a legacy no-evidence row leaves
  // every denominator until push evidence heals it.
  it("excludes an unpublished Wrote Branch from the Session-cost divisor (ISS-8148 D7)", async () => {
    await committedOrganizations.run(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const { publishedId, unpublishedId, sessionId } = await withDb(
        async (db) => {
          const published = await createBranchArtifact(
            db,
            organizationId,
            "published-cost",
            { firstPushedAt: ACTIVITY_AT }
          );
          const session = await linkValidSession(
            db,
            organizationId,
            published,
            "published-cost",
            user.id
          );
          const unpublished = await createBranchArtifact(
            db,
            organizationId,
            "unpublished-cost",
            { firstPushedAt: null }
          );
          await db.artifactLink.create({
            data: {
              organizationId,
              sourceId: session,
              targetId: unpublished,
              linkType: LinkType.RelatesTo,
              branchParticipation: BranchParticipationKind.Wrote,
              metadata: {
                linkKind: SessionArtifactLinkKind.SessionBranch,
              },
            },
            select: { id: true },
          });
          return {
            publishedId: published,
            unpublishedId: unpublished,
            sessionId: session,
          };
        }
      );

      const list = await branchReadService.listBranches(organizationId, {
        limit: 50,
        offset: 0,
      });
      expect(list.items.map((item) => item.id)).toContain(publishedId);
      expect(list.items.map((item) => item.id)).not.toContain(unpublishedId);
      expect(list.sessionBranchCount).toEqual({ [sessionId]: 1 });
    });
  });

  it("retains unavailable Last active in finite windows without fabricating artifact activity", async () => {
    await committedOrganizations.run(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const { branchId, activeBranchId } = await withDb(async (db) => {
        const unavailableId = await createBranchArtifact(
          db,
          organizationId,
          "null-activity",
          { firstPushedAt: ACTIVITY_AT, lastActivityAt: null }
        );
        const unavailableSessionId = await linkValidSession(
          db,
          organizationId,
          unavailableId,
          "null-activity",
          user.id
        );
        // ISS-11915: a linked session's computed last activity IS Last-active
        // evidence, so this branch keeps no activity only while its session
        // holds the uncomputed epoch default.
        await db.sessionDetail.update({
          where: { artifactId: unavailableSessionId },
          data: {
            lastActivityAt: new Date(UNCOMPUTED_SESSION_LAST_ACTIVITY_MS),
          },
          select: { artifactId: true },
        });
        const populatedId = await createBranchArtifact(
          db,
          organizationId,
          "known-activity",
          { firstPushedAt: ACTIVITY_AT, lastActivityAt: ACTIVITY_AT }
        );
        await linkValidSession(
          db,
          organizationId,
          populatedId,
          "known-activity",
          user.id
        );
        return { branchId: unavailableId, activeBranchId: populatedId };
      });

      // Finite top-level windows retain an otherwise qualifying Branch whose
      // authoritative Last active is unavailable.
      const list = await branchReadService.listBranches(organizationId, {
        limit: 50,
        offset: 0,
        startDate: new Date("2020-01-01T00:00:00.000Z"),
        endDate: new Date("2100-01-01T00:00:00.000Z"),
      });
      expect(list.items.map((item) => item.id)).toEqual([
        activeBranchId,
        branchId,
      ]);
      const item = list.items.find((candidate) => candidate.id === branchId);
      expect(item).toMatchObject({
        lastActivityAt: "",
        canonicalLastActiveAt: {
          state: BranchMetricAvailability.Unavailable,
          value: null,
        },
      });

      // The same unavailable Branch remains in another finite window rather
      // than being included/excluded based on artifact creation time.
      const pastOnly = await branchReadService.listBranches(organizationId, {
        limit: 50,
        offset: 0,
        startDate: new Date("2020-01-01T00:00:00.000Z"),
        endDate: new Date("2020-12-31T00:00:00.000Z"),
      });
      expect(pastOnly.items.some((item) => item.id === branchId)).toBe(true);
    });
  });

  it("publishes Median PR size and Merge rate from the cohort's verified, session-linked pull requests", async () => {
    await committedOrganizations.run(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const branchIds = await withDb(async (db) => {
        const ids: string[] = [];
        for (const [index, size] of [10, 30].entries()) {
          const name = `sized-${index}`;
          const branchId = await createBranchArtifact(
            db,
            organizationId,
            name,
            { firstPushedAt: ACTIVITY_AT }
          );
          ids.push(branchId);
          await linkValidSession(db, organizationId, branchId, name, user.id);
          await createCountedPullRequest(db, organizationId, branchId, {
            number: index + 1,
            repositoryFullName: `acme/${name}`,
            additions: size,
            deletions: 0,
            mergedAt: ACTIVITY_AT,
          });
        }
        const closedName = "closed-unmerged";
        const closedBranchId = await createBranchArtifact(
          db,
          organizationId,
          closedName,
          { firstPushedAt: ACTIVITY_AT }
        );
        await linkValidSession(
          db,
          organizationId,
          closedBranchId,
          closedName,
          user.id
        );
        await createCountedPullRequest(db, organizationId, closedBranchId, {
          number: 9,
          repositoryFullName: `acme/${closedName}`,
          additions: 1000,
          deletions: 0,
          closedAt: ACTIVITY_AT,
        });
        ids.push(closedBranchId);
        // Operator ruling 2026-10-14: a closed, unmerged draft is excluded from
        // Merge rate and Median PR size and does not star either card.
        const draftName = "closed-draft";
        const draftBranchId = await createBranchArtifact(
          db,
          organizationId,
          draftName,
          { firstPushedAt: ACTIVITY_AT }
        );
        await linkValidSession(
          db,
          organizationId,
          draftBranchId,
          draftName,
          user.id
        );
        await createCountedPullRequest(db, organizationId, draftBranchId, {
          number: 10,
          repositoryFullName: `acme/${draftName}`,
          additions: 1000,
          deletions: 0,
          closedAt: ACTIVITY_AT,
          isDraft: true,
        });
        return ids;
      });

      const analytics = await branchReadService.getBranchAnalytics(
        organizationId,
        { limit: 50, offset: 0 }
      );

      expect(readPullRequestMetricFacts).toHaveBeenCalledWith(
        organizationId,
        expect.anything(),
        expect.arrayContaining([expect.objectContaining({ startAt: null })])
      );
      expect(analytics.canonicalMetrics?.medianPrSize.current).toEqual({
        state: BranchMetricAvailability.Complete,
        value: 20,
      });
      expect(analytics.canonicalMetrics?.mergeRatePct.current).toEqual({
        state: BranchMetricAvailability.Complete,
        value: (2 / 3) * 100,
      });

      const cohort = await branchReadService.getBranchCohortAnalytics(
        organizationId,
        { branchIds: branchIds.slice(0, 2) }
      );

      expect(readPullRequestMetricFacts).toHaveBeenCalledTimes(2);
      expect(cohort.canonicalMetrics.medianPrSize.current).toEqual({
        state: BranchMetricAvailability.Complete,
        value: 20,
      });
      expect(cohort.canonicalMetrics.mergeRatePct.current).toEqual({
        state: BranchMetricAvailability.Complete,
        value: 100,
      });
    });
  });

  it("reads AI spend from the cost SQL, splitting each event across the branches its session wrote to (ISS-12346)", async () => {
    await committedOrganizations.run(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const sharedId = await withDb(async (db) => {
        const sharedName = "shared-spend";
        const otherName = "other-spend";
        const sharedBranchId = await createBranchArtifact(
          db,
          organizationId,
          sharedName,
          { firstPushedAt: ACTIVITY_AT }
        );
        const otherId = await createBranchArtifact(
          db,
          organizationId,
          otherName,
          { firstPushedAt: ACTIVITY_AT }
        );
        for (const [branchId, name] of [
          [sharedBranchId, sharedName],
          [otherId, otherName],
        ] as const) {
          await attachVerifiedPullRequestPublication(
            db,
            organizationId,
            branchId,
            name,
            `acme/${name}`
          );
        }
        const sessionId = await linkValidSession(
          db,
          organizationId,
          sharedBranchId,
          sharedName,
          user.id
        );
        await db.artifactLink.create({
          data: {
            organizationId,
            sourceId: sessionId,
            targetId: otherId,
            linkType: LinkType.RelatesTo,
            branchParticipation: BranchParticipationKind.Wrote,
            metadata: { linkKind: SessionArtifactLinkKind.SessionBranch },
          },
          select: { id: true },
        });
        await db.agentSessionTokenEvent.create({
          data: {
            agentSessionId: sessionId,
            externalEventId: "spend-1",
            model: "claude",
            estimatedCost: 6,
            eventCreatedAt: ACTIVITY_AT,
          },
          select: { id: true },
        });
        return sharedBranchId;
      });

      const analytics = await branchReadService.getBranchAnalytics(
        organizationId,
        { limit: 50, offset: 0 }
      );

      expect(readCostMetricFacts).toHaveBeenCalledWith(
        organizationId,
        expect.arrayContaining([expect.any(String)]),
        expect.anything(),
        expect.arrayContaining([expect.objectContaining({ startAt: null })])
      );
      // Two branches share the session, so the cohort holds the whole $6.
      expect(analytics.canonicalMetrics?.aiSpendUsd.current).toEqual({
        state: BranchMetricAvailability.Complete,
        value: 6,
      });

      // One of the two: it takes its half, so the divisor is the org-wide set.
      const cohort = await branchReadService.getBranchCohortAnalytics(
        organizationId,
        { branchIds: [sharedId] }
      );
      expect(cohort.canonicalMetrics.aiSpendUsd.current).toEqual({
        state: BranchMetricAvailability.Complete,
        value: 3,
      });
    });
  });

  it("takes Median PR size and Merge rate over a custom date range, and the other metrics over all time (ISS-11589 D2)", async () => {
    await committedOrganizations.run(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      await withDb(async (db) => {
        const branchId = await createBranchArtifact(
          db,
          organizationId,
          "ranged",
          { firstPushedAt: ACTIVITY_AT }
        );
        await linkValidSession(db, organizationId, branchId, "ranged", user.id);
        await createCountedPullRequest(db, organizationId, branchId, {
          number: 1,
          repositoryFullName: "acme/ranged",
          additions: 10,
          deletions: 0,
          mergedAt: ACTIVITY_AT,
        });
      });

      const before = await branchReadService.getBranchAnalytics(
        organizationId,
        {
          limit: 50,
          offset: 0,
          startDate: new Date("2026-06-20T00:00:00.000Z"),
          endDate: new Date("2026-07-05T00:00:00.000Z"),
        }
      );
      const after = await branchReadService.getBranchAnalytics(organizationId, {
        limit: 50,
        offset: 0,
        startDate: new Date("2026-07-10T00:00:00.000Z"),
        endDate: new Date("2026-07-25T00:00:00.000Z"),
      });

      expect(before.canonicalMetrics?.medianPrSize.current).toEqual({
        state: BranchMetricAvailability.Complete,
        value: 10,
      });
      expect(after.canonicalMetrics?.medianPrSize.current).toEqual({
        state: BranchMetricAvailability.NoData,
        value: null,
      });
      expect(after.canonicalMetrics?.mergeRatePct.current).toEqual({
        state: BranchMetricAvailability.NotApplicable,
        value: null,
      });
    });
  });

  it("keeps a remote-evidence branch with NO valid session OUT of the corpus (FEA-4225 preserved)", async () => {
    await committedOrganizations.run(async () => {
      const organizationId = await createTestOrganization();
      const branchId = await withDb((db) =>
        createBranchArtifact(db, organizationId, "remote-only", {
          firstPushedAt: ACTIVITY_AT,
        })
      );

      // Publication alone cannot attribute Session cost, so the Branch stays
      // hidden and its detail route fails closed.
      const detail = await branchReadService.getBranchDetail(
        organizationId,
        branchId
      );
      expect(detail).toBeNull();

      const list = await branchReadService.listBranches(organizationId, {
        limit: 50,
        offset: 0,
      });
      expect(list.items.some((item) => item.id === branchId)).toBe(false);
    });
  });
});

function createTestOrganization(): Promise<string> {
  return committedOrganizations.create();
}
