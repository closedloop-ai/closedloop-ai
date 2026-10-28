import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import { Prisma, withDb } from "@repo/database";
import { v7 as uuidv7 } from "uuid";
import { POSTGRES_MAX_ACCEPTED_VERBATIM_BIND_PARAMETERS } from "@/lib/postgres-bind-parameters";

/**
 * Bind slots one VALUES row consumes: id, organization_id, repository_full_name,
 * verification_state, first_observed_at, last_observed_at,
 * observed_session_count, updated_at.
 */
const OBSERVED_REPOSITORY_BINDS_PER_ROW = 8;

/**
 * Rows per statement, DERIVED from the ceiling rather than chosen — the same
 * reasoning `REPO_SYNC_TIER_UPSERT_CHUNK_SIZE` spells out: a hand-picked
 * constant lets a widened row silently overflow the Bind message, while a
 * derived one moves with the row. Halved for headroom, so the row can double in
 * width before the size has to change.
 *
 * The VERBATIM ceiling, because the write below is a `$executeRaw` assembled
 * with `Prisma.join` — Prisma passes it through without inspecting it, so it
 * meets the wire's uint16 limit rather than Prisma's own per-statement budget.
 * The ACCEPTED member of that pair, because the question here is how wide a
 * statement may be, not the width at which one is refused.
 *
 * The ingest caller caps a batch well below this, so in practice one statement
 * carries the whole batch; the chunking is the bound for any other caller.
 */
export const OBSERVED_REPOSITORY_UPSERT_CHUNK_SIZE = Math.floor(
  POSTGRES_MAX_ACCEPTED_VERBATIM_BIND_PARAMETERS /
    OBSERVED_REPOSITORY_BINDS_PER_ROW /
    2
);

/**
 * PLN-1775 M1: one desktop-observed repository name and how many of this
 * payload's sessions named it.
 */
export type ObservedRepositoryObservation = {
  repositoryFullName: string;
  observedSessionCount: number;
};

/**
 * Record repository names the org's own sessions worked in but for which the
 * server holds no repository record at all (ISS-7403).
 *
 * This is DISCOVERY, not authority. The row it writes is `pending` and carries
 * no identity: a desktop-reported full name still proves nothing about a
 * repository, and only M2's verified read may fill the identity and
 * default-branch columns. Until then the row means exactly "someone here works
 * in a repo by this name", which is the input an oauth-only org has and the
 * installation-derived candidate sources cannot see.
 *
 * WRITES OUTSIDE THE INGEST TRANSACTION, by the caller's construction: the
 * session slices this describes have already committed. A failure here must
 * never cost a durable session, and a Prisma interactive transaction cannot
 * absorb a failed write and keep going (AGENTS.md), so the write cannot live at
 * the seam that produced the names.
 *
 * `ON CONFLICT` deliberately touches only the observation columns. An already
 * `verified` or `denied` row keeps its state, its identity, its failure count,
 * and its `next_verification_at` — re-seeing a repo is not evidence about
 * whether we can read it, and resetting the verifier's bookkeeping from the
 * ingest path would let a busy repo retry a settled denial forever.
 *
 * Rows are normalized, folded by name, and written in a TOTAL ORDER. Both parts
 * are load-bearing: a single multi-row `ON CONFLICT DO UPDATE` aborts with
 * SQLSTATE 21000 if one conflict key appears twice in its VALUES list
 * (normalization can collapse two caller keys into one), and two ingests for the
 * same org run concurrently — unordered, they can take the same row locks in
 * opposite orders and deadlock (40P01), exactly as the repo-sync tier write
 * orders its own chunk.
 *
 * Timestamps are BOUND from `now` rather than `NOW()` — the columns are
 * `TIMESTAMP(3)` without zone, and a server-side `NOW()` would land a
 * session-`TimeZone`-converted value beside the UTC ones Prisma writes.
 */
export async function recordObservedRepositories(input: {
  organizationId: string;
  observations: readonly ObservedRepositoryObservation[];
  now: Date;
}): Promise<void> {
  const rows = foldObservationRows(input.observations);
  if (rows.length === 0) {
    return;
  }
  for (
    let start = 0;
    start < rows.length;
    start += OBSERVED_REPOSITORY_UPSERT_CHUNK_SIZE
  ) {
    const chunk = rows.slice(
      start,
      start + OBSERVED_REPOSITORY_UPSERT_CHUNK_SIZE
    );
    const values = Prisma.join(
      chunk.map(
        (row) => Prisma.sql`(
          ${uuidv7()}::uuid,
          ${input.organizationId}::uuid,
          ${row.repositoryFullName},
          ${GitHubObservedRepositoryVerificationState.Pending},
          ${input.now},
          ${input.now},
          ${row.observedSessionCount},
          ${input.now}
        )`
      )
    );
    await withDb((db) =>
      db.$executeRaw(Prisma.sql`
        INSERT INTO "github_observed_repository" (
          "id",
          "organization_id",
          "repository_full_name",
          "verification_state",
          "first_observed_at",
          "last_observed_at",
          "observed_session_count",
          "updated_at"
        )
        VALUES ${values}
        ON CONFLICT ("organization_id", "repository_full_name") DO UPDATE SET
          "last_observed_at" = EXCLUDED."last_observed_at",
          "observed_session_count" =
            "github_observed_repository"."observed_session_count"
            + EXCLUDED."observed_session_count",
          "updated_at" = EXCLUDED."updated_at"
      `)
    );
  }
}

/**
 * Normalize, fold by name, and order the batch's observations.
 *
 * A count is summed rather than replaced when normalization collapses two
 * caller keys, so folding cannot lose the evidence weight of either.
 */
function foldObservationRows(
  observations: readonly ObservedRepositoryObservation[]
): ObservedRepositoryObservation[] {
  const byFullName = new Map<string, number>();
  for (const observation of observations) {
    const repositoryFullName = normalizeRepoFullName(
      observation.repositoryFullName
    );
    if (repositoryFullName.length === 0) {
      continue;
    }
    const observed = Math.max(1, observation.observedSessionCount);
    byFullName.set(
      repositoryFullName,
      (byFullName.get(repositoryFullName) ?? 0) + observed
    );
  }
  return [...byFullName]
    .map(([repositoryFullName, observedSessionCount]) => ({
      repositoryFullName,
      observedSessionCount,
    }))
    .sort((left, right) =>
      left.repositoryFullName.localeCompare(right.repositoryFullName)
    );
}

/**
 * PLN-1775 M0: how far a desktop-observed repository has got toward being usable
 * as a discovery candidate and a branch-authority source (`GitHubObservedRepository`).
 *
 * `Pending` is the only state an observation write may create, and it is NOT a
 * claim about the repository — a desktop-reported full name is never authority.
 * `Verified` means a GitHub read through an org credential returned the repo, so
 * the row carries real identity and a default-branch group. `Denied` means every
 * candidate credential was durably refused (404/403 cloak included), which is a
 * settled negative rather than a retry.
 *
 * A transient refusal — budget, rate limit, an outage — leaves the row `Pending`
 * with a later `nextVerificationAt`, never `Denied`: those recover on their own,
 * and burning them into a terminal state would strand a readable repo forever.
 *
 * String const rather than a Prisma enum so a fourth state costs no migration
 * (mirrors `GitHubRepoSyncTier`).
 */
export const GitHubObservedRepositoryVerificationState = {
  Pending: "pending",
  Verified: "verified",
  Denied: "denied",
} as const;
export type GitHubObservedRepositoryVerificationState =
  (typeof GitHubObservedRepositoryVerificationState)[keyof typeof GitHubObservedRepositoryVerificationState];
