import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { displaySortCandidate } from "@/__tests__/support/agent-sessions/display-sort-candidate.test-fixtures";
import {
  AGENT_SESSION_SORT_COLUMNS,
  type AgentSessionSortColumn,
  type AgentSessionSortRule,
} from "../validators";
import { buildAgentSessionOrderBy } from "./query-builder";
import type { DisplaySortCandidate } from "./session-display-sort";
import { buildDisplaySortComparator } from "./session-sort-comparators";
import {
  isDbSortColumn,
  isDisplayValueSort,
  SESSION_UNIQUE_TIEBREAKER,
} from "./session-sort-order";

/**
 * ISS-9478 pagination proof, for the two arms a Sessions list request can take.
 *
 * A stable page boundary needs a TOTAL order over the population: with one,
 * `skip`/`take` over a fixed population partitions it; without one, rows tied on
 * every requested key can land on either side of a boundary. "Stable" here is
 * the RULING in the human-signed ISS-9478 triage packet: "stable under
 * concurrent updates" means a total repeatable order for a FIXED population.
 * Offset paging is not insert-stable by design (`session-sort-order.ts`,
 * FEA-4329), and cursor paging is not built (PLN-1938 §8 decision 6).
 *
 * The DB arm (every rule DB-native) is the `orderBy` the database runs. Its
 * single-rule totality is observed through a tie-adversarial fake in
 * `session-sort-order.test.ts`; this file covers every two-rule chain.
 *
 * The display arm (any rule in {@link DISPLAY_SORT_COLUMNS}) discards that
 * `orderBy` — the database only supplies the candidate set — and ranks in memory
 * with `buildDisplaySortComparator`, so the comparator is what has to be total.
 */

const DIRECTIONS = ["asc", "desc"] as const;

const DB_SORT_COLUMNS = AGENT_SESSION_SORT_COLUMNS.filter(isDbSortColumn);
const DISPLAY_SORT_COLUMNS =
  AGENT_SESSION_SORT_COLUMNS.filter(isDisplayValueSort);

/** Six candidates identical in every sort key, differing only in `artifactId`. */
const CANDIDATE_IDS = ["a", "b", "c", "d", "e", "f"];

describe("DB arm — every two-rule chain ends in the unique tiebreaker (ISS-9478)", () => {
  it("emits each rule's own key, in order, whatever position the rule holds", () => {
    // Position independence is what carries the FEA-4330 `nulls: "last"` pin
    // into a secondary slot: the single-rule key is pinned per nullable column
    // in `session-sort-order.test.ts` and against the live column nullability
    // in `session-list-sort-plan.integration.test.ts`, so a chain that dropped
    // or flipped it in position 2 differs from the single-rule key here.
    for (const [first, second] of orderedPairs(DB_SORT_COLUMNS)) {
      for (const firstDir of DIRECTIONS) {
        for (const secondDir of DIRECTIONS) {
          const orderBy = buildAgentSessionOrderBy({
            sorts: [
              { column: first, dir: firstDir },
              { column: second, dir: secondDir },
            ],
          });
          const label = `${first} ${firstDir}, ${second} ${secondDir}`;
          expect(orderBy[0], label).toEqual(primaryKeyOf(first, firstDir));
          expect(orderBy[1], label).toEqual(primaryKeyOf(second, secondDir));
          expect(orderBy.at(-1), label).toEqual(SESSION_UNIQUE_TIEBREAKER);
        }
      }
    }
  });
});

describe("display arm — the in-memory comparator is total (ISS-9478)", () => {
  beforeEach(() => {
    // A running session's Duration key is `now - start`, so the clock is pinned:
    // nothing here may tie or separate rows because time moved.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-03T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(DISPLAY_SORT_COLUMNS)(
    "%s: alone and chained with every column, orders identical rows one way from either input order",
    (column) => {
      for (const rules of displayChains(column)) {
        const compare = buildDisplaySortComparator(rules);
        const rows = CANDIDATE_IDS.map((id) => terminalCandidate(id));
        const forward = [...rows].sort(compare).map((row) => row.artifactId);
        const reversed = [...rows]
          .reverse()
          .sort(compare)
          .map((row) => row.artifactId);
        const label = describeRules(rules);
        expect(reversed, label).toEqual(forward);
        for (const [left, right] of orderedPairs(rows)) {
          expect(compare(left, right), label).not.toBe(0);
        }
      }
    }
  );

  it.each(DISPLAY_SORT_COLUMNS)(
    "%s: the same rows with one shared id compare equal, so only the terminal key separated them (counterfactual)",
    (column) => {
      for (const rules of displayChains(column)) {
        const compare = buildDisplaySortComparator(rules);
        const rows = CANDIDATE_IDS.map(() => terminalCandidate("same"));
        for (const [left, right] of orderedPairs(rows)) {
          expect(compare(left, right), describeRules(rules)).toBe(0);
        }
      }
    }
  );
});

function primaryKeyOf(
  column: AgentSessionSortColumn,
  dir: AgentSessionSortRule["dir"]
) {
  return buildAgentSessionOrderBy({ sorts: [{ column, dir }] })[0];
}

function orderedPairs<T>(items: readonly T[]): [T, T][] {
  return items.flatMap((left, leftIndex) =>
    items
      .filter((_, rightIndex) => rightIndex !== leftIndex)
      .map((right): [T, T] => [left, right])
  );
}

/**
 * The display column alone, and as either rule of a two-rule chain with every
 * other sort column, in every direction combination.
 */
function displayChains(
  column: AgentSessionSortColumn
): AgentSessionSortRule[][] {
  const chains: AgentSessionSortRule[][] = DIRECTIONS.map((dir) => [
    { column, dir },
  ]);
  const others = AGENT_SESSION_SORT_COLUMNS.filter((other) => other !== column);
  for (const other of others) {
    for (const dir of DIRECTIONS) {
      for (const otherDir of DIRECTIONS) {
        chains.push(
          [
            { column, dir },
            { column: other, dir: otherDir },
          ],
          [
            { column: other, dir: otherDir },
            { column, dir },
          ]
        );
      }
    }
  }
  return chains;
}

function describeRules(rules: readonly AgentSessionSortRule[]): string {
  return rules.map((rule) => `${rule.column} ${rule.dir}`).join(", ");
}

/**
 * A finished session (the fixture's status is `inactive`), so its Duration is
 * `end - start` and not clock-relative.
 */
function terminalCandidate(artifactId: string): DisplaySortCandidate {
  return displaySortCandidate(artifactId, { endsWithError: false });
}
