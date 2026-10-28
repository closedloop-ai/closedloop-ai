import { randomUUID } from "node:crypto";
import { LinkType } from "@repo/api/src/types/artifact";
import {
  BranchParticipationKind,
  BranchStatus,
} from "@repo/api/src/types/branch";
import {
  SessionArtifactLinkKind,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import {
  LOC_SOURCE_BRANCH_FALLBACK,
  LOC_SOURCE_GIT,
  sumSessionLocDedupedByBranch,
} from "@repo/api/src/utils/session-loc";
import { ArtifactType, type Prisma, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { computeDedupedBaselineLoc } from "./cohort-baseline-loc";
import { loadSessionLocCost } from "./loc-per-dollar";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const WINDOW_START = new Date("2026-07-01T00:00:00.000Z");
const WINDOW_END = new Date("2026-07-31T23:59:59.999Z");
const IN_WINDOW = new Date("2026-07-12T10:00:00.000Z");
const OUTSIDE_WINDOW = new Date("2026-06-30T23:59:59.999Z");

describeIfDb("computeDedupedBaselineLoc against real Postgres", () => {
  it("dedupes fallback LOC by authored branch without leaking orgs, reviewed links, or excluded sessions", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const otherOrganizationId = await createTestOrganization();
      const otherUser = await createTestUser(otherOrganizationId);

      await seedSession(organizationId, user.id, {
        label: "git-loc",
        linesAdded: 3,
        linesRemoved: 2,
        locSource: LOC_SOURCE_GIT,
      });

      const sharedBranch = await seedBranch(organizationId, {
        repositoryFullName: "acme/shared",
        branchName: "feature/shared",
      });
      await seedLinkedFallbackSession(organizationId, user.id, sharedBranch, {
        label: "shared-explicit",
        linesAdded: 100,
        linesRemoved: 0,
        branchParticipation: BranchParticipationKind.Wrote,
        metadata: { linkKind: SessionArtifactLinkKind.SessionBranch },
      });
      await seedLinkedFallbackSession(organizationId, user.id, sharedBranch, {
        label: "shared-legacy",
        linesAdded: 0,
        linesRemoved: 100,
        branchParticipation: null,
        metadata: {
          linkKind: SessionArtifactLinkKind.SessionPr,
          relationTypes: [SessionPrRelationType.Created],
        },
      });

      const legacyWriteBranch = await seedBranch(organizationId, {
        repositoryFullName: "acme/legacy-write",
        branchName: "legacy-write",
      });
      await seedLinkedFallbackSession(
        organizationId,
        user.id,
        legacyWriteBranch,
        {
          label: "legacy-write",
          linesAdded: 12,
          linesRemoved: 8,
          branchParticipation: null,
          metadata: {
            linkKind: SessionArtifactLinkKind.SessionPr,
            relationTypes: [SessionPrRelationType.Created],
          },
        }
      );

      await seedSession(organizationId, user.id, {
        label: "unlinked-fallback",
        linesAdded: 7,
        linesRemoved: 3,
        locSource: LOC_SOURCE_BRANCH_FALLBACK,
      });

      const reviewedBranch = await seedBranch(organizationId, {
        repositoryFullName: "acme/reviewed",
        branchName: "reviewed",
      });
      await seedLinkedFallbackSession(organizationId, user.id, reviewedBranch, {
        label: "reviewed-only",
        linesAdded: 80,
        linesRemoved: 5,
        branchParticipation: BranchParticipationKind.Reviewed,
        metadata: { linkKind: SessionArtifactLinkKind.SessionBranch },
      });
      await seedLinkedFallbackSession(organizationId, user.id, reviewedBranch, {
        label: "reviewed-peer-write",
        linesAdded: 10,
        linesRemoved: 1,
        branchParticipation: BranchParticipationKind.Wrote,
        metadata: { linkKind: SessionArtifactLinkKind.SessionBranch },
      });

      const legacyReviewedBranch = await seedBranch(organizationId, {
        repositoryFullName: "acme/legacy-reviewed",
        branchName: "legacy-reviewed",
      });
      await seedLinkedFallbackSession(
        organizationId,
        user.id,
        legacyReviewedBranch,
        {
          label: "legacy-reviewed-only",
          linesAdded: 70,
          linesRemoved: 4,
          branchParticipation: null,
          metadata: {
            linkKind: SessionArtifactLinkKind.SessionPr,
            relationTypes: [SessionPrRelationType.Reviewed],
          },
        }
      );
      await seedLinkedFallbackSession(
        organizationId,
        user.id,
        legacyReviewedBranch,
        {
          label: "legacy-reviewed-peer-write",
          linesAdded: 9,
          linesRemoved: 1,
          branchParticipation: BranchParticipationKind.Wrote,
          metadata: { linkKind: SessionArtifactLinkKind.SessionBranch },
        }
      );

      const excludedBranch = await seedBranch(organizationId, {
        repositoryFullName: "acme/excluded",
        branchName: "excluded",
      });
      const excludedSessionId = await seedLinkedFallbackSession(
        organizationId,
        user.id,
        excludedBranch,
        {
          label: "excluded",
          linesAdded: 400,
          linesRemoved: 400,
          branchParticipation: BranchParticipationKind.Wrote,
          metadata: { linkKind: SessionArtifactLinkKind.SessionBranch },
        }
      );

      const outOfWindowBranch = await seedBranch(organizationId, {
        repositoryFullName: "acme/out-of-window",
        branchName: "out-of-window",
      });
      await seedLinkedFallbackSession(
        organizationId,
        user.id,
        outOfWindowBranch,
        {
          label: "out-of-window",
          linesAdded: 600,
          linesRemoved: 600,
          branchParticipation: BranchParticipationKind.Wrote,
          metadata: { linkKind: SessionArtifactLinkKind.SessionBranch },
          sessionStartedAt: OUTSIDE_WINDOW,
        }
      );

      const otherOrgBranch = await seedBranch(otherOrganizationId, {
        repositoryFullName: "acme/shared",
        branchName: "feature/shared",
      });
      await seedLinkedFallbackSession(
        otherOrganizationId,
        otherUser.id,
        otherOrgBranch,
        {
          label: "other-org",
          linesAdded: 1000,
          linesRemoved: 1000,
          branchParticipation: BranchParticipationKind.Wrote,
          metadata: { linkKind: SessionArtifactLinkKind.SessionBranch },
        }
      );

      const result = await withDb((db) =>
        computeDedupedBaselineLoc(db, {
          organizationId,
          excludedSessionIds: [excludedSessionId],
          startDate: WINDOW_START,
          endDate: WINDOW_END,
        })
      );

      expect(result).toEqual({ loc: 315, truncated: false });
    });
  });

  it("keeps SQL and TypeScript branch-participation classification in parity", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const sessionIds: string[] = [];

      sessionIds.push(
        await seedSession(organizationId, user.id, {
          label: "git-loc",
          linesAdded: 3,
          linesRemoved: 2,
          locSource: LOC_SOURCE_GIT,
        })
      );

      const sharedBranch = await seedBranch(organizationId, {
        repositoryFullName: "acme/shared",
        branchName: "feature/shared",
      });
      sessionIds.push(
        await seedLinkedFallbackSession(organizationId, user.id, sharedBranch, {
          label: "shared-explicit",
          linesAdded: 100,
          linesRemoved: 0,
          branchParticipation: BranchParticipationKind.Wrote,
          metadata: { linkKind: SessionArtifactLinkKind.SessionBranch },
        }),
        await seedLinkedFallbackSession(organizationId, user.id, sharedBranch, {
          label: "shared-legacy-created",
          linesAdded: 0,
          linesRemoved: 100,
          branchParticipation: null,
          metadata: {
            linkKind: SessionArtifactLinkKind.SessionPr,
            relationTypes: [SessionPrRelationType.Created],
          },
        })
      );

      const reviewedBranch = await seedBranch(organizationId, {
        repositoryFullName: "acme/reviewed",
        branchName: "reviewed",
      });
      sessionIds.push(
        await seedLinkedFallbackSession(
          organizationId,
          user.id,
          reviewedBranch,
          {
            label: "reviewed-only",
            linesAdded: 30,
            linesRemoved: 7,
            branchParticipation: BranchParticipationKind.Reviewed,
            metadata: { linkKind: SessionArtifactLinkKind.SessionBranch },
          }
        )
      );

      const legacyReviewedBranch = await seedBranch(organizationId, {
        repositoryFullName: "acme/legacy-reviewed",
        branchName: "legacy-reviewed",
      });
      sessionIds.push(
        await seedLinkedFallbackSession(
          organizationId,
          user.id,
          legacyReviewedBranch,
          {
            label: "legacy-reviewed-only",
            linesAdded: 20,
            linesRemoved: 2,
            branchParticipation: null,
            metadata: {
              linkKind: SessionArtifactLinkKind.SessionPr,
              relationTypes: [SessionPrRelationType.Reviewed],
            },
          }
        )
      );

      const sqlBaseline = await withDb((db) =>
        computeDedupedBaselineLoc(db, {
          organizationId,
          excludedSessionIds: [],
          startDate: WINDOW_START,
          endDate: WINDOW_END,
        })
      );
      const locCostBySession = await withDb((db) =>
        loadSessionLocCost(db, organizationId, sessionIds)
      );
      const tsFold = sumSessionLocDedupedByBranch(locCostBySession.values());

      expect(sqlBaseline).toEqual({ loc: 164, truncated: false });
      expect(tsFold).toBe(sqlBaseline.loc);
    });
  });
});

