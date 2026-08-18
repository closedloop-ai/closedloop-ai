/**
 * @file db-host-migration-refusal-roundtrip.test.ts
 * @description ISS-4714 — the DB-host migration-refusal serialization round trip.
 *
 * The desktop migration runner executes INSIDE the db-host `utilityProcess`, so
 * a `DesktopMigrationError` it throws is flattened by `serializeDbHostError` into
 * a plain serialized error crossing the structured-clone boundary back to main,
 * where `rebuildError` reconstructs it. Before the fix that reconstruction always
 * produced a plain `Error`, so `instanceof DesktopMigrationError` — and thus
 * `isDbAheadOfAppError` — was ALWAYS false in production and the "update required"
 * banner never rendered, even though the in-process unit test (which throws the
 * real class instance) passed. This pins the production path:
 *   1. `serializeDbHostError` carries the refusal `kind` on the wire.
 *   2. a Ready response carrying that serialized error makes `client.start()`
 *      reject with a rebuilt typed `DesktopMigrationError` whose `kind` survives,
 *      so `isDbAheadOfAppError` classifies the DB-ahead (Downgrade) case true.
 *   3. a non-migration boot error round-trips to a plain `Error` (not DB-ahead).
 *   4. a version-skewed / unknown `refusalKind` degrades to a plain `Error`.
 *
 * Uses `node:test` and drives the REAL `DbHostClient` over a fake forked child,
 * mirroring `db-host-client-clone-safe-post.test.ts`, so no Electron boot.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DbHostClient } from "../src/main/database/db-host/db-host-client.js";
import {
  type DbHostError,
  DbHostRequestKind,
  DbHostResponseKind,
  serializeDbHostError,
} from "../src/main/database/db-host/db-host-protocol.js";
import {
  DesktopMigrationError,
  isDbAheadOfAppError,
  MigrationRefusalKind,
} from "../src/main/lifecycle/migration-refusal.js";
import type {
  DbHostChildListenerArgs,
  DbHostChildMessageListener,
} from "./db-host-fake-child-support.js";

/**
 * A fake forked db-host child whose init Ready reply carries a supplied
 * serialized error, modelling a migration refusal thrown in the child.
 */
function makeFakeChild(readyError: DbHostError | undefined) {
  const posted: { kind: string; id?: number }[] = [];
  let messageListener: DbHostChildMessageListener | undefined;
  const child = {
    stderr: null,
    on(...args: DbHostChildListenerArgs): unknown {
      if (args[0] === "message") {
        messageListener = args[1];
      }
      return child;
    },
    postMessage(message: { kind: string; id?: number }) {
      posted.push(message);
    },
    kill() {
      // no-op for the fake
    },
  };
  return {
    child,
    ready() {
      const initId = posted.find((m) => m.kind === DbHostRequestKind.Init)?.id;
      messageListener?.({
        kind: DbHostResponseKind.Ready,
        id: initId,
        ...(readyError ? { error: readyError } : {}),
      });
    },
  };
}

type FakeChild = ReturnType<typeof makeFakeChild>;

/** Start a client over the fake, delivering its Ready reply, and return the rejection. */
async function startAndCaptureError(fake: FakeChild): Promise<unknown> {
  const client = new DbHostClient({
    onEmit: () => undefined,
    onLog: () => undefined,
    fork: () => fake.child,
  });
  const started = client.start({ dataDir: "/tmp/agent-dashboard" }).then(
    () => null,
    (error: unknown) => error
  );
  fake.ready();
  return await started;
}

test("a DesktopMigrationError round-trips through the db-host boundary and stays classified DB-ahead", async () => {
  // The child threw the DB-ahead (Downgrade) refusal; serialize it exactly as
  // the worker does before it crosses the structured-clone boundary.
  const serialized = serializeDbHostError(
    new DesktopMigrationError(
      MigrationRefusalKind.Downgrade,
      "refusing: local store carries migration 0099_from_the_future this build lacks"
    )
  );
  assert.equal(
    serialized.refusalKind,
    MigrationRefusalKind.Downgrade,
    "serializeDbHostError must carry the refusal kind on the wire"
  );

  const fake = makeFakeChild(serialized);
  const error = await startAndCaptureError(fake);

  assert.ok(
    error instanceof DesktopMigrationError,
    "rebuildError must reconstruct a typed DesktopMigrationError from the wire kind"
  );
  assert.equal(
    (error as DesktopMigrationError).kind,
    MigrationRefusalKind.Downgrade
  );
  assert.equal(
    isDbAheadOfAppError(error),
    true,
    "the rebuilt error must classify as the DB-ahead condition in production"
  );
});

test("a non-migration boot error round-trips to a plain Error (never DB-ahead)", async () => {
  const serialized = serializeDbHostError(
    new Error("some unrelated boot failure")
  );
  assert.equal(
    serialized.refusalKind,
    undefined,
    "a non-refusal error must not carry a refusal kind"
  );

  const fake = makeFakeChild(serialized);
  const error = await startAndCaptureError(fake);

  assert.ok(error instanceof Error);
  assert.ok(
    !(error instanceof DesktopMigrationError),
    "a generic boot error must not rebuild as a migration error"
  );
  assert.equal(
    isDbAheadOfAppError(error),
    false,
    "a generic failure must not surface the update-required state"
  );
});

test("an unknown/version-skewed refusalKind degrades to a plain Error", async () => {
  // A newer child could send a refusal kind this build does not know; it must
  // not throw or mis-classify — degrade to a plain Error.
  const fake = makeFakeChild({
    message: "refusing for an unknown reason",
    name: "DesktopMigrationError",
    refusalKind: "some_future_refusal" as MigrationRefusalKind,
  });
  const error = await startAndCaptureError(fake);

  assert.ok(error instanceof Error);
  assert.ok(
    !(error instanceof DesktopMigrationError),
    "an unknown refusal kind must not rebuild as a typed migration error"
  );
  assert.equal(isDbAheadOfAppError(error), false);
});
