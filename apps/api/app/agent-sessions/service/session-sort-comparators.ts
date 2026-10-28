import { PRIORITY_ORDINAL } from "@repo/api/src/types/search-query";
import { compareNullableNumber } from "@repo/lib/sort-comparators";
import type { AgentSessionSortRule } from "../validators";
import {
  compareDisplayDurationKeys,
  compareOwnerDisplayNameKeys,
  compareRecordUpdatedAtKeys,
  compareStatusIdentityTiebreaker,
  compareTiebreaker,
  type DisplaySortCandidate,
} from "./session-display-sort";

/**
 * ISS-8335: the in-memory ORDER for a Sessions list rule list — the second half
 * of applying every rule the v2 toolbar can stack.
 *
 * `session-sort-order.ts` owns the arm the database can answer. This owns the
 * arm it cannot: as soon as ONE rule keys off a derived displayed value or the
 * reconciled cost, the whole chain is resolved here, against the same values the
 * cells render.
 *
 * TWO INVARIANTS, and the chain is worthless without either.
 *
 * The final tiebreaker is applied ONCE, LAST — after
 * every rule. It is a total order, so a comparator that applies it can never
 * return `0` for two distinct rows; folding it into each rule would make rule 2
 * unreachable and leave the toolbar displaying a secondary sort that decides
 * nothing. That is why every rule here reads a `…Keys` comparator, which returns
 * `0` on a genuine tie, rather than the tiebreaking `compareBy…` sibling those
 * are factored out of.
 * Root-ranked Status chains use `(computeTargetId, externalSessionId)` before the cloud-only
 * artifact ID collision guard; other chains retain the historical artifact ID.
 *
 * And a rule only ever DECIDES a tie its predecessors left open, because
 * {@link chainComparators} consults it only on a `0`. Direction is per rule, so
 * `[status asc, cost desc]` means what it reads as.
 */

/** A comparator over candidates of `T`, in the shape `Array#sort` takes. */
export type SessionSortComparator<T> = (a: T, b: T) => number;

/**
 * The comparator chain for a rule list resolved in memory.
 *
 * ISS-7176: it binds EVERY rule, cost included. It used to filter cost rules out,
 * which was safe only while `resolveSessionListPage` tested cost-sensitivity
 * first and diverted any such list to a separate reconciled path. With cost a
 * DB-native column that path is gone, a mixed chain like `[cost asc, user asc]`
 * is served here, and a filtered-out cost rule would silently decide nothing.
 */
export function buildDisplaySortComparator(
  rules: readonly AgentSessionSortRule[],
  statusRootRank?: (status: string) => number | null
): SessionSortComparator<DisplaySortCandidate> {
  return chainComparators(
    rules.map((rule) =>
      bindSortRule<DisplaySortCandidate>(rule, statusRootRank)
    ),
    statusRootRank !== undefined &&
      rules.some((rule) => rule.column === "status")
  );
}

/**
 * A Prisma `Decimal?` as a number, PRESERVING null.
 *
 * Deliberately not `toNumber` from `@/lib/prisma-number`, which maps null to 0.
 * That would collapse an UNPRICED session into a genuine $0 — the distinction
 * `estimated_cost` was made nullable to carry (ISS-7813), and the one the
 * nulls-last ordering below depends on.
 */
function toNullableNumber(value: { toNumber(): number } | null): number | null {
  return value === null ? null : value.toNumber();
}

/**
 * Compose ordered comparators into one, ending in the unique tiebreaker.
 *
 * Each link is consulted only when every earlier link tied, which is what makes
 * a secondary rule a TIE-BREAK rather than a re-sort. With no rules the chain is
 * the tiebreaker alone — a total, repeatable order rather than an arbitrary one.
 */
function chainComparators<T extends DisplaySortCandidate>(
  comparators: readonly SessionSortComparator<T>[],
  hasStatusRule: boolean
): SessionSortComparator<T> {
  return (a, b) => {
    for (const compare of comparators) {
      const verdict = compare(a, b);
      if (verdict !== 0) {
        return verdict;
      }
    }
    return hasStatusRule
      ? compareStatusIdentityTiebreaker(a, b)
      : compareTiebreaker(a, b);
  };
}

/**
 * One non-cost rule as a direction-bound, tiebreaker-free comparator.
 *
 * The three display-value columns delegate to `session-display-sort.ts`, the
 * derivation SSOT the cells render from. The DB-native columns —
 * `status` among them since ISS-9939 / ISS-10262 while D5 is off — are compared here on their
 * own candidate fields, because a chain the database could not order at all
 * still has to order THEM — this is the same key
 * `dbColumnOrderBy` emits, read in memory instead of in Postgres, with the same
 * FEA-4330 nulls-last semantics in both directions.
 */
