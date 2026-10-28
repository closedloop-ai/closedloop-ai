import { BranchStatus } from "@repo/api/src/types/branch";
import { GitHubPRState } from "@repo/api/src/types/github";
import {
  ArtifactRefMethod,
  SessionArtifactLinkKind,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
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
import { hasMatchingSessionPrLinks } from "./session-pr-links";

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
 *
 * ISS-7905 — and the reason this file is where that widening is PROVED. The
 * delivery arms now include a non-prose session→branch link, whose at-rest shape
 * carries no `metadata.method` key at all. Whether a JSON-path predicate ADMITS
 * an absent key is Postgres three-valued-logic behaviour that no mocked reader
 * can see: the unit suites assert the predicate's shape, and a shape assertion
 * stays green over a predicate that selects nothing. Only these cases fail when
 * that happens.
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
  lastVerifiedAt?: Date | null;
  /**
   * Which session→target relationship the seeded link records. `SessionBranch`
   * is the installation-free lane's at-rest shape and IS in the delivery
   * population since ISS-7905; pass `linkMethod` to make it prose-derived, which
   * is what still keeps a link out.
   */
  linkKind?: SessionArtifactLinkKind;
  /** `metadata.method`, the ref-provenance field the prose exclusion reads. */
  linkMethod?: ArtifactRefMethod;
  /** A PR that is current on its own row but NOT the branch's current pointer. */
  pointBranchAtPr?: boolean;
};

