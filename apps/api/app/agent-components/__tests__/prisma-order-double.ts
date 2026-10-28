/**
 * A `findMany` ordering double that applies a Prisma `orderBy` with PostgreSQL's
 * REAL null semantics, so a test can prove the ordering the query ASKS FOR is
 * the ordering the rows come back in.
 *
 * The point is the default: PostgreSQL sorts nulls FIRST on a descending sort
 * (and LAST on ascending). A read that writes `{ lastSeenAt: "desc" }` over a
 * nullable column therefore leads with the rows that never recorded a timestamp.
 * Only an explicit `{ sort: "desc", nulls: "last" }` puts them behind the rows
 * that did. A double that hardcoded nulls-last would hide exactly that bug, so
 * this one reads the `nulls` key off the caller's own `orderBy` and defaults to
 * the engine's behaviour when it is absent.
 */

type SortOrder = "asc" | "desc";

type PrismaOrderByEntry = Record<
  string,
  SortOrder | { sort: SortOrder; nulls?: "first" | "last" }
>;

export type PrismaOrderBy = PrismaOrderByEntry | PrismaOrderByEntry[];

type Comparable = string | number | Date | null | undefined;

function rankOf(value: Comparable, order: SortOrder, nullsFirst: boolean) {
  if (value == null) {
    return { isNull: true, nullsFirst, key: 0 };
  }
  const key = value instanceof Date ? value.getTime() : value;
  return { isNull: false, nullsFirst, key, order };
}

function compareValues(
  left: Comparable,
  right: Comparable,
  order: SortOrder,
  nullsFirst: boolean
): number {
  const a = rankOf(left, order, nullsFirst);
  const b = rankOf(right, order, nullsFirst);
  if (a.isNull && b.isNull) {
    return 0;
  }
  if (a.isNull || b.isNull) {
    const nullSide = a.isNull ? -1 : 1;
    return nullsFirst ? nullSide : -nullSide;
  }
  if (a.key === b.key) {
    return 0;
  }
  const ascending = a.key < b.key ? -1 : 1;
  return order === "asc" ? ascending : -ascending;
}

/**
 * PostgreSQL's implicit null placement when the query does not say: last for
 * `asc`, first for `desc`.
 */
function defaultNullsFirst(order: SortOrder): boolean {
  return order === "desc";
}

/**
 * Sort a copy of `rows` by `orderBy`, honouring each entry's `nulls` key and
 * falling back to PostgreSQL's default placement when it is omitted. Unknown or
 * equal fields fall through to the next entry, then to the input order (the
 * sort is stable), which is what an unordered read gives a caller anyway.
 */
export function sortByPrismaOrderBy<T extends Record<string, unknown>>(
  rows: readonly T[],
  orderBy: PrismaOrderBy | undefined
): T[] {
  if (!orderBy) {
    return [...rows];
  }
  const entries = Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...rows].sort((left, right) => {
    for (const entry of entries) {
      for (const [field, spec] of Object.entries(entry)) {
        const order = typeof spec === "string" ? spec : spec.sort;
        const nullsFirst =
          typeof spec === "string" || spec.nulls === undefined
            ? defaultNullsFirst(order)
            : spec.nulls === "first";
        const compared = compareValues(
          left[field] as Comparable,
          right[field] as Comparable,
          order,
          nullsFirst
        );
        if (compared !== 0) {
          return compared;
        }
      }
    }
    return 0;
  });
}
