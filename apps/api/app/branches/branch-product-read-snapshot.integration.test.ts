import { BranchPushSource, LinkType } from "@repo/api/src/types/artifact";
import {
  BranchParticipationKind,
  BranchStatus,
} from "@repo/api/src/types/branch";
import {
  BranchActivityAtomVersion,
  BranchActivityAttributionKind,
  BranchActivityEvidenceCompleteness,
  BranchActivitySource,
} from "@repo/api/src/types/branch-activity";
import {
  BRANCH_LIST_SERVER_PAGE_SIZE,
  BranchListFacetAvailability,
  BranchListPageMode,
  BranchListSortDirection,
  BranchListSortKey,
} from "@repo/api/src/types/branch-list-contract";
import {
  CommentSurface,
  CommentTargetType,
  TRACE_COMMENT_METADATA_KIND,
  TRACE_COMMENT_SCHEMA_VERSION,
} from "@repo/api/src/types/comment";
import { CommentBodyFormat } from "@repo/api/src/types/comment-thread-dto";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import { ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it, vi } from "vitest";
import { persistedGitHubRepositoryAuthority } from "@/__tests__/fixtures/repository-default-authority";
import {
  createCommittedTestOrganizationTracker,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { traceCommentsService } from "@/app/trace-comments/service";
import {
  BranchProductReadWorkload,
  withBranchProductReadSnapshot,
} from "./branch-product-read-snapshot";

const candidateReadBarrier = vi.hoisted(() => {
  type BarrierState = {
    markReached: () => void;
    reached: Promise<void>;
    release: () => void;
    released: Promise<void>;
  };

  let active: BarrierState | null = null;
  return {
    arm(): Pick<BarrierState, "reached" | "release"> {
      if (active) {
        throw new Error("Candidate read barrier is already armed");
      }
      let markReached: () => void = () => undefined;
      let markReleased: () => void = () => undefined;
      const reached = new Promise<void>((resolve) => {
        markReached = resolve;
      });
      const released = new Promise<void>((resolve) => {
        markReleased = resolve;
      });
      const state: BarrierState = {
        markReached,
        reached,
        released,
        release: () => {
          markReleased();
          if (active === state) {
            active = null;
          }
        },
      };
      active = state;
      return { reached, release: state.release };
    },
    releaseActive(): void {
      active?.release();
    },
    async waitAfterCandidateRead(): Promise<void> {
      const state = active;
      if (!state) {
        return;
      }
      state.markReached();
      await state.released;
    },
  };
});

vi.mock("./branch-candidate-read", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./branch-candidate-read")>();
  return {
    ...actual,
    getBranchCandidateIds: async (
      ...args: Parameters<typeof actual.getBranchCandidateIds>
    ) => {
      const result = await actual.getBranchCandidateIds(...args);
      await candidateReadBarrier.waitAfterCandidateRead();
      return result;
    },
    getBranchCandidatePage: async (
      ...args: Parameters<typeof actual.getBranchCandidatePage>
    ) => {
      const result = await actual.getBranchCandidatePage(...args);
      await candidateReadBarrier.waitAfterCandidateRead();
      return result;
    },
    getBranchCandidateSnapshots: async (
      ...args: Parameters<typeof actual.getBranchCandidateSnapshots>
    ) => {
      const result = await actual.getBranchCandidateSnapshots(...args);
      await candidateReadBarrier.waitAfterCandidateRead();
      return result;
    },
  };
});

import { branchReadService } from "./branch-read-service";

const ACTIVITY_AT = new Date("2026-07-01T00:00:00.000Z");
const PRODUCT_EVIDENCE_REVOCATION = {
  Publication: "publication",
  Wrote: "wrote",
} as const;

type ProductEvidenceRevocation =
  (typeof PRODUCT_EVIDENCE_REVOCATION)[keyof typeof PRODUCT_EVIDENCE_REVOCATION];
type TestDb = Parameters<Parameters<typeof withDb>[0]>[0];

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;
const committedOrganizations = createCommittedTestOrganizationTracker();

