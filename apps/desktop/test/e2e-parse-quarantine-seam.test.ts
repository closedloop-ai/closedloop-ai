/**
 * @file e2e-parse-quarantine-seam.test.ts
 * @description ISS-4573: unit coverage for the TEST-ONLY, E2E-launch-env-gated
 * parse-quarantine seam. The seam only exists to let the launched-app Electron E2E
 * trip quarantine fast; these tests pin that it is genuinely gated — a production
 * run (env unset) sees NO effect — and that it arms only on the exact sentinel, so a
 * stray inherited value can't accidentally flip it on. Env is passed explicitly (no
 * `process.env` mutation) so the tests are order-independent.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  E2E_PARSE_QUARANTINE_CONFIG,
  E2E_PARSE_QUARANTINE_ENABLED_VALUE,
  E2E_PARSE_QUARANTINE_ENV,
  E2E_POISON_TRANSCRIPT_MARKER,
  E2E_POISON_WORKER_CAPABILITY_ENV,
  isE2eParseQuarantineEnabled,
  isE2ePoisonSource,
} from "../src/main/collectors/engine/e2e-parse-quarantine-seam.js";

const POISON_SOURCE = `/tmp/history/${E2E_POISON_TRANSCRIPT_MARKER}-abc.jsonl`;
const HEALTHY_SOURCE = "/tmp/history/normal-session.jsonl";
const UNPACKAGED = false;
const PACKAGED = true;

function enabledEnv(): NodeJS.ProcessEnv {
  return { [E2E_PARSE_QUARANTINE_ENV]: E2E_PARSE_QUARANTINE_ENABLED_VALUE };
}

function workerCapabilityEnv(): NodeJS.ProcessEnv {
  return {
    [E2E_POISON_WORKER_CAPABILITY_ENV]: E2E_PARSE_QUARANTINE_ENABLED_VALUE,
  };
}

test("ISS-4573: disarmed by default — a production env is a no-op", () => {
  // The overwhelmingly common case: the E2E launch env is unset, so the seam is off
  // and neither consumer changes behavior. (isPackaged defaults to true = fail-closed.)
  assert.equal(isE2eParseQuarantineEnabled({}), false);
  assert.equal(isE2ePoisonSource(POISON_SOURCE, {}), false);
});

test("ISS-4573: arms ONLY on the exact enabled sentinel AND an unpackaged build", () => {
  assert.equal(isE2eParseQuarantineEnabled(enabledEnv(), UNPACKAGED), true);
  // PR #4085 review (wongk): a PACKAGED build never arms even with the exact
  // sentinel — a packaged client that inherited the flag must not quarantine a
  // normal transcript.
  assert.equal(isE2eParseQuarantineEnabled(enabledEnv(), PACKAGED), false);
  // The default (no isPackaged arg) is fail-closed (packaged), so even the exact
  // sentinel is a no-op unless the caller proves the build is unpackaged.
  assert.equal(isE2eParseQuarantineEnabled(enabledEnv()), false);
  // A stray/unexpected value must not flip the seam on (fail-safe), unpackaged or not.
  assert.equal(
    isE2eParseQuarantineEnabled(
      { [E2E_PARSE_QUARANTINE_ENV]: "true" },
      UNPACKAGED
    ),
    false
  );
  assert.equal(
    isE2eParseQuarantineEnabled({ [E2E_PARSE_QUARANTINE_ENV]: "" }, UNPACKAGED),
    false
  );
  assert.equal(
    isE2eParseQuarantineEnabled(
      { [E2E_PARSE_QUARANTINE_ENV]: "0" },
      UNPACKAGED
    ),
    false
  );
});

test("ISS-4573: only a marked poison source wedges, and only with the explicit worker capability", () => {
  // Worker capability set + marked → poison.
  assert.equal(isE2ePoisonSource(POISON_SOURCE, workerCapabilityEnv()), true);
  // Capability set but a healthy (unmarked) source is never wedged.
  assert.equal(isE2ePoisonSource(HEALTHY_SOURCE, workerCapabilityEnv()), false);
  // A marked source is NOT wedged without the explicit worker capability — the
  // marker alone can never poison a production parse.
  assert.equal(isE2ePoisonSource(POISON_SOURCE, {}), false);
  // PR #4085 review (wongk): the worker reads ONLY the runner-supplied capability,
  // NOT the raw inherited app-level sentinel. A worker that inherited the app-level
  // env but was NOT explicitly forked with the capability (the packaged case) never
  // wedges.
  assert.equal(isE2ePoisonSource(POISON_SOURCE, enabledEnv()), false);
});

test("ISS-4573: the injected config quarantines fast but stays a real deadline", () => {
  // A single wedged pass quarantines (threshold 1), and the deadline is low but
  // still non-zero so a healthy transcript parses well within it.
  assert.equal(E2E_PARSE_QUARANTINE_CONFIG.parseQuarantineMaxAttempts, 1);
  assert.ok(
    E2E_PARSE_QUARANTINE_CONFIG.historicalParseTimeoutMs > 0,
    "the parse deadline stays a real, positive bound"
  );
});
