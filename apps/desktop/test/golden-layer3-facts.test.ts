/**
 * ISS-5179: synthetic unit tests for the Layer 3 fact-checking helpers
 * (test/golden/golden-layer3-facts.ts).
 *
 * `nullableNum` is the identity-match primitive the Layer 3 sweep compares
 * nullable SQLite columns through. Its inputs come off a raw `SELECT *` read
 * whose row type is hand-declared and therefore unenforced at runtime, so
 * `undefined` is reachable there no matter what the signature says — the
 * AGENTS.md "types do not constrain persisted rows" trust-boundary carveout.
 * These cases pin the absent-column behavior so a future tightening back to a
 * strict `=== null` check cannot silently reintroduce `NaN`.
 *
 * Everything here is synthetic — no corpus files, no SQLite.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { nullableNum } from "./golden/golden-layer3-facts.js";

/**
 * The `pr_number` half of a `pull_requests` row. `L3Rows` declares `pr_number`
 * as required, but the value arrives from `SELECT *` over a raw client — the
 * declaration is an assertion about the schema, not a runtime guarantee — so
 * the honest boundary shape marks it optional.
 */
type PrRowLike = {
  repo_full_name: string | null;
  pr_number?: number | bigint | null;
};

/** The branch-read side of the identity match (`BranchPrRow`, narrowed). */
type BranchPrLike = { repoFullName: string | null; prNumber: number | null };

/**
 * The `agg.branches.pr_rows_subset` predicate from golden-layer3.ts, reduced to
 * the two fields that carry the nullable identity.
 */
function prRowMatches(rows: PrRowLike[], p: BranchPrLike): boolean {
  return rows.some(
    (row) =>
      (row.repo_full_name ?? null) === (p.repoFullName ?? null) &&
      nullableNum(row.pr_number) === p.prNumber
  );
}

test("nullableNum: an absent column yields null, never NaN", () => {
  // A `SELECT *` row missing `pr_number` hands back `undefined`. The declared
  // row type forbids it; the database does not.
  const absent = nullableNum(undefined);
  assert.equal(
    absent,
    null,
    "an absent column must read as null (unknown), not a number"
  );
  // Name the failure mode rather than leave it implied: `Number(undefined)` is
  // NaN, the one value that compares unequal to ITSELF, so an identity match
  // built on it can never succeed and never errors either.
  assert.equal(
    absent !== null && Number.isNaN(absent),
    false,
    "nullableNum must never return NaN"
  );
});

test("nullableNum: null stays null and real values still convert", () => {
  assert.equal(nullableNum(null), null);
  assert.equal(nullableNum(42), 42);
  assert.equal(nullableNum(42n), 42, "bigint columns narrow to number");
  assert.equal(
    nullableNum(0),
    0,
    "a literal PR 0 stays distinct from an absent PR number"
  );
});

test("nullableNum: an absent column still matches an absent PR number", () => {
  // Both sides genuinely agree — neither carries a PR number — so the identity
  // match must succeed. Under `Number(undefined)` this row set matches NOTHING,
  // because NaN is unequal to null AND to itself, so any selection keyed on the
  // comparison silently comes back empty rather than erroring.
  const rows: PrRowLike[] = [{ repo_full_name: "acme/web" }];
  assert.equal(
    prRowMatches(rows, { repoFullName: "acme/web", prNumber: null }),
    true,
    "null matches only null — and an absent column is a null, not a NaN"
  );
  assert.equal(
    prRowMatches(rows, { repoFullName: "acme/web", prNumber: 0 }),
    false,
    "an unknown PR number must NOT match a literal PR 0"
  );
});

test("nullableNum: a present column matches on identity, not on 0-folding", () => {
  const rows: PrRowLike[] = [{ repo_full_name: "acme/web", pr_number: 42 }];
  assert.equal(
    prRowMatches(rows, { repoFullName: "acme/web", prNumber: 42 }),
    true
  );
  assert.equal(
    prRowMatches(rows, { repoFullName: "acme/web", prNumber: null }),
    false,
    "a known PR number must NOT match an unknown one"
  );
});
