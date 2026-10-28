/**
 * ISS-9780 — `findMany` fakes that APPLY the `orderBy` they are handed and break
 * ties adversarially.
 *
 * A read ordered on a non-unique column has no defined answer for its tied rows:
 * the planner may return them in any order, and nothing in a normal test fixture
 * makes it exercise that freedom. These fakes do — they reverse the pre-sort
 * order on alternating calls — so only a TOTAL ordering (one ending in a unique
 * terminal key) produces the same sequence twice. A read that ends on
 * `updatedAt` alone reorders between two identical calls, which is what the
 * tiebreaker tests observe rather than asserting the literal `orderBy` back.
 */

import { isRecord } from "@/lib/type-guards";

type SortDirection = "asc" | "desc";

type SortSpec = { sort: SortDirection; nulls?: "first" | "last" };

/**
 * One key's ordering, in every shape a Prisma `orderBy` spells it: a bare
 * direction, a `{ sort, nulls }` spec (ISS-9478), or a nested term for a
 * relation (`{ artifact: { priority: … } }`), which reads the related row.
 */
type OrderSpec = SortDirection | SortSpec | OrderTerm;

type OrderTerm = { [key: string]: OrderSpec };

type NestedReadArgs = {
  orderBy?: unknown;
  take?: number;
};

type FindManyArgs = NestedReadArgs & {
  select?: Record<string, unknown>;
};

function comparableValue(value: unknown): number | string | boolean {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  return String(value);
}

function compareDirected(
  left: unknown,
  right: unknown,
  direction: SortDirection
): number {
  const leftValue = comparableValue(left);
  const rightValue = comparableValue(right);
  if (leftValue < rightValue) {
    return direction === "asc" ? -1 : 1;
  }
  if (leftValue > rightValue) {
    return direction === "asc" ? 1 : -1;
  }
  return 0;
}

/**
 * A `{ sort, nulls }` key, with PostgreSQL's placement when `nulls` is omitted
 * (NULLs sort as the largest value: last ascending, first descending).
 */
function compareWithNulls(
  left: unknown,
  right: unknown,
  spec: SortSpec
): number {
  const leftNull = left === null || left === undefined;
  const rightNull = right === null || right === undefined;
  if (leftNull || rightNull) {
    if (leftNull && rightNull) {
      return 0;
    }
    const nullsLast = spec.nulls ? spec.nulls === "last" : spec.sort === "asc";
    return leftNull === nullsLast ? 1 : -1;
  }
  return compareDirected(left, right, spec.sort);
}

function isSortSpec(spec: OrderSpec): spec is SortSpec {
  return typeof spec === "object" && "sort" in spec;
}

function relatedRow(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function compareByTerm(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  term: OrderTerm
): number {
  const entry = Object.entries(term)[0];
  if (!entry) {
    return 0;
  }
  const [key, spec] = entry;
  if (typeof spec === "string") {
    return compareDirected(left[key], right[key], spec);
  }
  if (isSortSpec(spec)) {
    return compareWithNulls(left[key], right[key], spec);
  }
  return compareByTerm(relatedRow(left[key]), relatedRow(right[key]), spec);
}

function compareByTerms<TRow extends Record<string, unknown>>(
  left: TRow,
  right: TRow,
  terms: readonly OrderTerm[]
): number {
  for (const term of terms) {
    const verdict = compareByTerm(left, right, term);
    if (verdict !== 0) {
      return verdict;
    }
  }
  return 0;
}

function normalizeTerms(orderBy: unknown): OrderTerm[] {
  if (Array.isArray(orderBy)) {
    return orderBy as OrderTerm[];
  }
  if (orderBy && typeof orderBy === "object") {
    return [orderBy as OrderTerm];
  }
  return [];
}

/**
 * Serve `rows` the way a planner free to reorder ties would: the pre-sort order
 * is reversed when `flip` is set, the requested ordering is then applied on top,
 * and `take` cuts the result. An ordering that is total survives the flip; one
 * that is not resolves its ties the other way round.
 */
function serveHostile<TRow extends Record<string, unknown>>(
  rows: readonly TRow[],
  args: NestedReadArgs | undefined,
  flip: boolean
): TRow[] {
  const preSorted = flip ? [...rows].reverse() : [...rows];
  const terms = normalizeTerms(args?.orderBy);
  const sorted =
    terms.length === 0
      ? preSorted
      : [...preSorted].sort((left, right) =>
          compareByTerms(left, right, terms)
        );
  return typeof args?.take === "number" ? sorted.slice(0, args.take) : sorted;
}

/**
 * Build a `findMany` stand-in over `rows`. Successive calls see the SAME rows in
 * opposite pre-sort order, so any ordering the caller asks for that is not total
 * resolves its ties differently between call one and call two.
 */
export function createHostileOrderedFindMany<
  TRow extends Record<string, unknown>,
>(rows: readonly TRow[]) {
  let call = 0;
  return (args?: FindManyArgs) => {
    call += 1;
    return Promise.resolve(serveHostile(rows, args, call % 2 === 0));
  };
}

/**
 * The same fake for a read whose tie-prone ordering is on a NESTED relation —
 * `select: { teams: { orderBy, take } }`. A bounded nested read (`take: 1`) is
 * where a non-total order decides WHICH related row the result displays, and the
 * top-level fake above never sees that `orderBy` at all, so it would stay green
 * under the exact defect.
 *
 * Each row's `relation` array is permuted between calls and then ordered and cut
 * by the nested arguments the caller supplied; the outer rows go through the
 * same treatment with the outer arguments.
 */
export function createHostileNestedOrderedFindMany<
  TRow extends Record<string, unknown>,
>(rows: readonly TRow[], relation: string) {
  let call = 0;
  return (args?: FindManyArgs) => {
    call += 1;
    const flip = call % 2 === 0;
    const nestedArgs = args?.select?.[relation] as NestedReadArgs | undefined;
    const shaped = rows.map((row) => {
      const nested = row[relation];
      if (!Array.isArray(nested)) {
        return row;
      }
      return {
        ...row,
        [relation]: serveHostile(
          nested as readonly Record<string, unknown>[],
          nestedArgs,
          flip
        ),
      } as TRow;
    });
    return Promise.resolve(serveHostile(shaped, args, flip));
  };
}
