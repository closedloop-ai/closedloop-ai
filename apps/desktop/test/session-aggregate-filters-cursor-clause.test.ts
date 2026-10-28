// ISS-7583 (PRD-618): `session-aggregate-filters.ts` exports four functions and
// only ONE of them — `countSqliteSessionsForFilters` — was named by any test.
// This suite covers the other three at the level they actually fail:
//
//   * `buildListCursorFilterClause` numbers its placeholders with a
//     `() => `$${params.length + 1}`` closure shared across four optional
//     groups, so what a given `$N` refers to depends on how many params the
//     groups BEFORE it happened to push. That is the desktop `$N` -> `?N`
//     rewrite trap (`translateNumberedParams`) waiting to happen: an off-by-one
//     or a batched push emits a statement that binds the wrong value — or none
//     — and SQLite answers it happily with the wrong population.
//   * `listCursorPageSortExpression` names an `activity`-CTE column per sort
//     key. A wrong name is a SQL error at read time, not a type error.
//   * `buildUsageFilterClause` must render "" for an empty filter set, never a
//     bare `WHERE`, because callers concatenate it straight into a statement.
//
// Deliberately NOT re-asserted here: the window+search combination EXECUTED
// against a real SQLite database, which `sqlite-unsorted-list-cursor-page.test.ts`
// already owns. That test proves the clause SELECTS the right rows; this one
// proves the clause+params PAIR is internally consistent before it is ever
// bound. Both are needed — an execution test over one fixed subset cannot see a
// numbering bug that only appears when a different combination of groups is
// present, and a structural test cannot see a predicate that binds correctly and
// still means the wrong thing.

import assert from "node:assert/strict";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { describe, test } from "vitest";
import { SessionListCursorSortKey } from "../src/main/agent-sync/agent-session-read-model.js";
import { BRANCH_WRITE_METHOD_VALUES } from "../src/main/database/db-constants.js";
import {
  buildListCursorFilterClause,
  buildUsageFilterClause,
  listCursorPageSortExpression,
} from "../src/main/database/session-aggregate-filters.js";

/** Every `$N` token in a rendered clause, in the order it appears. */
const PLACEHOLDER_RE = /\$(\d+)/g;

/** The placeholder each `LIKE` comparison in the search predicate binds. */
const LIKE_PLACEHOLDER_RE = /LIKE (\$\d+)/g;

/** A rendered clause opens with the keyword rather than starting bare. */
const LEADING_WHERE_RE = /^WHERE /;

/**
 * The status arms' case-folding expression, spelled as a LITERAL for the same
 * reason {@link LIST_WINDOW_TS} is — see its note. Sharing the implementation's
 * local would make the shape assertion restate whatever it renders.
 */
const CANONICAL_STATUS_EXPR = "lower(s.status)";

const WINDOW_START = new Date("2026-08-01T00:00:00.000Z");
const WINDOW_END = new Date("2026-08-31T23:59:59.000Z");

/**
 * The session-list date window's SQL bound, spelled as a LITERAL rather than
 * imported from `SESSION_LAST_ACTIVITY_AT_TS_EXPR`.
 *
 * That is the deliberate choice here, and the exception to the repo's
 * import-the-constant rule: sharing the constant would make this assertion
 * restate the implementation and pass on ANY basis, which is the precise drift
 * ISS-5443 exists to prevent — the list bounding on `last_activity_at` while the
 * usage/KPI aggregate bounded on `started_at`, one screen, two cohorts. A basis
 * change SHOULD redden this test, so whoever makes it has to look at both halves
 * on purpose.
 */
const LIST_WINDOW_TS = "s.last_activity_at";

