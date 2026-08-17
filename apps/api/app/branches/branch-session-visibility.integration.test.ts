import { LinkType } from "@repo/api/src/types/artifact";
import {
  BranchDataState,
  BranchParticipationKind,
  BranchStatus,
} from "@repo/api/src/types/branch";
import {
  BranchActivityAtomVersion,
  BranchActivityAttributionKind,
  BranchActivityEvidenceCompleteness,
  BranchActivitySource,
} from "@repo/api/src/types/branch-activity";
import { BranchMetricAvailability } from "@repo/api/src/types/branch-metrics";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import { ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import { persistedGitHubRepositoryAuthority } from "@/__tests__/fixtures/repository-default-authority";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { branchReadService } from "@/app/branches/branch-read-service";

/**
 * FEA-4311 — a Branch record is DERIVED FROM branches observed in agent sessions
 * (PRD-510), so a linked session is admissible corpus provenance ON ITS OWN. The
 * bug: `branchCandidateWhereClause`/`branchWhere` gated visibility SOLELY on
 * remote evidence (an owned current PR OR set-once push state), so a branch
 * genuinely observed in a session was HIDDEN from the Branches list and its
 * detail 404'd until a push/PR was also recorded.
 *
 * The fix makes a VALID LINKED SESSION sufficient for corpus membership on its
 * own (`branchCandidateMembershipClause`): remote evidence ENRICHES a branch but
 * is no longer a co-requirement. This preserves FEA-4225's invariant that a
 * branch with NO valid session stays out of the corpus even if it carries remote
 * head evidence.
 *  - a session-linked branch with NO remote evidence is now INCLUDED (list) and
 *    READABLE (detail) — this test's core assertion (was hidden/404 before);
 *  - a branch with NEITHER a session NOR remote evidence stays EXCLUDED;
 *  - a remote-evidence branch with NO valid session stays EXCLUDED (FEA-4225).
 *
 * End-to-end against real Postgres, inside `autoRollbackTransaction`.
 */

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const ACTIVITY_AT = new Date("2026-07-01T00:00:00.000Z");

type TestDb = Parameters<Parameters<typeof withDb>[0]>[0];

async function createBranchArtifact(
  db: TestDb,
  organizationId: string,
  branchName: string,
  options: { firstPushedAt: Date | null; lastActivityAt?: Date | null }
): Promise<string> {
  const lastActivityAt =
    options.lastActivityAt === undefined ? ACTIVITY_AT : options.lastActivityAt;
  const artifact = await db.artifact.create({
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
      artifactId: artifact.id,
      organizationId,
      repositoryFullName: `acme/${branchName}`,
      branchName,
      // Remote evidence is present only when firstPushedAt is set; a null value
      // seeds a branch whose ONLY possible admission is a linked session.
      firstPushedAt: options.firstPushedAt,
      // A session-only branch admitted before any push can have a NULL
      // last_activity_at; seed that shape to prove the unavailable fallback.
      lastActivityAt,
    },
  });
  if (lastActivityAt) {
    await db.branchActivityAtom.create({
      data: {
        version: BranchActivityAtomVersion.V1,
        organizationId,
        branchArtifactId: artifact.id,
        source: BranchActivitySource.GitHead,
        sourceEventId: `fixture:${branchName}`,
        occurredAt: lastActivityAt,
        attributionKind: BranchActivityAttributionKind.Branch,
        completeness: BranchActivityEvidenceCompleteness.Complete,
      },
    });
  }
  await db.publicRepository.create({
    data: {
      organizationId,
      ...persistedGitHubRepositoryAuthority({
        githubRepoId: `repo-${artifact.id}`,
        fullName: `acme/${branchName}`,
      }),
      owner: "acme",
      name: branchName,
      htmlUrl: `https://github.com/acme/${branchName}`,
    },
  });
  return artifact.id;
}

async function linkValidSession(
  db: TestDb,
  organizationId: string,
  branchArtifactId: string,
  branchName: string,
  userId: string
): Promise<string> {
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
      userId,
      computeTargetId: computeTarget.id,
      externalSessionId: `ext-${branchName}`,
      harness: "claude",
      sessionStartedAt: ACTIVITY_AT,
      sessionUpdatedAt: ACTIVITY_AT,
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
  });
  return session.id;
}

