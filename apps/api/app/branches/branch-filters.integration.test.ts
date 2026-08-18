import { BranchPushSource, LinkType } from "@repo/api/src/types/artifact";
import {
  BranchParticipationKind,
  BranchSessionPresence,
  BranchStatus,
} from "@repo/api/src/types/branch";
import { FileChangeStatus } from "@repo/api/src/types/branch-view";
import { GitHubPRState } from "@repo/api/src/types/github";
import {
  SessionArtifactLinkKind,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import { ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import { persistedGitHubRepositoryAuthority } from "@/__tests__/fixtures/repository-default-authority";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestUser,
  linkValidSessionToBranch,
} from "@/__tests__/utils/db-helpers";
import { branchReadService } from "@/app/branches/branch-read-service";

/**
 * FEA-4003 — behavioral coverage for the linked-session presence and LOC-change
 * range predicates in the branch list read. Real Postgres because the filters
 * live in raw-SQL candidate predicates over `artifact_links` and
 * `branch_file_changes`. Seeds a single org with four branches whose linked-
 * session presence and LOC totals are known, then asserts each filter narrows
 * the returned id set to exactly the expected branches. Runs inside
 * `autoRollbackTransaction`, so nothing persists.
 */

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

/**
 * How the seeded session→branch link should classify. `wrote` is an active-write
 * link over a session that HAS a `SessionDetail` row (a valid session — populates
 * `sessionIds`); `reviewedNullParticipation` seeds a legacy
 * `branch_participation: null` link whose metadata derives reviewed-only, which
 * `accumulateSessionLink` skips — so it must NOT count as a linked session.
 * `orphanedWrote` is an active-write link whose source SESSION has NO
 * `SessionDetail` row (the FEA-4263 orphaned/half-synced link): the fold skips it
 * and `branchLinkedSessionExistsSql`'s `INNER JOIN session_detail` must too, so it
 * lands under "None", never "Has".
 */
const SeedLinkKind = {
  None: "none",
  Wrote: "wrote",
  OrphanedWrote: "orphanedWrote",
  ReviewedNullParticipation: "reviewedNullParticipation",
} as const;
type SeedLinkKind = (typeof SeedLinkKind)[keyof typeof SeedLinkKind];

type SeedBranchInput = {
  branchName: string;
  link: SeedLinkKind;
  artifactStatus?: GitHubPRState;
  selectedPrState?: GitHubPRState;
  selectedPrSnapshotCount?: number;
  /** Per-file [additions, deletions] rows; empty ⇒ no file-change rows (LOC unavailable). */
  fileChanges: [number, number][];
  /**
   * Owner for the `SessionDetail` a `Wrote` link needs. Required for `Wrote`
   * (a valid session), ignored for `OrphanedWrote`, `ReviewedNullParticipation`,
   * and `None` (no `SessionDetail` is created).
   */
  userId?: string;
};

async function seedBranch(
  organizationId: string,
  input: SeedBranchInput
): Promise<string> {
  const artifactId = await withDb(async (db) => {
    const artifact = await db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.BRANCH,
        name: input.branchName,
        status: input.artifactStatus ?? BranchStatus.Open,
      },
      select: { id: true },
    });
    await db.branchDetail.create({
      data: {
        artifactId: artifact.id,
        organizationId,
        repositoryFullName: `acme/${input.branchName}`,
        branchName: input.branchName,
        // FR12 visibility gate: an explicit set-once push makes the branch
        // surface in the list without needing a current PR.
        firstPushedAt: new Date("2026-07-01T00:00:00.000Z"),
        pushSource: BranchPushSource.Session,
        lastActivityAt: new Date("2026-07-01T00:00:00.000Z"),
      },
    });
    const repositoryFullName = `acme/${input.branchName}`;
    await db.publicRepository.create({
      data: {
        organizationId,
        ...persistedGitHubRepositoryAuthority({
          githubRepoId: `repo-${artifact.id}`,
          fullName: repositoryFullName,
        }),
        owner: "acme",
        name: input.branchName,
        htmlUrl: `https://github.com/${repositoryFullName}`,
      },
    });
    if (input.selectedPrState) {
      const currentPullRequestId = await seedSelectedPullRequestSnapshots(
        db,
        organizationId,
        artifact.id,
        input.branchName,
        input.selectedPrState,
        input.selectedPrSnapshotCount ?? 1
      );
      await db.branchDetail.update({
        where: { artifactId: artifact.id },
        data: { currentPullRequestDetailId: currentPullRequestId },
      });
    }
    if (input.fileChanges.length > 0) {
      await db.branchFileChange.createMany({
        data: input.fileChanges.map(([additions, deletions], index) => ({
          branchArtifactId: artifact.id,
          headSha: "sha-1",
          path: `src/file-${index}.ts`,
          status: FileChangeStatus.Modified,
          additions,
          deletions,
        })),
      });
    }
    if (input.link !== SeedLinkKind.None) {
      await seedSessionLink(db, organizationId, artifact.id, input);
    }
    return artifact.id;
  });
  return artifactId;
}

