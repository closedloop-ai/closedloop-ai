/**
 * @file attribution-path-memo.test.ts
 * @description ISS-5272 — the shared `path → org/repo` memo that stops
 * `git remote get-url origin` being re-spawned once per session cwd per call
 * site.
 *
 * FIXTURE RULE (v4 C7): `resolveSessionAttributionAsync` consults the caller's
 * own `attributionByCwd` FIRST and short-circuits before the shared memo, so
 * every memo/TTL assertion here builds a FRESH per-call cache. A suite that
 * reuses one cache measures the per-call map and proves nothing about the memo.
 *
 * Spawns are counted end-to-end, not mocked: the git binary is overridden with a
 * shim that appends to a counter file and then execs the real git, so the count
 * is what the production code path actually executed.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  type RepoFullNameOutcome,
  RepoFullNameStatus,
  resolveRepoFullNameOutcomeAsync,
} from "../src/main/../server/operations/git-helpers.js";
import { resolveSessionAttributionAsync } from "../src/main/agent-sync/agent-session-attribution.js";
import {
  ATTRIBUTION_MEMO_MAX_ENTRIES,
  ATTRIBUTION_MEMO_TTL_ABSENT_MS,
  ATTRIBUTION_MEMO_TTL_PRESENT_MS,
  ATTRIBUTION_SPAWN_CONCURRENCY,
  ATTRIBUTION_YIELD_INTERVAL,
  AttributionRepoSource,
  createAttributionYieldCadence,
  readAttributionSpawnGateActive,
  readAttributionYieldCount,
  resetAttributionPathMemo,
  resetAttributionYieldCount,
  resolveAttributionRepoFullName,
  revalidateAttributionRepoFullName,
} from "../src/main/agent-sync/attribution-path-memo.js";
import { coldReadGate } from "../src/main/collectors/parsing/cold-read-gate.js";
import { configureBinaryPathsResolver } from "../src/server/operations/symphony-loop.js";
import {
  emptyAttributionCache,
  initGitRepoWithOrigin,
} from "./attribution-test-helpers.js";

const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], {
  encoding: "utf8",
}).trim();

/** Executable shim that records one line per invocation, then execs real git. */
function writeCountingGitShim(dir: string, name: string): string {
  const shimPath = path.join(dir, name);
  const counterPath = `${shimPath}.count`;
  writeFileSync(counterPath, "", "utf8");
  writeFileSync(
    shimPath,
    `#!/bin/sh\nprintf 'x' >> '${counterPath}'\nexec '${REAL_GIT}' "$@"\n`,
    "utf8"
  );
  chmodSync(shimPath, 0o755);
  return shimPath;
}

function readShimCount(shimPath: string): number {
  return readFileSync(`${shimPath}.count`, "utf8").length;
}

/** A loader that records its calls and answers from a scripted queue. */
function scriptedLoader(outcomes: RepoFullNameOutcome[]): {
  load: (repoPath: string) => Promise<RepoFullNameOutcome>;
  calls: string[];
} {
  const calls: string[] = [];
  let index = 0;
  return {
    calls,
    load: (repoPath: string) => {
      calls.push(repoPath);
      const outcome = outcomes[Math.min(index, outcomes.length - 1)];
      index += 1;
      return Promise.resolve(outcome);
    },
  };
}

const resolved = (repoFullName: string): RepoFullNameOutcome => ({
  status: RepoFullNameStatus.Resolved,
  repoFullName,
});
const noOrigin: RepoFullNameOutcome = {
  status: RepoFullNameStatus.NoOrigin,
  repoFullName: null,
};
const spawnFailed: RepoFullNameOutcome = {
  status: RepoFullNameStatus.SpawnFailed,
  repoFullName: null,
};

/** Rejection message thrown by the poisoned-in-flight loader below. */
const GIT_EXPLODED_PATTERN = /git exploded/;

/**
 * Let every pending microtask run. The spawn gate awaits its permit acquire
 * before invoking the load, so a load launched in this turn is DISPATCHED one
 * microtask later. `setImmediate` fires after the microtask queue drains, so a
 * single flush is enough for a whole fan-out. Only counts of ALREADY-launched
 * work are read after a flush; nothing here waits on a load to settle.
 */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

