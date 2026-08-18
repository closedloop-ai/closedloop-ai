import assert from "node:assert/strict";
import test from "node:test";
import {
  readBranchSessionTokenRowsForBranch,
  readBranchTokenAggregateRows,
  readBranchTokenAggregateRowsForBranch,
  readBranchUsageTokenRows,
} from "../src/main/database/branch-reads.js";
import { seeder, withAcDb } from "./branch-reads-ac-test-helpers.js";

test("ISS-4413: per-branch token aggregates fold baseline_* columns", async () => {
  await withAcDb(async (db) => {
    const s = seeder(db);
    const branch = await s.branch({
      branch: "feature/baseline",
      firstPushedAt: "2026-06-01T00:10:00.000Z",
    });
    await s.session("s1");
    await s.link({
      session: "s1",
      artifactId: branch,
      method: "git_push",
    });

    await db.run(
      `INSERT INTO token_usage
         (session_id, model, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens,
          baseline_input, baseline_output,
          baseline_cache_read, baseline_cache_write,
          cost_usd_estimated)
       VALUES ('s1', 'claude-sonnet-4-5', 200, 80, 30, 10, 100, 40, 20, 5, 0.50)`
    );

    const key = { repoFullName: "acme/web", branchName: "feature/baseline" };

    const agg = await readBranchTokenAggregateRows(db.prisma);
    assert.equal(agg.length, 1);
    assert.equal(agg[0]?.inputTokens, 300);
    assert.equal(agg[0]?.outputTokens, 120);
    assert.equal(agg[0]?.cacheReadTokens, 50);
    assert.equal(agg[0]?.cacheWriteTokens, 15);

    const scopedAgg = await readBranchTokenAggregateRowsForBranch(
      db.prisma,
      key
    );
    assert.equal(scopedAgg.length, 1);
    assert.equal(scopedAgg[0]?.inputTokens, 300);
    assert.equal(scopedAgg[0]?.outputTokens, 120);
    assert.equal(scopedAgg[0]?.cacheReadTokens, 50);
    assert.equal(scopedAgg[0]?.cacheWriteTokens, 15);

    const sessionTokens = await readBranchSessionTokenRowsForBranch(
      db.prisma,
      key
    );
    assert.equal(sessionTokens.length, 1);
    assert.equal(sessionTokens[0]?.inputTokens, 300);
    assert.equal(sessionTokens[0]?.outputTokens, 120);
    assert.equal(sessionTokens[0]?.cacheReadTokens, 50);
    assert.equal(sessionTokens[0]?.cacheWriteTokens, 15);
  });
});

test("ISS-4413: baseline fold is a no-op for never-compacted rows (baseline_* = 0)", async () => {
  await withAcDb(async (db) => {
    const s = seeder(db);
    const branch = await s.branch({
      branch: "feature/no-compact",
      firstPushedAt: "2026-06-01T00:10:00.000Z",
    });
    await s.session("s1");
    await s.link({
      session: "s1",
      artifactId: branch,
      method: "git_push",
    });

    await db.run(
      `INSERT INTO token_usage
         (session_id, model, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens,
          cost_usd_estimated)
       VALUES ('s1', 'claude-sonnet-4-5', 500, 200, 40, 15, 0.80)`
    );

    const key = {
      repoFullName: "acme/web",
      branchName: "feature/no-compact",
    };

    const agg = await readBranchTokenAggregateRows(db.prisma);
    assert.equal(agg.length, 1);
    assert.equal(agg[0]?.inputTokens, 500);
    assert.equal(agg[0]?.outputTokens, 200);
    assert.equal(agg[0]?.cacheReadTokens, 40);
    assert.equal(agg[0]?.cacheWriteTokens, 15);

    const scopedAgg = await readBranchTokenAggregateRowsForBranch(
      db.prisma,
      key
    );
    assert.equal(scopedAgg.length, 1);
    assert.equal(scopedAgg[0]?.inputTokens, 500);
    assert.equal(scopedAgg[0]?.outputTokens, 200);

    const sessionTokens = await readBranchSessionTokenRowsForBranch(
      db.prisma,
      key
    );
    assert.equal(sessionTokens.length, 1);
    assert.equal(sessionTokens[0]?.inputTokens, 500);
    assert.equal(sessionTokens[0]?.outputTokens, 200);
  });
});

test("ISS-4413: even-split baseline fold with multi-branch session", async () => {
  await withAcDb(async (db) => {
    const s = seeder(db);
    const branchA = await s.branch({
      branch: "feature/a",
      firstPushedAt: "2026-06-01T00:10:00.000Z",
    });
    const branchB = await s.branch({
      branch: "feature/b",
      firstPushedAt: "2026-06-01T00:10:00.000Z",
    });
    await s.session("s1");
    await s.link({
      session: "s1",
      artifactId: branchA,
      method: "git_push",
    });
    await s.link({
      session: "s1",
      artifactId: branchB,
      method: "git_push",
    });

    await db.run(
      `INSERT INTO token_usage
         (session_id, model, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens,
          baseline_input, baseline_output,
          baseline_cache_read, baseline_cache_write,
          cost_usd_estimated)
       VALUES ('s1', 'claude-sonnet-4-5', 200, 100, 40, 20, 100, 50, 10, 5, 1.00)`
    );

    const agg = await readBranchTokenAggregateRows(db.prisma);
    assert.equal(agg.length, 2);
    for (const row of agg) {
      assert.equal(row.inputTokens, 150);
      assert.equal(row.outputTokens, 75);
      assert.equal(row.cacheReadTokens, 25);
      assert.equal(row.cacheWriteTokens, 12);
    }

    const sessionTokensA = await readBranchSessionTokenRowsForBranch(
      db.prisma,
      { repoFullName: "acme/web", branchName: "feature/a" }
    );
    assert.equal(sessionTokensA.length, 1);
    assert.equal(sessionTokensA[0]?.inputTokens, 300);
    assert.equal(sessionTokensA[0]?.outputTokens, 150);
    assert.equal(sessionTokensA[0]?.cacheReadTokens, 50);
    assert.equal(sessionTokensA[0]?.cacheWriteTokens, 25);
    assert.equal(sessionTokensA[0]?.branchCount, 2);
  });
});

test("ISS-4413: all-time usage rows fold baseline_* columns", async () => {
  await withAcDb(async (db) => {
    const s = seeder(db);
    const branch = await s.branch({
      branch: "feature/usage-baseline",
      firstPushedAt: "2026-06-01T00:10:00.000Z",
    });
    await s.session("s1");
    await s.link({
      session: "s1",
      artifactId: branch,
      method: "git_push",
    });

    await db.run(
      `INSERT INTO token_usage
         (session_id, model, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens,
          baseline_input, baseline_output,
          baseline_cache_read, baseline_cache_write,
          cost_usd_estimated)
       VALUES ('s1', 'claude-sonnet-4-5', 200, 80, 30, 10, 100, 40, 20, 5, 0.50)`
    );

    const usage = await readBranchUsageTokenRows(db.prisma);
    assert.equal(usage.length, 1);
    assert.equal(usage[0]?.inputTokens, 300);
    assert.equal(usage[0]?.outputTokens, 120);
    assert.equal(usage[0]?.cacheReadTokens, 50);
    assert.equal(usage[0]?.cacheWriteTokens, 15);
  });
});
