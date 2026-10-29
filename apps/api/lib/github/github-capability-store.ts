import type {
  GitHubAccessDenialReason,
  GitHubCredentialKind,
} from "@repo/api/src/types/github";
import type { TransactionClient } from "@repo/database";
import { getPrismaErrorCode } from "@/lib/db-utils";
import { GITHUB_SYNC_REPO_VERDICT_TTL_MS } from "@/lib/github/github-access";
import {
  normalizeGitHubName,
  storedGitHubCredentialKind,
} from "@/lib/github/github-connection-credential";

/**
 * PLN-1525: writes to the `GitHubAccessCapability` verdict cache. Reads are
 * folded into the registry query (`github-clerk-registry.ts`) so they cost
 * zero extra queries.
 *
 * Invalidation is NOT here. It used to be, as a 401 hook compare-and-set on
 * the stored cipher; PLN-1742's M5 tail moved it to the registry, which drops
 * a connection's verdicts in the same transaction that retires the row.
 */

export type GitHubCapabilityClient = {
  gitHubAccessCapability: Pick<
    TransactionClient["gitHubAccessCapability"],
    "updateMany" | "create" | "deleteMany"
  >;
};

export type GitHubCapabilityVerdict = {
  organizationId: string;
  githubUserConnectionId: string;
  targetOwner: string;
  normalizedTargetOwner: string;
  /**
   * Verdict granularity matches probe granularity: non-null (normalized via
   * normalizeGitHubName) for repo-bearing targets in both lanes; null only
   * for owner-only interactive targets.
   */
  targetRepo: string | null;
  credentialKind: GitHubCredentialKind;
  /** null = positive verdict (the credential reaches the target). */
  denialReason: GitHubAccessDenialReason | null;
  installationId: string | null;
  checkedAt: Date;
  expiresAt: Date;
};

/**
 * Race-safe, freshness-safe write of one verdict row. Row identity is
 * enforced by partial unique indexes (see the model's NOTE in schema.prisma),
 * which Prisma `upsert` cannot target — so this is update-first, then create
 * with a P2002 catch that falls back to updating the concurrent winner's row.
 *
 * Both update paths are gated on `checkedAt <= incoming.checkedAt`:
 * process-local single-flight does not protect separate serverless
 * instances, and a slower, older probe must never move the cache backward
 * over a newer verdict. A dropped stale write is the correct outcome.
 * `organizationId` rides in every predicate per the org-scoping rule.
 */
export async function saveCapabilityVerdict(
  db: GitHubCapabilityClient,
  verdict: GitHubCapabilityVerdict
): Promise<void> {
  const identity = {
    organizationId: verdict.organizationId,
    githubUserConnectionId: verdict.githubUserConnectionId,
    normalizedTargetOwner: verdict.normalizedTargetOwner,
    targetRepo: verdict.targetRepo,
  };
  const freshness = { checkedAt: { lte: verdict.checkedAt } };
  const data = {
    targetOwner: verdict.targetOwner,
    credentialKind: verdict.credentialKind,
    denialReason: verdict.denialReason,
    installationId: verdict.installationId,
    checkedAt: verdict.checkedAt,
    expiresAt: verdict.expiresAt,
  };
  const updated = await db.gitHubAccessCapability.updateMany({
    where: { ...identity, ...freshness },
    data,
  });
  if (updated.count > 0) {
    return;
  }
  try {
    await db.gitHubAccessCapability.create({
      data: { ...identity, ...data },
      select: { id: true },
    });
  } catch (error) {
    if (getPrismaErrorCode(error) !== "P2002") {
      throw error;
    }
    // Lost the create race. The winner's row may be newer than this verdict,
    // in which case the guarded update matches nothing — by design.
    await db.gitHubAccessCapability.updateMany({
      where: { ...identity, ...freshness },
      data,
    });
  }
}

/** One (owner, repo) pair a verdict lookup covers. */
export type GitHubRepoVerdictTarget = { owner: string; repo: string };

/** The verdict columns both the pool and the repo-sync tier reason over. */
export type GitHubRepoVerdictRow = {
  credentialKind: string;
  denialReason: string | null;
  checkedAt: Date;
  expiresAt: Date;
};

