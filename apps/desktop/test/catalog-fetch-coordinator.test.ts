/**
 * @file catalog-fetch-coordinator.test.ts
 * @description ISS-5274 — the main-process orchestration of the catalog fetch,
 * whose ~20 gh/HTTPS calls used to run inside the db-host (13.4s measured
 * against a 100ms op budget).
 *
 * The load-bearing property is the FALLBACK BOUNDARY: a failure before apply
 * retries the whole thing in the db-host, a failure at apply does not. Retrying
 * after a successful collect would repeat every network call inside the db-host
 * — reintroducing the exact stall this removes — and could double-apply over
 * partially-written rows, since `applyFetchResult` writes per row.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createCatalogFetchCoordinator } from "../src/main/packs/catalog-fetch-coordinator.js";

type Call = { name: string; args: unknown[] };

function harness(options: {
  rows?: unknown;
  failOn?: string;
  ghAvailable?: boolean;
}) {
  const calls: Call[] = [];
  const coordinator = createCatalogFetchCoordinator({
    rawStoreOp: (name, args = []) => {
      calls.push({ name, args });
      if (name === options.failOn) {
        return Promise.reject(new Error(`${name} failed`));
      }
      if (name === "catalog.fetch.rows") {
        return Promise.resolve(options.rows ?? []);
      }
      return Promise.resolve(undefined);
    },
    resolveGhAvailable: () => Promise.resolve(options.ghAvailable ?? false),
    log: () => {},
  });
  return { calls, coordinator };
}

test("the happy path reads and applies without ever touching catalog.fetch.run", async () => {
  const { calls, coordinator } = harness({ rows: [] });

  await coordinator.run();

  assert.deepEqual(
    calls.map((c) => c.name),
    ["catalog.fetch.rows", "catalog.fetch.apply"]
  );
});

test("a failed rows read falls back to the in-db-host fetch exactly once", async () => {
  const { calls, coordinator } = harness({ failOn: "catalog.fetch.rows" });

  await coordinator.run();

  assert.deepEqual(
    calls.map((c) => c.name),
    ["catalog.fetch.rows", "catalog.fetch.run"]
  );
});

test("an apply failure does NOT fall back", async () => {
  const { calls, coordinator } = harness({
    rows: [],
    failOn: "catalog.fetch.apply",
  });

  await coordinator.run();

  // The network half already succeeded. Re-running it inside the db-host to
  // retry a write would repeat ~20 gh/HTTPS calls there and risk double-applying
  // over the rows the failed apply may already have written.
  assert.ok(!calls.some((c) => c.name === "catalog.fetch.run"));
});

test("concurrent triggers coalesce to one fetch plus one trailing rerun", async () => {
  const calls: Call[] = [];
  let releaseFirst: (() => void) | null = null;
  let readCount = 0;
  const coordinator = createCatalogFetchCoordinator({
    rawStoreOp: (name, args = []) => {
      calls.push({ name, args });
      if (name === "catalog.fetch.rows") {
        readCount += 1;
        if (readCount === 1) {
          return new Promise((resolve) => {
            releaseFirst = () => resolve([]);
          });
        }
      }
      return Promise.resolve([]);
    },
    resolveGhAvailable: () => Promise.resolve(false),
    log: () => {},
  });

  // Boot, the 24h timer, and a manual refresh can all land at once; they must
  // never become three overlapping GitHub fetches racing each other's applies.
  const first = coordinator.run();
  const second = coordinator.run();
  const third = coordinator.run();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(releaseFirst, "the first fetch should be in flight");
  (releaseFirst as unknown as () => void)();
  await Promise.all([first, second, third]);

  assert.equal(
    calls.filter((c) => c.name === "catalog.fetch.rows").length,
    2,
    "1 in-flight + 1 coalesced rerun, no matter how many triggers landed"
  );
});

test("stop() refuses further runs", async () => {
  const { calls, coordinator } = harness({ rows: [] });

  coordinator.stop();
  await coordinator.run();

  assert.deepEqual(calls, []);
});

test("stop() mid-collect halts the remaining network work instead of marching through every row", async () => {
  const fetched: string[] = [];
  const calls: Call[] = [];
  let releaseFirst: (() => void) | null = null;
  const rows = Array.from({ length: 5 }, (_v, i) => ({
    packId: `p${i}`,
    githubUrl: `https://github.com/o/r${i}`,
    contents: null,
  }));
  const coordinator = createCatalogFetchCoordinator({
    rawStoreOp: (name, args = []) => {
      calls.push({ name, args });
      return Promise.resolve(name === "catalog.fetch.rows" ? rows : undefined);
    },
    resolveGhAvailable: () => Promise.resolve(false),
    log: () => {},
    transport: {
      fetchPluginManifest: () => Promise.resolve(null),
      fetchRepoStats: (_owner, repo) => {
        fetched.push(repo);
        if (fetched.length === 1) {
          return new Promise((resolve) => {
            releaseFirst = () =>
              resolve({ repo: { stargazers_count: 1 }, release: null });
          });
        }
        return Promise.resolve({
          repo: { stargazers_count: 1 },
          release: null,
        });
      },
    },
  });

  const run = coordinator.run();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(releaseFirst, "the first row's fetch should be in flight");
  // The user quit while row 0 was in flight.
  coordinator.stop();
  (releaseFirst as unknown as () => void)();
  await run;

  // Before this guard, teardown kept launching the remaining rows — up to two
  // 5s-timeout calls each — in the MAIN process, which nothing was killing.
  assert.deepEqual(fetched, ["r0"]);
  assert.ok(
    !calls.some((c) => c.name === "catalog.fetch.apply"),
    "a stopped run must not write into a closing db-host"
  );
});

test("the collected plan carries the injected gh availability", async () => {
  const { calls, coordinator } = harness({ rows: [], ghAvailable: true });

  await coordinator.run();

  const apply = calls.find((c) => c.name === "catalog.fetch.apply");
  const plan = apply?.args[0] as { usedGhCli: boolean };
  // Proves the injected resolver is what decides transport — not a second,
  // synchronous resolution happening inside the fetcher on the main thread.
  assert.equal(plan.usedGhCli, true);
});