describe("buildListCursorFilterClause placeholder numbering", () => {
  test("an empty request renders no clause and no params, not a bare WHERE", () => {
    const { clause, params } = buildListCursorFilterClause({});

    assert.equal(clause, "");
    assert.deepEqual(params, []);
  });

  test("startDate alone binds $1 to the ISO lower bound", () => {
    const { clause, params } = buildListCursorFilterClause({
      startDate: WINDOW_START,
    });

    assert.equal(clause, `WHERE ${LIST_WINDOW_TS} >= $1`);
    assert.deepEqual(params, [WINDOW_START.toISOString()]);
  });

  test("endDate alone binds $1 to the ISO upper bound", () => {
    const { clause, params } = buildListCursorFilterClause({
      endDate: WINDOW_END,
    });

    assert.equal(clause, `WHERE ${LIST_WINDOW_TS} <= $1`);
    assert.deepEqual(params, [WINDOW_END.toISOString()]);
  });

  test("both bounds number in request order, lower bound first", () => {
    const { clause, params } = buildListCursorFilterClause({
      startDate: WINDOW_START,
      endDate: WINDOW_END,
    });

    assert.equal(
      clause,
      `WHERE ${LIST_WINDOW_TS} >= $1 AND ${LIST_WINDOW_TS} <= $2`
    );
    assert.deepEqual(params, [
      WINDOW_START.toISOString(),
      WINDOW_END.toISOString(),
    ]);
  });

  test("a statuses-only request reaches the clause with no window", () => {
    const { clause, params } = buildListCursorFilterClause({
      statuses: [SESSION_STATUS.INACTIVE],
    });

    // The INACTIVE branch is a bare equality against a literal, so this is the
    // shape a naive `WHERE ${conditions.join(" AND ")}` builder gets wrong in
    // the opposite direction: a non-empty clause carrying ZERO params. Keeping a
    // status selection out of this clause is what used to force every
    // status-filtered list read onto the capped full-corpus hydration fallback,
    // so "the group is present at all" is the load-bearing half of this.
    assert.match(clause, LEADING_WHERE_RE);
    assert.ok(clause.includes(`= '${SESSION_STATUS.INACTIVE}'`));
    assert.deepEqual(params, []);
    assert.deepEqual(placeholderViolations(clause, params), []);
  });

  test("an active-only request renders a clause that binds nothing", () => {
    // ISS-10741: EXPECTATION CHANGED. This used to assert a staleness cutoff
    // bound as `$1`. The ACTIVE arm no longer derives one — it is a literal
    // comparison now, like INACTIVE above — so the whole pinned-clock apparatus
    // this file carried for that single param is gone with it.
    const { clause, params } = buildListCursorFilterClause({
      statuses: [SESSION_STATUS.ACTIVE],
    });

    assert.match(clause, LEADING_WHERE_RE);
    // ISS-11239: EXPECTATION CHANGED. The arm used to carry `AND NOT
    // (reconciledEnd)`; the facet now matches the stored status alone, so the
    // whole arm is the bare equality and never reads `ended_at`.
    assert.ok(
      clause.includes(`(${CANONICAL_STATUS_EXPR} = '${SESSION_STATUS.ACTIVE}')`)
    );
    assert.ok(!clause.includes("ended_at"));
    assert.deepEqual(params, []);
    assert.deepEqual(placeholderViolations(clause, params), []);
  });

  // ISS-10629 deleted the three cases that pinned the WAITING, STALE and UNKNOWN
  // branch shapes here, with the branches themselves. They are not re-homed: the
  // contract they stated — what SQL a display-only status renders — was retired
  // by the operator ruling, not moved.

  test("an unrecognized status falls through to a parameterized equality", () => {
    const { clause, params } = buildListCursorFilterClause({
      statuses: ["NotAStatus"],
    });

    // Case-folded by `canonicalSharedStatus` before binding, so the param is
    // what `lower(s.status)` can actually equal.
    assert.deepEqual(params, ["notastatus"]);
    assert.deepEqual(placeholderViolations(clause, params), []);
  });

  test("multiple statuses OR together and number across the group boundary", () => {
    // The property is that the second arm's `$N` depends on how many the first
    // pushed, so BOTH arms have to bind. ISS-10741 left the unrecognized
    // fallback as the only one that does — an ACTIVE arm here would push
    // nothing and the case would pass without exercising the shared closure at
    // all.
    const { clause, params } = buildListCursorFilterClause({
      statuses: ["NotAStatus", "AlsoNotAStatus"],
    });

    assert.deepEqual(params, ["notastatus", "alsonotastatus"]);
    assert.ok(clause.includes(" OR "));
    assert.deepEqual(placeholderViolations(clause, params), []);
  });

  test("search binds one pattern, resolved identities, then displayed branch methods", () => {
    const { clause, params } = buildListCursorFilterClause({
      search: "Alpha_Run",
    });

    // The LIKE pattern is lowercased and LIKE-escaped (the `_` is a wildcard
    // otherwise), pushed ONCE, and referenced by every text column. Resolved
    // repository/base-branch identities follow, then the write-evidence methods
    // that select the displayed branch.
    assert.deepEqual(params, [
      String.raw`%alpha\_run%`,
      "[]",
      "[]",
      ...BRANCH_WRITE_METHOD_VALUES,
    ]);
    assert.deepEqual(placeholderViolations(clause, params), []);

    // The reuse is the point: EVERY searched column compares against the one
    // pattern param, rather than each pushing its own copy. Asserted as "no LIKE
    // site binds anything but $1" instead of a hardcoded site count, because the
    // set of searched columns belongs to the search predicate and may grow —
    // whereas one-param-for-all-of-them is the contract this test owns. The
    // exact param array above is what keeps this from passing vacuously.
    const likePlaceholders = [...clause.matchAll(LIKE_PLACEHOLDER_RE)].map(
      (match) => match[1]
    );
    assert.ok(likePlaceholders.length > 0);
    assert.deepEqual(new Set(likePlaceholders), new Set(["$1"]));
  });

  test("all four groups together number contiguously in emission order", () => {
    const { clause, params } = buildListCursorFilterClause({
      startDate: WINDOW_START,
      endDate: WINDOW_END,
      search: "alpha",
      // ISS-10741: an unrecognized status, because the emission-ORDER claim
      // below needs the status group to bind something and ACTIVE no longer
      // does.
      statuses: ["NotAStatus"],
    });

    // The ordering-dependent case. Note the emission order is start, end,
    // STATUSES, search — not the declaration order of the request object — so a
    // reader cannot infer it from the call site, which is exactly why it is
    // pinned by value here.
    assert.deepEqual(params, [
      WINDOW_START.toISOString(),
      WINDOW_END.toISOString(),
      "notastatus",
      "%alpha%",
      "[]",
      "[]",
      ...BRANCH_WRITE_METHOD_VALUES,
    ]);
    assert.deepEqual(placeholderViolations(clause, params), []);

    // Each group's own bound still reads the index its value sits at.
    assert.ok(clause.includes(`${LIST_WINDOW_TS} >= $1`));
    assert.ok(clause.includes(`${LIST_WINDOW_TS} <= $2`));
    assert.ok(clause.includes("= $3"));
    assert.ok(clause.includes("LIKE $4"));
  });

  test("every subset keeps placeholders and params consistent", () => {
    // A sweep rather than one more hand-written case: the invariant is about the
    // CLOSURE being shared across groups, so it has to hold for every
    // combination, including the ones nobody writes a named test for.
    const requests = filterGroupSubsets([
      { startDate: WINDOW_START },
      { endDate: WINDOW_END },
      // ISS-10741: an unrecognized status rather than ACTIVE. The sweep needs a
      // status arm that still BINDS, both to exercise the shared closure and
      // because the invariant below is false for a literal-only arm — ACTIVE
      // and INACTIVE now render a clause while binding nothing.
      { statuses: ["NotAStatus"] },
      { search: "needle" },
    ]);

    assert.equal(requests.length, 16);
    for (const request of requests) {
      const { clause, params } = buildListCursorFilterClause(request);

      // A clause is empty exactly when nothing was bound — the two halves of the
      // return value cannot disagree about whether the request filtered at all.
      assert.equal(clause === "", params.length === 0);
      assert.deepEqual(placeholderViolations(clause, params), []);
    }
  });
});

