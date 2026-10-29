/**
 * ISS-8399 — the EXTERNAL-DELIVERY pull-request population.
 *
 * The fourth owner recognised by the `pull-request-population-declaration`
 * source gate, and it exists for the same reason the invariant-audit owner
 * (ISS-4752) does: it answers a question neither sanctioned population can.
 *
 * - The ORG-MERGED population (`pull-request-population.ts`) admits only rows
 *   that are merged AND session-linked AND verified. A delivery provider
 *   measures work on pull requests regardless of whether a session touched
 *   them or whether they merged, so composing that predicate here would turn
 *   every unlinked or open pull request into a `NO_COUNTERPART` — reporting a
 *   coverage hole in OUR data that is actually a filter we applied ourselves.
 * - The BRANCH-CANONICAL resolution (`branch-canonical-pull-request.ts`)
 *   answers "which PR speaks for THIS branch". The provider gives us no
 *   branch; it gives us `<owner>/<repo>#<number>` and nothing else.
 *
 * So this owner answers exactly one question: **which of our pull-request rows,
 * if any, IS the one an external provider named by repository and number.** It
 * is an identity resolution, not a count, and NOTHING HERE MAY BE RENDERED AS A
 * POPULATION FIGURE — reporting "we have N pull requests" from these rows is
 * the PRD-683 defect (two screens counting different universes) with an extra
 * hop.
 *
 * The declaration is SCOPED to `apps/api/lib/delivery-points/` in the gate, the
 * same way the invariant-audit owner is scoped to the cron surface, so "reads
 * by bare identity on purpose" stays a reviewed lane rather than a bypass any
 * consumer can import.
 *
 * WHY `findMany` AND NOT `findFirst`. The schema's
 * `@@unique([organizationId, repositoryFullName, number])` is PARTIAL — it
 * applies only `where repository_id IS NULL` — so Postgres does not enforce one
 * row per (org, repo, number) in general, even though Prisma's generated client
 * exposes the key as if it did. A `findFirst` would compile, return whichever
 * row the planner reached first, and silently attribute one pull request's
 * delivery points to another. The set read is what makes ambiguity VISIBLE.
 */

import { withDb } from "@repo/database";

/** Rows per statement, bounding one `OR` list. */
const LOOKUP_CHUNK = 200;

/** A pull request as an external provider named it. */
export type ExternalDeliveryPullRequestRef = {
  /** Normalized `owner/name`, per `normalizeRepoFullName`. */
  readonly repositoryFullName: string;
  readonly number: number;
};

/**
 * One of our rows that could be the named pull request.
 *
 * `branchArtifactId` is the load-bearing identity, NOT `artifactId`:
 * `PullRequestDetail.artifactId` is vestigial (it predates
 * `20260515002500_add_branch_artifact_foundation`, every current writer omits
 * it, and there is no `PULL_REQUEST` member of `ArtifactType` for it to point
 * at), so NULL is the normal state of a correctly-ingested pull request. A
 * consumer that keyed on it would match almost nothing and read that as a
 * coverage hole. It is carried here only because a legacy row may still have
 * one and it is a real artifact when present.
 */
export type ExternalDeliveryPullRequestCandidate = {
  readonly detailId: string;
  readonly branchArtifactId: string;
  readonly artifactId: string | null;
};

/** `owner/repo#number` — the batch key, only ever built from parsed parts. */
export function externalDeliveryPullRequestKey(
  repositoryFullName: string,
  number: number
): string {
  return `${repositoryFullName}#${number}`;
}

/**
 * Resolve a batch of provider references to our candidate rows.
 *
 * Returns EVERY candidate per key rather than a winner. Arbitration is the
 * caller's, and the only correct arbitration for more than one candidate is to
 * call it ambiguous.
 *
 * A row whose `repositoryFullName` is NULL is dropped rather than bucketed: the
 * repository half of the key is nullable in the schema, and this repo's own
 * review lessons name dedup on a nullable field as a silent double-count.
 */
export async function readExternalDeliveryPullRequestCandidates(
  organizationId: string,
  refs: readonly ExternalDeliveryPullRequestRef[]
): Promise<Map<string, ExternalDeliveryPullRequestCandidate[]>> {
  const wanted = new Map<string, ExternalDeliveryPullRequestRef>();
  for (const ref of refs) {
    wanted.set(
      externalDeliveryPullRequestKey(ref.repositoryFullName, ref.number),
      ref
    );
  }

  const byKey = new Map<string, ExternalDeliveryPullRequestCandidate[]>();
  const pending = [...wanted.values()];
  for (let index = 0; index < pending.length; index += LOOKUP_CHUNK) {
    const chunk = pending.slice(index, index + LOOKUP_CHUNK);
    const rows = await withDb((db) =>
      db.pullRequestDetail.findMany({
        where: {
          organizationId,
          OR: chunk.map((ref) => ({
            repositoryFullName: ref.repositoryFullName,
            number: ref.number,
          })),
        },
        select: {
          id: true,
          artifactId: true,
          branchArtifactId: true,
          repositoryFullName: true,
          number: true,
        },
      })
    );
    for (const row of rows) {
      if (!row.repositoryFullName) {
        continue;
      }
      const key = externalDeliveryPullRequestKey(
        row.repositoryFullName,
        row.number
      );
      const bucket = byKey.get(key) ?? [];
      bucket.push({
        detailId: row.id,
        branchArtifactId: row.branchArtifactId,
        artifactId: row.artifactId,
      });
      byKey.set(key, bucket);
    }
  }
  return byKey;
}
