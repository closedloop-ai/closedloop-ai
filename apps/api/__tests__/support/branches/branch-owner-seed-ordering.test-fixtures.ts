import { BranchParticipationKind } from "@repo/api/src/types/branch";
import {
  BRANCH_PUSH_METHOD_VALUES,
  SessionArtifactLinkKind,
} from "@repo/api/src/types/session-artifact-link";
import { type Prisma, withDb } from "@repo/database";
import {
  closedloopKey,
  FIRST_PUSHED_AT,
  LATER_PUSHED_AT,
  seedBranch,
  seedCommit,
  seedGitHubConnection,
} from "@/__tests__/utils/branch-identity-sql-fixture";
import {
  createTestUser,
  linkValidSessionToBranch,
} from "@/__tests__/utils/db-helpers";

/**
 * ISS-12463: branches whose Owner is decided by the ordering clauses of the
 * candidate SQL rather than by which single rung has evidence — rung
 * precedence, every within-rung tiebreak, the `IS NOT NULL` / `<> ''` login
 * guards, and each push-method and link-kind literal. The backfill migration
 * carries a hand-inlined copy of that SQL, so a clause that decides no branch
 * here could drift on one side with the parity case still green.
 *
 * A connection whose login is `''` makes the `<> ''` guards observable: without
 * the guard, the absent login resolves to that user instead of being skipped.
 *
 * @returns the seeded branch ids and the owner each must be stamped with.
 */
export async function seedOwnerOrderingCorpus(
  organizationId: string
): Promise<Map<string, string>> {
  const [
    pusher,
    committer,
    prAuthor,
    emptyLogin,
    undated,
    later,
    tieLow,
    tieHigh,
    prOtherRepo,
    prFirst,
    prSecond,
    twinA,
    twinB,
    pushTieA,
    pushTieB,
    pushEarly,
    pushLate,
  ] = await Promise.all(
    Array.from({ length: 17 }, () => createTestUser(organizationId))
  );
  const connections: [{ id: string }, string][] = [
    [committer, "ordering-committer"],
    [prAuthor, "ordering-pr-author"],
    [emptyLogin, ""],
    [undated, "ordering-undated"],
    [later, "ordering-later"],
    [tieLow, "ordering-tie-low"],
    [tieHigh, "ordering-tie-high"],
    [prOtherRepo, "ordering-pr-other-repo"],
    [prFirst, "ordering-pr-first"],
    [prSecond, "ordering-pr-second"],
    [twinA, "ordering-twin"],
    [twinB, "ordering-twin"],
  ];
  await Promise.all(
    connections.map(([user, login]) =>
      seedGitHubConnection({ organizationId, userId: user.id, login })
    )
  );
  const seed = ordering(organizationId);
  const expected = new Map<string, string>();

  const pushOverInference = await seed.branch("push-over-inference", true);
  await seed.push(pushOverInference, pusher.id, FIRST_PUSHED_AT);
  await seed.commit(pushOverInference, "ordering-committer", FIRST_PUSHED_AT);
  await seed.pullRequest(pushOverInference, "acme/a", 1, "ordering-pr-author");
  expected.set(pushOverInference, pusher.id);

  const commitOverPr = await seed.branch("commit-over-pr", false);
  await seed.commit(commitOverPr, "ordering-committer", FIRST_PUSHED_AT);
  await seed.pullRequest(commitOverPr, "acme/a", 1, "ordering-pr-author");
  expected.set(commitOverPr, committer.id);

  // Each discarded commit wins under one mutated clause: the NULL and `''`
  // logins without their guards, the undated one under NULLS FIRST, the later
  // one under `committed_at DESC`, the higher sha under `sha DESC`.
  const commitOrder = await seed.branch("commit-order", false);
  await seed.commit(commitOrder, null, daysBefore(2));
  await seed.commit(commitOrder, "", daysBefore(1));
  await seed.commit(commitOrder, "ordering-undated", null);
  await seed.commit(commitOrder, "ordering-later", LATER_PUSHED_AT);
  await seed.commit(commitOrder, "ordering-tie-high", FIRST_PUSHED_AT, "b");
  await seed.commit(commitOrder, "ordering-tie-low", FIRST_PUSHED_AT, "a");
  expected.set(commitOrder, tieLow.id);

  // The earliest commit's author has no connection: the rung is spent, and
  // the later commit's author must not inherit it.
  const unresolvedCommit = await seed.branch("unresolved-commit", false);
  await seed.commit(unresolvedCommit, "ordering-ghost", FIRST_PUSHED_AT);
  await seed.commit(unresolvedCommit, "ordering-committer", LATER_PUSHED_AT);
  await seed.pullRequest(unresolvedCommit, "acme/a", 1, "ordering-pr-author");
  expected.set(unresolvedCommit, prAuthor.id);

  // An unresolvable PR author falls through to the next PR, in repository
  // name then number order.
  const prOrder = await seed.branch("pr-order", false);
  await seed.pullRequest(prOrder, "acme/b", 1, "ordering-pr-other-repo");
  await seed.pullRequest(prOrder, "acme/a", 2, "");
  await seed.pullRequest(prOrder, "acme/a", 3, "ordering-ghost");
  await seed.pullRequest(prOrder, "acme/a", 5, "ordering-pr-second");
  await seed.pullRequest(prOrder, "acme/a", 4, "ordering-pr-first");
  expected.set(prOrder, prFirst.id);

  // Two connections share one login: `person_key` settles the rung.
  const twinLogin = await seed.branch("twin-login", false);
  await seed.commit(twinLogin, "ordering-twin", FIRST_PUSHED_AT);
  expected.set(twinLogin, lowerKey(twinA.id, twinB.id));

  const pushTie = await seed.branch("push-tie", true);
  await seed.push(pushTie, pushTieA.id, FIRST_PUSHED_AT);
  await seed.push(pushTie, pushTieB.id, FIRST_PUSHED_AT);
  expected.set(pushTie, lowerKey(pushTieA.id, pushTieB.id));

  const pushEarliest = await seed.branch("push-earliest", false);
  await seed.push(pushEarliest, pushLate.id, LATER_PUSHED_AT);
  await seed.push(pushEarliest, pushEarly.id, FIRST_PUSHED_AT);
  expected.set(pushEarliest, pushEarly.id);

  // Push evidence recorded only through a literal the SQL names: each must
  // outrank the commit author.
  const ghPrCreate = await seed.branch("gh-pr-create", false);
  await seed.push(ghPrCreate, pusher.id, FIRST_PUSHED_AT, {
    method: GH_PR_CREATE_METHOD,
  });
  await seed.commit(ghPrCreate, "ordering-committer", FIRST_PUSHED_AT);
  expected.set(ghPrCreate, pusher.id);

  const sessionPrSet = await seed.branch("session-pr-set", false);
  await seed.push(sessionPrSet, pusher.id, FIRST_PUSHED_AT, {
    metadata: { linkKinds: [SessionArtifactLinkKind.SessionPrSet] },
    participation: BranchParticipationKind.Reviewed,
  });
  await seed.commit(sessionPrSet, "ordering-committer", FIRST_PUSHED_AT);
  expected.set(sessionPrSet, pusher.id);

  const sessionPr = await seed.branch("session-pr", false);
  await seed.push(sessionPr, pusher.id, FIRST_PUSHED_AT, {
    metadata: { linkKind: SessionArtifactLinkKind.SessionPr },
  });
  await seed.commit(sessionPr, "ordering-committer", FIRST_PUSHED_AT);
  expected.set(sessionPr, pusher.id);

  return expected;
}

