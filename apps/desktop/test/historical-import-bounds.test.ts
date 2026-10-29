import assert from "node:assert/strict";
import { test } from "vitest";
import {
  HISTORICAL_IMPORT_SESSION_TIMEOUT_MS,
  HISTORICAL_PARSE_TIMEOUT_MS,
  IMPORT_NO_MOVEMENT_GIVE_UP_MS,
  IMPORT_STALL_CHECK_INTERVAL_MS,
  SANCTIONED_SOURCE_STALL_MS,
} from "../src/shared/historical-import-bounds.js";

// ISS-8059. The renderer used to give up on a no-movement import at 120s while
// the main process was still granting a single source up to 210s, so the splash
// claimed failure over a loop that was inside bounds it had granted on purpose.
// The window is now one contract, and this suite is the tripwire on it.
//
// Every expected value below is written out INDEPENDENTLY on purpose. Deriving
// them from the constants under test would make each assertion tautological:
// raising a main-process bound would move the expectation with it and this file
// would stay green while the two processes silently re-diverged. The duplication
// is the test — a bound change is supposed to fail here and be re-reasoned.
const EXPECTED_PARSE_MS = 90_000;
const EXPECTED_IMPORT_SESSION_MS = 120_000;
const EXPECTED_SANCTIONED_MS = 210_000;
const EXPECTED_CHECK_INTERVAL_MS = 10_000;
const EXPECTED_GIVE_UP_MS = 220_000;

test("the sanctioned per-source budget is the parse bound followed by the write bound", () => {
  assert.equal(
    HISTORICAL_PARSE_TIMEOUT_MS,
    EXPECTED_PARSE_MS,
    "the parse bound moved; every give-up derived from it needs re-reasoning"
  );
  assert.equal(
    HISTORICAL_IMPORT_SESSION_TIMEOUT_MS,
    EXPECTED_IMPORT_SESSION_MS,
    "the write bound moved; every give-up derived from it needs re-reasoning"
  );
  assert.equal(
    SANCTIONED_SOURCE_STALL_MS,
    EXPECTED_SANCTIONED_MS,
    "the longest one source may hold the loop without the aggregate moving"
  );
});

test("the shared give-up window is strictly greater than the sanctioned budget", () => {
  assert.equal(IMPORT_STALL_CHECK_INTERVAL_MS, EXPECTED_CHECK_INTERVAL_MS);
  assert.equal(IMPORT_NO_MOVEMENT_GIVE_UP_MS, EXPECTED_GIVE_UP_MS);
  // Stated against the LIVE constants too, not only the literals above: this is
  // the invariant itself, and it is what a hand-edit that pins the give-up back
  // to a private smaller number would break.
  assert.ok(
    IMPORT_NO_MOVEMENT_GIVE_UP_MS > SANCTIONED_SOURCE_STALL_MS,
    `a give-up of ${IMPORT_NO_MOVEMENT_GIVE_UP_MS}ms inside the ${SANCTIONED_SOURCE_STALL_MS}ms a source is granted accuses a healthy import`
  );
  // And by a full sample, so the give-up cannot land ON the sanctioned boundary
  // and call a source that used exactly its budget a wedge.
  assert.ok(
    IMPORT_NO_MOVEMENT_GIVE_UP_MS - SANCTIONED_SOURCE_STALL_MS >=
      IMPORT_STALL_CHECK_INTERVAL_MS,
    "the give-up must clear the sanctioned budget by at least one poll interval"
  );
});