afterEach(async () => {
  candidateReadBarrier.releaseActive();
  await committedOrganizations.cleanup();
});

describeIfDb("Product Branch read snapshots (ISS-6557)", () => {
  it("allows concurrent full-corpus reads within their transaction budgets", async () => {
    await committedOrganizations.run(async () => {
      let markFirstEntered: () => void = () => undefined;
      let releaseFirst: () => void = () => undefined;
      const firstEntered = new Promise<void>((resolve) => {
        markFirstEntered = resolve;
      });
      const firstReleased = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const firstRead = withBranchProductReadSnapshot(
        "full-corpus",
        async () => {
          markFirstEntered();
          await firstReleased;
          return "first";
        },
        BranchProductReadWorkload.FullCorpus
      );
      await firstEntered;

      try {
        await expect(
          withBranchProductReadSnapshot(
            "full-corpus",
            async () => "second",
            BranchProductReadWorkload.FullCorpus
          )
        ).resolves.toBe("second");
      } finally {
        releaseFirst();
      }
      await expect(firstRead).resolves.toBe("first");
    });
  });

  it("orders the full atom corpus before the 100/101 page boundary", async () => {
    await committedOrganizations.run(async () => {
      const organizationId = await committedOrganizations.create();
      const user = await createTestUser(organizationId);
      const { expectedIds, finalPageId } = await withDb((db) =>
        seedCanonicalPagingCorpus(db, organizationId, user.id)
      );

      const first = await branchReadService.listBranches(organizationId, {
        limit: 100,
        offset: 0,
      });
      const second = await branchReadService.listBranches(organizationId, {
        limit: 100,
        offset: 100,
      });

      expect(first.items.map((item) => item.id)).toEqual(
        expectedIds.slice(0, 100)
      );
      expect(first.total).toBe(101);
      expect(first.hasMore).toBe(true);
      expect(second.items.map((item) => item.id)).toEqual(
        expectedIds.slice(100)
      );
      expect(second.items[0]?.id).toBe(finalPageId);
      expect(second.items[0]?.lastActivityAt).toBe("2026-07-02T00:00:01.000Z");
      expect(second.total).toBe(101);
      expect(second.hasMore).toBe(false);
      expect(first.items[0]?.lastActivityAt).not.toBe(
        "2099-01-01T00:00:00.000Z"
      );
    });
  });

  it("keeps a 101-candidate page stable across a post-selection Wrote revocation", async () => {
    await committedOrganizations.run(async () => {
      const organizationId = await committedOrganizations.create();
      const user = await createTestUser(organizationId);
      const { expectedIds, finalPageId } = await withDb((db) =>
        seedCanonicalPagingCorpus(db, organizationId, user.id, 101)
      );
      await withDb((db) =>
        seedIneligibleBoundaryNoise(db, organizationId, user.id, "wrote-101")
      );

      const inFlight = await readAcrossProductRevocation(
        organizationId,
        finalPageId,
        PRODUCT_EVIDENCE_REVOCATION.Wrote,
        () =>
          branchReadService.listBranches(organizationId, {
            limit: 100,
            offset: 0,
          })
      );

      expect(inFlight.items.map((item) => item.id)).toEqual(
        expectedIds.slice(0, 100)
      );
      expect(inFlight.total).toBe(101);
      expect(inFlight.hasMore).toBe(true);

      const next = await branchReadService.listBranches(organizationId, {
        limit: 100,
        offset: 0,
      });
      expect(next.items.map((item) => item.id)).toEqual(
        expectedIds.slice(0, 100)
      );
      expect(next.total).toBe(100);
      expect(next.hasMore).toBe(false);
    });
  });

  it("keeps a 100-candidate page stable across a post-selection publication revocation", async () => {
    await committedOrganizations.run(async () => {
      const organizationId = await committedOrganizations.create();
      const user = await createTestUser(organizationId);
      const { expectedIds } = await withDb((db) =>
        seedCanonicalPagingCorpus(db, organizationId, user.id, 100)
      );
      await withDb((db) =>
        seedIneligibleBoundaryNoise(
          db,
          organizationId,
          user.id,
          "publication-100"
        )
      );
      const revokedBranchId = expectedIds[40];
      if (!revokedBranchId) {
        throw new Error("Expected a Branch at the 100-candidate boundary");
      }

      const inFlight = await readAcrossProductRevocation(
        organizationId,
        revokedBranchId,
        PRODUCT_EVIDENCE_REVOCATION.Publication,
        () =>
          branchReadService.listBranches(organizationId, {
            limit: 100,
            offset: 0,
          })
      );

      expect(inFlight.items.map((item) => item.id)).toEqual(expectedIds);
      expect(inFlight.total).toBe(100);
      expect(inFlight.hasMore).toBe(false);

      const next = await branchReadService.listBranches(organizationId, {
        limit: 100,
        offset: 0,
      });
      expect(next.items.map((item) => item.id)).toEqual(
        expectedIds.filter((branchId) => branchId !== revokedBranchId)
      );
      expect(next.total).toBe(99);
      expect(next.hasMore).toBe(false);
    });
  });

  it("keeps server rows, total, and every facet on one pre-revocation snapshot", async () => {
    await committedOrganizations.run(async () => {
      const organizationId = await committedOrganizations.create();
      const user = await createTestUser(organizationId);
      const { targetBranchId } = await withDb((db) =>
        seedRacePair(db, organizationId, user.id, "server-page-snapshot")
      );
      const query = {
        pageMode: BranchListPageMode.Server,
        limit: BRANCH_LIST_SERVER_PAGE_SIZE,
        offset: 0,
        sortKey: BranchListSortKey.Name,
        sortDir: BranchListSortDirection.Asc,
      } as const;

      const inFlight = await readAcrossProductRevocation(
        organizationId,
        targetBranchId,
        PRODUCT_EVIDENCE_REVOCATION.Wrote,
        () => branchReadService.listBranches(organizationId, query)
      );

      expect(inFlight.items).toHaveLength(2);
      expect(inFlight.total).toBe(2);
      expect(inFlight.lastActiveCohort?.total).toBe(2);
      expect(inFlight.lastActiveCohort?.evaluationNow).toBe(
        inFlight.pageInfo?.now
      );
      expect(inFlight.facets).toBeDefined();
      expect(inFlight.facets?.names.availability).toBe(
        BranchListFacetAvailability.Complete
      );
      expect(inFlight.facets?.statuses.availability).toBe(
        BranchListFacetAvailability.Complete
      );
      expect(inFlight.facets?.pullRequests.availability).toBe(
        BranchListFacetAvailability.Complete
      );
      expect(inFlight.facets?.lastActiveRanges.availability).toBe(
        BranchListFacetAvailability.Complete
      );
      expect(inFlight.facets?.repositories.availability).toBe(
        BranchListFacetAvailability.Complete
      );

      const next = await branchReadService.listBranches(organizationId, query);
      expect(next.items).toHaveLength(1);
      expect(next.total).toBe(1);
      expect(next.lastActiveCohort?.total).toBe(1);
      expect(next.lastActiveCohort?.evaluationNow).toBe(next.pageInfo?.now);
      expect(next.facets?.names.options).toHaveLength(1);
    });
  });

  it.each([
    PRODUCT_EVIDENCE_REVOCATION.Wrote,
    PRODUCT_EVIDENCE_REVOCATION.Publication,
  ])(
    "keeps usage on its opening snapshot across a post-selection %s revocation",
    async (revocation) => {
      await committedOrganizations.run(async () => {
        const organizationId = await committedOrganizations.create();
        const user = await createTestUser(organizationId);
        const { targetBranchId } = await withDb((db) =>
          seedRacePair(db, organizationId, user.id, `usage-${revocation}`)
        );

        const inFlight = await readAcrossProductRevocation(
          organizationId,
          targetBranchId,
          revocation,
          () =>
            branchReadService.getBranchUsage(organizationId, {
              limit: 50,
              offset: 0,
            })
        );
        expect(inFlight.totalBranches).toBe(2);

        const next = await branchReadService.getBranchUsage(organizationId, {
          limit: 50,
          offset: 0,
        });
        expect(next.totalBranches).toBe(1);
      });
    }
  );

  it.each([
    PRODUCT_EVIDENCE_REVOCATION.Wrote,
    PRODUCT_EVIDENCE_REVOCATION.Publication,
  ])(
    "keeps analytics on its opening snapshot across a post-selection %s revocation",
    async (revocation) => {
      await committedOrganizations.run(async () => {
        const organizationId = await committedOrganizations.create();
        const user = await createTestUser(organizationId);
        const { targetBranchId } = await withDb((db) =>
          seedRacePair(db, organizationId, user.id, `analytics-${revocation}`)
        );

        const inFlight = await readAcrossProductRevocation(
          organizationId,
          targetBranchId,
          revocation,
          () =>
            branchReadService.getBranchAnalytics(organizationId, {
              limit: 50,
              offset: 0,
            })
        );
        expect(inFlight.activeBranchCount.value).toBe(2);

        const next = await branchReadService.getBranchAnalytics(
          organizationId,
          {
            limit: 50,
            offset: 0,
          }
        );
        expect(next.activeBranchCount.value).toBe(1);
      });
    }
  );

  it.each([
    PRODUCT_EVIDENCE_REVOCATION.Wrote,
    PRODUCT_EVIDENCE_REVOCATION.Publication,
  ])(
    "keeps cohorts on their opening snapshot across a post-selection %s revocation",
    async (revocation) => {
      await committedOrganizations.run(async () => {
        const organizationId = await committedOrganizations.create();
        const user = await createTestUser(organizationId);
        const { targetBranchId, controlBranchId } = await withDb((db) =>
          seedRacePair(db, organizationId, user.id, `cohort-${revocation}`)
        );
        const branchIds = [targetBranchId, controlBranchId];

        const inFlight = await readAcrossProductRevocation(
          organizationId,
          targetBranchId,
          revocation,
          () =>
            branchReadService.getBranchCohortAnalytics(organizationId, {
              branchIds,
            })
        );
        expect(inFlight.matchedBranchIds).toEqual(branchIds);
        expect(inFlight.canonicalMetrics.cohortSize).toBe(2);

        const next = await branchReadService.getBranchCohortAnalytics(
          organizationId,
          { branchIds }
        );
        expect(next.matchedBranchIds).toEqual([controlBranchId]);
        expect(next.canonicalMetrics.cohortSize).toBe(1);
      });
    }
  );

  it.each([
    PRODUCT_EVIDENCE_REVOCATION.Wrote,
    PRODUCT_EVIDENCE_REVOCATION.Publication,
  ])(
    "removes Branch trace comments and aggregate counts after %s revocation",
    async (revocation) => {
      await committedOrganizations.run(async () => {
        const organizationId = await committedOrganizations.create();
        const user = await createTestUser(organizationId);
        const { targetBranchId } = await withDb((db) =>
          seedRacePair(db, organizationId, user.id, `comments-${revocation}`)
        );
        await withDb((db) =>
          seedBranchTraceComment(db, organizationId, user.id, targetBranchId)
        );

        const target = {
          type: CommentTargetType.Branch,
          id: targetBranchId,
        } as const;
        await expect(
          traceCommentsService.list({ organizationId, userId: user.id, target })
        ).resolves.toHaveLength(1);
        await expect(
          traceCommentsService.listAll({
            organizationId,
            userId: user.id,
            filters: { targetType: CommentTargetType.Branch },
          })
        ).resolves.toMatchObject({
          total: 1,
          items: [{ artifactId: targetBranchId }],
        });

        await revokeProductEvidence(organizationId, targetBranchId, revocation);

        await expect(
          traceCommentsService.list({ organizationId, userId: user.id, target })
        ).resolves.toBeNull();
        await expect(
          traceCommentsService.listAll({
            organizationId,
            userId: user.id,
            filters: { targetType: CommentTargetType.Branch },
          })
        ).resolves.toEqual({ items: [], total: 0, nextCursor: null });
      });
    }
  );
});