type PushOptions = {
  method?: string;
  metadata?: Prisma.InputJsonObject;
  participation?: BranchParticipationKind;
};

function ordering(organizationId: string) {
  let sequence = 0;
  const next = () => {
    sequence += 1;
    return sequence;
  };
  return {
    branch: (name: string, stamped: boolean) =>
      seedBranch(organizationId, `ordering-${name}`, {
        firstPushedAt: stamped ? FIRST_PUSHED_AT : null,
      }),
    /** `shaDigit` repeats into the sha, so a tie's order is the digit's. */
    commit: (
      branchId: string,
      authorLogin: string | null,
      committedAt: Date | null,
      shaDigit?: string
    ) =>
      seedCommit({
        organizationId,
        branchId,
        sha: shaDigit
          ? shaDigit.repeat(SHA_LENGTH)
          : `${next()}`.padStart(SHA_LENGTH, "0"),
        authorLogin,
        committedAt,
      }),
    /**
     * The branch id is appended to `repository` so two branches' PRs never
     * share a (repository, number) key; it is shared within a branch, so the
     * PRs' repository order is `repository`'s.
     */
    pullRequest: async (
      branchId: string,
      repository: string,
      number: number,
      authorLogin: string
    ) => {
      await withDb((db) =>
        db.pullRequestDetail.create({
          data: {
            organizationId,
            branchArtifactId: branchId,
            repositoryFullName: `${repository}-${branchId}`,
            number,
            authorLogin,
          },
          select: { id: true },
        })
      );
    },
    push: async (
      branchId: string,
      userId: string,
      observedAt: Date,
      options: PushOptions = {}
    ) => {
      const sessionArtifactId = await linkValidSessionToBranch({
        organizationId,
        userId,
        branchArtifactId: branchId,
        label: `ordering-push-${next()}`,
        ...(options.metadata ? { metadata: options.metadata } : {}),
      });
      await withDb((db) =>
        db.artifactLink.updateMany({
          where: {
            organizationId,
            sourceId: sessionArtifactId,
            targetId: branchId,
          },
          data: {
            branchParticipationMethod: options.method ?? GIT_PUSH_METHOD,
            branchParticipationObservedAt: observedAt,
            ...(options.participation
              ? { branchParticipation: options.participation }
              : {}),
          },
        })
      );
    },
  };
}

function daysBefore(days: number): Date {
  return new Date(FIRST_PUSHED_AT.getTime() - days * DAY_MS);
}

function lowerKey(left: string, right: string): string {
  return closedloopKey(left) < closedloopKey(right) ? left : right;
}

const [GIT_PUSH_METHOD, GH_PR_CREATE_METHOD] = BRANCH_PUSH_METHOD_VALUES;
const SHA_LENGTH = 40;
const DAY_MS = 86_400_000;