/**
 * Prisma `where` fragment selecting the ACTIVE verdict rows for ONE repo.
 *
 * One definition for every sync-lane carrier: the pool's nested select, the
 * per-repo tier classifier, and — through `activeRepoVerdictBatchWhere` — the
 * org-wide batch. Without this they drift, and a drifted predicate means the
 * pool refuses a credential the tier still counts as covering — the exact
 * thrash ISS-5093 exists to remove.
 *
 * Note the normalization: rows store owner and repo as SEPARATE columns keyed
 * by `normalizeGitHubName`, which is not the same helper as
 * `normalizeRepoFullName`. A caller holding a full name must split it first.
 *
 * This overload is EXACT — a one-element `IN` list is an equality — so its rows
 * can be handed straight to `hasActiveNoAccessVerdict` /
 * `hasDurableNoAccessVerdict`, which carry no owner/repo columns and so cannot
 * filter by pair themselves. Taking a single target rather than an array is
 * what keeps that true: batching many repos through here is a compile error,
 * not a silent cross-repo denial. Many repos go through the batch variant.
 */
export function activeRepoVerdictWhere(
  target: GitHubRepoVerdictTarget,
  now: Date
) {
  return activeRepoVerdictBatchWhere([target], now);
}

/**
 * The same fragment for MANY repos — a deliberate SUPERSET (ISS-6577).
 *
 * The columns are filtered by two independent `IN` lists rather than one
 * `{owner, repo}` disjunct per target, because an OR list makes Postgres
 * re-evaluate the whole expression against every scanned row (quadratic in an
 * org's repo count, on a path that runs on every connect/disconnect and
 * installation add/remove webhook) and burns 2 bind parameters per target
 * against PostgreSQL's 65,535 limit. Two hashed `IN` checks cost one bind
 * parameter per DISTINCT value and are flat in the repo count.
 *
 * They are also top-level and therefore sargable — but note there is as yet NO
 * composite index on (organization_id, normalized_target_owner, target_repo),
 * so today the planner still drives off `github_user_connection_id` or
 * `organization_id`. The win banked here is the per-row expression cost and the
 * bind-parameter count; the index that would let these quals drive the scan is
 * tracked separately.
 *
 * The price is that this matches the owner × repo CROSS-PRODUCT, so a caller
 * MUST re-key the rows by composite `owner/repo` and discard the pairs it did
 * not ask for BEFORE reasoning over them — the shared no-access predicates
 * cannot do it for you. Over-selection is the safe direction (every requested
 * pair is still matched) and is bounded by what the org actually stored: the
 * fragment can only ever return rows that exist.
 *
 * `expiresAt` lives here alone, so what "active" MEANS still has exactly one
 * definition across all three carriers; only the row-selection shape differs.
 */
export function activeRepoVerdictBatchWhere(
  targets: readonly GitHubRepoVerdictTarget[],
  now: Date
) {
  const owners = new Set<string>();
  const repoNames = new Set<string>();
  for (const target of targets) {
    owners.add(normalizeGitHubName(target.owner));
    repoNames.add(normalizeGitHubName(target.repo));
  }
  return {
    normalizedTargetOwner: { in: [...owners] },
    targetRepo: { in: [...repoNames] },
    expiresAt: { gt: now },
  };
}

/**
 * Does this connection hold an active no-access verdict for the target?
 *
 * Verdict rows earned by the OTHER credential family say nothing about this
 * one, so mismatched rows are ignored — the same rule the interactive
 * resolver's `readCachedVerdict` applies.
 */
export function hasActiveNoAccessVerdict(
  rows: readonly GitHubRepoVerdictRow[],
  scopes: readonly string[]
): boolean {
  const kind = storedGitHubCredentialKind(scopes);
  return rows.some(
    (row) => row.credentialKind === kind && row.denialReason !== null
  );
}

/**
 * The same question, but demanding a verdict the SYNC lane wrote.
 *
 * Both lanes write one shared row per (connection, owner, repo) and both stamp
 * `denialReason: no_installation`, so nothing on the row names its author. The
 * only thing that separates them is how long they claim to be true: the
 * interactive resolver writes a 5-minute negative, the sync lane a 6-hour one.
 *
 * That distinction is load-bearing for the tier and only for the tier. Pool
 * exclusion may honour any active verdict — it is re-evaluated every tick and
 * costs one credential one draw. Demoting a repo to `unsyncable` drops it out
 * of the sweep until the wake-up window, so letting a 5-minute interactive blip
 * trigger it would turn a transient 403 into a multi-hour sync outage.
 */
export function hasDurableNoAccessVerdict(
  rows: readonly GitHubRepoVerdictRow[],
  scopes: readonly string[]
): boolean {
  const kind = storedGitHubCredentialKind(scopes);
  return rows.some(
    (row) =>
      row.credentialKind === kind &&
      row.denialReason !== null &&
      row.expiresAt.getTime() - row.checkedAt.getTime() >=
        GITHUB_SYNC_REPO_VERDICT_TTL_MS
  );
}