describeIfDb("collectMergedPrsForScope (ISS-6028, real Postgres)", () => {
  it("returns exactly the merged PRs the session-linked delivery arms reach", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const owner = await createTestUser(organizationId);
      const other = await createTestUser(organizationId);
      const foreignOrganizationId = await createTestOrganization();
      const foreignOwner = await createTestUser(foreignOrganizationId);

      // In scope: a merged, current PR reached through a SessionPr link.
      await seedBranchWithLinkedSession({
        organizationId,
        userId: owner.id,
        label: "merged",
        additions: 600,
        deletions: 400,
      });
      // ISS-7905, ALSO in scope: the installation-free lane's at-rest shape — a
      // non-prose session→BRANCH link and no session→PR link at all. Its
      // metadata carries no `method` key, which is the majority shape and the
      // one a bare `NOT` over that JSON path silently drops.
      await seedBranchWithLinkedSession({
        organizationId,
        userId: owner.id,
        label: "branch-link",
        linkKind: SessionArtifactLinkKind.SessionBranch,
        additions: 300,
        deletions: 200,
      });
      // Out of scope: linked from ANOTHER user's session, so the session `where`
      // must drop it — this is what proves the scope survives the semi-join.
      await seedBranchWithLinkedSession({
        organizationId,
        userId: other.id,
        label: "other-user",
      });
      await seedBranchWithLinkedSession({
        organizationId: foreignOrganizationId,
        userId: foreignOwner.id,
        label: "foreign-org",
      });
      // Out: an OPEN PR, a PROSE-derived session→branch link, and an unverified
      // merged PR. The prose row is the boundary of the widened arm — it shares
      // the admitted `branch-link` row's evidence tier and differs only by
      // provenance, so admitting branch evidence must not become a way back in
      // for the mentions ISS-5823 bars from every metric population.
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
        label: "branch-link-prose",
        linkKind: SessionArtifactLinkKind.SessionBranch,
        linkMethod: ArtifactRefMethod.BranchMentionInProse,
        additions: 700,
        deletions: 700,
      });
      await seedBranchWithLinkedSession({
        organizationId,
        userId: owner.id,
        label: "unverified",
        lastVerifiedAt: null,
      });

      const { prs } = await collectMergedPrsForScope(
        organizationId,
        scopeFor(organizationId, owner.id)
      );

      // TWO rows, named by their line counts rather than counted: `merged`
      // (600/400) through its session→PR link, and `branch-link` (300/200)
      // through branch evidence alone. Every other fixture seeded above is a
      // negative this set must not contain, and the sizes are distinct so a
      // widening that swept one of them in cannot pass as the right length.
      expect(prs.map((pr) => pr.additions).sort(ascending)).toEqual([300, 600]);
      expect(prs.map((pr) => pr.deletions).sort(ascending)).toEqual([200, 400]);
      expect(prs.every((pr) => pr.mergedAt === MERGED_AT.getTime())).toBe(true);
    });
  });

  it("admits a scope whose ONLY evidence is a non-prose session→branch link", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const branchOnly = await createTestUser(organizationId);
      const proseOnly = await createTestUser(organizationId);

      await seedBranchWithLinkedSession({
        organizationId,
        userId: branchOnly.id,
        label: "branch-only",
        linkKind: SessionArtifactLinkKind.SessionBranch,
        additions: 300,
        deletions: 200,
      });
      await seedBranchWithLinkedSession({
        organizationId,
        userId: proseOnly.id,
        label: "prose-only",
        linkKind: SessionArtifactLinkKind.SessionBranch,
        linkMethod: ArtifactRefMethod.PrMentionInProse,
      });

      const branchOnlyScope = scopeFor(organizationId, branchOnly.id);
      // The GATE, asserted on its own. `collectMergedPrsForScope` short-circuits
      // on `hasMatchingSessionPrLinks` BEFORE it reads a PR row, so a scope with
      // no session→PR link anywhere in it is the only fixture that can tell the
      // widened probe from the pre-ISS-7905 one: narrowing just this predicate
      // leaves a MIXED scope (a SessionPr link seeded beside a SessionBranch
      // one) green, because the probe finds the PR link either way.
      expect(await hasMatchingSessionPrLinks(branchOnlyScope)).toBe(true);
      expect(
        await hasMatchingSessionPrLinks(scopeFor(organizationId, proseOnly.id))
      ).toBe(false);

      // …and the production path end to end, so a probe that opens the gate
      // over a reader that then admits nothing cannot pass as a fix.
      const { prs } = await collectMergedPrsForScope(
        organizationId,
        branchOnlyScope
      );
      expect(prs.map((pr) => pr.additions)).toEqual([300]);
      const prose = await collectMergedPrsForScope(
        organizationId,
        scopeFor(organizationId, proseOnly.id)
      );
      expect(prose.prs).toEqual([]);
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

      const { prs } = await collectMergedPrsForScope(
        organizationId,
        scopeFor(organizationId, owner.id)
      );

      expect(prs).toHaveLength(3);
    });
  });

  it("admits only canonical identities on a reused Branch", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const owner = await createTestUser(organizationId);

      await seedReusedBranch({
        organizationId,
        userId: owner.id,
        label: "only-two",
        declaredNumbers: [2],
      });
      const { prs: onlyTwo } = await collectMergedPrsForScope(
        organizationId,
        scopeFor(organizationId, owner.id)
      );
      expect(onlyTwo.map((pr) => pr.additions)).toEqual([200]);

      await seedReusedBranch({
        organizationId,
        userId: owner.id,
        label: "both",
        declaredNumbers: [1, 2],
      });
      const { prs: both } = await collectMergedPrsForScope(
        organizationId,
        scopeFor(organizationId, owner.id)
      );
      expect(
        both.map((pr) => pr.additions).sort((a, b) => (a ?? 0) - (b ?? 0))
      ).toEqual([100, 200, 200]);
      expect(both.some((pr) => pr.additions === 300)).toBe(false);
    });
  });

  it("admits legacy unique Branches and excludes legacy ambiguous Branches", async () => {
    await autoRollbackTransaction(async () => {
      const organizationId = await createTestOrganization();
      const owner = await createTestUser(organizationId);
      await seedBranchWithLinkedSession({
        organizationId,
        userId: owner.id,
        label: "legacy-unique",
      });
      await seedReusedBranch({
        organizationId,
        userId: owner.id,
        label: "legacy-ambiguous",
        declaredNumbers: null,
        prNumbers: [1, 2],
      });

      const { prs } = await collectMergedPrsForScope(
        organizationId,
        scopeFor(organizationId, owner.id)
      );

      expect(prs).toHaveLength(1);
      expect(prs[0]?.additions).toBe(100);
    });
  });
});