async function seedBranchTraceComment(
  db: TestDb,
  organizationId: string,
  userId: string,
  branchId: string
): Promise<void> {
  await db.commentThread.create({
    data: {
      organizationId,
      artifactId: branchId,
      createdById: userId,
      metadata: {
        kind: TRACE_COMMENT_METADATA_KIND,
        schemaVersion: TRACE_COMMENT_SCHEMA_VERSION,
        targetType: CommentTargetType.Branch,
        surface: CommentSurface.BranchDetail,
      },
      anchor: {
        v: 1,
        kind: "trace",
        traceId: `trace:${branchId}:0`,
        turnId: `turn:${branchId}:0`,
        row: 0,
        selectedText: "Product Branch",
        sourceText: "Product Branch comment",
        startOffset: 0,
        endOffset: 14,
        sessionId: branchId,
        actor: { name: "codex", human: null },
      },
      comments: {
        create: {
          authorId: userId,
          plainText: "Product Branch comment",
          body: { type: "doc", content: [] },
          bodyFormat: CommentBodyFormat.RichV1,
        },
      },
    },
    select: { id: true },
  });
}

async function seedCanonicalPagingCorpus(
  db: TestDb,
  organizationId: string,
  userId: string,
  branchCount = 101
): Promise<{ expectedIds: string[]; finalPageId: string }> {
  const repositories = [
    { fullName: "/acme/zeta.git/", owner: "acme", name: "zeta" },
    { fullName: "acme/alpha", owner: "acme", name: "alpha" },
    {
      fullName: "acme/canonical-paging",
      owner: "acme",
      name: "canonical-paging",
    },
  ];
  await db.publicRepository.createMany({
    data: repositories.map((repository, index) => ({
      organizationId,
      ...persistedGitHubRepositoryAuthority({
        githubRepoId: `repo-canonical-paging-${index}-${organizationId}`,
        fullName: repository.fullName,
      }),
      owner: repository.owner,
      name: repository.name,
      htmlUrl: `https://github.com/${repository.owner}/${repository.name}`,
    })),
  });
  const tieAt = new Date("2026-07-02T00:03:00.000Z");
  const branches = Array.from({ length: branchCount }, (_, index) => ({
    id: canonicalPagingBranchId(index),
    branchName: canonicalPagingBranchName(index),
    repositoryFullName: canonicalPagingRepositoryFullName(index),
    occurredAt:
      index < 3
        ? tieAt
        : new Date(
            Date.parse("2026-07-02T00:00:00.000Z") +
              (branchCount - index) * 1000
          ),
  }));
  await db.artifact.createMany({
    data: [...branches].reverse().map((branch) => ({
      id: branch.id,
      organizationId,
      type: ArtifactType.BRANCH,
      name: branch.branchName,
      status: BranchStatus.Open,
    })),
  });
  await db.branchDetail.createMany({
    data: branches.map((branch) => ({
      artifactId: branch.id,
      organizationId,
      repositoryFullName: branch.repositoryFullName,
      branchName: branch.branchName,
      firstPushedAt: ACTIVITY_AT,
      pushSource: BranchPushSource.Session,
      lastActivityAt: new Date("2099-01-01T00:00:00.000Z"),
    })),
  });
  await db.branchActivityAtom.createMany({
    data: [
      ...[...branches].reverse().map((branch) => ({
        version: BranchActivityAtomVersion.V1,
        organizationId,
        branchArtifactId: branch.id,
        source: BranchActivitySource.GitHead,
        sourceEventId: `fixture:${branch.id}`,
        occurredAt: branch.occurredAt,
        attributionKind: BranchActivityAttributionKind.Branch,
        completeness: BranchActivityEvidenceCompleteness.Complete,
      })),
      {
        version: BranchActivityAtomVersion.V1 + 1,
        organizationId,
        branchArtifactId: canonicalPagingBranchId(branchCount - 1),
        source: "future_source",
        sourceEventId: "newer-invalid-atom",
        occurredAt: new Date("2099-01-01T00:00:00.000Z"),
        attributionKind: BranchActivityAttributionKind.Branch,
        completeness: BranchActivityEvidenceCompleteness.Complete,
      },
    ],
  });
  const session = await db.artifact.create({
    data: {
      organizationId,
      type: ArtifactType.SESSION,
      name: "canonical-paging-session",
      status: BranchStatus.Open,
    },
    select: { id: true },
  });
  const computeTarget = await db.computeTarget.create({
    data: {
      organizationId,
      userId,
      machineName: "machine-canonical-paging",
      platform: "darwin",
    },
    select: { id: true },
  });
  await db.sessionDetail.create({
    data: {
      artifactId: session.id,
      computeTargetId: computeTarget.id,
      externalSessionId: "ext-canonical-paging",
      harness: "claude",
      sessionStartedAt: ACTIVITY_AT,
      sessionUpdatedAt: ACTIVITY_AT,
      lastActivityAt: ACTIVITY_AT,
    },
    select: { artifactId: true },
  });
  await db.artifactLink.createMany({
    data: branches.map((branch) => ({
      organizationId,
      sourceId: session.id,
      targetId: branch.id,
      linkType: LinkType.RelatesTo,
      branchParticipation: BranchParticipationKind.Wrote,
      metadata: { linkKind: SessionArtifactLinkKind.SessionBranch },
    })),
  });
  const expectedIds = [
    canonicalPagingBranchId(2),
    canonicalPagingBranchId(1),
    canonicalPagingBranchId(0),
    ...Array.from({ length: branchCount - 3 }, (_, index) =>
      canonicalPagingBranchId(index + 3)
    ),
  ];
  return {
    expectedIds,
    finalPageId: canonicalPagingBranchId(branchCount - 1),
  };
}

