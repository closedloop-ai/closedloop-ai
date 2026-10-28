/**
 * @file migration-dir-names.test.ts
 * @description ISS-10416. Drives `findMigrationDirNameViolations` against
 * synthetic directory sets, so the decision is exercised on the cases a real
 * listing cannot show: the two same-base PRs whose colliding prefixes are the
 * reason the scheme changed, a malformed timestamp, and the boundary itself.
 *
 * The committed listing is asserted by `prisma-migrations-agreement.test.ts`,
 * which is the production wiring for this function; this file is the decision.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  compareMigrationDirNames,
  findMigrationDirNameViolations,
  lastContiguousMigrationDirName,
  migrationSortKey,
} from "../scripts/migration-order.mjs";

/**
 * A minimal stand-in for the committed history: the genesis and the recorded
 * boundary. Both are real committed directories — the boundary has to be, since
 * every classification in the function is relative to it.
 */
const HISTORY = ["0001_init", lastContiguousMigrationDirName] as const;

/** Two directories a pair of PRs cut from the same base would produce. */
const FIRST_NEW_DIR = "20260916231500_iss10416_first_pr";
const SECOND_NEW_DIR = "20260916231742_iss10416_second_pr";

const NEEDS_TIMESTAMP_RE = /must be named <YYYYMMDDHHMMSS>_<snake_case>/;
/** Strips the separators out of an ISO instant, leaving a bare prefix. */
const NON_DIGIT_RE = /\D/g;
const OUT_OF_ORDER_RE = /must sort after/;

test("a timestamped directory after the boundary is accepted", () => {
  assert.deepEqual(
    findMigrationDirNameViolations([...HISTORY, FIRST_NEW_DIR]),
    []
  );
});

/**
 * Both names are legal side by side, which is the half of the same-base pair
 * THIS function decides: neither PR claims the other's slot, so neither is
 * renumbered and nothing cascades to the PRs queued behind them.
 *
 * That is not the whole story and must not be read as one. Whether the pair may
 * merge in either ORDER is decided by `findOutOfOrderMigrations`, which this
 * function never sees — it sorts its own input, so the array order here is not a
 * merge order and a case varying it would pin nothing.
 * `scripts/lint/desktop-migration-same-base-pair.test.ts` owns that half,
 * including the one order still refused.
 */
test("two same-base PRs claim different slots, so neither is renumbered", () => {
  assert.deepEqual(
    findMigrationDirNameViolations([...HISTORY, FIRST_NEW_DIR, SECOND_NEW_DIR]),
    []
  );
});

test("the colliding four-digit pair those two PRs used to produce is rejected", () => {
  const violations = findMigrationDirNameViolations([
    ...HISTORY,
    "0095_iss10416_first_pr",
    "0095_iss10416_second_pr",
  ]);

  assert.equal(violations.length, 2);
  for (const violation of violations) {
    assert.match(violation, NEEDS_TIMESTAMP_RE);
  }
});

test("a four-digit directory added after the boundary is rejected", () => {
  assert.deepEqual(
    findMigrationDirNameViolations([...HISTORY, "0095_iss10416_example"])
      .length,
    1
  );
});

test("a 14-digit prefix that is not a real UTC instant is rejected", () => {
  for (const impossible of [
    "20261301000000_month_thirteen",
    "20260230000000_february_thirtieth",
    "20260916240000_hour_twenty_four",
    "20260916235960_second_sixty",
  ]) {
    assert.equal(
      findMigrationDirNameViolations([...HISTORY, impossible]).length,
      1,
      `${impossible} sorts wherever its digits fall and must not be accepted`
    );
  }
});

/**
 * The bounds the `Date` round-trip alone cannot enforce. Each of these is a REAL
 * instant, so unbounded it merges — and because a merged directory is never
 * renamed, a FUTURE one leaves every correctly minted migration after it sorting
 * below the tip and refused as backdated forever.
 *
 * `2036` is the case that decides the SHAPE of the future bound. It is the same
 * single keystroke as `2926` and it is a plausible-looking year, so any year
 * CEILING wide enough to be safe still admits it. Only `now` refuses both.
 */
