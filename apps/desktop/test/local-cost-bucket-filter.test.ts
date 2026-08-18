import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  SESSION_UNKNOWN_COST_BUCKET_ID,
  type SessionSubstantiveCounts,
} from "@repo/api/src/agent-session-filters";
import { matchesLocalCostBucketFilter } from "../src/main/session/local-cost-bucket-filter.js";

// A session that clearly did measurable work (a turn) — the common case, so the
// numeric-vs-unknown gate reads as availability-by-cost, not availability-by-work.
const WORKED: SessionSubstantiveCounts = { turns: 3 };
// A session that never ran (no turns/tokens/tool-uses) — renders "—" regardless
// of billing mode (ISS-4418 / ISS-4481).
const NO_WORK: SessionSubstantiveCounts = {
  turns: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  toolUseCount: 0,
};

describe("matchesLocalCostBucketFilter", () => {
  test("matches a priced session against a selected bucket (OR within dimension)", () => {
    // $75 known cost → in "$50+", not in "< $1".
    assert.equal(
      matchesLocalCostBucketFilter(75, "api", WORKED, ["from_50"]),
      true
    );
    assert.equal(
      matchesLocalCostBucketFilter(75, "api", WORKED, ["under_1"]),
      false
    );
    // OR across selected buckets.
    assert.equal(
      matchesLocalCostBucketFilter(0.25, "api", WORKED, ["under_1", "from_50"]),
      true
    );
  });

  test("normalizes sub-cent float drift to the cloud Decimal boundary", () => {
    // sumTokenUsage can yield 0.9999999999999998 for a true $1.00 — 6dp
    // normalization + the shared 2dp display rounding put it at exactly $1.00,
    // which is IN "≤ $1" (the inclusive top of the first bucket) and OUT of
    // "$1 to $10" (its lower bound is exclusive) (FEA-4293, Mike's decision).
    assert.equal(
      matchesLocalCostBucketFilter(0.999_999_999_999_999_8, "api", WORKED, [
        "under_1",
      ]),
      true
    );
    assert.equal(
      matchesLocalCostBucketFilter(0.999_999_999_999_999_8, "api", WORKED, [
        "from_1_to_10",
      ]),
      false
    );
  });

  test("excludes an UNKNOWN cost (renders —) from every numeric bucket (FEA-4294)", () => {
    // estimatedCost 0 with a non-subscription billing mode is the "—" cell — a
    // placeholder 0 that must NOT satisfy "< $1".
    assert.equal(
      matchesLocalCostBucketFilter(0, "api", WORKED, ["under_1"]),
      false
    );
    assert.equal(
      matchesLocalCostBucketFilter(0, null, WORKED, ["under_1"]),
      false
    );
    assert.equal(
      matchesLocalCostBucketFilter(0, "unknown", WORKED, ["under_1"]),
      false
    );
  });

  test("includes a WORKED $0 subscription session (shows a $ figure) in ≤ $1", () => {
    // A subscription session that ran renders a `$` figure even at $0, so it IS
    // numeric and belongs in "≤ $1".
    assert.equal(
      matchesLocalCostBucketFilter(0, "max_20x", WORKED, ["under_1"]),
      true
    );
    assert.equal(
      matchesLocalCostBucketFilter(0, "pro", WORKED, ["under_1"]),
      true
    );
  });

  test("ISS-4481: a NO-WORK $0 subscription session renders — , not in any numeric bucket", () => {
    // ISS-4418/ISS-4481: a subscription session that never ran shows "—", so it
    // is Unknown — never "≤ $1", even though its summed cost is 0.
    assert.equal(
      matchesLocalCostBucketFilter(0, "max_20x", NO_WORK, ["under_1"]),
      false
    );
    assert.equal(
      matchesLocalCostBucketFilter(0, "max_20x", NO_WORK, [
        SESSION_UNKNOWN_COST_BUCKET_ID,
      ]),
      true
    );
  });

  test("ISS-4481 (wongk): a raw sub-cent priced cost that displays $0.00 is KNOWN, not Unknown", () => {
    // The display renders `formatCost(0.0000004)` = "$0.00" (a $ figure), so the
    // availability check on the RAW cost must read it as KNOWN. It must NOT be
    // rounded to 0 first and mislabeled Unknown. It does not fall in "≤ $1"'s
    // displayed cohort boundary questions here — the point is Unknown excludes it.
    const raw = 0.000_000_4;
    assert.equal(
      matchesLocalCostBucketFilter(raw, "api", WORKED, [
        SESSION_UNKNOWN_COST_BUCKET_ID,
      ]),
      false
    );
    // And it displays $0.00 → rounds into the "≤ $1" bucket.
    assert.equal(
      matchesLocalCostBucketFilter(raw, "api", WORKED, ["under_1"]),
      true
    );
  });

  test("ISS-4481: the Unknown option matches EXACTLY the — rows, and only those", () => {
    const unknown = [SESSION_UNKNOWN_COST_BUCKET_ID];
    // Unknown-cost rows (render "—") match: non-subscription, non-positive cost.
    assert.equal(matchesLocalCostBucketFilter(0, "api", WORKED, unknown), true);
    assert.equal(matchesLocalCostBucketFilter(0, null, WORKED, unknown), true);
    // A no-work subscription session also renders "—", so it matches Unknown.
    assert.equal(
      matchesLocalCostBucketFilter(0, "max_20x", NO_WORK, unknown),
      true
    );
    // A priced row does NOT match Unknown.
    assert.equal(
      matchesLocalCostBucketFilter(12.34, "api", WORKED, unknown),
      false
    );
    // A WORKED $0.00 subscription (shows a "$" figure) does NOT match Unknown.
    assert.equal(
      matchesLocalCostBucketFilter(0, "max_20x", WORKED, unknown),
      false
    );
    assert.equal(
      matchesLocalCostBucketFilter(0, "pro", WORKED, unknown),
      false
    );
  });

  test("ISS-4481: Unknown does not overlap a numeric bucket for the same row", () => {
    // The unknown-cost row is in Unknown and NOT in "≤ $1"; a cheap known row is
    // in "≤ $1" and NOT in Unknown — the cohorts are disjoint.
    const unknown = [SESSION_UNKNOWN_COST_BUCKET_ID];
    assert.equal(matchesLocalCostBucketFilter(0, "api", WORKED, unknown), true);
    assert.equal(
      matchesLocalCostBucketFilter(0, "api", WORKED, ["under_1"]),
      false
    );
    assert.equal(
      matchesLocalCostBucketFilter(0.5, "api", WORKED, unknown),
      false
    );
    assert.equal(
      matchesLocalCostBucketFilter(0.5, "api", WORKED, ["under_1"]),
      true
    );
  });

  test("ISS-4481: Unknown composes OR-within with a numeric bucket", () => {
    // Unknown + "$50+" selected: both an unknown row and a $75 row match.
    const selection = [SESSION_UNKNOWN_COST_BUCKET_ID, "from_50"];
    assert.equal(
      matchesLocalCostBucketFilter(0, "api", WORKED, selection),
      true
    );
    assert.equal(
      matchesLocalCostBucketFilter(75, "api", WORKED, selection),
      true
    );
    // A mid-range known cost matches neither.
    assert.equal(
      matchesLocalCostBucketFilter(5, "api", WORKED, selection),
      false
    );
  });
});