function bindSortRule<T extends DisplaySortCandidate>(
  rule: AgentSessionSortRule,
  statusRootRank?: (status: string) => number | null
): SessionSortComparator<T> {
  const { dir } = rule;
  switch (rule.column) {
    case "autonomy":
      return (a, b) => compareNullableNumber(a.autonomy, b.autonomy, dir);
    case "duration":
      return (a, b) => compareDisplayDurationKeys(a, b, dir);
    case "status":
      if (statusRootRank) {
        return (a, b) =>
          compareNullableNumber(
            statusRootRank(a.artifact.status),
            statusRootRank(b.artifact.status),
            dir
          );
      }
      // Off-path: the PERSISTED status, matching Postgres raw-string order.
      return (a, b) =>
        compareStrings(a.artifact.status, b.artifact.status, dir);
    case "updated":
      return (a, b) => compareRecordUpdatedAtKeys(a, b, dir);
    case "user":
    case "assignee":
      return (a, b) => compareOwnerDisplayNameKeys(a, b, dir);
    case "harness":
      return (a, b) => compareStrings(a.harness, b.harness, dir);
    case "model":
      return (a, b) => compareStrings(a.model, b.model, dir);
    case "priority":
      // ISS-10332: the wire ordinal, never the enum's spelling — "HIGH" sorts
      // before "LOW" as a string. Nulls last in both directions, as the DB arm.
      return (a, b) =>
        compareNullableNumber(
          priorityRank(a.artifact.priority),
          priorityRank(b.artifact.priority),
          dir
        );
    case "repo":
      return (a, b) =>
        compareStrings(a.repositoryFullName, b.repositoryFullName, dir);
    case "started":
      return (a, b) =>
        compareInstants(a.sessionStartedAt, b.sessionStartedAt, dir);
    case "lastActivity":
      return (a, b) => compareInstants(a.lastActivityAt, b.lastActivityAt, dir);
    case "cost":
      // ISS-7176: ORDER BY THE DISPLAYED COST. This case used to return `() => 0`
      // — inert, and correct only while a cost rule could not reach here, because
      // `resolveSessionListPage` tested cost-sensitivity first and sent every such
      // list to the reconciled path. That path is gone, so a mixed chain like
      // `[cost asc, user asc]` now arrives here, and an inert comparator would
      // drop the reader's primary rule while the toolbar still showed it applied.
      //
      // `compareNullableNumber` floats nulls LAST in both directions, the same
      // FEA-4330 semantics `nullableColumnOrder("estimatedCost", dir)` pins on
      // the DB path — so an unpriced session sorts after every priced one
      // whichever path serves the page.
      return (a, b) =>
        compareNullableNumber(
          toNullableNumber(a.estimatedCost),
          toNullableNumber(b.estimatedCost),
          dir
        );
    default: {
      const exhaustive: never = rule.column;
      return exhaustive;
    }
  }
}

/**
 * Order two nullable strings, blanks LAST in BOTH directions — the same
 * FEA-4330 semantics `nullableColumnOrder` pins on the DB path, so the in-memory
 * chain cannot place a blank differently from the query it replaces.
 */
function compareStrings(
  a: string | null,
  b: string | null,
  dir: "asc" | "desc"
): number {
  if (a === null || b === null) {
    if (a === b) {
      return 0;
    }
    return a === null ? 1 : -1;
  }
  if (a === b) {
    return 0;
  }
  return dir === "asc" ? compareOrdered(a, b) : -compareOrdered(a, b);
}

/** Order two nullable instants, blanks LAST in BOTH directions (FEA-4330). */
function compareInstants(
  a: Date | null,
  b: Date | null,
  dir: "asc" | "desc"
): number {
  if (a === null || b === null) {
    if (a === b) {
      return 0;
    }
    return a === null ? 1 : -1;
  }
  const delta = a.getTime() - b.getTime();
  if (delta === 0) {
    return 0;
  }
  return dir === "asc" ? delta : -delta;
}

function compareOrdered(a: string, b: string): number {
  return a < b ? -1 : 1;
}

function priorityRank(
  priority: keyof typeof PRIORITY_ORDINAL | null
): number | null {
  return priority === null ? null : PRIORITY_ORDINAL[priority];
}