async function seedSelectedPullRequestSnapshots(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  organizationId: string,
  branchArtifactId: string,
  branchName: string,
  selectedPrState: GitHubPRState,
  snapshotCount: number
): Promise<string> {
  const isClosed = selectedPrState === GitHubPRState.Closed;
  const repositoryFullName = `acme/${branchName}`;
  const pullRequestData = {
    organizationId,
    branchArtifactId,
    number: 1,
    prState: selectedPrState,
    closedAt: isClosed ? new Date("2026-07-02T00:00:00.000Z") : null,
    ...persistedPullRequestHeadAuthority(branchArtifactId, repositoryFullName),
  };
  if (snapshotCount === 1) {
    const pullRequest = await db.pullRequestDetail.create({
      data: { ...pullRequestData, repositoryFullName, isCurrent: true },
      select: { id: true },
    });
    return pullRequest.id;
  }

  const installation = await db.gitHubInstallation.create({
    data: {
      organizationId,
      installationId: `installation-${branchArtifactId}`,
      accountId: `account-${branchArtifactId}`,
      accountLogin: "acme",
      accountType: "Organization",
      senderLogin: "fixture-user",
      senderId: `sender-${branchArtifactId}`,
    },
    select: { id: true },
  });
  const repositories =
    await db.gitHubInstallationRepository.createManyAndReturn({
      data: Array.from({ length: snapshotCount }, (_, index) => ({
        installationId: installation.id,
        githubRepoId: `repo-${branchArtifactId}-${index}`,
        fullName: repositoryFullName,
        name: branchName,
        owner: "acme",
        private: false,
      })),
      select: { id: true },
    });
  const currentRepository = repositories[0];
  if (!currentRepository) {
    throw new Error("Expected a repository for the selected PR fixture");
  }
  const currentPullRequest = await db.pullRequestDetail.create({
    data: {
      ...pullRequestData,
      repositoryId: currentRepository.id,
      isCurrent: true,
    },
    select: { id: true },
  });
  const additionalRepositories = repositories.slice(1);
  if (additionalRepositories.length > 0) {
    await db.pullRequestDetail.createMany({
      data: additionalRepositories.map((repository) => ({
        ...pullRequestData,
        repositoryId: repository.id,
        isCurrent: false,
      })),
    });
  }
  return currentPullRequest.id;
}

