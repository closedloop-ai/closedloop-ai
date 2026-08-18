/**
 * @file db-host-request-clone-safety.test.ts
 * @description ISS-4620 — boundary guard for the DB-host IPC request contract.
 *
 * `DbHostClient.post` sends every {@link DbHostRequest} to the forked DB-host
 * utilityProcess via `child.postMessage`, which serializes with the STRUCTURED
 * CLONE algorithm. A request carrying a non-cloneable value (a function, class
 * instance, `Error`, or — the ISS-4620 crash — the DB-host method proxy reached
 * into an invoke's `args`) makes `postMessage` throw "An object could not be
 * cloned", which on the initial dashboard-load path popped the fatal
 * "unexpected error" dialog and terminated the app.
 *
 * This guard runs representative request shapes — including the exact
 * initial-dashboard `Invoke` shape and the `syncSource.advanceSyncState`
 * cursor-persist shape whose broken `.bind(source)` caller was the root cause —
 * through `structuredClone` (the same algorithm `postMessage` uses) and asserts
 * they round-trip. A newly-added non-cloneable field on any request type fails
 * THIS test instead of production. The mutation legs prove the guard has teeth:
 * a function, an `Error`, or the DB-host proxy in `args` must NOT clone.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDbHostAgentDatabase } from "../src/main/database/db-host/db-host-agent-database.js";
import type { DbHostClient } from "../src/main/database/db-host/db-host-client.js";
import {
  type DbHostRequest,
  DbHostRequestKind,
} from "../src/main/database/db-host/db-host-protocol.js";

/**
 * The representative, structured-clone-safe requests the client actually posts,
 * keyed by request kind. Typing this as `Record<DbHostRequestKind,
 * DbHostRequest[]>` makes the guard EXHAUSTIVE at compile time: a NEW request
 * kind added to the union leaves an unassigned Record key, so `tsc` fails until
 * a fixture is added for it — the previous flat `DbHostRequest[]` accepted any
 * subset of kinds and let a new kind ship uncovered. Each kind lists every
 * variant whose optional fields must be exercised (all `Init.options` fields, the
 * null vs populated identity, and both the `ok:true`/`value` and `ok:false`/
 * `error` legs of a ScheduledReviewResult) so a new optional non-cloneable field
 * fails the round-trip loop below.
 */
const CLONE_SAFE_REQUESTS_BY_KIND: Record<DbHostRequestKind, DbHostRequest[]> =
  {
    [DbHostRequestKind.Init]: [
      // Minimal: only the required dataDir.
      { kind: DbHostRequestKind.Init, id: 1, options: { dataDir: "/tmp/db" } },
      // Every optional Init option populated (staleMinutes, identity).
      {
        kind: DbHostRequestKind.Init,
        id: 2,
        options: {
          dataDir: "/tmp/agent-dashboard",
          staleMinutes: 30,
          identity: { userId: "u-1", organizationId: "org-1" },
        },
      },
    ],
    [DbHostRequestKind.Invoke]: [
      // The initial-dashboard DB-load Invoke shape (dotted op + plain args).
      {
        kind: DbHostRequestKind.Invoke,
        id: 3,
        op: "dashboard.getInsights",
        args: ["overview", "30d"],
      },
      // The ISS-4620 root-cause path: the component-sync cursor persist. The FIXED
      // caller dispatches exactly this — `syncSource.advanceSyncState` with a plain
      // (sourceKey, PersistedSyncState) arg pair, all strings/string arrays.
      {
        kind: DbHostRequestKind.Invoke,
        id: 4,
        op: "syncSource.advanceSyncState",
        args: [
          "agent-component-sync:target-1",
          {
            observedTopUpdatedAt: "2026-07-31T03:06:00.000Z",
            observedIdsAtTopUpdatedAt: ["cmp-1"],
            deadLetteredIds: ["cmp-9", "cmp-10"],
          },
        ],
      },
      // Empty-args invoke (e.g. sessions.count()).
      { kind: DbHostRequestKind.Invoke, id: 5, op: "sessions.count", args: [] },
    ],
    [DbHostRequestKind.SetUserIdentity]: [
      { kind: DbHostRequestKind.SetUserIdentity, identity: null },
      {
        kind: DbHostRequestKind.SetUserIdentity,
        identity: { userId: "u-1", organizationId: "org-1" },
      },
    ],
    [DbHostRequestKind.Close]: [{ kind: DbHostRequestKind.Close, id: 6 }],
    [DbHostRequestKind.ScheduledReviewResult]: [
      // Failure leg: the serialized error variant.
      {
        kind: DbHostRequestKind.ScheduledReviewResult,
        id: 7,
        generation: "gen-1",
        ok: false,
        error: { message: "boom", name: "Error", stack: "Error: boom\n  at x" },
      },
      // Success leg: the full ScheduledReviewResult `value` (exercises the optional
      // `value` field a new non-cloneable ScheduledReviewResult member would fail).
      {
        kind: DbHostRequestKind.ScheduledReviewResult,
        id: 8,
        generation: "gen-2",
        ok: true,
        value: {
          ok: true,
          created: 2,
          skipped: 1,
          failed: 0,
          summary: "filed 2, skipped 1",
          error: null,
        },
      },
    ],
  };