function canonicalPagingBranchId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function canonicalPagingBranchName(index: number): string {
  if (index === 0) {
    return " feature-zeta ";
  }
  if (index === 1) {
    return " zulu ";
  }
  if (index === 2) {
    return "alpha";
  }
  return `canonical-page-${String(index).padStart(3, "0")}`;
}

function canonicalPagingRepositoryFullName(index: number): string {
  if (index === 0) {
    return "/acme/zeta.git/";
  }
  if (index < 3) {
    return "acme/alpha";
  }
  return "acme/canonical-paging";
}

async function seedIneligibleBoundaryNoise(
  db: TestDb,
  organizationId: string,
  userId: string,
  fixtureName: string
): Promise<void> {
  const sessionOnlyName = `${fixtureName}-session-only`;
  const sessionOnlyId = await createPublishedBranch(
    db,
    organizationId,
    sessionOnlyName,
    null
  );
  await linkValidSession(
    db,
    organizationId,
    sessionOnlyId,
    sessionOnlyName,
    userId
  );
  await createPublishedBranch(
    db,
    organizationId,
    `${fixtureName}-publication-only`,
    ACTIVITY_AT
  );
}

async function seedRacePair(
  db: TestDb,
  organizationId: string,
  userId: string,
  fixtureName: string
): Promise<{ targetBranchId: string; controlBranchId: string }> {
  const targetBranchName = `${fixtureName}-target`;
  const targetBranchId = await createPublishedBranch(
    db,
    organizationId,
    targetBranchName,
    ACTIVITY_AT
  );
  await linkValidSession(
    db,
    organizationId,
    targetBranchId,
    targetBranchName,
    userId
  );

  const controlBranchName = `${fixtureName}-control`;
  const controlBranchId = await createPublishedBranch(
    db,
    organizationId,
    controlBranchName,
    ACTIVITY_AT
  );
  await linkValidSession(
    db,
    organizationId,
    controlBranchId,
    controlBranchName,
    userId
  );
  return { targetBranchId, controlBranchId };
}