async function seedSessionLink(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  organizationId: string,
  branchArtifactId: string,
  input: SeedBranchInput
): Promise<void> {
  const session = await db.artifact.create({
    data: {
      organizationId,
      type: ArtifactType.SESSION,
      name: `session-for-${input.branchName}`,
      status: BranchStatus.Open,
    },
    select: { id: true },
  });
  // A `Wrote` link models a VALID session, so it must carry a SessionDetail row.
  // `OrphanedWrote` deliberately omits it (the half-synced link the fix excludes).
  if (input.link === SeedLinkKind.Wrote) {
    if (!input.userId) {
      throw new Error(
        "seedSessionLink: Wrote requires a userId for SessionDetail"
      );
    }
    const computeTarget = await db.computeTarget.create({
      data: {
        organizationId,
        userId: input.userId,
        machineName: `machine-${input.branchName}`,
        platform: "darwin",
      },
      select: { id: true },
    });
    await db.sessionDetail.create({
      data: {
        artifactId: session.id,
        userId: input.userId,
        computeTargetId: computeTarget.id,
        externalSessionId: `ext-${input.branchName}`,
        harness: "claude",
        sessionStartedAt: new Date("2026-07-01T00:00:00.000Z"),
        sessionUpdatedAt: new Date("2026-07-01T00:00:00.000Z"),
      },
    });
  }
  const wrote =
    input.link === SeedLinkKind.Wrote ||
    input.link === SeedLinkKind.OrphanedWrote;
  await db.artifactLink.create({
    data: {
      organizationId,
      sourceId: session.id,
      targetId: branchArtifactId,
      linkType: LinkType.RelatesTo,
      // A reviewed-derived link carries legacy `null` participation and metadata
      // that classifies it reviewed-only — exactly the shape `accumulateSessionLink`
      // (and now `branchLinkedSessionExistsSql`) must exclude from `sessionIds`.
      branchParticipation: wrote ? BranchParticipationKind.Wrote : null,
      metadata: wrote
        ? { linkKind: SessionArtifactLinkKind.SessionBranch }
        : {
            linkKind: SessionArtifactLinkKind.SessionPr,
            branchParticipation: BranchParticipationKind.Reviewed,
            relationTypes: [SessionPrRelationType.Reviewed],
          },
    },
  });
}

const LIST_QUERY = { limit: 50, offset: 0 } as const;

