import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import { GitHubFetchMechanism } from "@repo/api/src/types/github-read-model";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import { withDb } from "@repo/database";
import {
  type baseFixture,
  branchRef,
  findBranch,
  findPrByBranchNumber,
  PR_OBSERVED_AT,
  pullRequestRef,
  syncSession,
} from "./agent-session-pr-sync-helpers";

export const REPO = "acme/widgets";
export const NORMALIZED_REPO = normalizeRepoFullName(REPO);

/** The operator's `--min-attempt-age` boundary for this suite. */
export const CUTOFF = new Date("2026-08-22T00:00:00.000Z");
/** A reconciler attempt that has stood unanswered well past the cutoff. */
export const OLD_ATTEMPT = new Date("2026-08-01T00:00:00.000Z");
/** An attempt inside the grace window — the provider may still answer it. */
export const RECENT_ATTEMPT = new Date("2026-08-28T00:00:00.000Z");

/**
 * Prisma's 5s interactive-transaction default is a FIXTURE budget here, not an
 * assertion: every case seeds five to seven pull requests through the real sync
 * lane before it asserts anything, which sits right at that boundary on a loaded
 * machine. Widening it changes no expectation — the whole case still runs inside
 * one transaction that is still rolled back.
 */
export const ROLLBACK_OPTIONS = { maxWait: 5000, timeout: 20_000 };

export type StubShape = {
  fetchMechanism?: string;
  prState?: GitHubPRState;
  lastVerifiedAt?: Date | null;
  lastRefreshAttemptAt?: Date | null;
};

export async function syncPrRow(
  fx: Awaited<ReturnType<typeof baseFixture>>,
  branchName: string,
  prNumber: number,
  title?: string,
  repo: string = REPO
) {
  await syncSession({
    ...fx,
    artifactRefs: [
      branchRef(repo, branchName),
      pullRequestRef({
        repositoryFullName: repo,
        branchName,
        prNumber,
        ...(title ? { title } : {}),
      }),
    ],
  });
  const branch = await findBranch(
    fx.organizationId,
    normalizeRepoFullName(repo),
    branchName
  );
  if (!branch) {
    throw new Error(`branch ${branchName} did not materialize`);
  }
  const pr = await findPrByBranchNumber(branch.artifactId, prNumber);
  if (!pr) {
    throw new Error(`PR ${prNumber} did not materialize`);
  }
  return pr;
}

/** Write the desktop row, then force it into the state under test. */
export async function seedStub(
  fx: Awaited<ReturnType<typeof baseFixture>>,
  branchName: string,
  prNumber: number,
  shape: StubShape,
  title?: string,
  repo: string = REPO
) {
  const pr = await syncPrRow(fx, branchName, prNumber, title, repo);
  await withDb((db) =>
    db.pullRequestDetail.update({ where: { id: pr.id }, data: shape })
  );
  return pr;
}

export function readStamp(id: string) {
  return withDb((db) =>
    db.pullRequestDetail.findUniqueOrThrow({
      where: { id },
      select: { lastVerifiedAt: true, prState: true },
    })
  );
}

/**
 * Seven rows, one of which is the answer.
 *
 * Numbers are meaningful only as identity; the cohort is named by the constant
 * holding the id.
 */