async function createPublishedBranch(
  db: TestDb,
  organizationId: string,
  branchName: string,
  firstPushedAt: Date | null
): Promise<string> {
  const artifact = await db.artifact.create({
    data: {
      organizationId,
      type: ArtifactType.BRANCH,
      name: branchName,
      status: BranchStatus.Open,
    },
    select: { id: true },
  });
  const repositoryFullName = `acme/${branchName}`;
  await db.branchDetail.create({
    data: {
      artifactId: artifact.id,
      organizationId,
      repositoryFullName,
      branchName,
      firstPushedAt,
      pushSource: firstPushedAt ? BranchPushSource.Session : null,
      lastActivityAt: ACTIVITY_AT,
    },
    select: { artifactId: true },
  });
  await db.branchActivityAtom.create({
    data: {
      version: BranchActivityAtomVersion.V1,
      organizationId,
      branchArtifactId: artifact.id,
      source: BranchActivitySource.GitHead,
      sourceEventId: `fixture:${branchName}`,
      occurredAt: ACTIVITY_AT,
      attributionKind: BranchActivityAttributionKind.Branch,
      completeness: BranchActivityEvidenceCompleteness.Complete,
    },
    select: { id: true },
  });
  await db.publicRepository.create({
    data: {
      organizationId,
      ...persistedGitHubRepositoryAuthority({
        githubRepoId: `repo-${artifact.id}`,
        fullName: repositoryFullName,
      }),
      owner: "acme",
      name: branchName,
      htmlUrl: `https://github.com/${repositoryFullName}`,
    },
    select: { id: true },
  });
  return artifact.id;
}