test("a future prefix is rejected even though it is a real instant", () => {
  for (const mistyped of [
    "29260916120000_fat_fingered_era",
    "20360916120000_fat_fingered_decade",
    "20250916120000_before_the_scheme",
  ]) {
    const year = mistyped.slice(0, 4);
    assert.equal(
      new Date(`${year}-09-16T12:00:00.000Z`).toISOString().slice(0, 4),
      year,
      `${mistyped} must be a real instant, or this case proves nothing`
    );
    assert.equal(
      findMigrationDirNameViolations([...HISTORY, mistyped]).length,
      1,
      `${mistyped} is calendar-valid but not a legal mint`
    );
  }
});

/**
 * The other half of the clock bound, and why comparing an IMMUTABLE committed
 * set against a moving `now` is legal: the comparison only ever loosens. A
 * prefix minted a moment ago passes, and since `now` only moves forward it keeps
 * passing on every later run — so this bound can never redden a directory that
 * has already merged and can no longer be renamed.
 */
test("a prefix minted just now is accepted", () => {
  const justNow = new Date(Date.now() - 1000)
    .toISOString()
    .replace(NON_DIGIT_RE, "")
    .slice(0, 14);
  assert.deepEqual(
    findMigrationDirNameViolations([...HISTORY, `${justNow}_minted_now`]),
    []
  );
});

test("the committed history's two naming exceptions still pass", () => {
  assert.deepEqual(
    findMigrationDirNameViolations([
      "0001_init",
      "0011_clear_default_branch_pr_poison",
      "0011_session_activity_segments",
      "20260619220000_add_genai_prices_pricing_source",
      lastContiguousMigrationDirName,
    ]),
    []
  );
});

test("the boundary directory itself is historical, the next one is not", () => {
  assert.deepEqual(findMigrationDirNameViolations([...HISTORY]), []);
  assert.equal(
    findMigrationDirNameViolations([
      ...HISTORY,
      `${lastContiguousMigrationDirName}_suffix`,
    ]).length,
    1
  );
});

test("two directories resolving to one sort key are rejected", () => {
  // The FEA-2030 remap lands on this exact key, so a directory committed under
  // it would order ambiguously against the one that is remapped onto it.
  assert.match(
    findMigrationDirNameViolations([
      "0004_add_genai_prices_pricing_source",
      "20260619220000_add_genai_prices_pricing_source",
    ])[0] ?? "",
    OUT_OF_ORDER_RE
  );
});

test("a timestamped directory sorts after every committed name", () => {
  // The history's sort keys all begin `00`, and a timestamp prefix is a year,
  // so the two ranges cannot interleave. Both ends are pinned so a remap that
  // lifted a historical key out of the `0` range would redden here rather than
  // at a user's boot. These two are SORT-KEY probes, deliberately wider than the
  // bounds `isUtcTimestampPrefix` enforces — neither is a legal directory
  // name, and the point is that the ranges hold even so.
  const boundaryKey = migrationSortKey(lastContiguousMigrationDirName);
  for (const timestamped of [
    "10000101000000_floor",
    "99991231235959_ceiling",
  ]) {
    assert.ok(boundaryKey < migrationSortKey(timestamped));
    assert.ok(
      compareMigrationDirNames(lastContiguousMigrationDirName, timestamped) < 0
    );
  }
});

test("a name sorting inside the committed history must be a 000N name", () => {
  const intruder = "00001_not_four_digits";
  assert.deepEqual(findMigrationDirNameViolations([...HISTORY, intruder]), [
    `Migration directory ${intruder} sorts within the committed 000N history but is not one of its names`,
  ]);
});

test("any 000N-shaped name at or below the boundary passes", () => {
  // Pins current behavior; looks odd because the check accepts ANY 000N name in
  // the historical range, not only the directories that were committed there,
  // so a new `0050_bogus` would pass here. It is still refused before merge:
  // `findOutOfOrderMigrations` in scripts/lint/destructive-migrations/migration-order.ts
  // rejects any added migration that sorts before the latest one on main.
  assert.deepEqual(
    findMigrationDirNameViolations([...HISTORY, "0050_bogus"]),
    []
  );
});
