/**
 * FEA-3917: the desktop PR upsert must reconcile on the DB-enforced
 * producer-independent identity — `(repositoryId, number)` for App rows and the
 * partial `(organizationId, repositoryFullName, number) WHERE repository_id IS
 * NULL` for repo-less rows — NOT on branchArtifactId. When the same
 * (repo, number) is synced under a SECOND branch artifact, the old
 * branchArtifactId-keyed lookup missed the existing row and the artifact-first
 * create collided on the real unique index (P2002), rolling back the whole sync
 * batch and 500ing every ~30s retry forever. These run against real Postgres
 * because the guarantee is DB-level (the mock harness does not enforce uniques).
 */
import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import { GitHubInstallationStatus, withDb } from "@repo/database";
import { describe, expect, it } from "vitest";
import { adoptRepolessPullRequestByRepoIdentity } from "@/app/branches/github-projection-writer";
import { autoRollbackTransaction } from "../utils/db-helpers";
import {
  baseFixture,
  branchRef,
  findBranch,
  pullRequestRef,
  seedRepo,
  syncSession,
} from "./agent-session-pr-sync-helpers";

const hasDatabase = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const REPO = "acme/widgets";

describeIfDb("desktop PR sync cross-branch identity (FEA-3917)", () => {
  it("App repo: syncing the same PR under a second branch artifact reconciles onto the one row instead of colliding", async () => {
    await autoRollbackTransaction(async () => {
      const fx = await baseFixture();
      const normalized = normalizeRepoFullName(REPO);
      const seeded = await seedRepo(fx.organizationId, REPO);

      // Sync #1 materializes the PR row under branch artifact A (App repo, so the
      // row carries repositoryId; the (repositoryId, number) unique applies).
      await syncSession({
        ...fx,
        externalSessionId: "sess-a",
        artifactRefs: [
          branchRef(REPO, "feature/a"),
          pullRequestRef({
            repositoryFullName: REPO,
            prNumber: 42,
            branchName: "feature/a",
            state: GitHubPRState.Open,
          }),
        ],
      });
      // Sync #2 resolves a DIFFERENT branch artifact B for the same (repo, 42).
      // Before the fix this threw P2002 on @@unique([repositoryId, number]).
      await syncSession({
        ...fx,
        externalSessionId: "sess-b",
        artifactRefs: [
          branchRef(REPO, "feature/b"),
          pullRequestRef({
            repositoryFullName: REPO,
            prNumber: 42,
            branchName: "feature/b",
            state: GitHubPRState.Open,
          }),
        ],
      });

      const rows = await withDb((db) =>
        db.pullRequestDetail.findMany({
          where: {
            organizationId: fx.organizationId,
            repositoryId: seeded.repositoryId,
            number: 42,
          },
        })
      );
      expect(rows).toHaveLength(1);

      const branchA = await findBranch(
        fx.organizationId,
        normalized,
        "feature/a"
      );
      const branchB = await findBranch(
        fx.organizationId,
        normalized,
        "feature/b"
      );
      // Leave-attached (OQ1): the row stays nested under its first branch (A),
      // and the desktop does NOT point the second branch (B) at it.
      expect(rows[0]?.branchArtifactId).toBe(branchA?.artifactId);
      expect(branchA?.currentPullRequestDetailId).toBe(rows[0]?.id);
      expect(branchB?.currentPullRequestDetailId).toBeNull();
    });
  });

  it("repo-less: syncing the same PR under a second branch artifact reconciles onto the one row instead of colliding on the partial unique index", async () => {
    await autoRollbackTransaction(async () => {
      const fx = await baseFixture();
      const normalized = normalizeRepoFullName(REPO);

      // No App install → repo-less rows, keyed by the partial
      // (organization_id, repository_full_name, number) WHERE repository_id IS NULL.
      await syncSession({
        ...fx,
        externalSessionId: "sess-a",
        artifactRefs: [
          branchRef(REPO, "feature/a"),
          pullRequestRef({
            repositoryFullName: REPO,
            prNumber: 77,
            branchName: "feature/a",
            state: GitHubPRState.Open,
          }),
        ],
      });
      await syncSession({
        ...fx,
        externalSessionId: "sess-b",
        artifactRefs: [
          branchRef(REPO, "feature/b"),
          pullRequestRef({
            repositoryFullName: REPO,
            prNumber: 77,
            branchName: "feature/b",
            state: GitHubPRState.Open,
          }),
        ],
      });

      const rows = await withDb((db) =>
        db.pullRequestDetail.findMany({
          where: {
            organizationId: fx.organizationId,
            repositoryFullName: normalized,
            number: 77,
          },
        })
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.repositoryId).toBeNull();
      const branchA = await findBranch(
        fx.organizationId,
        normalized,
        "feature/a"
      );
      expect(rows[0]?.branchArtifactId).toBe(branchA?.artifactId);
    });
  });

  it("cross-branch reconciliation is dedup-only: a later merged sync under branch B does not freshen branch A's row into a terminal-but-unadvanced state (read-repair guard)", async () => {
    await autoRollbackTransaction(async () => {
      const fx = await baseFixture();
      const normalized = normalizeRepoFullName(REPO);

      // Branch A: repo-less PR observed OPEN → row + branch A both OPEN.
      await syncSession({
        ...fx,
        externalSessionId: "sess-a",
        artifactRefs: [
          branchRef(REPO, "feature/a"),
          pullRequestRef({
            repositoryFullName: REPO,
            prNumber: 66,
            branchName: "feature/a",
            state: GitHubPRState.Open,
          }),
        ],
      });
      const branchA = await findBranch(
        fx.organizationId,
        normalized,
        "feature/a"
      );
      const before = await withDb((db) =>
        db.pullRequestDetail.findFirst({
          where: { branchArtifactId: branchA?.artifactId, number: 66 },
        })
      );
      expect(before?.prState).toBe(GitHubPRState.Open);

      // The dev stops syncing A; the SAME PR is later synced (now MERGED, with a
      // strictly NEWER observation so the monotonic guard would not skip it) under
      // a DIFFERENT branch artifact B. The identity lookup finds A's row, but a
      // cross-branch sync must NOT overwrite its facts: doing so would set
      // prState=MERGED + a fresh read-repair clock while leaving branch A's
      // Artifact.status OPEN, permanently silencing pr-read-repair for branch A.
      await syncSession({
        ...fx,
        externalSessionId: "sess-b",
        artifactRefs: [
          branchRef(REPO, "feature/b"),
          pullRequestRef({
            repositoryFullName: REPO,
            prNumber: 66,
            branchName: "feature/b",
            state: GitHubPRState.Merged,
            observedAt: new Date("2026-07-11T10:00:00.000Z").toISOString(),
          }),
        ],
      });

      const rows = await withDb((db) =>
        db.pullRequestDetail.findMany({
          where: {
            organizationId: fx.organizationId,
            repositoryFullName: normalized,
            number: 66,
          },
        })
      );
      expect(rows).toHaveLength(1);
      // Row stays under A and is NOT freshened by branch B's merged observation.
      expect(rows[0]?.branchArtifactId).toBe(branchA?.artifactId);
      expect(rows[0]?.prState).toBe(GitHubPRState.Open);
      expect(rows[0]?.fetchObservedAt?.toISOString()).toBe(
        before?.fetchObservedAt?.toISOString()
      );
      // Branch A stays OPEN — PR row and branch status remain consistent (no
      // terminal-but-unadvanced divergence that would strand pr-read-repair).
      const artifactA = await withDb((db) =>
        db.artifact.findUnique({
          where: { id: branchA?.artifactId },
          select: { status: true },
        })
      );
      expect(artifactA?.status).toBe(GitHubPRState.Open);
    });
  });

  it("adoption + cross-branch re-sync converges on the adopted row (AC5, repo-less -> adopted across two branch artifacts)", async () => {
    await autoRollbackTransaction(async () => {
      const fx = await baseFixture();
      const normalized = normalizeRepoFullName(REPO);

      // Repo-less row under branch A.
      await syncSession({
        ...fx,
        externalSessionId: "sess-a",
        artifactRefs: [
          branchRef(REPO, "feature/a"),
          pullRequestRef({
            repositoryFullName: REPO,
            prNumber: 88,
            branchName: "feature/a",
            state: GitHubPRState.Open,
          }),
        ],
      });
      // App installs; webhook adopts the repo-less row by repo identity (fills
      // repositoryId + githubId), moving it under (repositoryId, number).
      const seeded = await seedRepo(fx.organizationId, REPO);
      await withDb((db) =>
        adoptRepolessPullRequestByRepoIdentity(db, {
          organizationId: fx.organizationId,
          repositoryFullName: normalized,
          number: 88,
          repositoryId: seeded.repositoryId,
          githubId: "PR_kwDO_fea3917_88",
        })
      );

      // Later desktop sync under a DIFFERENT branch artifact B, now resolving the
      // repositoryId. Must find the adopted row (repositoryId prong) — one row.
      await syncSession({
        ...fx,
        externalSessionId: "sess-b",
        artifactRefs: [
          branchRef(REPO, "feature/b"),
          pullRequestRef({
            repositoryFullName: REPO,
            prNumber: 88,
            branchName: "feature/b",
            state: GitHubPRState.Open,
          }),
        ],
      });

      const rows = await withDb((db) =>
        db.pullRequestDetail.findMany({
          where: {
            organizationId: fx.organizationId,
            repositoryFullName: normalized,
            number: 88,
          },
        })
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.repositoryId).toBe(seeded.repositoryId);
      expect(rows[0]?.githubId).toBe("PR_kwDO_fea3917_88");
    });
  });

  it("adoption skew: an adopted row is reconciled (not duplicated) when a later sync cannot resolve the repositoryId", async () => {
    await autoRollbackTransaction(async () => {
      const fx = await baseFixture();
      const normalized = normalizeRepoFullName(REPO);

      // Repo-less row under branch A, then App-adopted (repositoryId + githubId).
      await syncSession({
        ...fx,
        externalSessionId: "sess-a",
        artifactRefs: [
          branchRef(REPO, "feature/a"),
          pullRequestRef({
            repositoryFullName: REPO,
            prNumber: 55,
            branchName: "feature/a",
            state: GitHubPRState.Open,
          }),
        ],
      });
      const seeded = await seedRepo(fx.organizationId, REPO);
      await withDb((db) =>
        adoptRepolessPullRequestByRepoIdentity(db, {
          organizationId: fx.organizationId,
          repositoryFullName: normalized,
          number: 55,
          repositoryId: seeded.repositoryId,
          githubId: "PR_kwDO_fea3917_55",
        })
      );

      // The App install goes non-ACTIVE, so resolveBranchRepoMap can no longer
      // resolve the repositoryId — the later sync arrives with repositoryId=null
      // even though the stored row is already adopted (repositoryId set). A lookup
      // gated on `repositoryId: null` would miss it and create a second repo-less
      // row; the always-on repositoryFullName prong reconciles instead.
      await withDb((db) =>
        db.gitHubInstallation.updateMany({
          where: { organizationId: fx.organizationId },
          data: { status: GitHubInstallationStatus.SUSPENDED },
        })
      );
      await syncSession({
        ...fx,
        externalSessionId: "sess-b",
        artifactRefs: [
          branchRef(REPO, "feature/b"),
          pullRequestRef({
            repositoryFullName: REPO,
            prNumber: 55,
            branchName: "feature/b",
            state: GitHubPRState.Open,
          }),
        ],
      });

      const rows = await withDb((db) =>
        db.pullRequestDetail.findMany({
          where: {
            organizationId: fx.organizationId,
            repositoryFullName: normalized,
            number: 55,
          },
        })
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.repositoryId).toBe(seeded.repositoryId);
    });
  });
});
