import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { getSharedBranchUsage } from "../src/main/branch/shared-branches-api.js";
import { link, makeSource } from "./shared-branches-test-helpers.js";

/**
 * FEA-4280: `getSharedBranchUsage` must degrade gracefully on a single invalid
 * cloud/version-skewed token count instead of throwing and taking down the whole
 * Branches usage view. Split out of `shared-branches-api.test.ts` (a shrink-only
 * grandfathered file) into this focused sibling, reusing the shared canned-row
 * fixtures so the fixture wiring is not duplicated.
 */

// A JS-unsafe count (2^53, one past Number.MAX_SAFE_INTEGER) — the exact shape a
// version-skewed peer / cloud row can widen a stored counter to.
const OVER_SAFE_INTEGER_TOKEN = "9007199254740992";

describe("getSharedBranchUsage — invalid token degradation (FEA-4280)", () => {
  test("one out-of-range token value degrades gracefully — offending value clamped to 0, rest of the view still renders", async () => {
    // The offending row must NOT throw InvalidTokenCountError and take down the
    // ENTIRE Branches usage view.
    const source = makeSource({
      links: [
        link({ branch_name: "a", session_id: "unsafe-s1" }),
        link({ branch_name: "b", session_id: "valid-s2" }),
      ],
      usageTokens: [
        {
          session_id: "unsafe-s1",
          model: "unknown-model",
          input_tokens: OVER_SAFE_INTEGER_TOKEN,
          output_tokens: 1,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          billing_mode: null,
          created_at: "2026-06-10T10:00:00.000Z",
        },
        {
          session_id: "valid-s2",
          model: "unknown-model",
          input_tokens: 30,
          output_tokens: 40,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          billing_mode: null,
          created_at: "2026-06-10T10:00:00.000Z",
        },
      ],
    });

    // Does NOT throw; the offending input_tokens is clamped to 0, its sibling
    // (output_tokens: 1) is preserved, and the fully-valid second row flows
    // through unchanged — the view renders the rest of the data.
    const summary = await getSharedBranchUsage(source);
    assert.equal(summary.totalBranches, 2);
    assert.equal(summary.totalInputTokens, 30); // 0 (clamped) + 30
    assert.equal(summary.totalOutputTokens, 41); // 1 + 40
  });

  test("a fully-valid usage payload is unchanged by the lenient read", async () => {
    const source = makeSource({
      links: [link({ branch_name: "a", session_id: "s1" })],
      usageTokens: [
        {
          session_id: "s1",
          model: "unknown-model",
          input_tokens: 100,
          output_tokens: 200,
          cache_read_tokens: 5,
          cache_write_tokens: 7,
          billing_mode: null,
          created_at: "2026-06-10T10:00:00.000Z",
        },
      ],
    });
    const summary = await getSharedBranchUsage(source);
    assert.equal(summary.totalInputTokens, 100);
    assert.equal(summary.totalOutputTokens, 200);
    assert.equal(summary.totalCacheReadTokens, 5);
    assert.equal(summary.totalCacheWriteTokens, 7);
  });
});