export async function seedMixedPopulation(
  fx: Awaited<ReturnType<typeof baseFixture>>
) {
  // MERGED rather than the column default, deliberately. A `state`-only desktop
  // ref is verified by the producer and still a stub to the reconciler
  // (desktop-pull-request-facts.ts), so a non-default state with every fetchable
  // fact column still NULL is a first-class member of this population — and it is
  // the only shape that can tell a captured `pr_state` from a hardcoded one.
  const unresolvable = await seedStub(fx, "feature/unresolvable", 9001, {
    prState: GitHubPRState.Merged,
    lastVerifiedAt: PR_OBSERVED_AT,
    lastRefreshAttemptAt: OLD_ATTEMPT,
  });
  // The legacy producer wrote BOTH clocks from one `observedAt`, so equal
  // clocks mean the reconciler has never attempted this row. It is due to
  // self-repair on its next tick and must survive.
  const selfHealing = await seedStub(fx, "feature/self-healing", 9002, {
    lastVerifiedAt: PR_OBSERVED_AT,
    lastRefreshAttemptAt: PR_OBSERVED_AT,
  });
  // Written after ISS-8423: factless and already honest, so there is no stamp
  // to clear. The producer leaves both clocks null on its own.
  const postFix = await syncPrRow(fx, "feature/post-fix", 9003);
  const healthy = await seedStub(
    fx,
    "feature/healthy",
    9004,
    { lastVerifiedAt: PR_OBSERVED_AT, lastRefreshAttemptAt: OLD_ATTEMPT },
    "A real title"
  );
  // ISS-8462: a reconciled desktop row whose mechanism flipped and which the
  // selector can no longer reach. It fails every other conjunct's test for
  // "resolvable", which is exactly why the mechanism conjunct has to hold it.
  const frozen = await seedStub(fx, "feature/frozen", 9005, {
    fetchMechanism: GitHubFetchMechanism.Graphql,
    lastVerifiedAt: PR_OBSERVED_AT,
    lastRefreshAttemptAt: OLD_ATTEMPT,
  });
  const recentlyAttempted = await seedStub(fx, "feature/recent", 9006, {
    lastVerifiedAt: PR_OBSERVED_AT,
    lastRefreshAttemptAt: RECENT_ATTEMPT,
  });
  // Written after ISS-8423 and since attempted by the reconciler without being
  // resolved: genuinely unresolvable, but it never claimed verification, so
  // there is no stamp to clear and no prior value to capture. Selecting it would
  // drive a NOT NULL capture insert with a null pre-image.
  const attemptedPostFix = await seedStub(
    fx,
    "feature/attempted-post-fix",
    9007,
    {
      lastVerifiedAt: null,
      lastRefreshAttemptAt: OLD_ATTEMPT,
    }
  );
  return {
    unresolvable,
    selfHealing,
    postFix,
    healthy,
    frozen,
    recentlyAttempted,
    attemptedPostFix,
  };
}

/** A second repo in the SAME org, so a global LIMIT can cross a group boundary. */
export const SECOND_REPO = "acme/gadgets";
export const NORMALIZED_SECOND_REPO = normalizeRepoFullName(SECOND_REPO);

/**
 * Five eligible stubs, two repos, attempt clocks interleaved so a global
 * `LIMIT 3` lands two rows in one group and one in the other.
 *
 * Interleaving is the point. If both repos' rows were contiguous in attempt
 * order, a limited run would empty one group and skip the other, and a summary
 * that ignored the LIMIT entirely would still get one group's number right by
 * accident.
 */
export async function seedInterleavedEligible(
  fx: Awaited<ReturnType<typeof baseFixture>>
) {
  const attempts = [
    { repo: REPO, at: new Date("2026-08-01T00:00:00.000Z") },
    { repo: SECOND_REPO, at: new Date("2026-08-02T00:00:00.000Z") },
    { repo: REPO, at: new Date("2026-08-03T00:00:00.000Z") },
    { repo: SECOND_REPO, at: new Date("2026-08-04T00:00:00.000Z") },
    { repo: REPO, at: new Date("2026-08-05T00:00:00.000Z") },
  ];
  const seeded: { id: string; repo: string }[] = [];
  for (const [index, attempt] of attempts.entries()) {
    const pr = await seedStub(
      fx,
      `feature/eligible-${index}`,
      9100 + index,
      { lastVerifiedAt: PR_OBSERVED_AT, lastRefreshAttemptAt: attempt.at },
      undefined,
      attempt.repo
    );
    seeded.push({ id: pr.id, repo: attempt.repo });
  }
  return seeded;
}
