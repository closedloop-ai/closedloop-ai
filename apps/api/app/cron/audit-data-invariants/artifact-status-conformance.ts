/**
 * ISS-9434 gauge 10: `artifacts` rows whose `status` is outside the vocabulary
 * for their type/subtype.
 *
 * This is the REPLACEMENT for a constraint that was declined, not garnish.
 * PLN-1978 §4 ruled that `artifacts.status` stays freeform — no CHECK constraint
 * — on the grounds that the application-level guards already hold (one bad row in
 * 12,350 documents). With no storage-level guard, this check is the only thing
 * that will ever catch the next one.
 *
 * Its own module rather than more of `service.ts`: that file already carries the
 * nine cost/enrichment checks and sits within a few dozen lines of the 500-line
 * smell threshold, and "which status words may this artifact type store" is a
 * different responsibility from "does this session's cost reconcile".
 */

import { ArtifactType } from "@repo/api/src/types/artifact";
import { statusOptionsForSubtype } from "@repo/api/src/types/document";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { withDb } from "@repo/database";
import { DEPLOYMENT_STATE_OPTIONS } from "@/app/deployments/deployment-state";

/**
 * How many distinct (type, subtype, status) groups reach the emission as
 * labels. `status` is a freeform column, so its label cardinality is a real
 * Datadog hazard — the same bound, for the same reason, that gauge 9 puts on its
 * producer-supplied model names. The COUNT is summed over every off-vocabulary
 * group, bounded or not, so the total never lies about what the breakdown could
 * not fit.
 *
 * Which groups win the slots is decided by {@link compareByRarestFirst}, and the
 * direction is load-bearing — see its note.
 */
const MAX_OFF_VOCABULARY_LABELS = 10;

/**
 * The uppercase vocabulary a BRANCH artifact stores — the PR state it mirrors.
 */
const BRANCH_STATUS_OPTIONS: readonly string[] = Object.values(GitHubPRState);

/**
 * The three lifecycle members, and deliberately ONLY those three.
 *
 * `waiting` is NOT admitted, even though a live population still carries it:
 * migration `20260817120000_iss5981_backfill_waiting_session_status` says in its
 * own header that it does not empty that population, and PLN-1978 §6 records the
 * population as UNMEASURED. Blessing the spelling here would make the one
 * instrument that can size it report zero. It surfaces as its own breakdown row
 * instead, which is why the breakdown exists — a lump sum would let a tolerated
 * legacy population hide the next cross-vocabulary write inside it.
 */
const SESSION_STATUS_OPTIONS: readonly string[] = Object.values(SESSION_STATUS);

/**
 * Which words each artifact type may store, as an exhaustive `Record` rather
 * than a lookup with a default arm: a new {@link ArtifactType} member fails
 * `tsc` here until someone states its vocabulary, instead of silently acquiring
 * "everything conforms".
 *
 * DOCUMENT is a function of `subtype` because the column carries two disjoint
 * vocabularies there; `statusOptionsForSubtype` is the same discriminator the
 * validators and the UI key off, imported rather than restated.
 */
const STATUS_VOCABULARY_BY_TYPE: Record<
  ArtifactType,
  (subtype: string | null) => readonly string[]
> = {
  [ArtifactType.Document]: (subtype) => statusOptionsForSubtype(subtype),
  [ArtifactType.Branch]: () => BRANCH_STATUS_OPTIONS,
  [ArtifactType.Deployment]: () => DEPLOYMENT_STATE_OPTIONS,
  [ArtifactType.Session]: () => SESSION_STATUS_OPTIONS,
};

export type ArtifactStatusGroup = {
  type: string;
  subtype: string | null;
  status: string;
  artifactCount: number;
};

export type OffVocabularyArtifactStatuses = {
  count: number;
  byStatus: ArtifactStatusGroup[];
};

/**
 * Whether this (type, subtype, status) triple is one no writer should have
 * produced.
 *
 * A `type` outside {@link ArtifactType} counts as off-vocabulary rather than
 * being skipped: the column is a Postgres enum, so a value outside it means the
 * enum itself moved without this map, and "no vocabulary to be inside" is not
 * the same as "conforms".
 */
export function isOffVocabularyArtifactStatus(group: {
  type: string;
  subtype: string | null;
  status: string;
}): boolean {
  if (!Object.hasOwn(STATUS_VOCABULARY_BY_TYPE, group.type)) {
    return true;
  }
  const vocabulary = STATUS_VOCABULARY_BY_TYPE[group.type as ArtifactType](
    group.subtype
  );
  return !vocabulary.includes(group.status);
}

/**
 * Count every off-vocabulary row, with a bounded breakdown of the groups that
 * produced them.
 *
 * ONE aggregate, never a row projection: the query groups in Postgres and
 * returns one row per distinct (type, subtype, status) triple, so the scan cost
 * is a single pass over `artifacts` and the result set is the size of the
 * vocabulary space rather than of the table. The grouping is deliberately NOT
 * limited in SQL — the total has to sum over every off-vocabulary group, and a
 * `LIMIT` there would silently cap the number this gauge exists to report.
 */
export function checkOffVocabularyArtifactStatuses(): Promise<OffVocabularyArtifactStatuses> {
  return withDb(async (db) => {
    const rows = await db.$queryRaw<
      Array<{
        type: string;
        subtype: string | null;
        status: string;
        artifact_count: bigint;
      }>
    >`
      SELECT a.type::text AS type,
             a.subtype::text AS subtype,
             a.status AS status,
             COUNT(*) AS artifact_count
      FROM artifacts a
      GROUP BY a.type, a.subtype, a.status
    `;

    let count = 0;
    const offVocabulary: ArtifactStatusGroup[] = [];
    for (const row of rows) {
      if (!isOffVocabularyArtifactStatus(row)) {
        continue;
      }
      const artifactCount = Number(row.artifact_count);
      count += artifactCount;
      offVocabulary.push({
        type: row.type,
        subtype: row.subtype,
        status: row.status,
        artifactCount,
      });
    }

    offVocabulary.sort(compareByRarestFirst);
    return {
      count,
      byStatus: offVocabulary.slice(0, MAX_OFF_VOCABULARY_LABELS),
    };
  });
}

/**
 * RAREST population first, with a deterministic label tie-break.
 *
 * Ascending, deliberately, and the opposite of what a "top offenders" breakdown
 * would do. This gauge exists to catch the next FEA-1837, and FEA-1837 was ONE
 * row — a single FEATURE stored with a Document-only status. Descending put the
 * biggest group first, so the tolerated legacy `waiting` session population won
 * a slot every day and the singleton was the first thing evicted once ten
 * distinct groups existed. That is the failure `docs/data-invariants.md` already
 * names for a lump sum ("a tolerated legacy population hides the next write
 * inside it"), reintroduced at group granularity.
 *
 * A large population does not need the breakdown to be seen: it moves `count`,
 * which is what the anomaly monitor reads. A singleton moves the total from N to
 * N+1, which no `change(value)` monitor picks up — the breakdown is the ONLY
 * place it can surface. So the scarce slots go to the rows that have nowhere
 * else to appear.
 */
function compareByRarestFirst(
  left: ArtifactStatusGroup,
  right: ArtifactStatusGroup
): number {
  if (left.artifactCount !== right.artifactCount) {
    return left.artifactCount - right.artifactCount;
  }
  if (left.type !== right.type) {
    return left.type < right.type ? -1 : 1;
  }
  if (left.status !== right.status) {
    return left.status < right.status ? -1 : 1;
  }
  return (left.subtype ?? "") < (right.subtype ?? "") ? -1 : 1;
}
