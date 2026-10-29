/**
 * @file catalog-fetch-coordinator.test.ts
 * @description ISS-5274 — the main-process orchestration of the catalog fetch,
 * whose ~20 HTTPS calls used to run inside the db-host (13.4s measured
 * against a 100ms op budget).
 *
 * The load-bearing property is the FALLBACK BOUNDARY: a failure before apply
 * retries the whole thing in the db-host, a failure at apply does not. Retrying
 * after a successful collect would repeat every network call inside the db-host
 * — reintroducing the exact stall this removes — and could double-apply over
 * partially-written rows, since `applyFetchResult` writes per row.
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import { createCatalogFetchCoordinator } from "../src/main/packs/catalog-fetch-coordinator.js";
import { GitHubJsonFetchStatus } from "../src/main/packs/catalog-github-client.js";
import { deferred } from "./deferred.js";

type Call = { name: string; args: unknown[] };

function harness(options: { rows?: unknown; failOn?: string }) {
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
  // retry a write would repeat ~20 HTTPS calls there and risk double-applying
  // over the rows the failed apply may already have written.
  assert.ok(!calls.some((c) => c.name === "catalog.fetch.run"));
});

test("concurrent triggers coalesce to one fetch plus one trailing rerun", async () => {
  const calls: Call[] = [];
  // This test owns the mock, so the read entering the coordinator IS the
  // completion signal: hand the release function out through a deferred rather
  // than waiting for `releaseFirst` to become observable (desktop AGENTS.md
  // FEA-2399 — a bounded poll is only for a subject that emits no signal).
  const firstFetchInFlight = deferred<() => void>();
  let readCount = 0;
  const coordinator = createCatalogFetchCoordinator({
    rawStoreOp: (name, args = []) => {
      calls.push({ name, args });
      if (name === "catalog.fetch.rows") {
        readCount += 1;
        if (readCount === 1) {
          return new Promise((resolve) => {
            firstFetchInFlight.resolve(() => resolve([]));
          });
        }
      }
      return Promise.resolve([]);
    },
    log: () => {},
  });

  // Boot, the 24h timer, and a manual refresh can all land at once; they must
  // never become three overlapping GitHub fetches racing each other's applies.
  const first = coordinator.run();
  const second = coordinator.run();
  const third = coordinator.run();
  const releaseFirst = await firstFetchInFlight.promise;
  releaseFirst();
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
  const firstRowFetchInFlight = deferred<() => void>();
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
    log: () => {},
    transport: {
      fetchPluginManifest: () => Promise.resolve(null),
      fetchRepoStats: (_owner, repo) => {
        fetched.push(repo);
        if (fetched.length === 1) {
          return new Promise((resolve) => {
            firstRowFetchInFlight.resolve(() =>
              resolve({
                status: GitHubJsonFetchStatus.Success,
                value: { repo: { stargazers_count: 1 }, release: null },
              })
            );
          });
        }
        return Promise.resolve({
          status: GitHubJsonFetchStatus.Success,
          value: { repo: { stargazers_count: 1 }, release: null },
        });
      },
    },
  });

  const run = coordinator.run();
  const releaseFirst = await firstRowFetchInFlight.promise;
  // The user quit while row 0 was in flight.
  coordinator.stop();
  releaseFirst();
  await run;

  // Before this guard, teardown kept launching the remaining rows — up to two
  // 5s-timeout calls each — in the MAIN process, which nothing was killing.
  assert.deepEqual(fetched, ["r0"]);
  assert.ok(
    !calls.some((c) => c.name === "catalog.fetch.apply"),
    "a stopped run must not write into a closing db-host"
  );
});
