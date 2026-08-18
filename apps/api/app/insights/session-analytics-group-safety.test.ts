import { SessionTraceThrottleSourceType } from "@repo/api/src/types/agent-session";
import { Prisma } from "@repo/database";
import { describe, expect, it } from "vitest";
import { FAILURE_THROTTLE_SOURCE_TYPES } from "./session-analytics-classify";
import {
  assertGroupSafe,
  ENGINEER_NAME,
  FAILURE_THROTTLE_SOURCE,
  PRODUCED_ARTIFACT,
  SIGNAL_GRID_GROUP_BY,
  SIGNAL_GRID_SELECT,
  WALL_CLOCK_MINUTES,
} from "./session-analytics-sql";

/**
 * ISS-5263 — the invariant that keeps the session-analytics screens plannable.
 *
 * A `Prisma.sql` fragment carrying a `${value}` emits a bound parameter, and
 * every interpolation of that fragment gets a FRESH placeholder number. A
 * fragment reused across a SELECT list and its matching GROUP BY therefore
 * renders `… / $5` in one and `… / $9` in the other; Postgres compares grouping
 * expressions structurally, refuses to match two different `Param` nodes, and
 * raises 42803 on the underlying column. That is what blanked both the
 * Lost-work and TokenOps screens from the day they shipped.
 *
 * `session-analytics-sql.ts` guards this at module load, so a regression fails
 * the moment anything imports it. This suite states the contract in one place
 * and names the fragments it covers, so a NEW shared fragment has an obvious
 * home rather than shipping unguarded.
 *
 * This is a shape contract, not a substitute for execution: the reads are
 * planned against a real Postgres in
 * `apps/api/__tests__/integration/insights-session-analytics-groupby.test.ts`.
 */

/** The load-time guard's own message, matched rather than repeated verbatim. */
const NO_BOUND_PARAMETERS = /no bound parameters/;

const GROUPED_FRAGMENTS = [
  ["WALL_CLOCK_MINUTES", WALL_CLOCK_MINUTES],
  ["PRODUCED_ARTIFACT", PRODUCED_ARTIFACT],
  ["FAILURE_THROTTLE_SOURCE", FAILURE_THROTTLE_SOURCE],
  ["ENGINEER_NAME", ENGINEER_NAME],
  ["SIGNAL_GRID_SELECT", SIGNAL_GRID_SELECT],
  ["SIGNAL_GRID_GROUP_BY", SIGNAL_GRID_GROUP_BY],
] as const;

describe("session-analytics SQL fragments reused across SELECT and GROUP BY", () => {
  it.each(GROUPED_FRAGMENTS)("%s carries no bound parameters", (_name, sql) => {
    expect(sql.values).toEqual([]);
  });

  it("renders the wall-clock divisor as a literal, not a placeholder", () => {
    expect(WALL_CLOCK_MINUTES.sql).toContain("/ 60");
  });

  it("renders the failure throttle sources as literals, not a parameter list", () => {
    for (const sourceType of FAILURE_THROTTLE_SOURCE_TYPES) {
      expect(FAILURE_THROTTLE_SOURCE.sql).toContain(`'${sourceType}'`);
    }
    // `TokenSnapshot` is a usage sample, not a throttle — excluding it is why
    // the list is enumerated rather than derived from the whole enum.
    expect(FAILURE_THROTTLE_SOURCE.sql).not.toContain(
      `'${SessionTraceThrottleSourceType.TokenSnapshot}'`
    );
  });
});

/**
 * The guard itself, executed rather than assumed.
 *
 * Every fragment above is already parameter-free, so the list can only prove
 * that today's fragments pass — it never exercises the branch that fires. These
 * run the decision against synthetic fragments so a guard that stopped throwing
 * fails here instead of at plan time in production.
 */
describe("assertGroupSafe", () => {
  it("throws when a fragment carries a bound parameter", () => {
    const splitAt = new Date("2026-06-15T00:00:00.000Z");
    expect(() =>
      assertGroupSafe(
        "SPLIT_AT_BOUND",
        Prisma.sql`(s.session_started_at < ${splitAt})`
      )
    ).toThrow(NO_BOUND_PARAMETERS);
  });

  it("returns a parameter-free fragment unchanged", () => {
    const fragment = Prisma.sql`date_trunc('day', s.session_started_at)`;
    expect(assertGroupSafe("DAY_BUCKET_UTC", fragment)).toBe(fragment);
  });
});
