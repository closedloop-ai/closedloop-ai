// @ts-check

/**
 * ISS-4638 — file-level sharding for the desktop `node:test` suite.
 *
 * Why this exists: `test:node` is 700+ files and ~526s on the `linux_4_core_arm`
 * runner, which was 77% of the single `desktop` job's `Test desktop` step and,
 * because `desktop` is a REQUIRED context that also runs on `merge_group`, the
 * floor on merge-queue dwell for every PR in the repo. node:test isolates each
 * file in its own child process, so the files are independent and can be split
 * across runners.
 *
 * Why the split lives HERE rather than inline in run-node-tests.mjs: that script
 * is a top-level side-effecting entrypoint that runs the whole suite on import,
 * so nothing in it is reachable from a test — the same reason
 * run-node-tests-outcome.mjs was carved out. A partition bug is invisible in the
 * worst way: a dropped file does not fail, it just stops running, and every
 * shard stays green. `apps/desktop/test/run-node-tests-shard.test.ts` asserts the
 * partition property (union == input, pairwise disjoint) that makes that
 * impossible.
 *
 * STRIDE, not contiguous slices. `files.filter((_, i) => i % total === index-1)`
 * is a partition for ANY (index, total) with no arithmetic to get wrong at the
 * boundary — no `Math.ceil` rounding that can drop the tail or double-count it,
 * which is the classic contiguous-slice bug. It also interleaves the
 * alphabetically-sorted file list, so a directory-shaped cluster of slow suites
 * (all `sync-*.test.ts`, say) lands across shards instead of piling into one.
 */

/** `<index>/<total>`, 1-based, matching Playwright's `--shard` spelling. */
const SHARD_SPEC_PATTERN = /^(\d+)\/(\d+)$/;

/**
 * @typedef {object} ShardSpec
 * @property {number} index 1-based shard number
 * @property {number} total Number of shards the suite is split across
 */

/**
 * Parse `NODE_TEST_SHARD`.
 *
 * Unset or empty means UNSHARDED — the release lane, the post-merge validation
 * lane and a local `pnpm test` all run the full suite, and must keep doing so.
 * Anything else that is not a valid shard THROWS rather than falling back to the
 * full suite: a typo'd shard silently running EVERY file on all 3 runners is
 * a 3x cost regression that reports green, and a typo'd shard silently running
 * NONE of them is lost coverage that also reports green.
 *
 * @param {string | undefined | null} raw
 * @returns {ShardSpec | null} `null` when unsharded
 */
export function parseShardSpec(raw) {
  const value = (raw ?? "").trim();
  if (value === "") {
    return null;
  }
  const match = SHARD_SPEC_PATTERN.exec(value);
  if (!match) {
    throw new Error(
      `[run-node-tests] NODE_TEST_SHARD must be "<index>/<total>" (1-based), got ${JSON.stringify(raw)}`
    );
  }
  const index = Number(match[1]);
  const total = Number(match[2]);
  if (total < 1 || index < 1 || index > total) {
    throw new Error(
      `[run-node-tests] NODE_TEST_SHARD ${value} is out of range: index must be 1..total and total must be at least 1`
    );
  }
  return { index, total };
}

/**
 * Take this shard's files out of the full, already-sorted list.
 *
 * @template T
 * @param {readonly T[]} files
 * @param {ShardSpec | null} shard
 * @returns {T[]}
 */
export function selectShard(files, shard) {
  if (shard === null) {
    return [...files];
  }
  return files.filter(
    (_, position) => position % shard.total === shard.index - 1
  );
}