async function linkValidSession(
  db: TestDb,
  organizationId: string,
  branchArtifactId: string,
  branchName: string,
  userId: string
): Promise<void> {
  const session = await db.artifact.create({
    data: {
      organizationId,
      type: ArtifactType.SESSION,
      name: `session-for-${branchName}`,
      status: BranchStatus.Open,
    },
    select: { id: true },
  });
  const computeTarget = await db.computeTarget.create({
    data: {
      organizationId,
      userId,
      machineName: `machine-${branchName}`,
      platform: "darwin",
    },
    select: { id: true },
  });
  await db.sessionDetail.create({
    data: {
      artifactId: session.id,
      computeTargetId: computeTarget.id,
      externalSessionId: `ext-${branchName}`,
      harness: "claude",
      sessionStartedAt: ACTIVITY_AT,
      sessionUpdatedAt: ACTIVITY_AT,
      lastActivityAt: ACTIVITY_AT,
    },
    select: { artifactId: true },
  });
  await db.artifactLink.create({
    data: {
      organizationId,
      sourceId: session.id,
      targetId: branchArtifactId,
      linkType: LinkType.RelatesTo,
      branchParticipation: BranchParticipationKind.Wrote,
      metadata: { linkKind: SessionArtifactLinkKind.SessionBranch },
    },
    select: { id: true },
  });
}

