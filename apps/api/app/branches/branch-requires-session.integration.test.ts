import { BranchPushSource, LinkType } from "@repo/api/src/types/artifact";
import {
  BranchDataState,
  BranchParticipationKind,
  BranchStatus,
} from "@repo/api/src/types/branch";
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
 * FEA-4263 — the branch-requires-session invariant: a branch is first-class
 * (renders a FULL detail page / counts a session) only when it relates to ≥1
 * VALID session. The observed violation was a branch with a full branch detail
 * page but zero linked sessions (PR #3786).
 *
 * Root cause: the branch read counted a session→branch `ArtifactLink` whose
 * source SESSION artifact carried NO `SessionDetail` row (an orphaned /
 * half-synced link — `source.session` resolves null). Such a link inflated
 * `BranchRow.sessionIds` to length 1, so `deriveDataState` returned `Ready` (a
 * full detail page) over zero real sessions instead of `NoSessions` (the honest
 * empty state).
 *
 * These assert the behavior end-to-end against real Postgres (the fix lives in
 * `accumulateSessionLink`, which joins through `source.session`). A branch with
 * a VALID linked session is `Ready` and part of the corpus. FEA-4225 then makes a
 * valid linked session a server-side ELIGIBILITY requirement, so a branch whose
 * only links are orphaned is not merely `NoSessions` — it is excluded from the
 * list and its detail 404s until a real session hydrates. Runs inside
 * `autoRollbackTransaction`.
 */

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const PUSHED_AT = new Date("2026-07-01T00:00:00.000Z");

async function seedRemoteEvidenceBranch(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  organizationId: string,
  branchName: string
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
  // FR12 remote evidence (set-once push) — a branch surfaces in the list with
  // this alone, so the session-count classification is what decides Ready vs
  // NoSessions.
  await db.branchDetail.create({
    data: {
      artifactId: artifact.id,
      organizationId,
      repositoryFullName: `acme/${branchName}`,
      branchName,
      firstPushedAt: PUSHED_AT,
      pushSource: BranchPushSource.Session,
      lastActivityAt: PUSHED_AT,
    },
  });
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

/**
 * Link a session ARTIFACT to the branch. When `withDetail` is false the session
 * artifact has no `SessionDetail` row — the orphaned/half-synced link the fix
 * must not count as a valid session.
 */
async function linkSession(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  organizationId: string,
  branchArtifactId: string,
  branchName: string,
  options: { withDetail: boolean; userId?: string }
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
  if (options.withDetail) {
    if (!options.userId) {
      throw new Error("linkSession: withDetail requires a userId");
    }
    const computeTarget = await db.computeTarget.create({
      data: {
        organizationId,
        userId: options.userId,
        machineName: `machine-${branchName}`,
        platform: "darwin",
      },
      select: { id: true },
    });
    await db.sessionDetail.create({
      data: {
        artifactId: session.id,
        userId: options.userId,
        computeTargetId: computeTarget.id,
        externalSessionId: `ext-${branchName}`,
        harness: "claude",
        sessionStartedAt: PUSHED_AT,
        sessionUpdatedAt: PUSHED_AT,
      },
    });
  }
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

describeIfDb(
  "branch requires a valid session to be first-class (FEA-4263)",
  () => {
    it("marks a branch with ≥1 valid linked session as Ready with the session counted", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const user = await createTestUser(organizationId);
        const { branchId, sessionId } = await withDb(async (db) => {
          const id = await seedRemoteEvidenceBranch(
            db,
            organizationId,
            "valid-session"
          );
          const sid = await linkSession(
            db,
            organizationId,
            id,
            "valid-session",
            {
              withDetail: true,
              userId: user.id,
            }
          );
          return { branchId: id, sessionId: sid };
        });

        const detail = await branchReadService.getBranchDetail(
          organizationId,
          branchId
        );
        expect(detail?.dataState).toBe(BranchDataState.Ready);
        expect(detail?.sessionIds).toEqual([sessionId]);
        expect(detail?.sessions).toHaveLength(1);
      });
    });

    it("excludes a branch whose only link is orphaned (no SessionDetail) from the corpus", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        // A session→branch link whose SESSION artifact has NO SessionDetail row —
        // exactly the orphaned link that previously inflated sessionIds and forced
        // a full Ready detail page over zero real sessions. Under FEA-4225 an
        // orphaned link is not a valid session, so the branch is not part of the
        // agent Branches surface at all: its detail 404s and it never lists (this
        // supersedes FEA-4263's earlier "still surfaces with the NoSessions state").
        const branchId = await withDb(async (db) => {
          const id = await seedRemoteEvidenceBranch(
            db,
            organizationId,
            "orphaned-link"
          );
          await linkSession(db, organizationId, id, "orphaned-link", {
            withDetail: false,
          });
          return id;
        });

        const detail = await branchReadService.getBranchDetail(
          organizationId,
          branchId
        );
        // Ineligible → getBranchDetail resolves null (the route maps this to 404).
        expect(detail).toBeNull();

        // The list agrees: the branch is absent entirely.
        const list = await branchReadService.listBranches(organizationId, {
          limit: 50,
          offset: 0,
        });
        expect(list.items.some((item) => item.id === branchId)).toBe(false);
      });
    });

    it("flips a legacy orphaned-link branch into the corpus (Ready) once the session's detail lands (graceful, no mutation)", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const user = await createTestUser(organizationId);
        const { branchId, sessionId } = await withDb(async (db) => {
          const id = await seedRemoteEvidenceBranch(
            db,
            organizationId,
            "later-hydrated"
          );
          const sid = await linkSession(
            db,
            organizationId,
            id,
            "later-hydrated",
            { withDetail: false }
          );
          return { branchId: id, sessionId: sid };
        });

        // Orphaned link only: ineligible under FEA-4225 → excluded (null detail).
        const before = await branchReadService.getBranchDetail(
          organizationId,
          branchId
        );
        expect(before).toBeNull();

        // The session's detail row lands (nothing was mutated to hide it earlier —
        // the link was there all along).
        await withDb(async (db) => {
          const computeTarget = await db.computeTarget.create({
            data: {
              organizationId,
              userId: user.id,
              machineName: "machine-later",
              platform: "darwin",
            },
            select: { id: true },
          });
          await db.sessionDetail.create({
            data: {
              artifactId: sessionId,
              userId: user.id,
              computeTargetId: computeTarget.id,
              externalSessionId: "ext-later-hydrated",
              harness: "claude",
              sessionStartedAt: PUSHED_AT,
              sessionUpdatedAt: PUSHED_AT,
            },
          });
        });

        const after = await branchReadService.getBranchDetail(
          organizationId,
          branchId
        );
        expect(after?.dataState).toBe(BranchDataState.Ready);
        expect(after?.sessionIds).toEqual([sessionId]);
      });
    });
  }
);