describeIfDb(
  "branch list filters — linked session + LOC range (FEA-4003)",
  () => {
    it("accepts legacy sessionPresence values without changing the canonical corpus", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const user = await createTestUser(organizationId);
        const withSession = await seedBranch(organizationId, {
          branchName: "with-session",
          link: SeedLinkKind.Wrote,
          fileChanges: [[10, 5]],
          userId: user.id,
        });
        // A branch with remote push evidence but NO linked session. Under FEA-4225
        // it is no longer part of the agent Branches corpus at all.
        await seedBranch(organizationId, {
          branchName: "no-session",
          link: SeedLinkKind.None,
          fileChanges: [[3, 2]],
        });

        // Unfiltered: only the session-linked branch is eligible.
        const unfiltered = await branchReadService.listBranches(
          organizationId,
          LIST_QUERY
        );
        expect(unfiltered.items.map((item) => item.id)).toEqual([withSession]);
        expect(unfiltered.total).toBe(1);

        const hasResult = await branchReadService.listBranches(organizationId, {
          ...LIST_QUERY,
          sessionPresence: BranchSessionPresence.Has,
        });
        expect(hasResult.items.map((item) => item.id)).toEqual([withSession]);

        // FEA-3826: both legacy values remain parse-compatible no-ops. Canonical
        // persisted-session membership decides the corpus, so neither value may
        // filter away the valid linked branch or resurrect the zero-session one.
        const noneResult = await branchReadService.listBranches(
          organizationId,
          {
            ...LIST_QUERY,
            sessionPresence: BranchSessionPresence.None,
          }
        );
        expect(noneResult.items.map((item) => item.id)).toEqual([withSession]);
        expect(noneResult.total).toBe(unfiltered.total);
        expect(hasResult.total).toBe(unfiltered.total);
      });
    });

    it("excludes an orphaned wrote link (no SessionDetail) from the corpus until its session hydrates", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const user = await createTestUser(organizationId);
        // An active `wrote` link whose source SESSION has NO SessionDetail row
        // (FEA-4263 orphaned/half-synced link). `accumulateSessionLink` skips it
        // and `branchLinkedSessionExistsSql`'s INNER JOIN session_detail excludes
        // it, so it is NOT a valid linked session. Under FEA-4225 that makes the
        // branch ineligible for the corpus entirely — unfiltered and either
        // legacy sessionPresence value all return the same canonical result.
        const orphaned = await seedBranch(organizationId, {
          branchName: "orphaned-wrote",
          link: SeedLinkKind.OrphanedWrote,
          fileChanges: [[4, 1]],
        });

        const unfilteredBefore = await branchReadService.listBranches(
          organizationId,
          LIST_QUERY
        );
        expect(unfilteredBefore.items.map((item) => item.id)).toEqual([]);

        const hasBefore = await branchReadService.listBranches(organizationId, {
          ...LIST_QUERY,
          sessionPresence: BranchSessionPresence.Has,
        });
        expect(hasBefore.items.map((item) => item.id)).toEqual([]);

        const noneBefore = await branchReadService.listBranches(
          organizationId,
          { ...LIST_QUERY, sessionPresence: BranchSessionPresence.None }
        );
        expect(noneBefore.items.map((item) => item.id)).toEqual([]);

        // The session's detail row lands. The orphan is now a valid session, so
        // the branch becomes eligible and appears exactly once with one linked
        // session — proving eligibility keys off SessionDetail presence, not just
        // the link existing (graceful version-skew re-hydration).
        await withDb(async (db) => {
          const link = await db.artifactLink.findFirstOrThrow({
            where: { organizationId, targetId: orphaned },
            select: { sourceId: true },
          });
          const computeTarget = await db.computeTarget.create({
            data: {
              organizationId,
              userId: user.id,
              machineName: "machine-orphaned-wrote",
              platform: "darwin",
            },
            select: { id: true },
          });
          await db.sessionDetail.create({
            data: {
              artifactId: link.sourceId,
              userId: user.id,
              computeTargetId: computeTarget.id,
              externalSessionId: "ext-orphaned-wrote",
              harness: "claude",
              sessionStartedAt: new Date("2026-07-01T00:00:00.000Z"),
              sessionUpdatedAt: new Date("2026-07-01T00:00:00.000Z"),
            },
          });
        });

        const unfilteredAfter = await branchReadService.listBranches(
          organizationId,
          LIST_QUERY
        );
        expect(unfilteredAfter.items.map((item) => item.id)).toEqual([
          orphaned,
        ]);
        expect(unfilteredAfter.items[0]?.sessionIds).toHaveLength(1);

        const hasAfter = await branchReadService.listBranches(organizationId, {
          ...LIST_QUERY,
          sessionPresence: BranchSessionPresence.Has,
        });
        expect(hasAfter.items.map((item) => item.id)).toEqual([orphaned]);

        const noneAfter = await branchReadService.listBranches(organizationId, {
          ...LIST_QUERY,
          sessionPresence: BranchSessionPresence.None,
        });
        expect(noneAfter.items.map((item) => item.id)).toEqual([orphaned]);
        expect(noneAfter.total).toBe(unfilteredAfter.total);
        expect(hasAfter.total).toBe(unfilteredAfter.total);
      });
    });

    it("excludes a branch whose only link is reviewed-derived (no valid session)", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        // Legacy `branch_participation: null` link whose metadata derives
        // reviewed-only. `accumulateSessionLink` skips it, so its branch has an
        // empty `sessionIds`; under FEA-4225 a reviewed-only branch has no VALID
        // session link and is excluded from the corpus entirely. Both deprecated
        // sessionPresence values preserve that canonical empty result.
        await seedBranch(organizationId, {
          branchName: "reviewed-only",
          link: SeedLinkKind.ReviewedNullParticipation,
          fileChanges: [[7, 1]],
        });

        const unfiltered = await branchReadService.listBranches(
          organizationId,
          LIST_QUERY
        );
        expect(unfiltered.items.map((item) => item.id)).toEqual([]);

        const hasResult = await branchReadService.listBranches(organizationId, {
          ...LIST_QUERY,
          sessionPresence: BranchSessionPresence.Has,
        });
        expect(hasResult.items.map((item) => item.id)).toEqual([]);

        const noneResult = await branchReadService.listBranches(
          organizationId,
          { ...LIST_QUERY, sessionPresence: BranchSessionPresence.None }
        );
        expect(noneResult.items.map((item) => item.id)).toEqual([]);
      });
    });

    it("filters branches by an inclusive LOC-change range and EXCLUDES unavailable LOC", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const user = await createTestUser(organizationId);
        // FEA-4225: every branch must have a valid linked session to be eligible,
        // so seed each with a valid `Wrote` link — this test isolates the LOC-range
        // predicate, not the session-eligibility gate.
        const small = await seedBranch(organizationId, {
          branchName: "small",
          link: SeedLinkKind.Wrote,
          fileChanges: [[3, 2]], // 5
          userId: user.id,
        });
        const mid = await seedBranch(organizationId, {
          branchName: "mid",
          link: SeedLinkKind.Wrote,
          fileChanges: [
            [40, 0],
            [0, 10],
          ], // 50
          userId: user.id,
        });
        const big = await seedBranch(organizationId, {
          branchName: "big",
          link: SeedLinkKind.Wrote,
          fileChanges: [[400, 100]], // 500
          userId: user.id,
        });
        // No file-change rows ⇒ LOC unavailable; must be excluded once a bound is set.
        await seedBranch(organizationId, {
          branchName: "unavailable",
          link: SeedLinkKind.Wrote,
          fileChanges: [],
          userId: user.id,
        });

        const lowerBounded = await branchReadService.listBranches(
          organizationId,
          { ...LIST_QUERY, locMin: 50 }
        );
        expect(new Set(lowerBounded.items.map((item) => item.id))).toEqual(
          new Set([mid, big])
        );

        const windowed = await branchReadService.listBranches(organizationId, {
          ...LIST_QUERY,
          locMin: 10,
          locMax: 100,
        });
        expect(windowed.items.map((item) => item.id)).toEqual([mid]);

        // A wide-open lower bound of 0 still excludes the unavailable-LOC branch.
        const fromZero = await branchReadService.listBranches(organizationId, {
          ...LIST_QUERY,
          locMin: 0,
        });
        const fromZeroIds = new Set(fromZero.items.map((item) => item.id));
        expect(fromZeroIds).toEqual(new Set([small, mid, big]));
      });
    });
  }
);