const CLONE_SAFE_REQUESTS: DbHostRequest[] = Object.values(
  CLONE_SAFE_REQUESTS_BY_KIND
).flat();

test("every DbHostRequest kind has at least one clone-safe fixture", () => {
  // A per-kind coverage assertion complementing the compile-time Record guard:
  // every union member must contribute a fixture (belt-and-suspenders against a
  // fixture list that a refactor accidentally empties for one kind).
  for (const kind of Object.values(DbHostRequestKind)) {
    assert.ok(
      (CLONE_SAFE_REQUESTS_BY_KIND[kind] ?? []).length >= 1,
      `request kind "${kind}" must have at least one clone-safe fixture`
    );
  }
});

test("every representative DbHostRequest round-trips through structuredClone", () => {
  for (const request of CLONE_SAFE_REQUESTS) {
    const label =
      request.kind === DbHostRequestKind.Invoke
        ? `${request.kind}:${request.op}`
        : request.kind;
    assert.doesNotThrow(
      () => structuredClone(request),
      `request "${label}" must be structured-clone-safe`
    );
    // A round-trip must preserve the payload verbatim (POJO equality).
    assert.deepEqual(structuredClone(request), request, label);
  }
});

test("a function reached into invoke args is NOT clone-safe (mutation guard)", () => {
  const badRequest = {
    kind: DbHostRequestKind.Invoke,
    id: 6,
    op: "syncSource.advanceSyncState",
    // The original bug shape: a callback where a plain DTO belongs.
    args: [() => undefined],
  } satisfies DbHostRequest;
  assert.throws(() => structuredClone(badRequest));
});

test("a method-bearing rich object reached into invoke args is NOT clone-safe (Prisma-model stand-in)", () => {
  // A plain object carrying a method — the "Prisma-object-with-methods" the
  // ISS-4620 ticket names — cannot cross the boundary. Only plain DTOs may.
  const richObject = {
    id: "row-1",
    save: () => undefined,
  };
  const badRequest = {
    kind: DbHostRequestKind.Invoke,
    id: 7,
    op: "importer.importSession",
    args: [richObject],
  } satisfies DbHostRequest;
  assert.throws(() => structuredClone(badRequest));
});

test("the DB-host method proxy reached into invoke args is NOT clone-safe (ISS-4620 root cause)", () => {
  // Reproduce the exact ISS-4620 shape: the method proxy itself in `args`. The
  // broken `source.advanceSyncState.bind(source)` caller dispatched
  // invoke("syncSource.advanceSyncState.bind", [<proxy>]) because the proxy has
  // no Function.prototype.bind — posting the proxy is the fatal DataCloneError.
  const fakeClient = {
    invoke: () => Promise.resolve(),
  } as unknown as DbHostClient;
  const agentDatabase = createDbHostAgentDatabase(fakeClient);
  const badRequest = {
    kind: DbHostRequestKind.Invoke,
    id: 8,
    op: "syncSource.advanceSyncState.bind",
    args: [agentDatabase.syncSource],
  } satisfies DbHostRequest;
  assert.throws(() => structuredClone(badRequest));
});
