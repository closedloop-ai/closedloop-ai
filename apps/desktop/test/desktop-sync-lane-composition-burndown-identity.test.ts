/**
 * @file desktop-sync-lane-composition-burndown-identity.test.ts
 * @description The production burn-down reporter reads the signed-in identity
 * into its store query, so the invocation lane's owed remainder can leave out
 * template sessions another identity owns (ISS-7096 parity; the store half is
 * `sync-burndown-invocation-ownership.test.ts`). Without the wiring the store
 * filter never runs and the frozen remainder returns.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type { AgentSessionSyncSource } from "../src/main/agent-sync/agent-session-sync-source.js";
import { buildSyncBurndownReporter } from "../src/main/agent-sync/desktop-sync-lane-composition.js";
import type { SyncBurndownQuery } from "../src/main/database/sync-burndown-store.js";
import { fakeDesktopSyncLaneDeps } from "./fake-desktop-sync-lane-deps.js";
import { emptySample } from "./sync-burndown-reporter-harness.js";

test("the composed burn-down reporter queries the store with the signed-in identity", async () => {
  const identity = { userId: "user-1", organizationId: "org-1" };
  const queries: SyncBurndownQuery[] = [];
  const base = fakeDesktopSyncLaneDeps();
  const deps = fakeDesktopSyncLaneDeps({
    desktopSessionManager: {
      ...base.desktopSessionManager,
      getIdentity: () => identity,
    },
    getSyncSource: () => {
      const source: Pick<AgentSessionSyncSource, "readSyncBurndown"> = {
        readSyncBurndown: (query: SyncBurndownQuery) => {
          queries.push(query);
          return Promise.resolve(emptySample());
        },
      };
      return source as AgentSessionSyncSource;
    },
  });

  await buildSyncBurndownReporter(deps, () => null).sampleOnce();

  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0]?.identity, identity);
});