async function readAcrossProductRevocation<Result>(
  organizationId: string,
  branchId: string,
  revocation: ProductEvidenceRevocation,
  read: () => Promise<Result>
): Promise<Result> {
  const barrier = candidateReadBarrier.arm();
  const readPromise = read();
  try {
    const boundary = await Promise.race([
      barrier.reached.then(() => ({ state: "reached" as const })),
      readPromise.then(
        () => ({ state: "finished" as const }),
        (error: unknown) => ({ state: "failed" as const, error })
      ),
    ]);
    if (boundary.state === "failed") {
      throw boundary.error;
    }
    if (boundary.state === "finished") {
      throw new Error(
        "Branch corpus read finished before the candidate barrier"
      );
    }
    await revokeProductEvidence(organizationId, branchId, revocation);
    barrier.release();
    return await readPromise;
  } catch (error) {
    barrier.release();
    await readPromise.catch(() => undefined);
    throw error;
  }
}

async function revokeProductEvidence(
  organizationId: string,
  branchId: string,
  revocation: ProductEvidenceRevocation
): Promise<void> {
  await withDb(async (db) => {
    if (revocation === PRODUCT_EVIDENCE_REVOCATION.Wrote) {
      await db.artifactLink.deleteMany({
        where: {
          organizationId,
          targetId: branchId,
          branchParticipation: BranchParticipationKind.Wrote,
        },
      });
      return;
    }
    await db.branchDetail.update({
      where: { artifactId: branchId },
      data: { firstPushedAt: null, pushSource: null },
      select: { artifactId: true },
    });
  });
}