/** Sorts nullable line counts so a set assertion does not depend on row order. */
function ascending(a: number | null, b: number | null): number {
  return (a ?? 0) - (b ?? 0);
}

/** The delivery scope shape: org-scoped sessions created by one user. */
function scopeFor(
  organizationId: string,
  userId: string
): Prisma.SessionDetailWhereInput {
  return { artifact: { is: { organizationId, createdById: userId } } };
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
      select: { artifactId: true },
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
        lastVerifiedAt:
          input.lastVerifiedAt === undefined
            ? new Date("2026-07-15T11:00:00.000Z")
            : input.lastVerifiedAt,
      },
      select: { id: true },
    });
    if (input.pointBranchAtPr !== false) {
      await db.branchDetail.update({
        where: { artifactId: branch.id },
        data: { currentPullRequestDetailId: pr.id },
        select: { artifactId: true },
      });
    }
    return branch.id;
  });
  const linkKind = input.linkKind ?? SessionArtifactLinkKind.SessionPr;
  await linkValidSessionToBranch({
    organizationId,
    userId: input.userId,
    branchArtifactId,
    label,
    ...(input.linkMethod
      ? { metadata: { linkKind, method: input.linkMethod } }
      : { linkKind }),
  });
  return branchArtifactId;
}

async function seedReusedBranch(input: {
  organizationId: string;
  userId: string;
  label: string;
  declaredNumbers: number[] | null;
  prNumbers?: number[];
}): Promise<string> {
  const prNumbers = input.prNumbers ?? [1, 2, 3];
  const repositoryFullName = `acme/${input.label}`;
  const branchArtifactId = await withDb(async (db) => {
    const branch = await db.artifact.create({
      data: {
        organizationId: input.organizationId,
        type: ArtifactType.BRANCH,
        name: `branch-${input.label}`,
        status: BranchStatus.Open,
      },
      select: { id: true },
    });
    await db.branchDetail.create({
      data: {
        artifactId: branch.id,
        organizationId: input.organizationId,
        repositoryFullName,
        branchName: input.label,
      },
      select: { artifactId: true },
    });
    let currentId: string | null = null;
    for (const number of prNumbers) {
      const pr = await db.pullRequestDetail.create({
        data: {
          organizationId: input.organizationId,
          branchArtifactId: branch.id,
          number,
          repositoryFullName,
          prState: GitHubPRState.Merged,
          mergedAt: MERGED_AT,
          lastVerifiedAt: new Date("2026-07-15T11:00:00.000Z"),
          additions: number * 100,
          deletions: 0,
          isCurrent: number === Math.max(...prNumbers),
        },
        select: { id: true },
      });
      if (number === Math.max(...prNumbers)) {
        currentId = pr.id;
      }
    }
    if (currentId) {
      await db.branchDetail.update({
        where: { artifactId: branch.id },
        data: { currentPullRequestDetailId: currentId },
        select: { artifactId: true },
      });
    }
    return branch.id;
  });
  await linkValidSessionToBranch({
    organizationId: input.organizationId,
    userId: input.userId,
    branchArtifactId,
    label: input.label,
    metadata:
      input.declaredNumbers === null
        ? { linkKind: SessionArtifactLinkKind.SessionPr }
        : {
            linkKind: SessionArtifactLinkKind.SessionBranch,
            linkKinds: [SessionArtifactLinkKind.SessionPrSet],
            prRefs: input.declaredNumbers.map((prNumber) => ({
              repositoryFullName,
              prNumber,
              relationTypes: [SessionPrRelationType.Created],
            })),
          },
  });
  return branchArtifactId;
}