describeIfDb("branch list status filtering — selected PR precedence", () => {
  it("reconciles PR-less local merged rows without overriding selected PR snapshots", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const user = await createTestUser(organizationId);
      const localMerged = await seedBranch(organizationId, {
        branchName: "local-merged-no-pr",
        link: SeedLinkKind.Wrote,
        artifactStatus: GitHubPRState.Merged,
        fileChanges: [],
        userId: user.id,
      });
      const selectedOpen = await seedBranch(organizationId, {
        branchName: "stale-local-merged-selected-open",
        link: SeedLinkKind.Wrote,
        artifactStatus: GitHubPRState.Merged,
        selectedPrState: GitHubPRState.Open,
        fileChanges: [],
        userId: user.id,
      });
      const selectedClosed = await seedBranch(organizationId, {
        branchName: "stale-local-merged-selected-closed",
        link: SeedLinkKind.Wrote,
        artifactStatus: GitHubPRState.Merged,
        selectedPrState: GitHubPRState.Closed,
        fileChanges: [],
        userId: user.id,
      });
      const duplicateSelectedOpen = await seedBranch(organizationId, {
        branchName: "stale-local-merged-duplicate-selected-open",
        link: SeedLinkKind.Wrote,
        artifactStatus: GitHubPRState.Merged,
        selectedPrState: GitHubPRState.Open,
        selectedPrSnapshotCount: 2,
        fileChanges: [],
        userId: user.id,
      });

      const unfiltered = await branchReadService.listBranches(
        organizationId,
        LIST_QUERY
      );
      expect(unfiltered.total).toBe(4);
      expect(
        unfiltered.items.find((item) => item.id === localMerged)?.status
      ).toBe(BranchStatus.Merged);
      expect(
        unfiltered.items.find((item) => item.id === selectedOpen)?.status
      ).toBe(BranchStatus.Open);
      expect(
        unfiltered.items.find((item) => item.id === selectedClosed)?.status
      ).toBe(BranchStatus.Closed);
      expect(
        unfiltered.items.find((item) => item.id === duplicateSelectedOpen)
          ?.status
      ).toBe(BranchStatus.Open);

      const merged = await branchReadService.listBranches(organizationId, {
        ...LIST_QUERY,
        status: [BranchStatus.Merged],
      });
      expect(merged.items.map((item) => item.id)).toEqual([localMerged]);
      expect(merged.items[0]?.status).toBe(BranchStatus.Merged);
      expect(merged.total).toBe(1);
    });
  });
});

