/**
 * @file db-host-shutdown-preload-unwrap.test.ts
 * @description ISS-5262 — the preload half of the shutdown-sentinel contract.
 *
 * `withDb` now RESOLVES a payload-free sentinel instead of rejecting when the
 * db-host went away mid-read, which is what stops `ipcMain.handle` printing
 * `Error occurred in handler for '<channel>'` after the shutdown sequence
 * reported clean. That only stays safe if EVERY preload bridge over a
 * `withDb`-registered channel unwraps it: the bridges cast the IPC result
 * (`invoke(...) as Promise<T>`), so a sentinel that slips past typechecks as the
 * declared type and reaches the renderer AS DATA — a truthy object read as a
 * successful `delete`, or a non-array handed to a table's `.map`.
 *
 * These tests pin the unwrap, plus the message classification the renderer
 * depends on.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  DB_HOST_SHUTTING_DOWN_MESSAGE,
  DB_HOST_SHUTTING_DOWN_RESULT,
  rejectIfDbHostShuttingDown,
} from "../src/shared/db-host-shutdown-contract.js";
import { isTransientDbHostErrorMessage } from "../src/shared/transient-db-host-error.js";

const SHUTDOWN_MESSAGE_PATTERN = /shutting down; read abandoned/;

test("rejectIfDbHostShuttingDown passes a real result through", () => {
  const usage = { totalCostUsd: 12.5, sessions: 3 };
  assert.equal(
    rejectIfDbHostShuttingDown(usage),
    usage,
    "a genuine payload is returned untouched, by identity"
  );
  assert.equal(rejectIfDbHostShuttingDown(null), null);
  assert.equal(rejectIfDbHostShuttingDown(0), 0, "a real zero is still a zero");
});

test("rejectIfDbHostShuttingDown converts the sentinel to a rejection", () => {
  assert.throws(
    () => rejectIfDbHostShuttingDown({ ...DB_HOST_SHUTTING_DOWN_RESULT }),
    SHUTDOWN_MESSAGE_PATTERN,
    "the sentinel must never be handed to a caller as a value"
  );
});

test("the rejection stays TRANSIENT for the renderer's classifier", () => {
  // Before ISS-5262 a read racing the teardown rejected with the raw
  // `db-host exited (code: 0)`, which the renderer classified as a lifecycle
  // blip (quiet reconnecting state, retry). A message the classifier does not
  // recognize would silently promote that to the hard error card — trading a
  // lying log for a lying UI.
  assert.equal(
    isTransientDbHostErrorMessage("db-host exited (code: 0)"),
    true,
    "baseline: the pre-change message was transient"
  );
  assert.equal(
    isTransientDbHostErrorMessage(DB_HOST_SHUTTING_DOWN_MESSAGE),
    true,
    "so the replacement must be transient too"
  );
});