describe("listCursorPageSortExpression", () => {
  test("LastActivity orders by the denormalized activity column", () => {
    assert.equal(
      listCursorPageSortExpression(SessionListCursorSortKey.LastActivity),
      "sort_last_activity_at"
    );
  });

  test("Started orders by the started-at floor column", () => {
    assert.equal(
      listCursorPageSortExpression(SessionListCursorSortKey.Started),
      "sort_started_at"
    );
  });

  test("Updated orders by the natural cursor column", () => {
    assert.equal(
      listCursorPageSortExpression(SessionListCursorSortKey.Updated),
      "updated_at"
    );
  });

  test("every sort key resolves to a distinct column", () => {
    // The `Record` over the union already fails `tsc` when a fourth key is added
    // without a map entry. This is the runtime half: a key REMOVED from the map
    // (or a map replaced by a lookup that can miss) returns `undefined`, which
    // renders as the literal string "undefined" inside the ORDER BY and fails at
    // read time instead of here.
    const keys = Object.values(SessionListCursorSortKey);
    const columns = keys.map((key) => listCursorPageSortExpression(key));

    for (const column of columns) {
      assert.equal(typeof column, "string");
      assert.ok(column.length > 0);
    }
    assert.equal(new Set(columns).size, keys.length);
  });
});

