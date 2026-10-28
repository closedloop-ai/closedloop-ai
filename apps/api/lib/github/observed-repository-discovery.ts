import { withDb } from "@repo/database";
import { GITHUB_REPO_SCOPE } from "@/lib/github/github-connection-credential";
import { GitHubObservedRepositoryVerificationState } from "@/lib/github/observed-repository-store";
import {
  dueObservedRepositoryWhere,
  OBSERVED_REPOSITORY_VERIFY_BATCH,
} from "@/lib/github/observed-repository-verifier";

/**
 * Orgs one verification tick may sweep.
 *
 * Deliberately smaller than the bootstrap cron's own org batch: verification
 * spends the same user tokens the reconciler sweeps with, and it runs on every
 * tick rather than once per org, so the ceiling on tokens it can draw is
 * `VERIFY_ORG_BATCH * OBSERVED_REPOSITORY_VERIFY_BATCH` reads per hour.
 */
export const VERIFY_ORG_BATCH = 10;

/**
 * Repositories an installation-free org has actually been proven able to read.
 *
 * This is the third repo-sync discovery source, beside installation rows and
 * existing PR projections. It queues the targeted session-linked tier-2
 * reconciler; it must not be used to enumerate repository PR history.
 *
 * `githubRepoId` is required, not decorative. A row's identity and
 * default-branch group are written by the same settle that flips the state, so
 * the two cannot disagree today — but a reader that filters on the state alone
 * would silently start trusting a half-written row the moment that stops being
 * true, and `normalizeSessionAuthority` returns nothing without a provider id
 * anyway.
 */
export async function listVerifiedObservedRepositoryNames(
  organizationId: string
): Promise<string[]> {
  const rows = await withDb((db) =>
    db.gitHubObservedRepository.findMany({
      where: {
        organizationId,
        verificationState: GitHubObservedRepositoryVerificationState.Verified,
        githubRepoId: { not: null },
      },
      select: { repositoryFullName: true },
    })
  );
  return rows.map((row) => row.repositoryFullName);
}

/**
 * Orgs with verification work to do, in least-recently-attempted order.
 *
 * Selected from the ROWS rather than from `organizations`, and that is the whole
 * point: the bootstrap cron's own selector is gated on
 * `githubRepoSyncBootstrappedAt IS NULL`, so it visits an org exactly once and
 * never again. Verification is not a one-off — an org observes new repositories
 * on every desktop sync, a denial earns a re-check, and a backoff expires — so
 * hanging it off that marker would verify one batch per org, forever.
 *
 * Ordering on `lastVerificationAttemptAt` (nulls first) is what rotates the
 * sweep: the verifier advances that column on every row it touches, so an org
 * drains its backlog at `OBSERVED_REPOSITORY_VERIFY_BATCH` per tick and then
 * falls behind the orgs it was ahead of. Over-selecting rows by that same batch
 * size is what makes up to `limit` DISTINCT orgs reachable when one org holds a
 * run of consecutive rows.
 *
 * Narrowed to orgs holding a live `repo`-scoped connection, exactly as the
 * reconciler's tier-3 wake-up is: without one no credential can be drawn, so
 * every row would spend a tick to learn nothing and re-defer.
 *
 * That narrowing is part of the ROW read, not a filter over the selected orgs,
 * and the difference is the whole correctness of the rotation. A disconnected
 * org's rows are never handed to the verifier, so nothing ever advances their
 * `lastVerificationAttemptAt` and they hold the head of the nulls-first ordering
 * permanently. Capping distinct orgs first and filtering after let `limit` such
 * orgs occupy the entire page and return an empty batch on every tick, starving
 * every connected org behind them forever (#5551).
 *
 * The row read has no org equality, so the M0 index
 * `(organization_id, verification_state, next_verification_at)` cannot serve it.
 * ISS-7476 landed the index that can: `github_observed_repository_due_rotation_idx`
 * on `(last_verification_attempt_at, id) WHERE verification_state` is
 * non-terminal, declared on `GitHubObservedRepository` in `schema.prisma`.
 *
 * lc-debt: that index bounds the SCAN, not the SORT. PSL has no `nulls`
 * argument, so it is built NULLS LAST while this query orders NULLS FIRST; a
 * sort over the bounded non-terminal subset remains. The sibling org selector in
 * `github-repo-sync-state.ts` still has no supporting index at all and carries
 * the same posture on the same hourly cron.
 */
export async function selectOrgIdsWithDueObservedRepositories(
  limit: number,
  now: Date
): Promise<string[]> {
  const rows = await withDb((db) =>
    db.gitHubObservedRepository.findMany({
      where: {
        ...dueObservedRepositoryWhere(now),
        organization: {
          githubUserConnections: {
            some: { revokedAt: null, scopes: { has: GITHUB_REPO_SCOPE } },
          },
        },
      },
      orderBy: [
        { lastVerificationAttemptAt: { sort: "asc", nulls: "first" } },
        { id: "asc" },
      ],
      take: Math.max(1, limit) * OBSERVED_REPOSITORY_VERIFY_BATCH,
      select: { organizationId: true },
    })
  );
  const organizationIds: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!seen.has(row.organizationId)) {
      seen.add(row.organizationId);
      organizationIds.push(row.organizationId);
    }
    if (organizationIds.length >= Math.max(1, limit)) {
      break;
    }
  }
  return organizationIds;
}
