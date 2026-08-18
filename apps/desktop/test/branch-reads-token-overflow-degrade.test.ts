import assert from "node:assert/strict";
import test from "node:test";
import {
  BranchCostCompleteness,
  BranchCostCompletenessReason,
} from "@repo/api/src/types/branch-usage";
import { ArtifactRefRelation } from "@repo/api/src/types/session-artifact-link";
import {
  TokenCostBasis,
  TokenCostCompleteness,
  TokenSourceIdentityAvailability,
} from "@repo/api/src/types/token-cost-provenance";
import { getSharedBranchUsage } from "../src/main/branch/shared-branches-api.js";
import {
  readBranchSessionTokenRowsForBranch,
  readBranchTokenAggregateRows,
  readBranchUsageTokenRows,
} from "../src/main/database/branch-reads.js";
import { seeder, withAcDb } from "./branch-reads-ac-test-helpers.js";

// A stored INTEGER token counter above Number.MAX_SAFE_INTEGER
// (9007199254740991). Written as a raw SQL literal (never a bound JS number,
// which would already round it) so the real libSQL store holds the exact
// out-of-range int64.
const OVER_SAFE_INTEGER_TOKEN_LITERAL = "9223372036854775807";

test("FEA-4280: an out-of-range stored token counter degrades to 0 instead of throwing (real libSQL)", async () => {
  // The production failure this guards: libSQL is opened with intMode:"number",
  // so an INTEGER above Number.MAX_SAFE_INTEGER throws a RangeError while the raw
  // ($queryRawUnsafe) row is DECODED — BEFORE any JS mapper runs. The JS clamp
  // alone is too late; the token columns/expressions must be CAST(... AS TEXT) in
  // the SQL so the value arrives as a string the lenient clamp can degrade. A
  // single bad counter must not take down the whole Branches usage batch.
  await withAcDb(async (db) => {
    const s = seeder(db);
    // Branch A: one session carrying an out-of-range input_tokens counter, plus
    // valid values on the other columns.
    const branchA = await s.branch({ branch: "feature/overflow" });
    await s.session("sBad");
    await s.link({
      session: "sBad",
      artifactId: branchA,
      method: "git_push",
      relation: ArtifactRefRelation.Created,
    });
    await db.run(
      `INSERT INTO token_usage
         (session_id, model, input_tokens, output_tokens, cache_read_tokens,
          cache_write_tokens, cost_usd_estimated)
       VALUES ('sBad', 'm1', ${OVER_SAFE_INTEGER_TOKEN_LITERAL}, 100, 10, 5, 1)`
    );
    await db.run(
      `INSERT INTO token_events
         (session_id, model, created_at, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, cost_usd_estimated,
          source_identity, cost_summary)
       VALUES ('sBad', 'm1', '2026-06-01T00:30:00.000Z',
               ${OVER_SAFE_INTEGER_TOKEN_LITERAL}, 100, 10, 5, 1, $1, $2)`,
      JSON.stringify({
        availability: TokenSourceIdentityAvailability.Available,
        scheme: "overflow-test",
        sourceRecordIds: ["overflow-event"],
      }),
      JSON.stringify({
        completeness: TokenCostCompleteness.Complete,
        subtotalUsd: 1,
        lanes: [{ basis: TokenCostBasis.ApiEstimated, subtotalUsd: 1 }],
      })
    );
    // Branch B: an entirely valid session so we can prove the rest of the batch
    // still renders (graceful degradation, not a whole-batch failure).
    const branchB = await s.branch({ branch: "feature/valid" });
    await s.session("sGood");
    await s.link({
      session: "sGood",
      artifactId: branchB,
      method: "git_push",
      relation: ArtifactRefRelation.Created,
    });
    await s.tokens("sGood", 300);

    // Per-(session,model) usage read (raw INTEGER columns, CAST(... AS TEXT)):
    // must NOT throw. The bad counter clamps to 0; every other value is exact.
    const usage = await readBranchUsageTokenRows(db.prisma);
    const bad = usage.find((r) => r.sessionId === "sBad");
    assert.ok(bad, "the overflow session still appears in the usage batch");
    assert.equal(bad.inputTokens, 0, "out-of-range input clamps to 0");
    assert.equal(bad.outputTokens, 100, "sibling valid columns are unaffected");
    assert.equal(bad.cacheReadTokens, 10);
    assert.equal(bad.cacheWriteTokens, 5);
    const good = usage.find((r) => r.sessionId === "sGood");
    assert.equal(good?.inputTokens, 300, "the valid session renders in full");

    // Aggregate read (CAST(SUM(...) AS INTEGER) AS TEXT): the overflow branch's
    // SUM would overflow the intMode:number decode without the TEXT cast. It must
    // degrade to 0, and the valid branch's total must be exact.
    const agg = await readBranchTokenAggregateRows(db.prisma);
    const aggBad = agg.find((r) => r.branchName === "feature/overflow");
    assert.equal(aggBad?.inputTokens, 0, "overflow SUM degrades to 0");
    const aggGood = agg.find((r) => r.branchName === "feature/valid");
    assert.equal(aggGood?.inputTokens, 300, "valid branch total is exact");

    // Branch-scoped per-session detail read (CAST(SUM(COALESCE(...)) AS INTEGER)
    // AS TEXT): same graceful degradation on the single-branch detail path.
    const detail = await readBranchSessionTokenRowsForBranch(db.prisma, {
      repoFullName: "acme/web",
      branchName: "feature/overflow",
    });
    const detailBad = detail.find((r) => r.sessionId === "sBad");
    assert.equal(detailBad?.inputTokens, 0, "detail SUM degrades to 0");
    assert.equal(
      detailBad?.outputTokens,
      100,
      "detail valid columns unaffected"
    );

    const summary = await getSharedBranchUsage(db);
    assert.deepEqual(summary.costCompleteness, {
      completeness: BranchCostCompleteness.Partial,
      reason: BranchCostCompletenessReason.Malformed,
      subtotalUsd: 1,
      lanes: { subscriptionEquivalentCost: 0, apiEstimatedCost: 1 },
    });
  });
});
