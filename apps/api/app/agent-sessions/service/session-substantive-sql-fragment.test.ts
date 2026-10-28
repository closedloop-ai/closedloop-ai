import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sessionSubstantiveSql } from "./session-substantive-predicate";

/**
 * ISS-10150 / PLN-1853 D13 amendment — `quality` graduated off the
 * TypeScript-resolved cohort onto a real predicate in the TypedSQL summary
 * statements, spliced from `packages/database/prisma/sql-fragments/
 * session-substantive.sql`. D13's own criterion for keeping a facet
 * TypeScript-resolved is "forking a live projection"; this is the parity
 * check that keeps the fragment from becoming exactly that fork. It lives
 * here (not in `scripts/lint/`) because a root script importing
 * `apps/api` runtime code crosses `@repo/database`'s package boundary in a
 * way `tsx` cannot reliably resolve — this module already imports
 * `sessionSubstantiveSql` normally, so the parity check belongs beside the
 * source of truth it protects.
 */

const REPO_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../.."
);
const FRAGMENT_DIR = join(REPO_ROOT, "packages/database/prisma/sql-fragments");
const FACET_COMMON_PATH = join(FRAGMENT_DIR, "facet-common.sql");
const SUBSTANTIVE_FRAGMENT_PATH = join(FRAGMENT_DIR, "session-substantive.sql");

const WHITESPACE_RUN = /\s+/g;
const OUTER_PARENS = /^\((.*)\)$/;
const SUBSTANTIVE_OPEN = /^\s*-- >>> SUBSTANTIVE\b/;
const SUBSTANTIVE_CLOSE = /^\s*-- <<< SUBSTANTIVE\s*$/;

function normalize(sql: string): string {
  return sql.replace(WHITESPACE_RUN, " ").trim();
}

/** Strips exactly one enclosing `(...)` pair, the wrapping `sessionSubstantiveSql`
 * adds and the fragment file omits — the consuming SQL supplies its own parens. */
function stripOuterParens(sql: string): string {
  const match = OUTER_PARENS.exec(sql.trim());
  return match ? match[1] : sql;
}

/**
 * Every `SUBSTANTIVE`-marked region's inner text, in file order.
 *
 * Deliberately NOT the shared splicer's `FRAGMENT <name>` marker syntax: that
 * mechanism's own `findRegionEnd` rejects a nested OPEN before the enclosing
 * region's CLOSE, and this region sits nested inside the `facet-common`
 * fragment (see facet-common.sql's D13-amendment comment). A distinct marker
 * name keeps this region invisible to — and un-corrupted by — that walk.
 */
function extractSubstantiveRegions(source: string): string[] {
  const lines = source.split("\n");
  const regions: string[] = [];
  let capturing: string[] | null = null;
  for (const line of lines) {
    if (SUBSTANTIVE_OPEN.test(line)) {
      capturing = [];
      continue;
    }
    if (SUBSTANTIVE_CLOSE.test(line)) {
      if (capturing === null) {
        throw new Error("SUBSTANTIVE close marker with no matching open");
      }
      regions.push(capturing.join("\n"));
      capturing = null;
      continue;
    }
    if (capturing !== null) {
      capturing.push(line);
    }
  }
  if (capturing !== null) {
    throw new Error("SUBSTANTIVE open marker never closed");
  }
  return regions;
}

describe("session-substantive.sql fragment parity (ISS-10150)", () => {
  it('matches sessionSubstantiveSql("sd")\'s rendered SQL', () => {
    const fragment = readFileSync(SUBSTANTIVE_FRAGMENT_PATH, "utf8");
    const canonical = sessionSubstantiveSql("sd").sql;

    expect(normalize(fragment)).toBe(normalize(stripOuterParens(canonical)));
  });

  it("is embedded in facet-common.sql exactly four times, matching the fragment file", () => {
    const facetCommon = readFileSync(FACET_COMMON_PATH, "utf8");
    const fragment = readFileSync(SUBSTANTIVE_FRAGMENT_PATH, "utf8");
    const regions = extractSubstantiveRegions(facetCommon);

    // Two for `quality` (the substantive arm, and the idle/negated arm — see
    // facet-common.sql's D13-amendment comment), and two more for ISS-10753's
    // `costBuckets` known/unknown split, which reuses this SAME measurable-work
    // test rather than re-deriving it a third and fourth time.
    expect(regions).toHaveLength(4);
    for (const region of regions) {
      expect(normalize(region)).toBe(normalize(fragment));
    }
  });
});