describe("buildUsageFilterClause", () => {
  test("an empty filter set renders no clause, not a bare WHERE", () => {
    const { clause, params } = buildUsageFilterClause({});

    // Callers concatenate this straight into a statement, so a bare `WHERE`
    // would be a syntax error on every unfiltered aggregate read.
    assert.equal(clause, "");
    assert.deepEqual(params, []);
  });

  test("a harness filter renders a parameterized condition", () => {
    // The positive control for the case above: without it, a builder that always
    // returned "" would pass the empty-filter assertion and drop every filter.
    const { clause, params } = buildUsageFilterClause({ harness: "claude" });

    assert.equal(clause, "WHERE s.harness = $1");
    assert.deepEqual(params, ["claude"]);
  });
});

/**
 * Every way a clause and its params disagree, as readable strings — the
 * invariant a shared `() => `$${params.length + 1}`` closure owes: the
 * placeholders a clause emits and the params array it emits alongside must
 * describe the same list.
 *
 * Catches three things a mis-numbered build breaks in different ways — an
 * off-by-one emits `$0` or an index past the end, a batched push repeats one
 * index and skips others, and a group that renders its placeholder before
 * pushing its value inverts the order.
 *
 * Returned rather than asserted in place so the assertion stays in the test
 * body (Biome `noMisplacedAssertion`), and so a failure prints the whole set of
 * problems at once instead of stopping at the first.
 */
function placeholderViolations(
  clause: string,
  params: readonly unknown[]
): string[] {
  const indexes = [...clause.matchAll(PLACEHOLDER_RE)].map((match) =>
    Number(match[1])
  );
  const violations: string[] = [];

  for (const index of indexes) {
    if (index < 1 || index > params.length) {
      violations.push(
        `placeholder $${index} has no param (${params.length} bound)`
      );
    }
  }

  const referenced = new Set(indexes);
  for (let index = 1; index <= params.length; index++) {
    if (!referenced.has(index)) {
      violations.push(`param $${index} is never referenced`);
    }
  }

  const firstAppearance = [...referenced];
  const ascending = firstAppearance.toSorted((left, right) => left - right);
  if (firstAppearance.join(",") !== ascending.join(",")) {
    violations.push(
      `placeholders first appear as ${firstAppearance.join(",")}, not in push order ${ascending.join(",")}`
    );
  }

  return violations;
}

/**
 * Every combination of the given filter groups, merged into one request each.
 *
 * Built by doubling rather than by bit-masking an index: the repo bans bitwise
 * operators, and a doubling build states the power-set shape directly.
 */
function filterGroupSubsets<T extends object>(groups: readonly T[]): T[] {
  let subsets: T[][] = [[]];
  for (const group of groups) {
    const extended: T[][] = [];
    for (const subset of subsets) {
      extended.push(subset, [...subset, group]);
    }
    subsets = extended;
  }
  return subsets.map((subset) => Object.assign({}, ...subset) as T);
}