async function seedCanonicalPagingCorpus(
  db: TestDb,
  organizationId: string,
  userId: string
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
  const branches = Array.from({ length: 101 }, (_, index) => ({
    id: canonicalPagingBranchId(index),
    branchName: canonicalPagingBranchName(index),
    repositoryFullName: canonicalPagingRepositoryFullName(index),
    occurredAt:
      index < 3
        ? tieAt
        : new Date(
            Date.parse("2026-07-02T00:00:00.000Z") + (101 - index) * 1000
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
      firstPushedAt: null,
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
        branchArtifactId: canonicalPagingBranchId(100),
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
      userId,
      computeTargetId: computeTarget.id,
      externalSessionId: "ext-canonical-paging",
      harness: "claude",
      sessionStartedAt: ACTIVITY_AT,
      sessionUpdatedAt: ACTIVITY_AT,
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
    ...Array.from({ length: 98 }, (_, index) =>
      canonicalPagingBranchId(index + 3)
    ),
  ];
  return { expectedIds, finalPageId: canonicalPagingBranchId(100) };
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

describeIfDb(
  "session-linked branches surface before a push/PR is recorded (FEA-4311)",
  () => {
    it("includes and reads a session-linked branch that has NO remote evidence", async () => {
      await autoRollbackTransaction(async () => {
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

        // Detail is READABLE (was 404 before the fix).
        const detail = await branchReadService.getBranchDetail(
          organizationId,
          branchId
        );
        expect(detail).not.toBeNull();
        expect(detail?.dataState).toBe(BranchDataState.Ready);
        expect(detail?.sessionIds).toEqual([sessionId]);

        // The list AGREES: the branch is present.
        const list = await branchReadService.listBranches(organizationId, {
          limit: 50,
          offset: 0,
        });
        expect(list.items.some((item) => item.id === branchId)).toBe(true);

        // Analytics count the corpus it belongs to (non-empty → Available count).
        const analytics = await branchReadService.getBranchAnalytics(
          organizationId,
          { limit: 50, offset: 0 }
        );
        expect(analytics.activeBranchCount.value).toBe(1);
      });
    });

    it("excludes a branch with NEITHER a linked session NOR remote evidence", async () => {
      await autoRollbackTransaction(async () => {
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

    it("retains unavailable Last active in finite windows without fabricating artifact activity", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const user = await createTestUser(organizationId);
        const { branchId, activeBranchId } = await withDb(async (db) => {
          const unavailableId = await createBranchArtifact(
            db,
            organizationId,
            "null-activity",
            // No push AND no last_activity_at: admission is the linked session,
            // while Last active remains unavailable.
            { firstPushedAt: null, lastActivityAt: null }
          );
          await linkValidSession(
            db,
            organizationId,
            unavailableId,
            "null-activity",
            user.id
          );
          const populatedId = await createBranchArtifact(
            db,
            organizationId,
            "known-activity",
            { firstPushedAt: null, lastActivityAt: ACTIVITY_AT }
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

    it("orders the full atom corpus before the 100/101 page boundary", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
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
        expect(second.items[0]?.lastActivityAt).toBe(
          "2026-07-02T00:00:01.000Z"
        );
        expect(second.total).toBe(101);
        expect(second.hasMore).toBe(false);
        expect(first.items[0]?.lastActivityAt).not.toBe(
          "2099-01-01T00:00:00.000Z"
        );
      });
    });

    it("keeps a remote-evidence branch with NO valid session OUT of the corpus (FEA-4225 preserved)", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const branchId = await withDb((db) =>
          createBranchArtifact(db, organizationId, "remote-only", {
            firstPushedAt: ACTIVITY_AT,
          })
        );

        // Remote evidence alone is NOT admissible provenance: the agent Branches
        // corpus represents branches observed in sessions, so a zero-session
        // branch stays hidden and its detail 404s (FEA-4225). FEA-4311 only makes
        // a session sufficient WITHOUT remote evidence; it does not admit remote
        // evidence WITHOUT a session.
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
  }
);
