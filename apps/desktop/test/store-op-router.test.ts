/**
 * @file store-op-router.test.ts
 * @description ISS-5274 — EXECUTES the store-op interception decision.
 *
 * Without this, every coordinator unit test can stay green while boot, the 24h
 * timer, and manual refresh all still run the fetch inside the db-host: the
 * coordinators would be correct and simply never called. The decision used to
 * live inline in `agent-dashboard-db-host-lifecycle.ts`, which eagerly forks a
 * real db-host utilityProcess and injects no client, so it could only ever be
 * source-scanned — and AGENTS.md is explicit that a guard test must execute the
 * decision, not assert a predicate appears somewhere.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RoutedStoreOp,
  routeStoreOp,
} from "../src/main/dashboard/store-op-router.js";

type Recorder = {
  forwarded: { name: string; args: unknown[] }[];
  packScanRuns: number;
  catalogRuns: number;
};

function harness(overrides: { packScan?: boolean; catalog?: boolean } = {}) {
  const recorder: Recorder = { forwarded: [], packScanRuns: 0, catalogRuns: 0 };
  const deps = {
    packScanCoordinator:
      overrides.packScan === false
        ? null
        : {
            run: () => {
              recorder.packScanRuns += 1;
              return Promise.resolve();
            },
            stop: () => {},
          },
    catalogCoordinator:
      overrides.catalog === false
        ? null
        : {
            run: () => {
              recorder.catalogRuns += 1;
              return Promise.resolve();
            },
            stop: () => {},
          },
    rawStoreOp: (name: string, args: unknown[] = []) => {
      recorder.forwarded.push({ name, args });
      return Promise.resolve("forwarded");
    },
  };
  return { recorder, deps };
}

test("catalog.fetch.run routes to the catalog coordinator, never the db-host", async () => {
  const { recorder, deps } = harness();

  await routeStoreOp(RoutedStoreOp.CatalogFetchRun, [], deps);

  assert.equal(recorder.catalogRuns, 1);
  assert.deepEqual(
    recorder.forwarded,
    [],
    "the in-db-host fetch must not be reached while a coordinator exists"
  );
});

test("packScanner.run routes to the pack-scan coordinator", async () => {
  const { recorder, deps } = harness();

  await routeStoreOp(RoutedStoreOp.PackScannerRun, [], deps);

  assert.equal(recorder.packScanRuns, 1);
  assert.deepEqual(recorder.forwarded, []);
});

test("a null coordinator forwards to the db-host (golden mode / pre-construction)", async () => {
  const { recorder, deps } = harness({ packScan: false, catalog: false });

  await routeStoreOp(RoutedStoreOp.CatalogFetchRun, [], deps);
  await routeStoreOp(RoutedStoreOp.PackScannerRun, [], deps);

  // Golden mode never builds a coordinator, and there is a real window at boot
  // before the runtime constructs them. Both must degrade to the in-db-host op,
  // which is still the whole implementation there.
  assert.deepEqual(
    recorder.forwarded.map((f) => f.name),
    [RoutedStoreOp.CatalogFetchRun, RoutedStoreOp.PackScannerRun]
  );
});

test("one coordinator being null does not divert the other op", async () => {
  const { recorder, deps } = harness({ catalog: false });

  await routeStoreOp(RoutedStoreOp.CatalogFetchRun, [], deps);
  await routeStoreOp(RoutedStoreOp.PackScannerRun, [], deps);

  assert.equal(recorder.packScanRuns, 1);
  assert.deepEqual(
    recorder.forwarded.map((f) => f.name),
    [RoutedStoreOp.CatalogFetchRun]
  );
});

test("every other op forwards unchanged, args included", async () => {
  const { recorder, deps } = harness();

  const result = await routeStoreOp(
    "packScanner.applyDefinitions",
    [["a"], { homeDir: "/h", userScopeRoots: [] }],
    deps
  );

  assert.equal(result, "forwarded");
  assert.equal(recorder.catalogRuns, 0);
  assert.equal(recorder.packScanRuns, 0);
  assert.deepEqual(recorder.forwarded, [
    {
      name: "packScanner.applyDefinitions",
      args: [["a"], { homeDir: "/h", userScopeRoots: [] }],
    },
  ]);
});

test("a coordinator's own fallback op is NOT re-intercepted", async () => {
  const { recorder, deps } = harness();

  // The coordinators call their fallbacks through the UN-intercepted
  // `rawStoreOp`, but the router must also not claim these names: routing
  // `catalog.fetch.rows`/`apply` back to the coordinator would be infinite
  // recursion rather than a fetch.
  await routeStoreOp("catalog.fetch.rows", [], deps);
  await routeStoreOp("catalog.fetch.apply", [{}], deps);
  await routeStoreOp("packScanner.collectDefinitions", [], deps);

  assert.equal(recorder.catalogRuns, 0);
  assert.equal(recorder.packScanRuns, 0);
  assert.deepEqual(
    recorder.forwarded.map((f) => f.name),
    [
      "catalog.fetch.rows",
      "catalog.fetch.apply",
      "packScanner.collectDefinitions",
    ]
  );
});
