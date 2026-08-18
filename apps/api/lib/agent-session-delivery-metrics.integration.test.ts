import { BranchStatus } from "@repo/api/src/types/branch";
import { GitHubPRState } from "@repo/api/src/types/github";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import { ArtifactType, type Prisma, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestUser,
  linkValidSessionToBranch,
} from "@/__tests__/utils/db-helpers";
import { collectMergedPrsForScope } from "./agent-session-delivery-metrics";

/**
 * ISS-6028 — the delivery cards' merged-PR population, against real Postgres.
 *
 * The fix reversed the traversal: instead of paging every PR-linked session and
 * walking `sourceLinks → target → branch → currentPullRequestDetail` per row, the
 * reader starts at `PullRequestDetail` and semi-joins BACK through the same
 * links. The mocked unit cases pin the STATEMENT that read builds; only a real
 * database proves the reversed relation path selects the SAME set — that the
 * link kind, the branch's current-PR pointer, the merged predicate, and the
 * session `where` all still constrain it. Runs inside `autoRollbackTransaction`,
 * so nothing persists.
 */

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const MERGED_AT = new Date("2026-07-15T12:00:00.000Z");

type SeedBranchInput = {
  organizationId: string;
  /** Owner of the linked session — the scope predicate filters on it. */
  userId: string;
  label: string;
  prState?: GitHubPRState;
  mergedAt?: Date | null;
  additions?: number;
  deletions?: number;
  /** Non-SessionPr links must not reach the delivery population. */
  linkKind?: SessionArtifactLinkKind;
  /** A PR that is current on its own row but NOT the branch's current pointer. */
  pointBranchAtPr?: boolean;
};

describeIfDb("collectMergedPrsForScope (ISS-6028, real Postgres)", () => {
  it("returns exactly the merged PRs the session→PR links reach for the scope", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const owner = await createTestUser(organizationId);
      const other = await createTestUser(organizationId);

      // In scope: a merged, current PR reached through a SessionPr link.
      await seedBranchWithLinkedSession({
        organizationId,
        userId: owner.id,
        label: "merged",
        additions: 600,
        deletions: 400,
      });
      // Out of scope: linked from ANOTHER user's session, so the session `where`
      // must drop it — this is what proves the scope survives the semi-join.
      await seedBranchWithLinkedSession({
        organizationId,
        userId: other.id,
        label: "other-user",
      });
      // Out: an OPEN PR (merged predicate), a session→BRANCH link rather than a
      // session→PR one (link kind), and a merged PR the branch does not point at
      // as its current PR (the traversal the old reader walked).
      await seedBranchWithLinkedSession({
        organizationId,
        userId: owner.id,
        label: "open",
        prState: GitHubPRState.Open,
        mergedAt: null,
      });
      await seedBranchWithLinkedSession({
        organizationId,
        userId: owner.id,
        label: "branch-link",
        linkKind: SessionArtifactLinkKind.SessionBranch,
      });
      await seedBranchWithLinkedSession({
        organizationId,
        userId: owner.id,
        label: "not-current",
        pointBranchAtPr: false,
      });

      const prs = await collectMergedPrsForScope(
        organizationId,
        scopeFor(organizationId, owner.id)
      );

      expect(prs).toHaveLength(1);
      expect(prs[0]?.mergedAt).toBe(MERGED_AT.getTime());
      expect(prs[0]?.additions).toBe(600);
      expect(prs[0]?.deletions).toBe(400);
    });
  });

  it("counts a PR reached from two sessions once, and two same-numbered repo-less PRs twice", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const owner = await createTestUser(organizationId);

      // One PR, two linking sessions → one row, one identity.
      const shared = await seedBranchWithLinkedSession({
        organizationId,
        userId: owner.id,
        label: "shared",
      });
      await linkValidSessionToBranch({
        organizationId,
        userId: owner.id,
        label: "shared-second",
        branchArtifactId: shared,
        linkKind: SessionArtifactLinkKind.SessionPr,
      });
      // Two DISTINCT repo-less PRs that share number 42: the identity falls back
      // to the linked branch artifact, so they must stay two (dedup-by-nullable).
      await seedBranchWithLinkedSession({
        organizationId,
        userId: owner.id,
        label: "repoless-a",
        repoLess: true,
      });
      await seedBranchWithLinkedSession({
        organizationId,
        userId: owner.id,
        label: "repoless-b",
        repoLess: true,
      });

      const prs = await collectMergedPrsForScope(
        organizationId,
        scopeFor(organizationId, owner.id)
      );

      expect(prs).toHaveLength(3);
    });
  });
});

/** The delivery scope shape: org-scoped sessions owned by one user. */
function scopeFor(
  organizationId: string,
  userId: string
): Prisma.SessionDetailWhereInput {
  return { userId, artifact: { is: { organizationId } } };
}

/**
 * Seeds a branch artifact carrying a pull request, plus a session linked to that
 * branch. Returns the branch artifact id.
 */
async function seedBranchWithLinkedSession(
  input: SeedBranchInput & { repoLess?: boolean }
): Promise<string> {
  const { organizationId, label } = input;
  const repositoryFullName = input.repoLess ? null : `acme/${label}`;
  const branchArtifactId = await withDb(async (db) => {
    const branch = await db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.BRANCH,
        name: `branch-${label}`,
        status: BranchStatus.Open,
      },
      select: { id: true },
    });
    await db.branchDetail.create({
      data: {
        artifactId: branch.id,
        organizationId,
        repositoryFullName: `acme/${label}`,
        branchName: label,
      },
    });
    const pr = await db.pullRequestDetail.create({
      data: {
        organizationId,
        branchArtifactId: branch.id,
        // Repo-less PRs deliberately share one number so the fallback identity
        // is what keeps them apart.
        number: input.repoLess ? 42 : 1,
        repositoryFullName,
        prState: input.prState ?? GitHubPRState.Merged,
        mergedAt: input.mergedAt === undefined ? MERGED_AT : input.mergedAt,
        additions: input.additions ?? 100,
        deletions: input.deletions ?? 50,
        isCurrent: true,
      },
      select: { id: true },
    });
    if (input.pointBranchAtPr !== false) {
      await db.branchDetail.update({
        where: { artifactId: branch.id },
        data: { currentPullRequestDetailId: pr.id },
      });
    }
    return branch.id;
  });
  await linkValidSessionToBranch({
    organizationId,
    userId: input.userId,
    branchArtifactId,
    label,
    linkKind: input.linkKind ?? SessionArtifactLinkKind.SessionPr,
  });
  return branchArtifactId;
}
