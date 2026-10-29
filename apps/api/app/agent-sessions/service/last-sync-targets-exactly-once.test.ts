/**
 * @file last-sync-targets-exactly-once.test.ts
 * @description ISS-10165 — the "Compute Target Freshness" ordering is TOTAL, so
 * a walk over it delivers each target exactly once across a page boundary even
 * when every ranking key is tied.
 *
 * WHY A SEPARATE SUITE FROM `last-sync-targets-order.test.ts`. That suite pins
 * the ordering's PRECEDENCE — which watermark leads, and that presence does not.
 * Precedence is an equality assertion: it goes red when someone reorders the
 * terms, and stays green when someone DELETES the terminal key, because the
 * expected literal is edited in the same hand-motion. This suite asserts the
 * consequence instead — feed the shipped `orderBy` to a planner that resolves
 * ties adversarially and the served pages must still partition the population.
 * Dropping `{ id: "asc" }` reddens it without anyone having to notice a literal.
 *
 * THE FAKE IS THE POINT. Ordering is executed by Postgres, and a read ordered on
 * non-unique columns has no defined answer for its tied rows — the planner may
 * return them in any order and a normal fixture never makes it use that freedom.
 * `createHostileOrderedFindMany` does: it reverses the row set between calls, so
 * only an ordering ending in a unique key produces a reproducible page.
 */
import { describe, expect, it } from "vitest";
import {
  buildLastSyncTargetsQuery,
  LAST_SYNC_TARGET_PAGE_SIZE,
} from "./last-sync-targets";

/**
 * ISS-10851: a term's direction can be the bare string OR `{ sort, nulls }` —
 * `buildLastSyncTargetsQuery` pins `nulls: "last"` explicitly on the two
 * watermark keys. `compareByTerms` below honors BOTH, and models an ABSENT
 * `nulls` as Postgres's own default (NULLS FIRST on a DESC key, NULLS LAST on
 * an ASC one) rather than as "ignore" — that is what makes the never-synced
 * case redden on a revert to the bare `"desc"` shorthand instead of passing.
 */
type OrderDirection = "asc" | "desc";
type OrderTerm = Record<
  string,
  | OrderDirection
  | { sort: OrderDirection; nulls?: "first" | "last" }
  | undefined
>;

/**
 * Both watermarks are nullable on `ComputeTarget` — a target that has never
 * synced carries neither — so the fixture type must be able to express that or
 * no case here can reach the null placement the query pins.
 */
type FakeTargetRow = {
  id: string;
  isOnline: boolean;
  lastSeenAt: Date;
  lastAgentSessionSyncAt: Date | null;
  lastAgentSessionSyncAttemptAt: Date | null;
};

/** Two full pages, so there is a boundary for a row to fall through. */
const CORPUS = LAST_SYNC_TARGET_PAGE_SIZE * 2;

/**
 * ONE tie bucket: every seeded target shares all four ranking values, so the
 * terminal key is the only thing that can decide the page. A fixture with
 * distinct watermarks is the vacuous version of this test.
 */
const TIED_AT = new Date("2026-06-26T00:00:00.000Z");

const SCOPE = {
  organizationId: "org-1",
  filters: {},
} as const;

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

function compareOneTerm(
  leftRaw: unknown,
  rightRaw: unknown,
  direction: OrderDirection,
  nulls: "first" | "last" | undefined
): number {
  const leftIsNull = leftRaw == null;
  const rightIsNull = rightRaw == null;
  if (leftIsNull || rightIsNull) {
    if (leftIsNull && rightIsNull) {
      return 0;
    }
    // An absent `nulls` is Postgres's default for the direction, NOT "ignore".
    const nullsLast = nulls ? nulls === "last" : direction === "asc";
    const nullLeadsResult = leftIsNull ? -1 : 1;
    return nullsLast ? -nullLeadsResult : nullLeadsResult;
  }
  const leftValue = comparableValue(leftRaw);
  const rightValue = comparableValue(rightRaw);
  if (leftValue < rightValue) {
    return direction === "asc" ? -1 : 1;
  }
  if (leftValue > rightValue) {
    return direction === "asc" ? 1 : -1;
  }
  return 0;
}

function compareByTerms(
  left: FakeTargetRow,
  right: FakeTargetRow,
  terms: readonly OrderTerm[]
): number {
  for (const term of terms) {
    const entry = Object.entries(term)[0];
    if (!entry) {
      continue;
    }
    const [key, rawDirection] = entry;
    const isObjectTerm = typeof rawDirection === "object";
    const direction = isObjectTerm ? rawDirection?.sort : rawDirection;
    if (!direction) {
      continue;
    }
    const compared = compareOneTerm(
      left[key as keyof FakeTargetRow],
      right[key as keyof FakeTargetRow],
      direction,
      isObjectTerm ? rawDirection?.nulls : undefined
    );
    if (compared !== 0) {
      return compared;
    }
  }
  return 0;
}

function buildTiedCorpus(): FakeTargetRow[] {
  const rows: FakeTargetRow[] = [];
  for (let index = 0; index < CORPUS; index++) {
    rows.push({
      id: `target-${String(index).padStart(3, "0")}`,
      isOnline: true,
      lastSeenAt: TIED_AT,
      lastAgentSessionSyncAt: TIED_AT,
      lastAgentSessionSyncAttemptAt: TIED_AT,
    });
  }
  return rows;
}

