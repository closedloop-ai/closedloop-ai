/**
 * ISS-12394 — branch coverage for `scripts/migration-order.mjs`.
 *
 * Drives `findMigrationDirNameViolations` through every naming and ordering
 * rule, and the sort helpers through their legacy-key and tie-break paths.
 * The calls run in a plain Node child, because the node lane's c8 only credits
 * code that runs outside a Vite-transformed worker. The child pins `Date.now`
 * so the future-prefix bound is deterministic.
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  describeNewMigrationDirNameRule,
  lastContiguousMigrationDirName,
} from "../scripts/migration-order.mjs";
import {
  CHILD_CASE_TIMEOUT_MS,
  runModuleInChild,
} from "./support/module-child";

const MODULE_URL = new URL("../scripts/migration-order.mjs", import.meta.url)
  .href;
const DESKTOP_DIR = fileURLToPath(new URL("..", import.meta.url));
const NOW_MS = Date.parse("2026-10-01T12:00:00.000Z");
const TIMESTAMP_RULE_PREFIX = "must be named <YYYYMMDDHHMMSS>_<snake_case>";
const SESSION_SEGMENTS = "0011_session_activity_segments";
const GENAI_PRICES = "20260619220000_add_genai_prices_pricing_source";

/** Run `body` in a child whose clock reads {@link NOW_MS}. */
function runInChild<T>(body: string): T {
  return runModuleInChild<T>({
    body,
    cwd: DESKTOP_DIR,
    moduleUrl: MODULE_URL,
    prelude: `Date.now = () => ${NOW_MS};`,
  });
}

function violations(names: readonly string[]): string[] {
  return runInChild<string[]>(
    `out(m.findMigrationDirNameViolations(${JSON.stringify(names)}));`
  );
}

function timestampViolation(name: string): string {
  return `Migration directory ${name} ${TIMESTAMP_RULE_PREFIX}: ${describeNewMigrationDirNameRule()}`;
}

describe("migrationSortKey", () => {
  it(
    "maps a legacy name to its sort key and passes any other name through",
    () => {
      expect(
        runInChild(
          `out([m.migrationSortKey(${JSON.stringify(GENAI_PRICES)}), m.migrationSortKey("0001_init")]);`
        )
      ).toEqual(["0004_add_genai_prices_pricing_source", "0001_init"]);
    },
    CHILD_CASE_TIMEOUT_MS
  );

  it(
    "keeps the LAST of the two duplicate session-segments entries",
    () => {
      // pins current behavior; looks odd because the Map literal lists this
      // key twice and the first entry (an identity mapping) is silently
      // overwritten.
      expect(
        runInChild(
          `out([m.legacyMigrationSortKeys.get(${JSON.stringify(SESSION_SEGMENTS)}), m.legacyMigrationSortKeys.size]);`
        )
      ).toEqual(["0012_session_activity_segments", 2]);
    },
    CHILD_CASE_TIMEOUT_MS
  );
});

describe("compareMigrationDirNames", () => {
  it(
    "orders by sort key, breaks a key tie by name, and returns 0 only for one name",
    () => {
      const [sorted, sessionVsClear, same] = runInChild<
        [string[], number, number]
      >(
        `out([
          ["0005_x", ${JSON.stringify(GENAI_PRICES)}, "0003_y"].sort(m.compareMigrationDirNames),
          Math.sign(m.compareMigrationDirNames(${JSON.stringify(SESSION_SEGMENTS)}, "0011_clear_default_branch_pr_poison")),
          m.compareMigrationDirNames("0001_a", "0001_a"),
        ]);`
      );
      expect(sorted).toEqual(["0003_y", GENAI_PRICES, "0005_x"]);
      expect(sessionVsClear).toBe(1);
      expect(same).toBe(0);
    },
    CHILD_CASE_TIMEOUT_MS
  );
});

describe("findMigrationDirNameViolations", () => {
  it(
    "accepts the historical set plus a valid timestamped migration",
    () => {
      expect(
        violations([
          "0001_init",
          GENAI_PRICES,
          "0011_clear_default_branch_pr_poison",
          SESSION_SEGMENTS,
          lastContiguousMigrationDirName,
          "20260916231500_iss1234_add_widget_index",
        ])
      ).toEqual([]);
    },
    CHILD_CASE_TIMEOUT_MS
  );

  it(
    "flags a duplicate name as out of order",
    () => {
      expect(violations(["0001_a", "0001_a"])).toEqual([
        "Migration directory 0001_a must sort after 0001_a",
      ]);
    },
    CHILD_CASE_TIMEOUT_MS
  );

  it(
    "flags a name inside the history that is not a 000N name",
    () => {
      expect(violations(["0001_Bad-Name"])).toEqual([
        "Migration directory 0001_Bad-Name sorts within the committed 000N history but is not one of its names",
      ]);
    },
    CHILD_CASE_TIMEOUT_MS
  );

  it(
    "flags every malformed name after the boundary",
    () => {
      const names = [
        "0095_next",
        "20251231235959_before_2026",
        "20261301000000_month13",
        "20260230000000_feb30",
        "20260101240000_hour24",
        "20260101000060_second60",
        "20260916231500_Upper",
      ];
      expect(violations(names)).toEqual(
        [...names]
          .sort((left, right) => left.localeCompare(right))
          .map(timestampViolation)
      );
    },
    CHILD_CASE_TIMEOUT_MS
  );

  it(
    "accepts a prefix up to one day past now and refuses one beyond it",
    () => {
      expect(violations(["20261002120000_skew_edge"])).toEqual([]);
      expect(violations(["20261002120001_future"])).toEqual([
        timestampViolation("20261002120001_future"),
      ]);
    },
    CHILD_CASE_TIMEOUT_MS
  );
});

describe("describeNewMigrationDirNameRule", () => {
  it(
    "names the boundary directory",
    () => {
      expect(
        runInChild<string>("out(m.describeNewMigrationDirNameRule());")
      ).toContain(`ended at ${lastContiguousMigrationDirName} (ISS-10416)`);
    },
    CHILD_CASE_TIMEOUT_MS
  );
});