beforeEach(() => {
  resetAttributionPathMemo();
  resetAttributionYieldCount();
});

afterEach(() => {
  configureBinaryPathsResolver(null);
  resetAttributionPathMemo();
  resetAttributionYieldCount();
});

test("ISS-5272: two separate per-call caches resolving the same path spawn git exactly once", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5272-onespawn-"));
  try {
    const worktree = path.join(dir, "wt");
    mkdirSync(worktree);
    initGitRepoWithOrigin(worktree, "acme/one-spawn");
    const shim = writeCountingGitShim(dir, "git-shim");
    configureBinaryPathsResolver(() => ({ git: shim }));

    const first = await resolveSessionAttributionAsync(
      worktree,
      emptyAttributionCache()
    );
    // A SECOND, independent per-call cache — the production shape, where every
    // call site builds its own resolver cache.
    const second = await resolveSessionAttributionAsync(
      worktree,
      emptyAttributionCache()
    );

    assert.equal(first?.repositoryFullName, "acme/one-spawn");
    assert.equal(
      second?.repositoryFullName,
      "acme/one-spawn",
      "the second per-call cache resolves the same identity"
    );
    assert.equal(
      readShimCount(shim),
      1,
      "the shared memo served the second cache without a second git spawn"
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-5272: a memo hit reports source=memo and runs no binary resolution or spawn", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5272-hit-"));
  try {
    const worktree = path.join(dir, "wt");
    mkdirSync(worktree);
    initGitRepoWithOrigin(worktree, "acme/hit-repo");
    const shim = writeCountingGitShim(dir, "git-shim");
    configureBinaryPathsResolver(() => ({ git: shim }));

    const cold = await resolveAttributionRepoFullName(worktree);
    assert.equal(cold.source, AttributionRepoSource.Live);
    assert.equal(cold.repositoryFullName, "acme/hit-repo");

    for (let i = 0; i < 5; i += 1) {
      const warm = await resolveAttributionRepoFullName(worktree);
      assert.equal(warm.source, AttributionRepoSource.Memo);
      assert.equal(warm.repositoryFullName, "acme/hit-repo");
    }
    assert.equal(
      readShimCount(shim),
      1,
      "five hits added no spawns, so no `$PATH`/binary resolution happened on the hit path"
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-5272: overlapping resolutions of one key collapse to a single load", async () => {
  const deferred: Array<(outcome: RepoFullNameOutcome) => void> = [];
  const calls: string[] = [];
  const load = (repoPath: string): Promise<RepoFullNameOutcome> => {
    calls.push(repoPath);
    return new Promise((resolve) => {
      deferred.push(resolve);
    });
  };

  // Launched together, BEFORE any resolves — the sequential case passes with no
  // single-flight code at all, so overlap is the property under test.
  const inFlight = [
    resolveAttributionRepoFullName("/repo/single-flight", 1000, load),
    resolveAttributionRepoFullName("/repo/single-flight", 1000, load),
    resolveAttributionRepoFullName("/repo/single-flight", 1000, load),
    resolveAttributionRepoFullName("/repo/single-flight", 1000, load),
  ];
  // All four were launched before ANY load settled (the deferred below is what
  // settles them), so this stays a genuine overlap test — the flush only lets
  // the gate dispatch, it does not let a resolution complete.
  await flushMicrotasks();
  assert.equal(
    calls.length,
    1,
    "only one load started for four overlapping callers"
  );
  deferred[0](resolved("acme/shared"));

  const results = await Promise.all(inFlight);
  assert.equal(
    calls.length,
    1,
    "no further load ran after the shared one settled"
  );
  for (const result of results) {
    assert.equal(result.repositoryFullName, "acme/shared");
  }
});

test("ISS-5272: a rejected in-flight resolution is evicted, so the next caller retries", async () => {
  let attempt = 0;
  const load = (): Promise<RepoFullNameOutcome> => {
    attempt += 1;
    if (attempt === 1) {
      return Promise.reject(new Error("git exploded"));
    }
    return Promise.resolve(resolved("acme/recovered"));
  };

  await assert.rejects(
    () => resolveAttributionRepoFullName("/repo/rejects", 1000, load),
    GIT_EXPLODED_PATTERN
  );
  const retry = await resolveAttributionRepoFullName(
    "/repo/rejects",
    1000,
    load
  );
  assert.equal(
    attempt,
    2,
    "the failed key was not left poisoned in the in-flight map"
  );
  assert.equal(retry.repositoryFullName, "acme/recovered");
  assert.equal(retry.source, AttributionRepoSource.Live);
});

test("ISS-5272 (C2): a spawn failure is never memoized, a clean no-origin answer is", async () => {
  const transient = scriptedLoader([spawnFailed]);
  const firstTransient = await resolveAttributionRepoFullName(
    "/repo/transient",
    1000,
    transient.load
  );
  assert.equal(firstTransient.repositoryFullName, null);
  await resolveAttributionRepoFullName("/repo/transient", 1000, transient.load);
  assert.equal(
    transient.calls.length,
    2,
    "a transient failure leaves the key unmemoized so live-first precedence survives"
  );

  const clean = scriptedLoader([noOrigin]);
  await resolveAttributionRepoFullName("/repo/no-origin", 1000, clean.load);
  const second = await resolveAttributionRepoFullName(
    "/repo/no-origin",
    1000,
    clean.load
  );
  assert.equal(clean.calls.length, 1, "a clean no-origin answer IS memoized");
  assert.equal(second.source, AttributionRepoSource.Memo);
  assert.equal(second.repositoryFullName, null);
});

test("ISS-5272 (C2): the classifier separates git's own non-zero exit from a failed spawn", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5272-classify-"));
  try {
    const notARepo = path.join(dir, "plain");
    mkdirSync(notARepo);

    const missing = await resolveRepoFullNameOutcomeAsync(
      path.join(dir, "never-created")
    );
    assert.equal(
      missing.status,
      RepoFullNameStatus.NoOrigin,
      "an absent path is a fact about the path, not a process failure"
    );

    const plain = await resolveRepoFullNameOutcomeAsync(notARepo);
    assert.equal(
      plain.status,
      RepoFullNameStatus.NoOrigin,
      "git ran and exited non-zero: a definitive no-origin answer"
    );

    // A directory passes the X_OK probe the override resolver runs, but execing
    // it fails with EACCES — a spawn that never produced an answer.
    configureBinaryPathsResolver(() => ({ git: dir }));
    const unspawnable = await resolveRepoFullNameOutcomeAsync(notARepo);
    assert.equal(
      unspawnable.status,
      RepoFullNameStatus.SpawnFailed,
      "an un-runnable git binary must not be mistaken for a no-origin answer"
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-5272: a resolved name expires after the positive TTL and re-resolves live", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5272-ttl-"));
  try {
    const worktree = path.join(dir, "wt");
    mkdirSync(worktree);
    initGitRepoWithOrigin(worktree, "acme/before");
    const shim = writeCountingGitShim(dir, "git-shim");
    configureBinaryPathsResolver(() => ({ git: shim }));

    const start = 1_000_000;
    const cold = await resolveAttributionRepoFullName(worktree, start);
    assert.equal(cold.repositoryFullName, "acme/before");

    execFileSync(
      REAL_GIT,
      ["remote", "set-url", "origin", "git@github.com:acme/after.git"],
      {
        cwd: worktree,
        stdio: "pipe",
      }
    );

    const stillWarm = await resolveAttributionRepoFullName(
      worktree,
      start + ATTRIBUTION_MEMO_TTL_PRESENT_MS - 1
    );
    assert.equal(
      stillWarm.repositoryFullName,
      "acme/before",
      "inside the TTL the memo answers, so the new remote is not seen yet"
    );

    const expired = await resolveAttributionRepoFullName(
      worktree,
      start + ATTRIBUTION_MEMO_TTL_PRESENT_MS + 1
    );
    assert.equal(
      expired.repositoryFullName,
      "acme/after",
      "past the TTL the memo re-resolves live and picks up the new remote"
    );
    assert.equal(readShimCount(shim), 2, "exactly one extra spawn, at expiry");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-5272: an absent origin expires after the SHORTER negative TTL", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5272-negttl-"));
  try {
    const worktree = path.join(dir, "wt");
    mkdirSync(worktree);
    const shim = writeCountingGitShim(dir, "git-shim");
    configureBinaryPathsResolver(() => ({ git: shim }));

    const start = 2_000_000;
    const cold = await resolveAttributionRepoFullName(worktree, start);
    assert.equal(cold.repositoryFullName, null, "not a git repo yet");

    initGitRepoWithOrigin(worktree, "acme/freshly-cloned");

    const stillNegative = await resolveAttributionRepoFullName(
      worktree,
      start + ATTRIBUTION_MEMO_TTL_ABSENT_MS - 1
    );
    assert.equal(stillNegative.repositoryFullName, null);
    assert.equal(stillNegative.source, AttributionRepoSource.Memo);

    const healed = await resolveAttributionRepoFullName(
      worktree,
      start + ATTRIBUTION_MEMO_TTL_ABSENT_MS + 1
    );
    assert.equal(
      healed.repositoryFullName,
      "acme/freshly-cloned",
      "a newly created worktree appears after the short negative TTL, well before the positive one"
    );
    assert.ok(
      ATTRIBUTION_MEMO_TTL_ABSENT_MS < ATTRIBUTION_MEMO_TTL_PRESENT_MS,
      "the negative TTL is the shorter of the pair"
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-5272 (C1): the memo evicts LRU at MAX_ENTRIES instead of full-flushing", async () => {
  const { load, calls } = scriptedLoader([resolved("acme/filler")]);
  const now = 5000;
  const oldest = "/repo/entry-0";
  for (let i = 0; i < ATTRIBUTION_MEMO_MAX_ENTRIES; i += 1) {
    await resolveAttributionRepoFullName(`/repo/entry-${i}`, now, load);
  }
  assert.equal(calls.length, ATTRIBUTION_MEMO_MAX_ENTRIES);

  // Touch a recent key so it is provably NOT the eviction victim.
  const recent = `/repo/entry-${ATTRIBUTION_MEMO_MAX_ENTRIES - 1}`;
  const touched = await resolveAttributionRepoFullName(recent, now, load);
  assert.equal(touched.source, AttributionRepoSource.Memo);

  // One more miss pushes past the cap.
  await resolveAttributionRepoFullName("/repo/overflow", now, load);
  assert.equal(calls.length, ATTRIBUTION_MEMO_MAX_ENTRIES + 1);

  const evicted = await resolveAttributionRepoFullName(oldest, now, load);
  assert.equal(
    evicted.source,
    AttributionRepoSource.Live,
    "the least recently used entry is the one that was dropped"
  );
  const survivor = await resolveAttributionRepoFullName(recent, now, load);
  assert.equal(
    survivor.source,
    AttributionRepoSource.Memo,
    "overflow evicted ONE entry — a clear-on-overflow memo would have dropped this one too"
  );
  const middle = await resolveAttributionRepoFullName(
    "/repo/entry-2000",
    now,
    load
  );
  assert.equal(
    middle.source,
    AttributionRepoSource.Memo,
    "the memo did not full-flush"
  );
});

test("ISS-5272 (M1.5): two different ALS git overrides do not share a memo entry", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5272-keyscope-"));
  try {
    const worktree = path.join(dir, "wt");
    mkdirSync(worktree);
    initGitRepoWithOrigin(worktree, "acme/key-scope");
    const shimA = writeCountingGitShim(dir, "git-shim-a");
    const shimB = writeCountingGitShim(dir, "git-shim-b");

    configureBinaryPathsResolver(() => ({ git: shimA }));
    await resolveAttributionRepoFullName(worktree);
    const underA = await resolveAttributionRepoFullName(worktree);
    assert.equal(underA.source, AttributionRepoSource.Memo);

    configureBinaryPathsResolver(() => ({ git: shimB }));
    const underB = await resolveAttributionRepoFullName(worktree);
    assert.equal(
      underB.source,
      AttributionRepoSource.Live,
      "a second override must not be served the first override's value"
    );

    assert.equal(readShimCount(shimA), 1);
    assert.equal(readShimCount(shimB), 1, "each override ran its own git");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-5272 (M2): the dedicated gate caps spawns at 8 and never touches the shared coldReadGate", async () => {
  const release: Array<() => void> = [];
  const load = (): Promise<RepoFullNameOutcome> =>
    new Promise((resolve) => {
      release.push(() => resolve(noOrigin));
    });

  const pending: Promise<unknown>[] = [];
  const launched = 32;
  for (let i = 0; i < launched; i += 1) {
    pending.push(
      resolveAttributionRepoFullName(`/repo/gated-${i}`, 1000, load)
    );
  }
  // The gate acquires permits synchronously, so the PEAK is observable right
  // here — no polling, no timing. Dispatch is not: the gate awaits its acquire,
  // so the loads themselves start a microtask later.
  assert.equal(
    readAttributionSpawnGateActive(),
    ATTRIBUTION_SPAWN_CONCURRENCY,
    "observed peak concurrency is exactly the cap, not merely <= it"
  );
  await flushMicrotasks();
  assert.equal(
    release.length,
    ATTRIBUTION_SPAWN_CONCURRENCY,
    `${launched} queued resolutions dispatched only ${ATTRIBUTION_SPAWN_CONCURRENCY} loads`
  );
  assert.equal(
    coldReadGate.active,
    0,
    "the process-wide cold-read singleton is not consumed by attribution spawns"
  );

  // Settle them one at a time; each release admits exactly one queued waiter,
  // so the cap holds for the whole drain rather than only at the peak.
  let drained = 0;
  while (drained < launched) {
    assert.ok(
      readAttributionSpawnGateActive() <= ATTRIBUTION_SPAWN_CONCURRENCY,
      "the cap held mid-drain, not just at the launch peak"
    );
    release[drained]();
    drained += 1;
    await flushMicrotasks();
  }
  await Promise.all(pending);
  assert.equal(
    readAttributionSpawnGateActive(),
    0,
    "every permit was released"
  );
});

test("ISS-5272 (M3/C5): the yield cadence fires an exact number of times per interval", async () => {
  let yields = 0;
  const tick = createAttributionYieldCadence(ATTRIBUTION_YIELD_INTERVAL, () => {
    yields += 1;
    return Promise.resolve();
  });
  const iterations = ATTRIBUTION_YIELD_INTERVAL * 3 + 5;
  for (let i = 0; i < iterations; i += 1) {
    await tick();
  }
  assert.equal(
    yields,
    3,
    "one yield per full interval, none for the remainder"
  );
  assert.equal(
    readAttributionYieldCount(),
    3,
    "the observability counter matches the injected yield count"
  );
});

test("ISS-5272 (C3): revalidation bypasses a valid memo entry and refreshes it", async () => {
  const { load, calls } = scriptedLoader([
    resolved("acme/stale"),
    resolved("acme/fresh"),
  ]);
  const now = 9000;
  const warm = await resolveAttributionRepoFullName(
    "/repo/revalidate",
    now,
    load
  );
  assert.equal(warm.repositoryFullName, "acme/stale");
  assert.equal(
    (await resolveAttributionRepoFullName("/repo/revalidate", now, load))
      .source,
    AttributionRepoSource.Memo
  );

  const revalidated = await revalidateAttributionRepoFullName(
    "/repo/revalidate",
    now,
    load
  );
  assert.equal(
    revalidated,
    "acme/fresh",
    "revalidation ignores the valid memo entry"
  );
  assert.equal(calls.length, 2);

  const afterwards = await resolveAttributionRepoFullName(
    "/repo/revalidate",
    now,
    load
  );
  assert.equal(afterwards.source, AttributionRepoSource.Memo);
  assert.equal(
    afterwards.repositoryFullName,
    "acme/fresh",
    "the revalidated value replaced the stale memo entry"
  );
});