/**
 * FEA-4225 — a valid linked session is a SERVER-SIDE eligibility requirement for
 * the agent Branches corpus. Remote PR/head evidence (identical `firstPushedAt`
 * on both branches here) may enrich a session-derived branch but is NOT
 * sufficient provenance on its own. Two branches carry the SAME remote head
 * evidence; only one has a valid session link. The list, total count, the
 * shared candidate-id path that feeds facets, and the analytics KPIs must all
 * return ONLY the linked branch. Once a session links to the other, it appears
 * exactly once with Linked Sessions = 1. Real Postgres because the gate lives in
 * a raw-SQL candidate predicate over `artifact_links`.
 */
describeIfDb(
  "branch list eligibility — requires a linked session (FEA-4225)",
  () => {
    it("surfaces only the session-linked branch, then the newly-linked one exactly once", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const user = await createTestUser(organizationId);
        // Identical remote head evidence (both push-qualified via seedBranch's
        // firstPushedAt), identical LOC — the ONLY difference is the session link.
        const linked = await seedBranch(organizationId, {
          branchName: "linked",
          link: SeedLinkKind.Wrote,
          fileChanges: [[10, 5]],
          userId: user.id,
        });
        const githubOnly = await seedBranch(organizationId, {
          branchName: "github-only",
          link: SeedLinkKind.None,
          fileChanges: [[10, 5]],
        });

        // List + total: only the linked branch is eligible.
        const before = await branchReadService.listBranches(
          organizationId,
          LIST_QUERY
        );
        expect(before.items.map((item) => item.id)).toEqual([linked]);
        expect(before.total).toBe(1);
        expect(before.hasMore).toBe(false);
        // The linked branch reports exactly one linked session.
        expect(before.items[0]?.sessionIds).toHaveLength(1);

        // Analytics KPIs cover the whole candidate corpus (shared candidate-id
        // path), so they see one active branch, not two.
        const analyticsBefore = await branchReadService.getBranchAnalytics(
          organizationId,
          LIST_QUERY
        );
        expect(analyticsBefore.activeBranchCount.value).toBe(1);

        // Detail: the GitHub-only branch 404s (getBranchDetail → null) even by
        // direct id, instead of rendering an empty "No sessions yet" detail.
        expect(
          await branchReadService.getBranchDetail(organizationId, githubOnly)
        ).toBeNull();
        expect(
          await branchReadService.getBranchDetail(organizationId, linked)
        ).not.toBeNull();

        // Link a valid session to the previously GitHub-only branch.
        await linkValidSessionToBranch({
          organizationId,
          userId: user.id,
          branchArtifactId: githubOnly,
          label: "github-only",
          sessionTimestamp: new Date("2026-07-01T00:00:00.000Z"),
        });

        // Now both appear — each exactly once, each with one linked session.
        const after = await branchReadService.listBranches(
          organizationId,
          LIST_QUERY
        );
        expect(new Set(after.items.map((item) => item.id))).toEqual(
          new Set([linked, githubOnly])
        );
        expect(after.total).toBe(2);
        const newlyLinked = after.items.find((item) => item.id === githubOnly);
        expect(newlyLinked?.sessionIds).toHaveLength(1);

        const analyticsAfter = await branchReadService.getBranchAnalytics(
          organizationId,
          LIST_QUERY
        );
        expect(analyticsAfter.activeBranchCount.value).toBe(2);

        // Detail now resolves for the newly-linked branch.
        expect(
          await branchReadService.getBranchDetail(organizationId, githubOnly)
        ).not.toBeNull();
      });
    });
  }
);

function persistedPullRequestHeadAuthority(
  branchArtifactId: string,
  repositoryFullName: string
) {
  const authority = persistedGitHubRepositoryAuthority({
    githubRepoId: `repo-${branchArtifactId}`,
    fullName: repositoryFullName,
  });
  return {
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
    headRepositoryDefaultBranchCredentialOwnerId:
      authority.defaultBranchCredentialOwnerId,
    headRepositoryDefaultBranchObservationKey:
      authority.defaultBranchObservationKey,
    headRepositoryDefaultBranchObservedAt: authority.defaultBranchObservedAt,
    headRepositoryDefaultBranchEventAt: authority.defaultBranchEventAt,
  };
}