type SeedBranchInput = {
  repositoryFullName: string;
  branchName: string;
};

type SeedSessionInput = {
  label: string;
  linesAdded: number;
  linesRemoved: number;
  locSource: string | null;
  sessionStartedAt?: Date;
};

type SeedLinkInput = Omit<SeedSessionInput, "locSource"> & {
  branchParticipation: BranchParticipationKind | null;
  metadata: Prisma.InputJsonObject;
};

async function seedBranch(
  organizationId: string,
  input: SeedBranchInput
): Promise<string> {
  return await withDb(async (db) => {
    const branch = await db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.BRANCH,
        name: input.branchName,
        status: BranchStatus.Open,
      },
      select: { id: true },
    });
    await db.branchDetail.create({
      data: {
        artifactId: branch.id,
        organizationId,
        repositoryFullName: input.repositoryFullName,
        branchName: input.branchName,
      },
      select: { artifactId: true },
    });
    return branch.id;
  });
}

async function seedLinkedFallbackSession(
  organizationId: string,
  userId: string,
  branchArtifactId: string,
  input: SeedLinkInput
): Promise<string> {
  const sessionArtifactId = await seedSession(organizationId, userId, {
    label: input.label,
    linesAdded: input.linesAdded,
    linesRemoved: input.linesRemoved,
    locSource: LOC_SOURCE_BRANCH_FALLBACK,
    sessionStartedAt: input.sessionStartedAt,
  });
  await withDb((db) =>
    db.artifactLink.create({
      data: {
        organizationId,
        sourceId: sessionArtifactId,
        targetId: branchArtifactId,
        linkType: LinkType.RelatesTo,
        branchParticipation: input.branchParticipation,
        metadata: input.metadata,
      },
      select: { id: true },
    })
  );
  return sessionArtifactId;
}

async function seedSession(
  organizationId: string,
  userId: string,
  input: SeedSessionInput
): Promise<string> {
  const unique = randomUUID().replaceAll("-", "").slice(0, 12);
  const timestamp = input.sessionStartedAt ?? IN_WINDOW;
  return await withDb(async (db) => {
    const session = await db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.SESSION,
        name: `session-${input.label}-${unique}`,
        status: SESSION_STATUS.ACTIVE,
      },
      select: { id: true },
    });
    const computeTarget = await db.computeTarget.create({
      data: {
        organizationId,
        userId,
        machineName: `machine-${input.label}-${unique}`,
        platform: "darwin",
      },
      select: { id: true },
    });
    await db.sessionDetail.create({
      data: {
        artifactId: session.id,
        computeTargetId: computeTarget.id,
        externalSessionId: `ext-${input.label}-${unique}`,
        harness: "claude",
        sessionStartedAt: timestamp,
        sessionUpdatedAt: timestamp,
        lastActivityAt: timestamp,
        linesAdded: input.linesAdded,
        linesRemoved: input.linesRemoved,
        locSource: input.locSource,
      },
      select: { artifactId: true },
    });
    return session.id;
  });
}