/**
 * A `findMany` stand-in that applies the `orderBy` it is handed over an input
 * whose physical order flips between calls — the planner's freedom over a tied
 * run, made deterministic so the assertion is not a coin flip.
 */
function createHostileOrderedFindMany(rows: readonly FakeTargetRow[]) {
  let call = 0;
  return (args: { orderBy: OrderTerm[]; take: number; skip?: number }) => {
    call += 1;
    const preSorted = call % 2 === 0 ? [...rows].reverse() : [...rows];
    const sorted = [...preSorted].sort((left, right) =>
      compareByTerms(left, right, args.orderBy ?? [])
    );
    return sorted.slice(args.skip ?? 0, (args.skip ?? 0) + args.take);
  };
}

describe("ISS-10165 — lastSyncTargets ordering is total", () => {
  it("serves each tied target exactly once across a page boundary", () => {
    const rows = buildTiedCorpus();
    const findMany = createHostileOrderedFindMany(rows);
    const query = buildLastSyncTargetsQuery(SCOPE);

    const firstPage = findMany({
      orderBy: query.orderBy,
      take: query.take,
    });
    const secondPage = findMany({
      orderBy: query.orderBy,
      take: query.take,
      skip: query.take,
    });

    const servedIds = [...firstPage, ...secondPage].map((row) => row.id);
    // Sorted-multiset equality against the seeded population: a count or a Set
    // size passes when one target is skipped and another served twice.
    expect([...servedIds].sort()).toEqual([...new Set(servedIds)].sort());
    expect([...servedIds].sort()).toEqual(rows.map((row) => row.id).sort());
  });

  it("ends the ordering on a key that is unique per row", () => {
    const query = buildLastSyncTargetsQuery(SCOPE);
    const terminal = query.orderBy.at(-1);
    // `id` is ComputeTarget's `@id`; the four keys ahead of it are all
    // non-unique, so nothing before it can terminate the ordering.
    expect(terminal).toEqual({ id: "asc" });
  });
});

/**
 * ISS-10851 — the other half of the ordering, and the half no fixture above can
 * reach: where a target that has NEVER synced lands.
 *
 * This is the counterfactual for the `nulls: "last"` pins. Revert either
 * watermark term to the bare `"desc"` shorthand and `compareOneTerm` falls back
 * to Postgres's own default for a DESC key — NULLS FIRST — which puts the
 * never-synced majority ahead of the one target that actually just synced, and
 * reddens this case. The literal-equality assertion in
 * `last-sync-targets-order.test.ts` cannot do that: the same hand-motion that
 * reverts the query edits the expected literal.
 */
describe("ISS-10851 — a never-synced target sorts last, not first", () => {
  it("ranks the one stamped target ahead of the never-synced majority", () => {
    const stamped: FakeTargetRow = {
      id: "target-zzz",
      isOnline: true,
      lastSeenAt: TIED_AT,
      lastAgentSessionSyncAt: TIED_AT,
      lastAgentSessionSyncAttemptAt: TIED_AT,
    };
    // Ids sort BEFORE the stamped target's, so the terminal `{ id: "asc" }`
    // would lead with a never-synced row if null placement did not decide first.
    const neverSynced: FakeTargetRow[] = [0, 1, 2, 3, 4, 5].map((index) => ({
      id: `target-${index}`,
      isOnline: true,
      lastSeenAt: TIED_AT,
      lastAgentSessionSyncAt: null,
      lastAgentSessionSyncAttemptAt: null,
    }));
    const findMany = createHostileOrderedFindMany([...neverSynced, stamped]);
    const query = buildLastSyncTargetsQuery(SCOPE);

    const page = findMany({ orderBy: query.orderBy, take: query.take });

    expect(page[0]?.id).toBe(stamped.id);
    expect(page.map((row) => row.id).slice(1)).toEqual(
      neverSynced.map((row) => row.id)
    );
  });

  it("places a target with an attempt but no accepted sync above one with neither", () => {
    // The two watermarks are ranked independently: the attempt stamp leads, so
    // a target that TRIED to sync outranks one that never did even though both
    // have a null accepted-sync watermark.
    const attemptedOnly: FakeTargetRow = {
      id: "target-b",
      isOnline: true,
      lastSeenAt: TIED_AT,
      lastAgentSessionSyncAt: null,
      lastAgentSessionSyncAttemptAt: TIED_AT,
    };
    const neither: FakeTargetRow = {
      id: "target-a",
      isOnline: true,
      lastSeenAt: TIED_AT,
      lastAgentSessionSyncAt: null,
      lastAgentSessionSyncAttemptAt: null,
    };
    const findMany = createHostileOrderedFindMany([neither, attemptedOnly]);
    const query = buildLastSyncTargetsQuery(SCOPE);

    const page = findMany({ orderBy: query.orderBy, take: query.take });

    expect(page.map((row) => row.id)).toEqual([attemptedOnly.id, neither.id]);
  });
});
